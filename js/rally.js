// Pure trajectory analysis: clean shuttle path, hits, speed estimate, rallies. No browser APIs (testable in node).
const hyp = (x, y) => Math.hypot(x, y);
/** distance from (x, y) to a player box's upper body / racket zone, in box heights */
function zoneDist(x, y, b) {
  const bh = b[3] - b[1], cx = Math.min(Math.max(x, b[0]), b[2]), cy = Math.min(Math.max(y, b[1] - 0.5 * bh), b[1] + 0.6 * bh);
  return hyp(x - cx, y - cy) / bh;
}

/** (x, y) in a racket zone (0.6 box heights past the upper body ≈ arm + racket): +1 ours, -1 someone else's, 0 none */
function zoneVote(x, y, mine, theirs) {
  const d = Math.min(Infinity, ...(mine || []).map(b => zoneDist(x, y, b)));
  const e = Math.min(Infinity, ...(theirs || []).map(b => zoneDist(x, y, b)));
  return d < 0.6 && d <= e ? 1 : e < 0.6 && e < d ? -1 : 0;
}

function hull(pts) {                 // monotone-chain convex hull
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => {
    const h = [];
    for (const q of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); }
    h.pop(); return h;
  };
  return [...half(p), ...half(p.reverse())];
}
const inHull = (h, x, y) => h.every((a, j) => { const b = h[(j + 1) % h.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });

/**
 * Play volume: the air a shuttle hit between our players can be in. Our shuttle flies from one of our players to one
 * on the other side, so at frame i it is above the floor around them: their court positions over [i − 0.5 s, i + 1 s]
 * (the receiver is still on the way), grown by `grow` m, up to `height` m (straight up in the image at the floor's
 * scale, as Court.airPolygon). Returns i → image hull, or null without players on both sides of the net.
 */
export function playVolume(boxes, toImg, { fps = 30, grow = 1.5, height = 8 } = {}) {
  const cache = new Map(), step = Math.max(1, Math.round(fps / 10));
  return i => {
    if (cache.has(i)) return cache.get(i);
    const floor = [];
    let far = false, near = false;
    for (let j = Math.max(0, i - Math.round(0.5 * fps)); j <= Math.min(boxes.length - 1, i + fps); j += step) {
      for (const b of boxes[j] || []) {
        if (b.length < 7) continue;
        if (b[6] < 6.7) far = true; else near = true;
        for (const [dx, dy] of [[-grow, -grow], [grow, -grow], [grow, grow], [-grow, grow]]) floor.push([b[5] + dx, b[6] + dy]);
      }
    }
    let h = null;
    if (far && near) {
      const img = [];
      for (const [x, y] of hull(floor)) {
        const p = toImg(x, y), ax = toImg(x + 1, y), ay = toImg(x, y + 1);
        const ppm = Math.max(hyp(ax[0] - p[0], ax[1] - p[1]), hyp(ay[0] - p[0], ay[1] - p[1]));
        img.push(p, [p[0], p[1] - ppm * height]);
      }
      if (img.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) h = hull(img);
    }
    cache.set(i, h);
    return h;
  };
}

/**
 * Our shuttle among each frame's heatmap blobs (cands[i] = [[x, y, strength], …], strongest first). TrackNet's own
 * post-process keeps only the largest blob, which is a neighbouring court's shuttle (or a static white spot) whenever
 * that one looks bigger. Blobs are linked frame to frame into tracklets (gap ≤ 3 frames, near where the tracklet's
 * velocity predicts, never > 120 px/frame); every frame takes the blob whose tracklet looks most like ours:
 *   evidence = 10 × (racket contact at its start + at its end: +1 ours, −1 someone else's, 0 none)
 *            + 10 × share of moving frames inside the play volume (−1…1; a still blob earns nothing)
 * summed over the best chain of tracklets through it (see below); ties → more moving frames, then the stronger blob.
 * Negative → someone else's: the frame stays empty rather than take it. Without players (no zones, no volume) this
 * is the longest moving tracklet.
 */
export function pickShuttle(cands, boxes, { fps = 30, width = 1280, others = [], vol = null } = {}) {
  const N = cands.length, k = width / 1280, f = fps / 30, maxGap = Math.max(1, Math.round(3 * f));
  const tracks = [], at = [];           // at[i] = [[track, cand], …]
  let active = [];
  for (let i = 0; i < N; i++) {
    const C = cands[i] || [];
    at[i] = [];
    const pairs = [];
    for (const t of active) {
      const [li, lx, ly] = t.pts.at(-1), g = i - li;
      const px = lx + t.v[0] * g, py = ly + t.v[1] * g, tol = (30 * k + 0.5 * hyp(t.v[0], t.v[1])) * g;
      C.forEach((c, n) => {
        const d = hyp(c[0] - px, c[1] - py);
        if (d < tol && hyp(c[0] - lx, c[1] - ly) <= 120 * k * g / f) pairs.push([d, t, n]);
      });
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set(), usedC = new Set();
    for (const [, t, n] of pairs) {
      if (usedT.has(t) || usedC.has(n)) continue;
      usedT.add(t); usedC.add(n);
      const [li, lx, ly] = t.pts.at(-1), c = C[n], g = i - li, v = [(c[0] - lx) / g, (c[1] - ly) / g];
      t.v = t.pts.length > 1 ? [(t.v[0] + v[0]) / 2, (t.v[1] + v[1]) / 2] : v;
      t.pts.push([i, c[0], c[1]]);
      at[i].push([t, c]);
    }
    C.forEach((c, n) => {
      if (usedC.has(n)) return;
      const t = { pts: [[i, c[0], c[1]]], v: [0, 0] };
      tracks.push(t); active.push(t); at[i].push([t, c]);
    });
    active = active.filter(t => i - t.pts.at(-1)[0] < maxGap);
  }
  // Racket contact counts only at a tracklet's ends (a hit starts or ends a flight): mid-flight, a near player's zone
  // covers half the image (box ~350 px tall at 720p) and the next court's shuttle flying behind him sat in it for 100
  // frames. The play volume counts as the share of moving frames inside (−1…1): a long flight can't outvote contacts
  const still = 4 * k, END = 3;
  const contact = pts => Math.sign(pts.reduce((s, [i, x, y]) => s + zoneVote(x, y, boxes[i], others[i]), 0));
  for (const t of tracks) {
    let inside = 0, moving = 0;
    t.pts.forEach(([i, x, y], j) => {
      if (!j || hyp(x - t.pts[j - 1][1], y - t.pts[j - 1][2]) < still) return;
      moving++;
      const h = vol?.(i);
      if (h) inside += inHull(h, x, y) ? 1 : -1;
    });
    const n = t.pts.length, ends = contact(t.pts.slice(0, END)) + (n > END ? contact(t.pts.slice(-END)) : 0);
    t.ev = 10 * ends + (moving >= 3 ? Math.min(0, (10 * inside) / moving) : 0);
    t.moving = moving;
  }
  // a hit breaks a tracklet (the velocity flips) but not the shuttle's place: tracklet b follows a when it starts
  // ≤ maxGap frames after a ends, no further than a shuttle moves in that time. A tracklet is scored by the best chain
  // through it, and one with a predecessor must take one: a lob our player just hit stays ours although it rises out
  // of the volume, and the next court's shuttle hit across our air (an oblique camera can't tell depth) stays theirs
  const ends = new Map();
  for (const t of tracks) { const e = t.pts.at(-1)[0]; (ends.get(e) ?? ends.set(e, []).get(e)).push(t); }
  for (const t of tracks) {
    const [s, x, y] = t.pts[0];
    t.prev = []; t.next ??= [];
    for (let g = 1; g <= maxGap; g++) for (const a of ends.get(s - g) || []) {
      const [, ax, ay] = a.pts.at(-1);
      if (hyp(x - ax, y - ay) <= 120 * k * g / f) { t.prev.push(a); (a.next ??= []).push(t); }
    }
  }
  const best = list => (list.length ? Math.max(...list) : 0);
  for (const t of tracks) t.fwd = t.ev + best(t.prev.map(a => a.fwd));            // tracks are in start order
  for (let n = tracks.length - 1; n >= 0; n--) tracks[n].bwd = tracks[n].ev + best(tracks[n].next.map(b => b.bwd));
  for (const t of tracks) t.chain = t.fwd + t.bwd - t.ev;
  const better = (a, b) => (a[0].chain - b[0].chain) || (a[0].moving - b[0].moving) || (a[1][2] - b[1][2]);
  return at.map(list => {
    const best = list.reduce((a, b) => (!a || better(b, a) > 0 ? b : a), null);
    return best && best[0].chain > 0 ? [best[1][0], best[1][1]] : null;
  });
}

/**
 * raw: per-frame shuttle position [x,y] | null (full-res px)
 * boxes: per-frame [[x1,y1,x2,y2,playerIdx,courtX,courtY], ...]
 * others: per-frame [[x1,y1,x2,y2], ...] people who are not our players (neighbouring courts); a shuttle nearer
 *         to one of them than to our players is theirs
 * cands: per-frame heatmap blobs [[x, y, strength], …] (optional): `raw` is then picked from them (pickShuttle)
 * toImg: court metres → image px (optional): play volume for pickShuttle
 */
export function analyzeShuttle(raw, boxes, { fps = 30, width = 1280, others = [], cands = null, toImg = null } = {}) {
  const vol = toImg ? playVolume(boxes, toImg, { fps }) : null;
  if (cands) raw = pickShuttle(cands, boxes, { fps, width, others, vol });
  const N = raw.length, k = width / 1280, f = fps / 30;
  const pos = raw.map(p => (p ? [...p] : null));

  // 1) drop isolated points and implausible jumps
  for (let i = 0; i < N; i++) {
    if (!pos[i]) continue;
    let nb = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j !== i && j >= 0 && j < N && raw[j] && hyp(raw[j][0] - raw[i][0], raw[j][1] - raw[i][1]) < 90 * k * Math.abs(j - i) / f) nb++;
    if (!nb) pos[i] = null;
  }
  // 1b) drop still blobs. A shuttle in play never stays put: TrackNet also locks onto static spots (a net-post top, a
  //     wall sign) for a few frames at a time, again and again at the same pixel, and onto a shuttle lying on the floor
  //     or held before the serve. A still run (≥ 4 frames within R px) is dropped when it lasts ≥ 0.5 s, or when
  //     still runs recur at the same spot at ≥ 2 other times (> 1 s apart)
  const R = 4 * k, runs0 = [];
  for (let i = 0; i < N; i++) {
    if (!raw[i]) continue;
    let j = i + 1;
    while (j < N && raw[j] && hyp(raw[j][0] - raw[i][0], raw[j][1] - raw[i][1]) < R) j++;
    if (j - i >= Math.round(4 * f)) { runs0.push({ s: i, e: j - 1, p: raw[i] }); i = j - 1; }
  }
  for (const r of runs0) {
    const again = runs0.filter(o => o !== r && Math.abs(o.s - r.s) > fps && hyp(o.p[0] - r.p[0], o.p[1] - r.p[1]) < 2 * R).length;
    if (r.e - r.s + 1 >= 0.5 * fps || again >= 2) for (let m = r.s; m <= r.e; m++) pos[m] = null;
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

  // 2b) drop flights that don't belong to this court: shuttles from neighbouring courts (an image region can't
  //     separate them when one court's air overlaps the next court in the image). A run (split at gaps and at
  //     jumps no shuttle makes in one frame — TrackNet switching courts) is kept when it is in our players'
  //     racket zones in more frames than in other people's (neighbouring courts; 1.2 box heights reached into
  //     the next court for near players), or — if nobody else's — when it continues a kept run within 0.5 s
  //     where that run's velocity predicts (mid-air parts after the shuttle was hidden by the hitter).
  if (boxes.some(f => f?.length)) {
    const jump = 200 * k / f, runs = [];
    for (let i = 0; i < N; i++) {
      if (!pos[i]) continue;
      let j = i, ours = 0, theirs = 0;
      do {
        const v = zoneVote(pos[j][0], pos[j][1], boxes[j], others[j]);
        if (v > 0) ours++; else if (v < 0) theirs++;
        j++;
      } while (j < N && pos[j] && hyp(pos[j][0] - pos[j - 1][0], pos[j][1] - pos[j - 1][1]) <= jump);
      runs.push({ s: i, e: j - 1, keep: ours > theirs, theirs: theirs > ours });
      i = j - 1;
    }
    // velocity at a run end (px/frame) from its last / first few frames
    const vel = (r, atEnd) => {
      const a = atEnd ? Math.max(r.s, r.e - 3) : r.s, b = atEnd ? r.e : Math.min(r.e, r.s + 3);
      return b > a ? [(pos[b][0] - pos[a][0]) / (b - a), (pos[b][1] - pos[a][1]) / (b - a)] : [0, 0];
    };
    const links = (from, to) => {        // from ends before to starts
      const g = to.s - from.e;
      if (g < 1 || g > 0.5 * fps) return false;
      const tol = (40 + 15 * g / f) * k;
      const v1 = vel(from, true), p1 = [pos[from.e][0] + v1[0] * g, pos[from.e][1] + v1[1] * g];
      const v2 = vel(to, false), p2 = [pos[to.s][0] - v2[0] * g, pos[to.s][1] - v2[1] * g];
      return hyp(p1[0] - pos[to.s][0], p1[1] - pos[to.s][1]) < tol || hyp(p2[0] - pos[from.e][0], p2[1] - pos[from.e][1]) < tol;
    };
    for (let changed = true; changed;) {
      changed = false;
      runs.forEach((r, n) => {
        if (r.keep || r.theirs) return;
        if ((runs[n - 1]?.keep && links(runs[n - 1], r)) || (runs[n + 1]?.keep && links(r, runs[n + 1]))) { r.keep = true; changed = true; }
      });
    }
    for (const r of runs) if (!r.keep) for (let m = r.s; m <= r.e; m++) pos[m] = null;
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
    else if (!pos[i - 1] && !pos[i - 2]) {
      // a new flight appearing counts only if it leaves fast or rising: a racket sends it away. Re-acquired mid-air
      // (lost at the top of a lob, then found falling slowly) or a static blob (lying shuttle, white object) is not a hit
      const m = Math.round(5 * f);
      hit = true; for (let j = 1; j <= m; j++) if (!pos[i + j]) hit = false;
      if (hit) {
        const v = vel(i, i + m);
        hit = hyp(v[0], v[1]) >= 2 * vt || v[1] <= -vt;
      }
    }
    if (hit) raw_hits.push(i);
  }
  const hits = [];
  for (const i of raw_hits) if (!hits.length || i - hits.at(-1).frame > 0.4 * fps) hits.push({ frame: i });

  // 4) hitter = nearest player box (upper body / racket zone), unless someone else (another court) is nearer
  for (const h of hits) {
    const [x, y] = pos[h.frame];
    let best = null, bd = Infinity;
    for (const b of boxes[h.frame] || []) {
      const d = zoneDist(x, y, b);
      if (d < bd) { bd = d; best = b; }
    }
    if ((others[h.frame] || []).some(b => zoneDist(x, y, b) < bd)) best = null;
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

  // 5) rallies: hits chained with gaps < 4 s and no shuttle loss > 1 s between them (between points it lies on
  //    the floor / is picked up; in play TrackNet keeps it); at least 2 hits
  const lostRun = (a, b) => { let run = 0, best = 0; for (let k = a + 1; k < b; k++) { run = pos[k] ? 0 : run + 1; if (run > best) best = run; } return best; };
  const rallies = [];
  let cur = null;
  for (const h of hits) {
    const prev = cur?.hits.at(-1).frame;
    if (cur && h.frame - prev < 4 * fps && lostRun(prev, h.frame) <= fps) cur.hits.push(h);
    else { if (cur) rallies.push(cur); cur = { hits: [h] }; }
  }
  if (cur) rallies.push(cur);
  const out = rallies.filter(r => r.hits.length >= 2).map(r => {
    const last = r.hits.at(-1).frame;
    let end = last; while (end + 1 < N && pos[end + 1] && end - last < 3 * fps) end++;
    return { start: r.hits[0].frame, end: Math.max(end, last + Math.round(0.5 * fps)), hits: r.hits, serve: r.hits[0] };
  });
  return { pos, hits, rallies: out, view: smoothPath(pos, hits, { fps, width }) };
}

/**
 * Display path for the shuttle circle. TrackNet's blob centres jitter by a few px from frame to frame (512×288
 * heatmap, the blob's shape changes), so a circle drawn on them stepped. Local quadratic fit (±h frames, tricube
 * weights) within each flight: windows stop at gaps, at jumps (TrackNet switching to another object, > 120 px/frame at
 * 1280 wide) and at hit frames (a hit stays a sharp turn; the hit frame keeps its detected point). A second pass
 * down-weights points far off the first fit (bisquare, 30 px) so a one-frame spike doesn't drag the circle.
 * Analysis (hits, speed, rallies) keeps the unsmoothed `pos`.
 */
export function smoothPath(pos, hits, { fps = 30, width = 1280, h = Math.max(2, Math.round((4 * fps) / 30)) } = {}) {
  const N = pos.length, k = width / 1280, jump = (120 * k * 30) / fps, c = 30 * k, cut = new Set(hits.map(x => x.frame));
  const near = (j, m) => hyp(pos[j][0] - pos[m][0], pos[j][1] - pos[m][1]) <= jump;
  const span = i => {
    let a = i, b = i;
    while (a > i - h && pos[a - 1] && !cut.has(a) && near(a - 1, a)) a--;
    while (b < i + h && pos[b + 1] && !cut.has(b) && near(b, b + 1)) b++;
    return [a, b];
  };
  // weighted least squares x(t) = c0 + c1·t (+ c2·t²) around t = 0; the fitted value there is c0
  const fit = (i, a, b, rw) => {
    const S = [0, 0, 0, 0, 0], X = [0, 0, 0], Y = [0, 0, 0];
    let n = 0;
    for (let j = a; j <= b; j++) {
      const t = j - i, w = (1 - Math.abs(t / (h + 1)) ** 3) ** 3 * (rw ? rw[j] : 1);
      if (w <= 0) continue;
      n++;
      for (let e = 0, tk = w; e <= 4; e++, tk *= t) { S[e] += tk; if (e <= 2) { X[e] += tk * pos[j][0]; Y[e] += tk * pos[j][1]; } }
    }
    if (n >= 5) {
      const det = S[0] * (S[2] * S[4] - S[3] * S[3]) - S[1] * (S[1] * S[4] - S[3] * S[2]) + S[2] * (S[1] * S[3] - S[2] * S[2]);
      const c0 = V => (V[0] * (S[2] * S[4] - S[3] * S[3]) - S[1] * (V[1] * S[4] - S[3] * V[2]) + S[2] * (V[1] * S[3] - S[2] * V[2])) / det;
      if (Math.abs(det) > 1e-9) return [c0(X), c0(Y)];
    }
    const det = S[0] * S[2] - S[1] * S[1];
    return n >= 3 && Math.abs(det) > 1e-9 ? [(X[0] * S[2] - X[1] * S[1]) / det, (Y[0] * S[2] - Y[1] * S[1]) / det] : null;
  };
  const spans = pos.map((p, i) => (p ? span(i) : null));
  const pass = rw => pos.map((p, i) => {
    if (!p || cut.has(i)) return p && [...p];
    const [a, b] = spans[i];
    return (b - a >= 2 && fit(i, a, b, rw)) || [...p];
  });
  const first = pass(null);
  const rw = pos.map((p, i) => {
    if (!p) return 0;
    const r = hyp(p[0] - first[i][0], p[1] - first[i][1]) / c;
    return r < 1 ? (1 - r * r) ** 2 : 0;
  });
  return pass(rw);
}

// ------------------------------------------------------------------ serves from the players (court lines)
const NET_Y = 6.7, SHORT_SERVICE = 1.98;
/**
 * Serve moments from player court positions — far more reliable than the shuttle in casual footage. Before every serve
 * the players stand still (server and receiver just behind the short service lines), then everyone starts moving.
 * A serve = the end of a quiet stretch (mean player speed < 0.35 m/s for ≥ 0.7 s; stretches < 1 s apart are merged)
 * at which someone stands within 1.8 m behind a short service line.
 * box: the service court served from, 'R' | 'L' (own right/left facing the net) by vote of the players near the short
 * lines, > 0.3 m off the centre line — server and receiver stand diagonally, i.e. both in their own right (or left)
 * court. null when they disagree. Right ⇔ the serving team's score is even.
 * boxes: per-frame [[x1,y1,x2,y2,playerIdx,courtX,courtY], ...]. Returns [{frame, quiet: [q0, q1], box}].
 * Verified by eye on the "หมู มาย vs มาร์ค กอล์ฟ" clip (serve / receive stances at the detected quiet stretches).
 */
export function detectServes(boxes, { fps = 30, quiet = 0.35, minQuiet = 0.7, line = 1.8 } = {}) {
  const N = boxes.length, h = Math.max(1, Math.round(fps / 4));
  const at = (i, p) => { const b = (boxes[i] || []).find(b => b[4] === p); return b && b.length >= 7 ? [b[5], b[6]] : null; };
  const ids = [...new Set(boxes.flatMap(f => (f || []).map(b => b[4])))];
  // mean speed of the tracked players over ±0.25 s (m/s); null with < 2 players
  const act = new Array(N).fill(null);
  for (let i = h; i < N - h; i++) {
    const v = ids.map(p => { const a = at(i - h, p), b = at(i + h, p); return a && b ? hyp(b[0] - a[0], b[1] - a[1]) / ((2 * h) / fps) : null; }).filter(x => x != null);
    if (v.length >= 2) act[i] = v.reduce((a, b) => a + b, 0) / v.length;
  }
  const nearLine = i => ids.some(p => {
    const q = at(i, p), b = q && Math.abs(q[1] - NET_Y) - SHORT_SERVICE;
    return q && b > -0.4 && b < line;
  });
  const spans = [];
  for (let i = 0; i < N; i++) {
    if (act[i] == null || act[i] >= quiet) continue;
    let j = i; while (j < N && (act[j] == null || act[j] < quiet + 0.15)) j++;      // hysteresis
    if (j - i >= minQuiet * fps && j < N - h) {                 // long enough, and play starts before the clip ends
      const last = spans.at(-1);
      if (last && i - last[1] < fps) last[1] = j; else spans.push([i, j]);
    }
    i = j;
  }
  const boxAt = i => {
    let r = 0, l = 0;
    for (const p of ids) {
      const q = at(i, p), b = q && Math.abs(q[1] - NET_Y) - SHORT_SERVICE;
      if (!q || b <= -0.4 || b >= line || Math.abs(q[0] - CW / 2) < 0.3) continue;
      if (q[1] > NET_Y ? q[0] > CW / 2 : q[0] < CW / 2) r++; else l++;
    }
    return r > l && !l ? 'R' : l > r && !r ? 'L' : null;
  };
  return spans.filter(([, b]) => nearLine(b - 1)).map(([a, b]) => ({ frame: b, quiet: [a, b], box: boxAt(b - Math.round(fps / 6)) }));
}

/**
 * Rallies from serve to serve (replaces the hit chains when serves were found). A rally starts at the serve and keeps
 * the hits chained from it (< 4 s apart, as in analyzeShuttle) before the next serve's quiet stretch; it ends 1.5 s after
 * the last of them (≥ 4 s). Hits after a break (passing the shuttle over between points) are not part of it.
 * serve = the hit within -0.5 / +1.5 s of the serve moment; if TrackNet missed that hit, the first shuttle position in
 * the window, given to the nearest player's racket zone (boxes as in analyzeShuttle).
 */
export function ralliesFromServes(an, serves, boxes, fps = 30) {
  const N = an.pos.length;
  return serves.map((sv, k) => {
    const limit = serves[k + 1] ? serves[k + 1].quiet[0] : N - 1, w0 = sv.frame - Math.round(0.5 * fps), w1 = sv.frame + Math.round(1.5 * fps);
    const hits = [];
    for (const h of an.hits) {
      if (h.frame < w0 || h.frame >= limit) continue;
      const prev = hits.at(-1)?.frame ?? sv.frame;
      if (h.frame - prev > 4 * fps) break;
      hits.push(h);
    }
    let serve = hits[0]?.frame <= w1 ? hits[0] : null;
    if (!serve) {
      for (let i = Math.max(0, w0); i <= Math.min(w1, N - 1) && !serve; i++) {
        if (!an.pos[i]) continue;
        let best = null, bd = 1.5;
        for (const b of boxes[i] || []) { const dd = zoneDist(an.pos[i][0], an.pos[i][1], b); if (dd < bd) { bd = dd; best = b; } }
        if (best) serve = { frame: i, player: best[4] ?? null, court: best.length >= 7 ? [best[5], best[6]] : null, speed: null, guessed: true };
      }
    }
    const start = Math.max(0, Math.min(serve?.frame ?? sv.frame, sv.frame));
    // TrackNet often loses the shuttle in play: at least 4 s; `limit` (next serve's quiet stretch) bounds the review clip
    const end = Math.min(limit, Math.max(hits.length ? hits.at(-1).frame + Math.round(1.5 * fps) : 0, start + 4 * fps));
    return { start, end: Math.max(end, start + 1), limit, hits, serve, box: sv.box ?? null, byServe: true };
  });
}

/**
 * Highlight reel: the `count` most exciting rallies (shots + top speed / 40), in time order, from `pad` s before the
 * serve until the shuttle is down (`downAt`), merged where they touch. count 0 = all. skip: rally indices to
 * leave out (marked "not a point" in the review). Returns [{start, end (frames), rallies: [i], shots, top (km/h | null)}].
 */
export function pickHighlights(an, { count = 5, fps = 30, pad = 1, tail = 2, skip = new Set() } = {}) {
  const N = an.pos.length, p = Math.round(pad * fps);
  const picked = an.rallies
    .map((r, i) => ({ i, r, top: Math.max(0, ...r.hits.map(h => h.speed || 0)) || null }))
    .filter(c => !skip.has(c.i))
    .sort((a, b) => b.r.hits.length + (b.top || 0) / 40 - (a.r.hits.length + (a.top || 0) / 40))
    .slice(0, count > 0 ? count : Infinity)
    .sort((a, b) => a.i - b.i);
  const clips = [];
  for (const c of picked) {
    const start = Math.max(0, c.r.start - p), end = downAt(an, c.i, fps, tail), last = clips.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end); last.rallies.push(c.i); last.shots += c.r.hits.length;
      last.top = Math.max(last.top || 0, c.top || 0) || null;
    } else clips.push({ start, end, rallies: [c.i], shots: c.r.hits.length, top: c.top });
  }
  return clips;
}

/**
 * Last frame worth showing of rally i. Clips that stopped ~1 s after the last *detected* hit ended before the shuttle was
 * down (TrackNet misses many hits, and player speed is too noisy to tell when a point is dead). Players only line up for
 * the next serve after the point, so a serve-based rally runs to the next serve's set-up (`limit`), at most `max` s.
 * Without it: follow the tracked shuttle after the last hit (gaps <= 0.7 s) to where it is lost, + `tail` s, >= 3 s
 * after the last hit, before the next rally.
 */
export function downAt(an, i, fps = 30, tail = 2, max = 25) {
  const N = an.pos.length, r = an.rallies[i];
  if (r.limit != null) return Math.max(r.end, Math.min(r.limit, r.start + max * fps, N - 1));
  const bound = Math.min(N - 1, an.rallies[i + 1] ? an.rallies[i + 1].start - 1 : N - 1);
  const from = r.hits.at(-1)?.frame ?? r.start, gap = Math.round(0.7 * fps);
  let down = from;
  for (let k = from + 1; k <= bound && k - down <= gap; k++) if (an.pos[k]) down = k;
  return Math.max(r.start + 1, Math.min(bound, Math.max(r.end, down + Math.round(tail * fps), from + 3 * fps)));
}

const posNear = (pos, f, w = 5) => {
  for (let d = 0; d <= w; d++) { const p = pos[f - d] ?? pos[f + d]; if (p) return p; }
  return null;
};
/** HUD state for frame i; badgeSecs = how long the shot-speed badge stays up after a hit (HudRenderer.badgeSecs). */
export function shuttleStateAt(an, i, fps, badgeSecs = 1) {
  const s = { pos: (an.view ?? an.pos)[i], rallyTime: null, rallyCount: null, lastSpeed: null, speedLabel: null, live: false, score: null };
  if (an.score) for (const e of an.score) { if (e.frame <= i) s.score = e; else break; }
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
      // pinned where the shot was hit (a badge following the shuttle was gone before it could be read)
      s.speedLabel = i - h.frame < badgeSecs * fps ? { speed: h.speed, age: (i - h.frame) / fps, at: posNear(an.view ?? an.pos, h.frame) } : null;
    }
  }
  return s;
}

// ------------------------------------------------------------------ scoring (rally-point, teams 'A' / 'B')
const NET = 6.7, CW = 6.1, CL = 13.4, SINGLES_IN = 0.46;
const other = t => (t === 'A' ? 'B' : t === 'B' ? 'A' : null);
const serveOf = r => (r ? r.serve ?? r.hits[0] ?? null : null);     // serve-based rallies set .serve (maybe guessed)

/**
 * What scoring needs from the config + court, kept as plain functions so this file stays pure.
 * players: cfg.players ({team, side}); toCourt(x, y) → [cx, cy] metres.
 */
export function scoreContext(players, toCourt, start = { A: 0, B: 0 }) {
  const sideTeam = {};
  for (const p of players) if (p.side && !sideTeam[p.side]) sideTeam[p.side] = p.team;
  return { teamOf: i => players[i]?.team ?? null, sideTeam, toCourt, singles: players.length <= 2, start };
}

/**
 * Guess each rally's winner, in order (keeps a running score from ctx.start). Evidence, strongest first:
 *  'box'   – the next serve's service court (court lines): right ⇔ the server's score is even. The winner serves next
 *            with score + 1, so when exactly one team's score + 1 fits the court, that team won this rally
 *  'serve' – the next rally's server's team (rally-point scoring: the winner serves next)
 *  'land'  – last shuttle position after the final hit, if the shuttle was falling into it and it maps onto the
 *            court area (± 2 m): on the floor the homography holds. A mid-air last point (TrackNet lost it, or a
 *            false static blob) maps to nonsense like 32 m and is ignored. With the last hitter known: landing on
 *            the hitter's own side (never crossed) or outside → hitter loses; inside the other side → hitter wins.
 *  'last'  – the last hitter's team loses
 * Returns [{winner: 'A'|'B'|null, by: 'box'|'serve'|'land'|'last'|null, land: [x, y]|null}] per rally.
 */
export function autoWinners(an, ctx) {
  const sc = { A: +ctx.start?.A || 0, B: +ctx.start?.B || 0 };
  return an.rallies.map((r, i) => {
    const w = guessWinner(an, ctx, r, an.rallies[i + 1], sc);
    if (w.winner) sc[w.winner]++;
    return w;
  });
}
function guessWinner(an, ctx, r, next, sc) {
  const { teamOf, sideTeam, toCourt, singles } = ctx;
  if (next?.box) {
    const fits = ['A', 'B'].filter(t => ((sc[t] + 1) % 2 === 0) === (next.box === 'R'));
    if (fits.length === 1) return { winner: fits[0], by: 'box', land: null };
  }
  const server = serveOf(next) ? teamOf(serveOf(next).player) : null;
  if (server) return { winner: server, by: 'serve', land: null };
  const lastHit = r.hits.at(-1);
  if (!lastHit) return { winner: null, by: null, land: null };
  const hitter = teamOf(lastHit.player);
  let j = r.end;
  while (j > lastHit.frame && !an.pos[j]) j--;
  // falling into the last point: image y grew over the preceding tracked frames
  let k = j;
  while (k > Math.max(lastHit.frame, j - 8) && an.pos[k - 1]) k--;
  const falling = j > lastHit.frame && an.pos[j] && an.pos[j][1] - an.pos[k][1] > 4;
  const land = falling && toCourt ? toCourt(an.pos[j][0], an.pos[j][1]) : null;
  if (land && land[0] > -2 && land[0] < CW + 2 && land[1] > -2 && land[1] < CL + 2) {
    const x0 = singles ? SINGLES_IN : 0, side = land[1] < NET ? 'far' : 'near';
    const inside = land[0] >= x0 && land[0] <= CW - x0 && land[1] >= 0 && land[1] <= CL;
    let winner;
    if (hitter) winner = sideTeam[side] === hitter || !inside ? other(hitter) : hitter;
    else winner = inside ? other(sideTeam[side]) : sideTeam[side];
    if (winner) return { winner, by: 'land', land: land.map(v => +v.toFixed(2)) };
  }
  return hitter ? { winner: other(hitter), by: 'last', land: null } : { winner: null, by: null, land: null };
}

/**
 * Running score. winners[i]: 'A'|'B'|null (null = not a point); extras: [{after: rallyIndex, winner}] for points the
 * rally detector missed (after = -1: before the first rally). Each point counts from its rally's end frame.
 * Also checks the serve court: the server stands in the right service court when their team's score is even.
 * Returns { rows: [{rally, extra, frame, winner, A, B, serveWarn}], timeline: [{frame, A, B}], final: {A, B} }.
 */
export function buildScore(an, winners, extras, start, ctx) {
  const sc = { A: +start?.A || 0, B: +start?.B || 0 };
  const rows = [], timeline = [{ frame: -1, A: sc.A, B: sc.B }];
  const point = (rally, extra, frame, winner) => {
    if (winner === 'A' || winner === 'B') sc[winner]++;
    rows.push({ rally, extra, frame, winner, A: sc.A, B: sc.B, serveWarn: false });
    timeline.push({ frame, A: sc.A, B: sc.B });
  };
  for (const e of extras.filter(e => e.after < 0)) point(-1, true, 0, e.winner);
  an.rallies.forEach((r, i) => {
    // serving team = last point's winner (rally point), else the detected server; court = detected box, else the server's spot
    const serve = serveOf(r), lastW = rows.at(-1)?.winner;
    const team = lastW === 'A' || lastW === 'B' ? lastW : serve ? ctx.teamOf(serve.player) : null;
    const right = r.box ? r.box === 'R'
      : serve?.court ? (serve.court[1] >= NET ? serve.court[0] > CW / 2 : serve.court[0] < CW / 2) : null;   // own right
    const serveWarn = !!(team && right != null && winners[i]) && right !== (sc[team] % 2 === 0);
    point(i, false, r.end, winners[i] ?? null);
    rows.at(-1).serveWarn = serveWarn;
    for (const e of extras.filter(e => e.after === i)) point(i, true, r.end, e.winner);
  });
  return { rows, timeline, final: { ...sc } };
}
