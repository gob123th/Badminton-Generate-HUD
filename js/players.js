// Map ByteTrack tracks to configured players: known IDs first (with jump check), then court-distance matching.
import { COURT_L, COURT_W, NET_Y } from './court.js';

const L_ANKLE = 15, R_ANKLE = 16;

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
}

export const fpsAlpha = (a30, fps) => 1 - Math.pow(1 - a30, 30 / Math.max(fps, 1));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const NET_SLACK = 0.6;           // m a player may reach past the net line (lunges / net kills)
const APP_W = 5;                 // appearance weight: (1 - similarity) * APP_W metres

/** 16-bin shirt colour histogram of the torso (black, 3 greys, 12 hues). */
export function torsoHist(ctx, box) {
  const [x1, y1, x2, y2] = box, w = x2 - x1, h = y2 - y1;
  const X = Math.max(0, Math.round(x1 + 0.25 * w)), Y = Math.max(0, Math.round(y1 + 0.18 * h));
  const RW = Math.max(2, Math.round(0.5 * w)), RH = Math.max(2, Math.round(0.32 * h));
  let data;
  try { data = ctx.getImageData(X, Y, RW, RH).data; } catch { return null; }
  const hist = new Float32Array(16);
  let n = 0;
  for (let i = 0; i < data.length; i += 8) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, s = mx ? (mx - mn) / mx : 0;
    let bin;
    if (v < 0.2) bin = 0;
    else if (s < 0.22) bin = 1 + Math.min(2, Math.floor((v - 0.2) / 0.27));
    else {
      let hh = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
      hh = (hh * 60 + 360) % 360;
      bin = 4 + Math.min(11, Math.floor(hh / 30));
    }
    hist[bin]++; n++;
  }
  if (!n) return null;
  for (let k = 0; k < 16; k++) hist[k] /= n;
  return hist;
}
const similarity = (a, b) => { let s = 0; for (let k = 0; k < 16; k++) s += Math.sqrt(a[k] * b[k]); return s; };

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
      half: (p.side || (anchors[i][1] < NET_Y ? 'far' : 'near')) === 'far' ? 0 : 1, app: null,
      anchor: seeds[i] || anchors[i],
      pos: null, head: null, box: null, trackId: null,
      visible: false, everSeen: false, lastSeen: -1e9,
    }));
    this.owner = new Map();       // track id -> player idx
    this.lastDets = [];
  }

  refPos(p) { return p.everSeen ? p.pos : p.anchor; }
  gate(p, t) { return p.everSeen ? Math.min(this.maxJump + this.maxSpeed * Math.max(t - p.lastSeen, 0), 8) : 15; }
  /** hard rule: players never change court half (end changes are not handled) */
  onSide(p, d) { return p.half === 0 ? d.court[1] < NET_Y + NET_SLACK : d.court[1] > NET_Y - NET_SLACK; }
  sim(p, d) { return p.app && d.hist ? similarity(p.app, d.hist) : null; }
  cost(p, d) {
    let c = dist(d.court, this.refPos(p));
    const s = this.sim(p, d);
    if (s !== null) c += APP_W * (1 - s);
    return c;
  }

  /** tracks: ByteTrack output; frameCtx: 2D context of the current frame (for shirt colours) */
  update(tracks, t, frameCtx = null) {
    const dets = [];
    for (const d of tracks) {
      const foot = footPoint(d), court = this.court.toCourt(foot[0], foot[1]);
      if (this.court.inPlay(court)) dets.push({ ...d, foot, court, hist: frameCtx ? torsoHist(frameCtx, d.box) : null });
    }
    this.lastDets = dets;
    const assigned = new Map(), used = new Set();

    // 1) known track ids — kept only if on the right side and not clearly someone else's shirt
    const cands = new Map();
    dets.forEach((d, di) => {
      const pi = this.owner.get(d.tid);
      if (pi === undefined) return;
      const p = this.players[pi];
      const dd = p.everSeen ? dist(d.court, p.pos) : 0;
      let ok = this.onSide(p, d) && (!p.everSeen || dd <= this.gate(p, t));
      if (ok) {
        const mine = this.sim(p, d);
        if (mine !== null) for (const q of this.players) {
          if (q === p || q.half !== p.half) continue;
          const other = this.sim(q, d);
          if (other !== null && other > mine + 0.2) { ok = false; break; }   // ByteTrack swapped partners
        }
      }
      if (!ok) { this.owner.delete(d.tid); return; }
      if (!cands.has(pi) || dd < cands.get(pi)[0]) cands.set(pi, [dd, di]);
    });
    for (const [pi, [, di]] of cands) { assigned.set(pi, di); used.add(di); }

    // 2) greedy by court distance + shirt colour, same side only
    const pairs = [];
    for (const p of this.players) {
      if (assigned.has(p.idx)) continue;
      dets.forEach((d, di) => { if (!used.has(di) && this.onSide(p, d)) pairs.push([this.cost(p, d), p.idx, di]); });
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [c, pi, di] of pairs) {
      const p = this.players[pi];
      if (assigned.has(pi) || used.has(di) || dist(dets[di].court, this.refPos(p)) > this.gate(p, t)) continue;
      assigned.set(pi, di); used.add(di);
      if (!this.owner.has(dets[di].tid)) this.owner.set(dets[di].tid, pi);
    }

    for (const p of this.players) {
      if (assigned.has(p.idx)) this.apply(p, dets[assigned.get(p.idx)], t);
      else p.visible = false;
    }
    // learn shirt colours slowly, only when the player stands clear of everyone else in the image
    for (const [pi, di] of assigned) {
      const p = this.players[pi], d = dets[di];
      if (!d.hist) continue;
      const crowded = dets.some((o, oi) => oi !== di && iou(o.box, d.box) > 0.05);
      if (crowded) continue;
      if (!p.app) p.app = Float32Array.from(d.hist);
      else for (let k = 0; k < 16; k++) p.app[k] += 0.03 * (d.hist[k] - p.app[k]);
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
