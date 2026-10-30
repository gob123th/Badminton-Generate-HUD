// Two-pass pipeline.
//  Pass 1 (analyze): decode → YOLO players + ByteTrack → per-frame snapshots; TrackNetV3 shuttle positions.
//  Post: rally/hit/speed analysis over the whole range (needs the "future" of the trajectory).
//  Pass 2 (render): decode again → draw HUD from snapshots + shuttle state → encode MP4 (original audio copied).
import {
  Input, BlobSource, ALL_FORMATS, CanvasSink, EncodedPacketSink, Output, Mp4OutputFormat,
  BufferTarget, StreamTarget, CanvasSource, EncodedAudioPacketSource, canEncodeVideo,
} from 'mediabunny';
import { ByteTracker } from './bytetrack.js';
import { PlayerTracker, interpolateBetween } from './players.js';
import { StatsTracker } from './stats.js';
import { HudRenderer, speedRank } from './hud.js';
import { analyzeShuttle, shuttleStateAt, scoreContext, autoWinners, buildScore, pickHighlights, detectServes, ralliesFromServes } from './rally.js';
import { t } from './i18n.js';

export async function openVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error(t('err.noVideoTrack'));
  if (!(await video.canDecode())) throw new Error(t('err.decode', { codec: video.codec }));
  const audio = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();
  const pstats = await video.computePacketStats(120);
  const sink = new CanvasSink(video, { poolSize: 2 });
  const firstTs = await video.getFirstTimestamp();
  const first = await sink.getCanvas(firstTs);
  if (!first) throw new Error(t('err.firstFrame'));
  return {
    file, input, video, audio, duration, firstTs,
    fps: pstats.averagePacketRate || 30,
    width: first.canvas.width, height: first.canvas.height,
    codec: video.codec, audioCodec: audio?.codec || null,
    sink,
  };
}

export async function grabFrame(vid, t) {
  // first frame may start after 0 (e.g. 0.033 s) — clamp so frame lookup never returns null
  const w = (await vid.sink.getCanvas(Math.max(t, vid.firstTs || 0))) || (await vid.sink.getCanvas(vid.firstTs || 0));
  return w?.canvas;
}

const bitrateFor = (w, h, fps) => Math.round(Math.min(Math.max(w * h * fps * 0.12, 3e6), 20e6));
async function pickCodec(w, h, bitrate) {
  for (const c of ['avc', 'hevc', 'vp9', 'av1']) if (await canEncodeVideo(c, { width: w, height: h, bitrate })) return c;
  throw new Error(t('err.encode'));
}

/** Stats-like view over a snapshot (what HudRenderer reads). */
class StatView {
  constructor(snap) { this.s = snap; }
  distance(i) { return this.s.dist[i] || 0; }
  stamina(i) { return this.s.sta[i]; }
  staminaFrac(i) { return this.s.staFrac[i]; }
}

/**
 * opts: {vid, cfg, court, detector, shuttle (ShuttleTracker|null), assist (WasbTracker|null), seeds, start, end, canvas, fileHandle, onProgress, signal}
 */
const boxIou = (a, b) => {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
};

export async function renderVideo(opts) {
  const { vid, cfg, court, detector, shuttle, assist, seeds, canvas, onProgress, signal } = opts;
  const W = vid.width, H = vid.height, fps = vid.fps;
  const start = Math.max(0, opts.start || 0), end = Math.min(opts.end ?? vid.duration, vid.duration);
  const totalFrames = Math.max(1, Math.round((end - start) * fps));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const hud = new HudRenderer(cfg, court, W, H, { stage: 'overlay' });   // pass-1 live preview: over the video
  const hudOut = new HudRenderer(cfg, court, W, H);                       // pass 2: the chosen stage (maybe inset)
  await Promise.all([hud.ready, hudOut.ready]);
  const useShuttle = !!shuttle && cfg.render.shuttle, useAssist = useShuttle && !!assist;
  const P1 = useShuttle ? 0.72 : 0.62;                  // progress share of pass 1
  const t0 = performance.now();
  const report = (phase, frac, extra = {}) => {
    const el = (performance.now() - t0) / 1000;
    onProgress?.({ phase, frac, eta: frac > 0.01 ? (el / frac) * (1 - frac) : null, ...extra });
  };

  // ---------------------------------------------------------- pass 0: shuttle background (median of samples)
  if (useShuttle) {
    report('bg', 0);
    const n = 32, ts = Array.from({ length: n }, (_, i) => start + ((end - start) * (i + 0.5)) / n);
    const bgSink = new CanvasSink(vid.video, { width: 512, height: 288, fit: 'fill', poolSize: n });
    const cs = [];
    for await (const wc of bgSink.canvasesAtTimestamps(ts)) if (wc) cs.push(wc.canvas);
    shuttle.setBackground(cs);
    shuttle.setRegion(court.airPolygon(), W, H);          // ignore shuttles from neighbouring courts
    shuttle.queue = [];
    if (useAssist) { assist.setRegion(court.airPolygon(), W, H); assist.reset(); }
  }

  // ---------------------------------------------------------- pass 1: analyze
  const bt = new ByteTracker({ high: cfg.model.conf, low: 0.1, newTrack: cfg.model.conf, fps });
  const tracker = new PlayerTracker(cfg, court, fps, seeds);
  const stats = new StatsTracker(cfg, tracker.players);
  const stride = Math.max(1, cfg.model.stride | 0);
  const rois = court.farTiles(W, H);                  // zoomed passes for small far-side players
  const snaps = [], rawShuttle = [], rawAssist = [], boxes = [];
  const others = [];            // per frame: boxes of people who are not our players (neighbouring courts, spectators)
  let lastOthers = [];
  let n = 0, firstTs = null, canceled = false;
  const sink = new CanvasSink(vid.video, { poolSize: 2 });
  for await (const wc of sink.canvases(start, end)) {
    if (signal?.aborted) { canceled = true; break; }
    if (firstTs === null) firstTs = wc.timestamp;
    const t = wc.timestamp - firstTs;
    ctx.drawImage(wc.canvas, 0, 0, W, H);
    if (n % stride === 0) {
      const dets = await detector.detect(canvas, W, H, cfg.model.iou, rois);
      tracker.update(bt.update(dets), t, ctx);
      const mine = tracker.players.filter(p => p.visible && p.box).map(p => p.box);
      lastOthers = dets.filter(d => d.score >= cfg.model.conf && !mine.some(b => boxIou(b, d.box) > 0.5)).map(d => d.box);
      stats.update(tracker.players, t);
    }
    const ps = tracker.players;
    snaps.push({
      t,
      players: ps.map(p => ({
        idx: p.idx, name: p.name, color: p.color, team: p.team, trackId: p.trackId,
        pos: p.pos && [...p.pos], head: p.head && [...p.head], show: tracker.drawable(p, t),
      })),
      dist: ps.map(p => stats.distance(p.idx)),
      sta: ps.map(p => stats.stamina(p.idx)),
      staFrac: ps.map(p => stats.staminaFrac(p.idx)),
      dets: cfg.render.showIds ? tracker.lastDets.map(d => ({ box: d.box, foot: d.foot, tid: d.tid })) : null,
    });
    boxes.push(ps.filter(p => p.visible && p.box).map(p => [...p.box, p.idx, p.pos[0], p.pos[1]]));
    others.push(lastOthers);
    rawShuttle.push(null);
    if (useShuttle) for (const r of await shuttle.push(wc.canvas, n, W, H)) rawShuttle[r.frame] = r.pos;
    if (useAssist) for (const r of await assist.push(wc.canvas, n, W, H)) rawAssist[r.frame] = r.pos;
    // live preview (players only; shuttle needs the whole trajectory first)
    hud.render(ctx, { ...snaps[n], stats: new StatView(snaps[n]), shuttle: null, preview: true });
    n++;
    report('analyze', (n / totalFrames) * P1, { frame: n, total: totalFrames });
  }
  if (canceled) return null;
  if (useShuttle) for (const r of await shuttle.flush(W, H)) rawShuttle[r.frame] = r.pos;
  // WASB only fills frames where TrackNetV3 found nothing (TrackNetV3 stays the primary)
  let assisted = 0;
  if (useAssist) {
    for (const r of await assist.flush(W, H)) rawAssist[r.frame] = r.pos;
    for (let i = 0; i < rawShuttle.length; i++) if (!rawShuttle[i] && rawAssist[i]) { rawShuttle[i] = rawAssist[i]; assisted++; }
  }
  interpolateBetween(snaps, boxes, stride);   // detection every `stride` frames: smooth positions in between

  const an = useShuttle ? analyzeShuttle(rawShuttle, boxes, { fps, width: W, others }) : null;
  // rallies from serve to serve (players' positions vs the service lines) when serves were found; else hit chains
  const serves = an ? detectServes(boxes, { fps }) : [];
  if (serves.length >= 2) an.rallies = ralliesFromServes(an, serves, boxes, fps);

  // ---------------------------------------------------------- score: auto guess, then optional user review
  let score = null;
  const skip = new Set();         // rallies the user marked "not a point" (passing the shuttle over, …): no highlight
  if (an && cfg.score?.enabled) {
    const sctx = scoreContext(cfg.players, (x, y) => court.toCourt(x, y), cfg.score.start);
    const auto = autoWinners(an, sctx);
    let picked = { winners: auto.map(a => a.winner), extras: [] };
    if (opts.review) {
      picked = await opts.review({ an, auto, ctx: sctx, start: cfg.score.start, time: f => start + snaps[Math.min(f, snaps.length - 1)].t });
      if (!picked || signal?.aborted) return null;
      picked.winners.forEach((w, i) => { if (!w) skip.add(i); });
    }
    score = buildScore(an, picked.winners, picked.extras, cfg.score.start, sctx);
    score.auto = auto;
    an.score = score.timeline;
  }

  // ---------------------------------------------------------- pass 2: render + encode
  canvas.width = hudOut.OW; canvas.height = hudOut.OH;
  const bitrate = bitrateFor(hudOut.OW, hudOut.OH, fps);
  const codec = await pickCodec(hudOut.OW, hudOut.OH, bitrate);
  const writable = opts.fileHandle ? await opts.fileHandle.createWritable() : null;
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
  const vSrc = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vSrc, { frameRate: fps });

  let aSrc = null, aIter = null, aNext = null, aMetaSent = false, aConfig = null;
  if (vid.audio && ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'].includes(vid.audioCodec)) {
    aSrc = new EncodedAudioPacketSource(vid.audioCodec);
    output.addAudioTrack(aSrc);
    aConfig = await vid.audio.getDecoderConfig();
    const aSink = new EncodedPacketSink(vid.audio);
    const first = (await aSink.getPacket(start)) || (await aSink.getFirstPacket());
    aIter = first ? aSink.packets(first) : null;
  }
  // highlight reel: a second, in-memory output fed with the same rendered frames inside the picked rallies
  let hl = null;
  const clips = an && cfg.highlight?.enabled ? pickHighlights(an, { count: cfg.highlight.count, fps, skip }) : [];
  if (clips.length) {
    const hTarget = new BufferTarget();
    const hOut = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: hTarget });
    const hSrc = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
    hOut.addVideoTrack(hSrc, { frameRate: fps });
    let hAud = null;
    if (aSrc) { hAud = new EncodedAudioPacketSource(vid.audioCodec); hOut.addAudioTrack(hAud); }
    let at = 0;                   // where each clip starts in the reel (s)
    const spans = clips.map((c, k) => {
      const t0 = snaps[c.start].t, t1 = snaps[Math.min(c.end, snaps.length - 1)].t + 1 / fps;
      const sp = { ...c, index: k + 1, total: clips.length, t0, t1, at };
      at += t1 - t0;
      return sp;
    });
    hl = { target: hTarget, out: hOut, src: hSrc, aud: hAud, spans, metaSent: false, duration: at };
    await hOut.start();
  }
  await output.start();
  const pumpAudio = async upTo => {
    while (aIter) {
      if (!aNext) { const r = await aIter.next(); if (r.done) { aIter = null; return; } aNext = r.value; }
      if (aNext.timestamp >= end) { aIter = null; return; }
      if (aNext.timestamp > upTo) return;
      const ts = aNext.timestamp - start;
      if (ts >= 0) { await aSrc.add(aNext.clone({ timestamp: ts }), aMetaSent ? undefined : { decoderConfig: aConfig }); aMetaSent = true; }
      const sp = hl?.aud && hl.spans.find(c => ts >= c.t0 && ts < c.t1);
      if (sp) { await hl.aud.add(aNext.clone({ timestamp: sp.at + ts - sp.t0 }), hl.metaSent ? undefined : { decoderConfig: aConfig }); hl.metaSent = true; }
      aNext = null;
    }
  };

  let m = 0;
  try {
    const sink2 = new CanvasSink(vid.video, { poolSize: 2 });
    for await (const wc of sink2.canvases(start, end)) {
      if (signal?.aborted) { canceled = true; break; }
      if (m >= snaps.length) break;
      const snap = snaps[m];
      hudOut.drawBase(ctx, wc.canvas);
      hudOut.render(ctx, { ...snap, stats: new StatView(snap), shuttle: an ? shuttleStateAt(an, m, fps, hudOut.badgeSecs) : null });
      await pumpAudio(wc.timestamp + 0.5);
      await vSrc.add(snap.t, wc.duration || 1 / fps);
      const sp = hl?.spans.find(c => m >= c.start && m <= c.end);
      if (sp) {                   // CanvasSource.add captured the main frame already; add the banner/fade on top
        hudOut.highlight(ctx, sp, snap.t - sp.t0, sp.t1 - snap.t - 1 / fps);
        await hl.src.add(sp.at + snap.t - sp.t0, wc.duration || 1 / fps);
      }
      m++;
      report('render', P1 + (m / snaps.length) * (1 - P1), { frame: m, total: snaps.length });
    }
  } catch (e) {
    await output.cancel().catch(() => {});
    await hl?.out.cancel().catch(() => {});
    throw e;
  }
  if (canceled) { await output.cancel(); await hl?.out.cancel(); return null; }
  await pumpAudio(end);
  await output.finalize();
  await hl?.out.finalize();

  const names = cfg.players.map(p => p.name);
  const result = {
    codec, frames: m,
    stats: {
      video: vid.file.name, fps, frames: m, start_s: +start.toFixed(2), duration_s: +(m / fps).toFixed(2),
      players: stats.toJSON(tracker.players),
      track_bindings: tracker.bindings(),
      detector_backend: detector.backend,
      shuttle: an ? {
        backend: shuttle.backend,
        detected_frames: an.pos.filter(Boolean).length,
        assist: useAssist ? { model: 'wasb', backend: assist.backend, filled_frames: assisted } : null,
        rallies: an.rallies.map((r, i) => ({
          rally: i + 1, start_s: +(snaps[r.start].t).toFixed(2), duration_s: +((r.end - r.start) / fps).toFixed(2), shots: r.hits.length,
          max_speed_kmh_est: Math.max(0, ...r.hits.map(h => h.speed || 0)) || null,
        })),
        shots: an.hits.map(h => ({ t_s: +(snaps[h.frame].t).toFixed(2), player: h.player != null ? names[h.player] : null, speed_kmh_est: h.speed, rank_est: h.speed != null ? speedRank(h.speed, cfg.render.badge.ranks).rank : null })),
      } : null,
      highlight: hl ? hl.spans.map(c => ({ clip: c.index, start_s: +(start + c.t0).toFixed(2), duration_s: +(c.t1 - c.t0).toFixed(2), rallies: c.rallies.map(i => i + 1), shots: c.shots, max_speed_kmh_est: c.top })) : null,
      score: score ? {
        start: { ...cfg.score.start }, final: score.final,
        points: score.rows.map(r => ({
          rally: r.rally + 1, manual: r.extra, t_s: +(snaps[Math.max(0, Math.min(r.frame, snaps.length - 1))].t).toFixed(2),
          winner: r.winner, score: `${r.A}-${r.B}`, evidence: r.extra ? 'manual' : score.auto[r.rally]?.by ?? null, serve_court_mismatch: r.serveWarn,
        })),
      } : null,
    },
    blob: null,
    highlight: hl ? { blob: new Blob([hl.target.buffer], { type: 'video/mp4' }), clips: hl.spans.length, duration_s: +hl.duration.toFixed(1) } : null,
    analysis: an,   // debug: window.__lastResult.analysis (shuttle path, hits, rallies)
    debug: { rawShuttle, boxes, others },   // inputs of analyzeShuttle, to replay rally.js offline in node
  };
  if (!writable) result.blob = new Blob([target.buffer], { type: 'video/mp4' });
  return result;
}
