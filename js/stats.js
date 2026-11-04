// Distance moved (jitter-filtered) + gamified stamina; per-frame player metrics after pass 1 (pure, testable in node).
export class StatsTracker {
  constructor(cfg, players) {
    const st = cfg.stamina;
    this.start = st.start; this.drain = st.drainPerMeter; this.min = st.min;
    this.deadband = cfg.stats.deadbandM;
    this.maxSpeed = cfg.tracking.maxSpeed;
    this.dist = players.map(() => 0);
    this.anchor = [];
  }

  update(players, t) {
    for (const p of players) {
      if (!p.visible || !p.pos) continue;
      const prev = this.anchor[p.idx];
      if (!prev) { this.anchor[p.idx] = { pos: [...p.pos], t }; continue; }
      const step = Math.hypot(p.pos[0] - prev.pos[0], p.pos[1] - prev.pos[1]);
      if (step < this.deadband) continue;
      if (step / Math.max(t - prev.t, 1e-3) <= this.maxSpeed) this.dist[p.idx] += step;   // else teleport: don't count
      this.anchor[p.idx] = { pos: [...p.pos], t };
    }
  }

  distance(i) { return this.dist[i] || 0; }
  stamina(i) { return Math.min(Math.max(this.start - this.drain * this.distance(i), this.min), this.start); }
  staminaFrac(i) { return this.start ? this.stamina(i) / this.start : 0; }

  toJSON(players) {
    const out = {};
    for (const p of players) out[p.name] = { team: p.team, distance_m: +this.distance(p.idx).toFixed(2), stamina: +this.stamina(p.idx).toFixed(1) };
    return out;
  }
}

const SPEED_WINDOW = 0.5;        // s: displacement over this window, centred on the frame (one-frame speed is mostly jitter)

/**
 * Adds to every snapshot, per player: spd (m/s over the window, held while lost), top (peak so far) and rallyM (distance
 * in the current rally, the last rally's total between rallies, null before the first / without rallies).
 * snaps[f]: {t, players: [{pos, seen}], dist: [m]}; rallies: [{start, end, limit?}] in frames. Returns the summary per
 * player + rally. Speeds above maxSpeed are tracker jumps, not sprints: dropped, not capped (a cap makes them the peak).
 */
export function playerMetrics(snaps, rallies, fps, maxSpeed = 7) {
  const N = snaps.length, nP = snaps[0]?.players.length ?? 0, h = Math.max(1, Math.round((SPEED_WINDOW / 2) * fps));
  const spans = (rallies || []).map(r => ({ start: r.start, end: Math.min(r.limit ?? r.end, N - 1) }));
  for (const s of snaps) { s.spd = new Array(nP).fill(null); s.top = new Array(nP).fill(null); s.rallyM = new Array(nP).fill(null); }
  const players = [];
  for (let i = 0; i < nP; i++) {
    let held = null, top = 0, seen = 0;
    for (let f = 0; f < N; f++) {
      const a = snaps[Math.max(0, f - h)], b = snaps[Math.min(N - 1, f + h)], pa = a.players[i], pb = b.players[i];
      if (snaps[f].players[i].seen) seen++;
      if (pa.seen && pb.seen && pa.pos && pb.pos && b.t > a.t) {
        const v = Math.hypot(pb.pos[0] - pa.pos[0], pb.pos[1] - pa.pos[1]) / (b.t - a.t);
        if (v <= maxSpeed) { held = v; top = Math.max(top, v); }
      }
      snaps[f].spd[i] = held; snaps[f].top[i] = held === null ? null : top;
    }
    let k = -1;
    for (let f = 0; f < N; f++) {
      while (k + 1 < spans.length && f >= spans[k + 1].start) k++;
      if (k < 0) continue;
      const stop = Math.min(f, spans[k].end);
      snaps[f].rallyM[i] = Math.max(0, snaps[stop].dist[i] - snaps[spans[k].start].dist[i]);
    }
    const dur = N > 1 ? snaps[N - 1].t - snaps[0].t : 0, dist = snaps[N - 1]?.dist[i] ?? 0;
    players.push({ distance: dist, avg: dur > 0 ? dist / dur : 0, top, seen: N ? seen / N : 0 });
  }
  const perRally = spans.map(sp => players.map((_, i) => {
    let top = 0;
    for (let f = sp.start; f <= sp.end; f++) top = Math.max(top, snaps[f].spd[i] ?? 0);
    return { distance: snaps[sp.end].dist[i] - snaps[sp.start].dist[i], top };
  }));
  return { players, perRally, spans };
}

/** last `secs` of each player's court positions up to frame f (court-map trail); a gap in tracking breaks the line */
export function trailsAt(snaps, f, fps, secs = 1.5) {
  const n = Math.round(secs * fps), step = Math.max(1, Math.round(fps / 10));
  return snaps[f].players.map((_, i) => {
    const pts = [];
    for (let k = Math.max(0, f - n); k <= f; k += step) {
      const p = snaps[k].players[i];
      pts.push(p.seen && p.pos ? p.pos : null);
    }
    return pts;
  });
}

/** Court-position counts for a heatmap: cells of `cell` m over the court ± margin, only inside `spans` when given. */
export function positionGrid(snaps, i, spans, { cell = 0.2, margin = 1, width = 6.1, length = 13.4 } = {}) {
  const nx = Math.ceil((width + 2 * margin) / cell), ny = Math.ceil((length + 2 * margin) / cell), grid = new Float32Array(nx * ny);
  const add = f => {
    const p = snaps[f].players[i];
    if (!p.seen || !p.pos) return;
    const x = Math.floor((p.pos[0] + margin) / cell), y = Math.floor((p.pos[1] + margin) / cell);
    if (x >= 0 && x < nx && y >= 0 && y < ny) grid[y * nx + x]++;
  };
  if (spans?.length) for (const s of spans) for (let f = s.start; f <= Math.min(s.end, snaps.length - 1); f++) add(f);
  else for (let f = 0; f < snaps.length; f++) add(f);
  return { grid, nx, ny, cell, margin };
}
