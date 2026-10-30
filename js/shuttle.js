// Shuttle tracking (Phase 3) with TrackNetV3 (MIT, github.com/qaz812345/TrackNetV3), gaps filled by WASB (see WasbTracker).
// Input: median background + 8 consecutive RGB frames at 512x288 → 8 heatmaps.
// analyzeShuttle(): cleans the trajectory, fills short gaps, detects hits, estimates shot speed, segments rallies.
import * as ort from 'onnxruntime-web';
import { fetchWithProgress } from './detector.js';
import { t } from './i18n.js';

export const TN_W = 512, TN_H = 288, TN_SEQ = 8;

// WebGPU's default NHWC layout gives wrong heatmaps for both shuttle models (onnxruntime-web 1.30.0): TrackNetV3's 8
// heatmaps all came out near the batch's first frame (the circle stood still, then jumped every 8 frames), WASB's
// were off too (max error 0.73 / 0.86 vs WASM). preferredLayout NCHW matches WASM exactly, ~40 % slower (~19 ms/frame
// each on this Mac). YOLO is fine with the default.
const provider = ep => (ep === 'webgpu' ? { name: 'webgpu', preferredLayout: 'NCHW' } : ep);

export class ShuttleTracker {
  static async create(url, onProgress) {
    const bytes = await fetchWithProgress(url, onProgress, t('err.shuttleFetch'));
    const errors = [];
    for (const ep of 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']) {
      try { return new ShuttleTracker(await ort.InferenceSession.create(bytes, { executionProviders: [provider(ep)] }), ep); }
      catch (e) { errors.push(`${ep}: ${e.message || e}`); }
    }
    throw new Error(t('err.shuttleOpen') + '\n' + errors.join('\n'));
  }

  constructor(session, backend) {
    this.session = session; this.backend = backend;
    this.canvas = new OffscreenCanvas(TN_W, TN_H);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.plane = TN_W * TN_H;
    this.input = new Float32Array(3 * (TN_SEQ + 1) * this.plane);
    this.queue = [];          // frame indices waiting
    this.n = 0;
  }

  /** Median background from sample frames (canvases). */
  setBackground(canvases) {
    const P = this.plane, n = canvases.length, vals = new Uint8Array(n);
    const datas = canvases.map(c => { this.ctx.drawImage(c, 0, 0, TN_W, TN_H); return this.ctx.getImageData(0, 0, TN_W, TN_H).data; });
    for (let p = 0; p < P; p++) for (let ch = 0; ch < 3; ch++) {
      for (let k = 0; k < n; k++) vals[k] = datas[k][p * 4 + ch];
      vals.sort();
      this.input[ch * P + p] = vals[n >> 1] / 255;
    }
  }

  /** Only accept shuttles inside this image polygon (full-res px), e.g. Court.airPolygon(); null = whole frame. */
  setRegion(poly, W, H) { this.mask = regionMask(poly, W, H); }

  /** Add a frame; returns [{frame, pos:[x,y]|null, cands:[[x,y,area],…]}] (full-res px) when a batch of 8 is complete. */
  async push(source, frameIndex, W, H) {
    const P = this.plane, slot = this.queue.length, off = 3 * (slot + 1) * P;
    this.ctx.drawImage(source, 0, 0, TN_W, TN_H);
    const d = this.ctx.getImageData(0, 0, TN_W, TN_H).data, inp = this.input;
    for (let p = 0, j = 0; p < P; p++, j += 4) { inp[off + p] = d[j] / 255; inp[off + P + p] = d[j + 1] / 255; inp[off + 2 * P + p] = d[j + 2] / 255; }
    this.queue.push(frameIndex);
    return this.queue.length === TN_SEQ ? this.run(W, H) : [];
  }

  /** Flush a partial batch by repeating the last frame. */
  async flush(W, H) {
    const n = this.queue.length;
    if (!n) return [];
    const P = this.plane, last = 3 * n * P;
    for (let s = n; s < TN_SEQ; s++) this.input.copyWithin(3 * (s + 1) * P, last, last + 3 * P);
    return (await this.run(W, H)).slice(0, n);
  }

  async run(W, H) {
    const frames = this.queue; this.queue = [];
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', this.input, [1, 3 * (TN_SEQ + 1), TN_H, TN_W]) });
    const hm = out[this.session.outputNames[0]].data, P = this.plane;
    const res = frames.map((f, k) => {
      const cands = blobs(hm, k * P, W / TN_W, H / TN_H, this.mask);
      return { frame: f, pos: cands[0]?.slice(0, 2) ?? null, cands };
    });
    for (const t of Object.values(out)) t.dispose?.();
    return res;
  }
}

/** polygon (full-res px) → 512x288 0/1 mask; null when no polygon */
function regionMask(poly, W, H) {
  if (!poly?.length) return null;
  const c = new OffscreenCanvas(TN_W, TN_H), g = c.getContext('2d');
  g.beginPath();
  poly.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x * TN_W / W, y * TN_H / H));
  g.fill();
  const a = g.getImageData(0, 0, TN_W, TN_H).data, mask = new Uint8Array(TN_W * TN_H);
  for (let p = 0; p < mask.length; p++) mask[p] = a[p * 4 + 3] > 127 ? 1 : 0;
  return mask;
}

// Assist model: WASB (MIT, github.com/nttcom/WASB-SBDT, BMVC 2023) — small HRNet, 3 RGB frames ImageNet-normalised
// @512x288 → 3 heatmaps; no background. Used only to fill frames where TrackNetV3 found nothing: compared by eye on
// "ต้า วา vs หมู ฟ้าช" 0–120 s it kept high lobs near the roof that TrackNetV3 lost (but hit legs / the net more often).
const WB_SEQ = 3, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
export class WasbTracker {
  static async create(url, onProgress) {
    const bytes = await fetchWithProgress(url, onProgress, t('err.shuttleFetch'));
    const errors = [];
    for (const ep of 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']) {
      try { return new WasbTracker(await ort.InferenceSession.create(bytes, { executionProviders: [provider(ep)] }), ep); }
      catch (e) { errors.push(`${ep}: ${e.message || e}`); }
    }
    throw new Error(t('err.shuttleOpen') + '\n' + errors.join('\n'));
  }

  constructor(session, backend) {
    this.session = session; this.backend = backend;
    this.canvas = new OffscreenCanvas(TN_W, TN_H);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.plane = TN_W * TN_H;
    this.input = new Float32Array(3 * WB_SEQ * this.plane);
    this.reset();
  }
  reset() { this.queue = []; this.prev = null; }
  setRegion(poly, W, H) { this.mask = regionMask(poly, W, H); }

  /** Add a frame; returns [{frame, pos:[x,y]|null, cands:[[x,y,heat],…]}] (full-res px) when a batch of 3 is complete. */
  async push(source, frameIndex, W, H) {
    const P = this.plane, off = 3 * this.queue.length * P;
    this.ctx.drawImage(source, 0, 0, TN_W, TN_H);
    const d = this.ctx.getImageData(0, 0, TN_W, TN_H).data, inp = this.input;
    for (let p = 0, j = 0; p < P; p++, j += 4) for (let ch = 0; ch < 3; ch++) inp[off + ch * P + p] = (d[j + ch] / 255 - MEAN[ch]) / STD[ch];
    this.queue.push(frameIndex);
    return this.queue.length === WB_SEQ ? this.run(W, H) : [];
  }

  async flush(W, H) {
    const n = this.queue.length;
    if (!n) return [];
    const P = this.plane, last = 3 * (n - 1) * P;
    for (let s = n; s < WB_SEQ; s++) this.input.copyWithin(3 * s * P, last, last + 3 * P);
    return (await this.run(W, H)).slice(0, n);
  }

  // WASB's online tracker: candidates within 300 px (at 1280 wide) of the previous pick, highest heat sum wins
  async run(W, H) {
    const frames = this.queue; this.queue = [];
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', this.input, [1, 3 * WB_SEQ, TN_H, TN_W]) });
    const hm = out[this.session.outputNames[0]].data, P = this.plane, gate = 300 * W / 1280;
    const res = frames.map((f, k) => {
      const all = heatBlobs(hm, k * P, W / TN_W, H / TN_H, this.mask);
      let c = all;
      if (this.prev) c = c.filter(b => Math.hypot(b.x - this.prev[0], b.y - this.prev[1]) < gate);
      const best = c.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
      this.prev = best && [best.x, best.y];
      const cands = all.sort((a, b) => b.score - a.score).slice(0, MAX_CANDS).map(b => [b.x, b.y, b.score]);
      return { frame: f, pos: this.prev, cands };
    });
    for (const o of Object.values(out)) o.dispose?.();
    return res;
  }
}

// WASB postprocess: 8-connected regions of heatmap > 0.5 → heat-weighted centre, score = heat sum; centre inside mask
function heatBlobs(hm, off, sx, sy, mask) {
  seen.fill(0);
  const res = [];
  for (let p = 0; p < TN_W * TN_H; p++) {
    if (hm[off + p] <= 0.5 || seen[p]) continue;
    let sp = 0, w = 0, wx = 0, wy = 0;
    stack[sp++] = p; seen[p] = 1;
    while (sp) {
      const q = stack[--sp], x = q % TN_W, y = (q / TN_W) | 0, v = hm[off + q];
      w += v; wx += v * x; wy += v * y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, r = ny * TN_W + nx;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= TN_W || ny >= TN_H || seen[r] || hm[off + r] <= 0.5) continue;
        seen[r] = 1; stack[sp++] = r;
      }
    }
    const cx = wx / w, cy = wy / w;
    if (mask && !mask[Math.round(cy) * TN_W + Math.round(cx)]) continue;
    res.push({ x: cx * sx, y: cy * sy, score: w });
  }
  return res;
}

// connected regions of heatmap > 0.5 → bbox center (as TrackNetV3 predict_location, which keeps only the largest),
// skipping regions whose center is outside the court mask; [[x, y, area], …] largest first, at most MAX_CANDS.
// All of them go to analyzeShuttle: when our shuttle and a neighbouring court's are both visible, the largest
// is often the wrong one.
const MAX_CANDS = 5;
const seen = new Uint8Array(TN_W * TN_H), stack = new Int32Array(TN_W * TN_H);
function blobs(hm, off, sx, sy, mask) {
  seen.fill(0);
  const res = [];
  for (let p = 0; p < TN_W * TN_H; p++) {
    if (hm[off + p] <= 0.5 || seen[p]) continue;
    let sp = 0, a = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    stack[sp++] = p; seen[p] = 1;
    while (sp) {
      const q = stack[--sp], x = q % TN_W, y = (q / TN_W) | 0; a++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const r of [q - 1, q + 1, q - TN_W, q + TN_W]) {
        if (r < 0 || r >= TN_W * TN_H || seen[r] || hm[off + r] <= 0.5) continue;
        if ((r === q - 1 && x === 0) || (r === q + 1 && x === TN_W - 1)) continue;
        seen[r] = 1; stack[sp++] = r;
      }
    }
    if (mask && !mask[((y0 + y1) >> 1) * TN_W + ((x0 + x1) >> 1)]) continue;
    res.push([((x0 + x1 + 1) / 2) * sx, ((y0 + y1 + 1) / 2) * sy, a]);
  }
  return res.sort((u, v) => v[2] - u[2]).slice(0, MAX_CANDS);
}
