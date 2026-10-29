// Compact ByteTrack (Kalman xyah + two-stage IoU association), same defaults as ultralytics bytetrack.yaml.
const STD_POS = 1 / 20, STD_VEL = 1 / 160;
const TRACKED = 0, LOST = 1, REMOVED = 2;

function xyah([x1, y1, x2, y2]) { const w = x2 - x1, h = y2 - y1; return [x1 + w / 2, y1 + h / 2, w / Math.max(h, 1e-6), h]; }
function tlbr([cx, cy, a, h]) { const w = a * h; return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]; }
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
}
function inv4(m) {          // 4x4 inverse (Gauss-Jordan)
  const a = m.map((r, i) => [...r, ...[0, 1, 2, 3].map(j => (i === j ? 1 : 0))]);
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    [a[i], a[p]] = [a[p], a[i]];
    const d = a[i][i];
    for (let c = 0; c < 8; c++) a[i][c] /= d;
    for (let r = 0; r < 4; r++) if (r !== i) { const f = a[r][i]; for (let c = 0; c < 8; c++) a[r][c] -= f * a[i][c]; }
  }
  return a.map(r => r.slice(4));
}

class KalmanTrack {
  constructor(det) {
    const m = xyah(det.box), h = m[3];
    this.mean = [...m, 0, 0, 0, 0];
    const std = [2 * STD_POS * h, 2 * STD_POS * h, 1e-2, 2 * STD_POS * h, 10 * STD_VEL * h, 10 * STD_VEL * h, 1e-5, 10 * STD_VEL * h];
    this.cov = std.map((s, i) => std.map((_, j) => (i === j ? s * s : 0)));
    this.score = det.score;
    this.det = det;
  }
  predict() {
    const m = this.mean, P = this.cov, h = m[3];
    if (this.state !== TRACKED) m[7] = 0;
    for (let i = 0; i < 4; i++) m[i] += m[i + 4];
    // P = F P F^T + Q  with F = [[I, I], [0, I]]
    const FP = P.map((r, i) => (i < 4 ? r.map((v, j) => v + P[i + 4][j]) : r.slice()));
    const N = FP.map(r => r.map((v, j) => (j < 4 ? v + r[j + 4] : v)));
    const q = [STD_POS * h, STD_POS * h, 1e-2, STD_POS * h, STD_VEL * h, STD_VEL * h, 1e-5, STD_VEL * h];
    for (let i = 0; i < 8; i++) N[i][i] += q[i] * q[i];
    this.cov = N;
  }
  correct(det) {
    const z = xyah(det.box), m = this.mean, P = this.cov, h = m[3];
    const r = [STD_POS * h, STD_POS * h, 1e-1, STD_POS * h];
    const S = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => P[i][j] + (i === j ? r[i] * r[i] : 0)));
    const Si = inv4(S);
    const K = P.map(row => [0, 1, 2, 3].map(j => row[0] * Si[0][j] + row[1] * Si[1][j] + row[2] * Si[2][j] + row[3] * Si[3][j]));
    const y = [0, 1, 2, 3].map(i => z[i] - m[i]);
    for (let i = 0; i < 8; i++) m[i] += K[i][0] * y[0] + K[i][1] * y[1] + K[i][2] * y[2] + K[i][3] * y[3];
    // P = P - K S K^T  ==  P - K (P[:4,:])
    this.cov = P.map((row, i) => row.map((v, j) => v - (K[i][0] * P[0][j] + K[i][1] * P[1][j] + K[i][2] * P[2][j] + K[i][3] * P[3][j])));
    this.score = det.score;
    this.det = det;
  }
  get box() { return tlbr(this.mean); }
}

function greedyMatch(tracks, dets, thresh, fuseScore) {
  const pairs = [];
  tracks.forEach((t, i) => dets.forEach((d, j) => {
    let sim = iou(t.box, d.box);
    if (fuseScore) sim *= d.score;
    const cost = 1 - sim;
    if (cost <= thresh) pairs.push([cost, i, j]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const ti = new Set(), dj = new Set(), matches = [];
  for (const [, i, j] of pairs) {
    if (ti.has(i) || dj.has(j)) continue;
    ti.add(i); dj.add(j); matches.push([i, j]);
  }
  return {
    matches,
    uTracks: tracks.map((_, i) => i).filter(i => !ti.has(i)),
    uDets: dets.map((_, j) => j).filter(j => !dj.has(j)),
  };
}

export class ByteTracker {
  constructor({ high = 0.25, low = 0.1, newTrack = 0.25, buffer = 30, match = 0.8, fps = 30 } = {}) {
    Object.assign(this, { high, low, newTrack, match });
    this.maxLost = Math.round((fps / 30) * buffer);
    this.frame = 0;
    this.nextId = 1;
    this.tracks = [];
  }

  /** dets: [{box, score, ...}] → [{tid, ...det}] for active tracks updated this frame */
  update(dets) {
    this.frame++;
    const f = this.frame;
    const high = dets.filter(d => d.score >= this.high);
    const low = dets.filter(d => d.score >= this.low && d.score < this.high);

    const alive = this.tracks.filter(t => t.state !== REMOVED);
    alive.forEach(t => t.predict());
    const unconfirmed = alive.filter(t => t.state === TRACKED && !t.activated);
    const pool = alive.filter(t => t.activated);

    const act = (t, d, reactivate) => {
      t.correct(d); t.state = TRACKED; t.activated = true; t.last = f;
      if (reactivate) t.len = 0; else t.len = (t.len || 0) + 1;
    };
    // 1st association: high-score dets vs tracked+lost
    let m = greedyMatch(pool, high, this.match, true);
    m.matches.forEach(([i, j]) => act(pool[i], high[j], pool[i].state === LOST));
    const remHigh = m.uDets.map(j => high[j]);
    // 2nd association: low-score dets vs remaining tracked
    const remTracked = m.uTracks.map(i => pool[i]).filter(t => t.state === TRACKED);
    m = greedyMatch(remTracked, low, 0.5, false);
    m.matches.forEach(([i, j]) => act(remTracked[i], low[j], false));
    m.uTracks.forEach(i => { remTracked[i].state = LOST; });
    // unconfirmed vs remaining high
    m = greedyMatch(unconfirmed, remHigh, 0.7, true);
    m.matches.forEach(([i, j]) => act(unconfirmed[i], remHigh[j], false));
    m.uTracks.forEach(i => { unconfirmed[i].state = REMOVED; });
    // new tracks
    for (const j of m.uDets) {
      const d = remHigh[j];
      if (d.score < this.newTrack) continue;
      const t = new KalmanTrack(d);
      t.id = this.nextId++; t.state = TRACKED; t.activated = f === 1; t.last = f; t.len = 0;
      this.tracks.push(t);
    }
    for (const t of this.tracks) if (t.state === LOST && f - t.last > this.maxLost) t.state = REMOVED;
    this.tracks = this.tracks.filter(t => t.state !== REMOVED);
    return this.tracks.filter(t => t.state === TRACKED && t.activated && t.last === f).map(t => ({ ...t.det, tid: t.id }));
  }
}
