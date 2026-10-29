// Map ByteTrack tracks to configured players: known IDs first (with jump check), then court-distance matching.
import { COURT_L, COURT_W, Court } from './court.js';

const L_ANKLE = 15, R_ANKLE = 16;

export const fpsAlpha = (a30, fps) => 1 - Math.pow(1 - a30, 30 / Math.max(fps, 1));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function footPoint(det) {
  const [x1, y1, x2, y2] = det.box;
  let foot = [(x1 + x2) / 2, y2];
  const k = det.kps;
  if (k) {
    const xs = [], ys = [];
    for (const j of [L_ANKLE, R_ANKLE]) if (k[j * 3 + 2] > 0.35) { xs.push(k[j * 3]); ys.push(k[j * 3 + 1]); }
    if (xs.length) foot = [xs.reduce((a, b) => a + b) / xs.length, Math.min(Math.max(...ys) + 0.02 * (y2 - y1), y2)];
  }
  return foot;
}

export function defaultAnchors(players) {
  const teams = [...new Set(players.map((p, i) => p.team || String(i)))];
  const groups = {};
  players.forEach((p, i) => {
    const side = p.side || (teams.indexOf(p.team || String(i)) % 2 === 0 ? 'far' : 'near');
    (groups[side] ||= []).push(i);
  });
  const anchors = [];
  for (const [side, idxs] of Object.entries(groups)) {
    const y = COURT_L * (side === 'far' ? 0.25 : 0.75);
    idxs.forEach((i, k) => { anchors[i] = [COURT_W * (k + 1) / (idxs.length + 1), y]; });
  }
  return anchors;
}

export class PlayerTracker {
  constructor(cfg, court, fps, seeds = {}) {
    this.court = court;
    const t = cfg.tracking, s = cfg.smoothing;
    this.maxSpeed = t.maxSpeed; this.maxJump = t.maxJump; this.lostTtl = t.lostTtl;
    this.aPos = fpsAlpha(s.posAlpha, fps);
    this.aTag = fpsAlpha(s.tagAlpha, fps);
    const anchors = defaultAnchors(cfg.players);
    this.players = cfg.players.map((p, i) => ({
      idx: i, name: p.name, color: p.color, team: p.team,
      anchor: seeds[i] || anchors[i],
      pos: null, head: null, box: null, trackId: null,
      visible: false, everSeen: false, lastSeen: -1e9,
    }));
    this.owner = new Map();       // track id -> player idx
    this.lastDets = [];
  }

  refPos(p) { return p.everSeen ? p.pos : p.anchor; }
  gate(p, t) { return p.everSeen ? Math.min(this.maxJump + this.maxSpeed * Math.max(t - p.lastSeen, 0), 8) : 15; }
  cost(p, d, t) {
    let c = dist(d.court, this.refPos(p));
    const recent = !p.everSeen || t - p.lastSeen < 5;
    const h = Court.half(d.court, 0.3);
    if (recent && h !== null && h !== Court.half(this.refPos(p))) c += 20;   // no net crossing mid-rally
    return c;
  }

  update(tracks, t) {
    const dets = [];
    for (const d of tracks) {
      const foot = footPoint(d), court = this.court.toCourt(foot[0], foot[1]);
      if (this.court.inPlay(court)) dets.push({ ...d, foot, court });
    }
    this.lastDets = dets;
    const assigned = new Map(), used = new Set();

    // 1) known track ids
    const cands = new Map();
    dets.forEach((d, di) => {
      const pi = this.owner.get(d.tid);
      if (pi === undefined) return;
      const p = this.players[pi];
      const dd = p.everSeen ? dist(d.court, p.pos) : 0;
      if (p.everSeen && dd > this.gate(p, t)) { this.owner.delete(d.tid); return; }   // ID switch
      if (!cands.has(pi) || dd < cands.get(pi)[0]) cands.set(pi, [dd, di]);
    });
    for (const [pi, [, di]] of cands) { assigned.set(pi, di); used.add(di); }

    // 2) greedy by court distance
    const pairs = [];
    for (const p of this.players) {
      if (assigned.has(p.idx)) continue;
      dets.forEach((d, di) => { if (!used.has(di)) pairs.push([this.cost(p, d, t), p.idx, di]); });
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [c, pi, di] of pairs) {
      if (assigned.has(pi) || used.has(di) || c > this.gate(this.players[pi], t)) continue;
      assigned.set(pi, di); used.add(di);
      if (!this.owner.has(dets[di].tid)) this.owner.set(dets[di].tid, pi);
    }

    for (const p of this.players) {
      if (assigned.has(p.idx)) this.apply(p, dets[assigned.get(p.idx)], t);
      else p.visible = false;
    }
    return this.players;
  }

  apply(p, d, t) {
    const head = [(d.box[0] + d.box[2]) / 2, d.box[1]];
    if (!p.everSeen || t - p.lastSeen > this.lostTtl * 2) {
      p.pos = [...d.court]; p.head = head;
    } else {
      p.pos = [p.pos[0] + this.aPos * (d.court[0] - p.pos[0]), p.pos[1] + this.aPos * (d.court[1] - p.pos[1])];
      p.head = [p.head[0] + this.aTag * (head[0] - p.head[0]), p.head[1] + this.aTag * (head[1] - p.head[1])];
    }
    p.box = d.box; p.trackId = d.tid;
    p.visible = true; p.everSeen = true; p.lastSeen = t;
  }

  drawable(p, t) { return p.everSeen && (p.visible || t - p.lastSeen <= this.lostTtl); }

  bindings() {
    const out = {};
    for (const [tid, pi] of [...this.owner].sort((a, b) => a[0] - b[0])) (out[this.players[pi].name] ||= []).push(tid);
    return out;
  }
}
