// Pure trajectory analysis: clean shuttle path, hits, speed estimate, rallies. No browser APIs (testable in node).
const hyp = (x, y) => Math.hypot(x, y);

/**
 * raw: per-frame shuttle position [x,y] | null (full-res px)
 * boxes: per-frame [[x1,y1,x2,y2,playerIdx,courtX,courtY], ...]
 */
export function analyzeShuttle(raw, boxes, { fps = 30, width = 1280 } = {}) {
  const N = raw.length, k = width / 1280, f = fps / 30;
  const pos = raw.map(p => (p ? [...p] : null));

  // 1) drop isolated points and implausible jumps
  for (let i = 0; i < N; i++) {
    if (!pos[i]) continue;
    let nb = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j !== i && j >= 0 && j < N && raw[j] && hyp(raw[j][0] - raw[i][0], raw[j][1] - raw[i][1]) < 90 * k * Math.abs(j - i) / f) nb++;
    if (!nb) pos[i] = null;
  }
  // 2) fill gaps up to 5 frames (scaled by fps)
  const maxGap = Math.round(5 * f);
  for (let i = 1; i < N; i++) {
    if (pos[i] || !pos[i - 1]) continue;
    let j = i; while (j < N && !pos[j]) j++;
    if (j >= N || j - i > maxGap || hyp(pos[j][0] - pos[i - 1][0], pos[j][1] - pos[i - 1][1]) > 60 * k * (j - i + 1) / f) { i = j; continue; }
    for (let m = i; m < j; m++) {
      const u = (m - i + 1) / (j - i + 1);
      pos[m] = [pos[i - 1][0] + (pos[j][0] - pos[i - 1][0]) * u, pos[i - 1][1] + (pos[j][1] - pos[i - 1][1]) * u];
    }
    i = j;
  }

  // 3) hits: horizontal reversal, falling→rising (gravity can't do that), or a new flight appearing
  const w = Math.max(2, Math.round(3 * f));
  const vel = (a, b) => (pos[a] && pos[b] ? [(pos[b][0] - pos[a][0]) / (b - a), (pos[b][1] - pos[a][1]) / (b - a)] : null);
  const vt = 1.5 * k / f;
  const raw_hits = [];
  for (let i = w; i < N - w; i++) {
    if (!pos[i]) continue;
    const a = vel(i - w, i), b = vel(i, i + w);
    let hit = false;
    if (a && b) hit = (a[0] * b[0] < 0 && Math.abs(a[0]) > vt && Math.abs(b[0]) > vt) || (a[1] > (vt * 2) / 3 && b[1] < -vt);
    else if (!pos[i - 1] && !pos[i - 2]) { hit = true; for (let m = 1; m <= Math.round(5 * f); m++) if (!pos[i + m]) hit = false; }
    if (hit) raw_hits.push(i);
  }
  const hits = [];
  for (const i of raw_hits) if (!hits.length || i - hits.at(-1).frame > 0.4 * fps) hits.push({ frame: i });

  // 4) hitter = nearest player box (upper body / racket zone)
  for (const h of hits) {
    const [x, y] = pos[h.frame];
    let best = null, bd = Infinity;
    for (const b of boxes[h.frame] || []) {
      const bh = b[3] - b[1], cx = Math.min(Math.max(x, b[0]), b[2]), cy = Math.min(Math.max(y, b[1] - 0.5 * bh), b[1] + 0.6 * bh);
      const d = hyp(x - cx, y - cy) / bh;
      if (d < bd) { bd = d; best = b; }
    }
    h.player = best && bd < 1.5 ? (best[4] ?? null) : null;
    h.court = best && bd < 1.5 && best.length >= 7 ? [best[5], best[6]] : null;
    h.speed = null;
  }
  // speed estimate from court geometry: hitter → receiver distance D over flight time T,
  // undoing air drag: D = L·ln(1 + v0·T/L), L = vt²/g (shuttle terminal velocity vt ≈ 7 m/s)
  const L = (7.0 * 7.0) / 9.81;
  for (let j = 0; j + 1 < hits.length; j++) {
    const h = hits[j], n = hits[j + 1], T = (n.frame - h.frame) / fps;
    if (!h.court || !n.court || T < 0.25 || T > 3) continue;
    if ((h.court[1] < 6.7) === (n.court[1] < 6.7)) continue;            // must cross the net
    const D = hyp(n.court[0] - h.court[0], n.court[1] - h.court[1]);
    const kmh = (L * (Math.exp(Math.min(D / L, 2.2)) - 1) / T) * 3.6;
    if (kmh >= 15 && kmh <= 420) h.speed = Math.round(kmh);
  }

  // 5) rallies: hits chained with gaps < 4 s; at least 2 hits
  const rallies = [];
  let cur = null;
  for (const h of hits) {
    if (cur && h.frame - cur.hits.at(-1).frame < 4 * fps) cur.hits.push(h);
    else { if (cur) rallies.push(cur); cur = { hits: [h] }; }
  }
  if (cur) rallies.push(cur);
  const out = rallies.filter(r => r.hits.length >= 2).map(r => {
    const last = r.hits.at(-1).frame;
    let end = last; while (end + 1 < N && pos[end + 1] && end - last < 3 * fps) end++;
    return { start: r.hits[0].frame, end: Math.max(end, last + Math.round(0.5 * fps)), hits: r.hits };
  });
  return { pos, hits, rallies: out };
}

/** HUD state for frame i. */
export function shuttleStateAt(an, i, fps) {
  const s = { pos: an.pos[i], trail: [], rallyTime: null, rallyCount: null, lastSpeed: null, speedLabel: null, live: false };
  for (let j = i; j >= Math.max(0, i - Math.round(10 * fps / 30)); j--) { if (!an.pos[j]) break; s.trail.push(an.pos[j]); }
  let rally = null;
  for (const r of an.rallies) { if (r.start <= i) rally = r; else break; }
  if (rally) {
    s.live = i <= rally.end;
    s.rallyTime = (Math.min(i, rally.end) - rally.start) / fps;
    s.rallyCount = rally.hits.filter(h => h.frame <= i).length;
  }
  for (const h of an.hits) {
    if (h.frame > i) break;
    if (h.speed != null) {
      s.lastSpeed = h.speed;
      s.speedLabel = i - h.frame < 1.2 * fps ? { speed: h.speed, age: (i - h.frame) / fps } : null;
    }
  }
  return s;
}
