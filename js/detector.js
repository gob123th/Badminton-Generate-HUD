// YOLO11-pose (ONNX, 640x640) in the browser: WebGPU first, WASM fallback.
import * as ort from 'onnxruntime-web';
import { t } from './i18n.js';

const SIZE = 640;
const NUM_ANCHORS = 8400;
const MIN_CONF = 0.1;          // keep low-score boxes for ByteTrack's second association

// Collect chunks instead of pre-sizing from content-length: hosts like GitHub Pages gzip the model,
// so content-length is the compressed size and the decoded stream is larger.
export async function fetchWithProgress(url, onProgress, errMsg = t('err.modelFetch')) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${errMsg} (${res.status}) ${url}`);
  const total = +res.headers.get('content-length') || 0;     // approximate when compressed
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) onProgress?.(Math.min(0.99, got / total));
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  onProgress?.(1);
  return buf;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
}

export class PoseDetector {
  static async create(modelUrl, onProgress) {
    const bytes = await fetchWithProgress(modelUrl, onProgress);
    const errors = [];
    const tries = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    for (const ep of tries) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        return new PoseDetector(session, ep);
      } catch (e) {
        errors.push(`${ep}: ${e.message || e}`);
      }
    }
    throw new Error(t('err.modelOpen') + '\n' + errors.join('\n'));
  }

  constructor(session, backend) {
    this.session = session;
    this.backend = backend;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.canvas = new OffscreenCanvas(SIZE, SIZE);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.input = new Float32Array(3 * SIZE * SIZE);
  }

  /**
   * source: canvas/image of size w x h. Returns [{box:[x1,y1,x2,y2], score, kps:Float32Array(51)}] in source px.
   * rois: extra [x, y, w, h] regions run zoomed in (far players are too small at 640 px), merged by NMS.
   */
  async detect(source, w, h, iouThr = 0.5, rois = []) {
    const cands = await this.infer(source, [0, 0, w, h], w, h);
    for (const r of rois) cands.push(...await this.infer(source, r, w, h));
    cands.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const c of cands) {
      if (keep.every(k => iou(k.box, c.box) < iouThr)) keep.push(c);
      if (keep.length >= 50) break;
    }
    for (const k of keep) k.box = [Math.max(0, k.box[0]), Math.max(0, k.box[1]), Math.min(w, k.box[2]), Math.min(h, k.box[3])];
    return keep;
  }

  /** one 640x640 letterboxed pass over region [rx, ry, rw, rh] of the source; candidates in source px */
  async infer(source, [rx, ry, rw, rh], w, h) {
    const s = Math.min(SIZE / rw, SIZE / rh), nw = Math.round(rw * s), nh = Math.round(rh * s);
    const px = (SIZE - nw) / 2, py = (SIZE - nh) / 2;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(source, rx, ry, rw, rh, px, py, nw, nh);
    const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data, inp = this.input, plane = SIZE * SIZE;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      inp[i] = rgba[j] / 255; inp[i + plane] = rgba[j + 1] / 255; inp[i + 2 * plane] = rgba[j + 2] / 255;
    }
    const out = await this.session.run({ [this.inputName]: new ort.Tensor('float32', inp, [1, 3, SIZE, SIZE]) });
    const o = out[this.outputName].data, N = NUM_ANCHORS;
    const X = v => (v - px) / s + rx, Y = v => (v - py) / s + ry;
    // a crop cuts people at its edges: drop boxes touching an edge that is not also the frame edge
    const E = 3 / s, cut = b => (rx > 0 && b[0] < rx + E) || (ry > 0 && b[1] < ry + E)
      || (rx + rw < w && b[2] > rx + rw - E) || (ry + rh < h && b[3] > ry + rh - E);

    const cands = [];
    for (let i = 0; i < N; i++) {
      const score = o[4 * N + i];
      if (score < MIN_CONF) continue;
      const cx = o[i], cy = o[N + i], bw = o[2 * N + i], bh = o[3 * N + i];
      const box = [X(cx - bw / 2), Y(cy - bh / 2), X(cx + bw / 2), Y(cy + bh / 2)];
      if (cut(box)) continue;
      const kps = new Float32Array(51);
      for (let j = 0; j < 17; j++) {
        kps[j * 3] = X(o[(5 + j * 3) * N + i]);
        kps[j * 3 + 1] = Y(o[(6 + j * 3) * N + i]);
        kps[j * 3 + 2] = o[(7 + j * 3) * N + i];
      }
      cands.push({ score, box, kps });
    }
    for (const t of Object.values(out)) t.dispose?.();
    return cands;
  }
}
