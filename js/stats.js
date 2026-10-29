// Distance moved (jitter-filtered) + gamified stamina.
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
