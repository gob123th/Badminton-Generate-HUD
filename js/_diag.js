// Diagnostic harness (dev only): run player tracking over a range and report side flips per player.
import { openVideo } from './pipeline.js';
import { PoseDetector } from './detector.js';
import { ByteTracker } from './bytetrack.js';
import { PlayerTracker, torsoHist } from './players.js';
import { PlayerTracker as OldTracker } from './_players_old.js';
import { Court } from './court.js';
import { loadConfig } from './config.js';
import { CanvasSink } from 'mediabunny';

// corners: TL,TR,BR,BL in px for the clip (default = sample clip, 1280×720)
export async function run({ url = '_full.mp4', start = 0, end = 180, every = 1, fixed = true,
  corners = [[-82.3, 339.7], [387.7, 317.3], [1415.1, 508.5], [539.5, 970.8]] } = {}) {
  const st = window.__diag = { done: false, frame: 0, log: [] };
  const blob = await (await fetch(url)).blob();
  const vid = await openVideo(new File([blob], url));
  const cfg = loadConfig();
  const court = new Court(corners, 'behind', 1.2);
  const det = await PoseDetector.create(cfg.model.file);
  const W = vid.width, H = vid.height, fps = vid.fps;
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
  const bt = new ByteTracker({ high: cfg.model.conf, low: 0.1, newTrack: cfg.model.conf, fps });
  const tr = fixed ? new PlayerTracker(cfg, court, fps, {}) : new OldTracker(cfg, court, fps, {});
  const ref = cfg.players.map(() => null), refN = cfg.players.map(() => 0), swapRun = cfg.players.map(() => 0);
  const sim = (a, b) => { let s = 0; for (let k = 0; k < 16; k++) s += Math.sqrt(a[k] * b[k]); return s; };
  const swaps = cfg.players.map(() => 0); st.swapLog = [];
  const sideOf = p => (p.side === 'far' ? 0 : 1);
  const flips = cfg.players.map(() => 0), seen = cfg.players.map(() => 0);
  const t0 = performance.now();
  let n = 0, first = null;
  for await (const wc of new CanvasSink(vid.video, { poolSize: 2 }).canvases(start, end)) {
    if (first === null) first = wc.timestamp;
    const t = wc.timestamp - first;
    ctx.drawImage(wc.canvas, 0, 0);
    if (n % every === 0) {
      const ps = tr.update(bt.update(await det.detect(cv, W, H, cfg.model.iou)), t, fixed ? ctx : null);
      ps.forEach((p, i) => {
        if (!p.visible) return;
        seen[i]++;
        const hh = torsoHist(ctx, p.box);
        if (hh && t < 3 && refN[i] < 60) { if (!ref[i]) ref[i] = new Float32Array(16); for (let k = 0; k < 16; k++) ref[i][k] += hh[k]; refN[i]++; }
        if (hh && t >= 3) {
          const own = sim(hh, ref[i].map(v => v / refN[i]));
          const q = ps.findIndex((o, j) => j !== i && cfg.players[j].side === cfg.players[i].side);
          const other = q >= 0 && ref[q] ? sim(hh, ref[q].map(v => v / refN[q])) : 0;
          if (other > own + 0.15) { swaps[i]++; swapRun[i]++; if (swapRun[i] === 15 && st.swapLog.length < 80) st.swapLog.push(`${(start + t - 0.5).toFixed(1)}s ${p.name}≈${cfg.players[q].name}`); }
          else swapRun[i] = 0;
        }
        const h = Court.half(p.pos, 0.5);
        if (h !== null && h !== sideOf(cfg.players[i])) { flips[i]++; if (st.log.length < 60) st.log.push(`${(start + t).toFixed(1)}s ${p.name} → ${h ? 'near' : 'far'}`); }
      });
    }
    n++; st.frame = n;
  }
  Object.assign(st, { done: true, swaps, secs: (performance.now() - t0) / 1000, frames: n, names: cfg.players.map(p => p.name), flips, seen });
  return st;
}
