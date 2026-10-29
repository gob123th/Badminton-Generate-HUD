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
