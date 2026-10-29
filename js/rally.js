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
    else if (!pos[i - 1] && !pos[i - 2]) { hit = true; for (let m = 1; m <= Math.round(5 * f); m++) if (!pos[i + m]) hit = false; }
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
    return { start: r.hits[0].frame, end: Math.max(end, last + Math.round(0.5 * fps)), hits: r.hits };
  });
  return { pos, hits, rallies: out };
}

/** HUD state for frame i. */
export function shuttleStateAt(an, i, fps) {
  const s = { pos: an.pos[i], trail: [], rallyTime: null, rallyCount: null, lastSpeed: null, speedLabel: null, live: false, score: null };
  if (an.score) for (const e of an.score) { if (e.frame <= i) s.score = e; else break; }
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

// ------------------------------------------------------------------ scoring (rally-point, teams 'A' / 'B')
const NET = 6.7, CW = 6.1, CL = 13.4, SINGLES_IN = 0.46;
const other = t => (t === 'A' ? 'B' : t === 'B' ? 'A' : null);

/**
 * What scoring needs from the config + court, kept as plain functions so this file stays pure.
 * players: cfg.players ({team, side}); toCourt(x, y) → [cx, cy] metres.
 */
export function scoreContext(players, toCourt) {
  const sideTeam = {};
  for (const p of players) if (p.side && !sideTeam[p.side]) sideTeam[p.side] = p.team;
  return { teamOf: i => players[i]?.team ?? null, sideTeam, toCourt, singles: players.length <= 2 };
}

/**
 * Guess each rally's winner. Evidence, strongest first:
 *  'serve' – the next rally's server's team (rally-point scoring: the winner serves next)
 *  'land'  – last shuttle position after the final hit → court (it is on the floor there, so the homography
 *            holds): inside → the other side wins; outside → the side it landed on wins
 *  'last'  – the last hitter's team loses
 * Returns [{winner: 'A'|'B'|null, by: 'serve'|'land'|'last'|null, land: [x, y]|null}] per rally.
 */
export function autoWinners(an, ctx) {
  const { teamOf, sideTeam, toCourt, singles } = ctx;
  return an.rallies.map((r, i) => {
    const next = an.rallies[i + 1];
    const server = next ? teamOf(next.hits[0].player) : null;
    if (server) return { winner: server, by: 'serve', land: null };
    let j = r.end;
    while (j > r.hits.at(-1).frame && !an.pos[j]) j--;
    if (j > r.hits.at(-1).frame && an.pos[j] && toCourt) {
      const land = toCourt(an.pos[j][0], an.pos[j][1]), x0 = singles ? SINGLES_IN : 0;
      const side = land[1] < NET ? 'far' : 'near';
      const inside = land[0] >= x0 && land[0] <= CW - x0 && land[1] >= 0 && land[1] <= CL;
      const winner = inside ? other(sideTeam[side]) : sideTeam[side];
      if (winner) return { winner, by: 'land', land: land.map(v => +v.toFixed(2)) };
    }
    const lastHitter = teamOf(r.hits.at(-1).player);
    return lastHitter ? { winner: other(lastHitter), by: 'last', land: null } : { winner: null, by: null, land: null };
  });
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
    const serve = r.hits[0], team = ctx.teamOf(serve.player);
    let serveWarn = false;
    if (team && serve.court && winners[i]) {
      const right = serve.court[1] >= NET ? serve.court[0] > CW / 2 : serve.court[0] < CW / 2;   // server's own right
      serveWarn = right !== (sc[team] % 2 === 0);
    }
    point(i, false, r.end, winners[i] ?? null);
    rows.at(-1).serveWarn = serveWarn;
    for (const e of extras.filter(e => e.after === i)) point(i, true, r.end, e.winner);
  });
  return { rows, timeline, final: { ...sc } };
}
