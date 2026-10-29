// Court geometry: homography image <-> court meters.
// Court coords (m): x = width 0..6.1 (left→right seen from near baseline), y = length 0..13.4 (far baseline → near), net y = 6.7.
export const COURT_W = 6.1;
export const COURT_L = 13.4;
export const NET_Y = COURT_L / 2;
const SHORT_SERVICE = 1.98, LONG_SERVICE_D = 0.76, SINGLES_IN = 0.46;

export function courtLines() {
  const W = COURT_W, L = COURT_L, s1 = NET_Y - SHORT_SERVICE, s2 = NET_Y + SHORT_SERVICE;
  return [
    [[0, 0], [W, 0]], [[0, L], [W, L]],
    [[0, 0], [0, L]], [[W, 0], [W, L]],
    [[SINGLES_IN, 0], [SINGLES_IN, L]], [[W - SINGLES_IN, 0], [W - SINGLES_IN, L]],
    [[0, LONG_SERVICE_D], [W, LONG_SERVICE_D]], [[0, L - LONG_SERVICE_D], [W, L - LONG_SERVICE_D]],
    [[0, s1], [W, s1]], [[0, s2], [W, s2]],
    [[W / 2, 0], [W / 2, s1]], [[W / 2, s2], [W / 2, L]],
  ];
}

/** Court-meter targets for clicked image corners TL, TR, BR, BL. */
function courtTargets(orientation) {
  const W = COURT_W, L = COURT_L;
  return orientation === 'side'
    ? [[0, 0], [0, L], [W, L], [W, 0]]
    : [[0, 0], [W, 0], [W, L], [0, L]];
}

function solve(A, b) {               // Gaussian elimination, partial pivot
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export class Court {
  constructor(corners, orientation = 'behind', marginM = 1.2) {
    this.corners = corners;
    this.orientation = orientation;
    this.margin = marginM;
    this.H = homography(corners, courtTargets(orientation));   // image -> court
    this.Hinv = invert3(this.H);                                // court -> image
  }
  toCourt(x, y) { return applyH(this.H, x, y); }
  toImg(x, y) { return applyH(this.Hinv, x, y); }
  inPlay([x, y]) {
    const m = this.margin;
    return x >= -m && x <= COURT_W + m && y >= -m && y <= COURT_L + m;
  }
  /**
   * Overlapping image tiles [x, y, w, h] over the band of the far half (+ room for a standing player above the
   * baseline), detected near native resolution: far players are ~45 px tall after the 640 px full-frame downscale
   * and YOLO misses them. The band spans the full frame width so people on neighbouring courts are found too —
   * analyzeShuttle() uses them to reject their shuttles. [] when the region is off-frame.
   */
  farTiles(W, H, size = 640, maxTiles = 4) {
    const m = this.margin, pts = [[-m, -m], [COURT_W + m, -m], [COURT_W + m, NET_Y + 1], [-m, NET_Y + 1]].map(p => this.toImg(...p));
    if (!pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return [];
    const tall = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / (COURT_W + 2 * m) * 2.4;   // ~2.4 m in px at the far baseline
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x1 = 0, x2 = W;
    const y1 = Math.max(0, Math.min(...ys) - tall), y2 = Math.min(H, Math.max(...ys) + tall * 0.2);
    if (y2 - y1 < 16 || Math.max(...xs) < 0 || Math.min(...xs) > W) return [];
    const ov = Math.min(Math.max(tall * 0.5, 64), 200);   // > a player's width, so everyone is whole in some tile
    const starts = (a, b, s) => {
      if (b - a <= s) return [a];
      const n = Math.ceil((b - a - ov) / (s - ov));
      return Array.from({ length: n }, (_, i) => a + (b - a - s) * i / (n - 1));
    };
    let s = size, tiles;
    for (;;) {   // grow tiles (= downscale) until they fit the budget, e.g. 4K video
      const sx = starts(x1, x2, s), sy = starts(y1, y2, s);
      tiles = sy.flatMap(y => sx.map(x => [x, y, Math.min(s, x2 - x), Math.min(s, y2 - y)].map(Math.round)));
      if (tiles.length <= maxTiles) return tiles;
      s *= 1.25;
    }
  }
  /**
   * Image polygon (convex hull) of the air above this court: floor + margin, lifted up to `height` m.
   * The lift uses the local px-per-metre of the floor (the less foreshortened court axis), so it is an
   * approximation without a vertical calibration. Used to ignore shuttles from neighbouring courts.
   */
  airPolygon(height = 8, margin = 1.5) {
    const m = margin, floor = [[-m, -m], [COURT_W + m, -m], [COURT_W + m, COURT_L + m], [-m, COURT_L + m]];
    const pts = [];
    for (const [x, y] of floor) {
      const p = this.toImg(x, y), ax = this.toImg(x + 1, y), ay = this.toImg(x, y + 1);
      const ppm = Math.max(Math.hypot(ax[0] - p[0], ax[1] - p[1]), Math.hypot(ay[0] - p[0], ay[1] - p[1]));
      pts.push(p, [p[0], p[1] - ppm * height]);
    }
    if (!pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);      // monotone-chain convex hull
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = list => {
      const h = [];
      for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); }
      return h.slice(0, -1);
    };
    return half(pts).concat(half([...pts].reverse()));
  }
  /** 0 = far half, 1 = near half, null = within hysteresis of the net */
  static half(p, hyst = 0) {
    const d = p[1] - NET_Y;
    if (Math.abs(d) < hyst) return null;
    return d < 0 ? 0 : 1;
  }
  drawLines(ctx, color = '#00ff66', width = 2) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
    for (const [a, b] of courtLines()) {
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {          // sampled: stays correct far outside the frame
        const t = k / 24, [x, y] = this.toImg(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
