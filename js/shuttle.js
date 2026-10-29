// Shuttle tracking (Phase 3) with TrackNetV3 (MIT, github.com/qaz812345/TrackNetV3).
// Input: median background + 8 consecutive RGB frames at 512x288 → 8 heatmaps.
// analyzeShuttle(): cleans the trajectory, fills short gaps, detects hits, estimates shot speed, segments rallies.
import * as ort from 'onnxruntime-web';

export const TN_W = 512, TN_H = 288, TN_SEQ = 8;

export class ShuttleTracker {
  static async create(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`โหลดโมเดลลูกขนไก่ไม่สำเร็จ (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    let bytes;
    if (res.body && total) {
      const r = res.body.getReader(); bytes = new Uint8Array(total); let got = 0;
      for (;;) { const { done, value } = await r.read(); if (done) break; bytes.set(value, got); got += value.length; onProgress?.(got / total); }
    } else bytes = new Uint8Array(await res.arrayBuffer());
    const errors = [];
    for (const ep of 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']) {
      try { return new ShuttleTracker(await ort.InferenceSession.create(bytes, { executionProviders: [ep] }), ep); }
      catch (e) { errors.push(`${ep}: ${e.message || e}`); }
    }
    throw new Error('เปิดโมเดลลูกขนไก่ไม่ได้\n' + errors.join('\n'));
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

  /** Add a frame; returns [{frame, pos:[x,y]|null}] (full-res px) when a batch of 8 is complete. */
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
    const res = frames.map((f, k) => ({ frame: f, pos: blobCenter(hm, k * P, W / TN_W, H / TN_H) }));
    for (const t of Object.values(out)) t.dispose?.();
    return res;
  }
}

// largest connected region of heatmap > 0.5 → bbox center (same as TrackNetV3 predict_location)
const seen = new Uint8Array(TN_W * TN_H), stack = new Int32Array(TN_W * TN_H);
function blobCenter(hm, off, sx, sy) {
  seen.fill(0);
  let best = null, bestA = 0;
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
    if (a > bestA) { bestA = a; best = [((x0 + x1 + 1) / 2) * sx, ((y0 + y1 + 1) / 2) * sy]; }
  }
  return best;
}
