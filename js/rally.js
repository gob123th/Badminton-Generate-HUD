// Pure trajectory analysis: clean shuttle path, hits, speed estimate, rallies. No browser APIs (testable in node).
const hyp = (x, y) => Math.hypot(x, y);
/** distance from (x, y) to a player box's upper body / racket zone, in box heights */
function zoneDist(x, y, b) {
  const bh = b[3] - b[1], cx = Math.min(Math.max(x, b[0]), b[2]), cy = Math.min(Math.max(y, b[1] - 0.5 * bh), b[1] + 0.6 * bh);
  return hyp(x - cx, y - cy) / bh;
}

/**
 * raw: per-frame shuttle position [x,y] | null (full-res px)
 * boxes: per-frame [[x1,y1,x2,y2,playerIdx,courtX,courtY], ...]
 * others: per-frame [[x1,y1,x2,y2], ...] people who are not our players (neighbouring courts); a shuttle nearer
 *         to one of them than to our players is theirs
 */
export function analyzeShuttle(raw, boxes, { fps = 30, width = 1280, others = [] } = {}) {
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
  // frame i in a racket zone (0.6 box heights past the upper body ≈ arm + racket): +1 ours, -1 someone else's, 0 none
  const zoneVote = i => {
    const [x, y] = pos[i];
    const d = Math.min(Infinity, ...(boxes[i] || []).map(b => zoneDist(x, y, b)));
    const e = Math.min(Infinity, ...(others[i] || []).map(b => zoneDist(x, y, b)));
    return d < 0.6 && d <= e ? 1 : e < 0.6 && e < d ? -1 : 0;
  };
  if (boxes.some(f => f?.length)) {
    const jump = 200 * k / f, runs = [];
    for (let i = 0; i < N; i++) {
      if (!pos[i]) continue;
      let j = i, ours = 0, theirs = 0;
      do {
        const v = zoneVote(j);
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
  return { pos, hits, rallies: out };
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
 * Highlight reel: the `count` most exciting rallies (shots + top speed / 40), in time order, padded by `pad` s and
 * merged where they touch. count 0 = all. skip: rally indices to leave out (marked "not a point" in the review).
 * Returns [{start, end (frames), rallies: [i], shots, top (km/h | null)}].
 */
export function pickHighlights(an, { count = 5, fps = 30, pad = 1, skip = new Set() } = {}) {
  const N = an.pos.length, p = Math.round(pad * fps);
  const picked = an.rallies
    .map((r, i) => ({ i, r, top: Math.max(0, ...r.hits.map(h => h.speed || 0)) || null }))
    .filter(c => !skip.has(c.i))
    .sort((a, b) => b.r.hits.length + (b.top || 0) / 40 - (a.r.hits.length + (a.top || 0) / 40))
    .slice(0, count > 0 ? count : Infinity)
    .sort((a, b) => a.i - b.i);
  const clips = [];
  for (const c of picked) {
    const start = Math.max(0, c.r.start - p), end = Math.min(N - 1, c.r.end + p), last = clips.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end); last.rallies.push(c.i); last.shots += c.r.hits.length;
      last.top = Math.max(last.top || 0, c.top || 0) || null;
    } else clips.push({ start, end, rallies: [c.i], shots: c.r.hits.length, top: c.top });
  }
  return clips;
}

/** HUD state for frame i. */
export function shuttleStateAt(an, i, fps) {
  const s = { pos: an.pos[i], rallyTime: null, rallyCount: null, lastSpeed: null, speedLabel: null, live: false, score: null };
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
      s.speedLabel = i - h.frame < 1.2 * fps ? { speed: h.speed, age: (i - h.frame) / fps } : null;
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
