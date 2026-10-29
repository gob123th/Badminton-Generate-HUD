// YOLO11-pose (ONNX, 640x640) in the browser: WebGPU first, WASM fallback.
import * as ort from 'onnxruntime-web';

const SIZE = 640;
const NUM_ANCHORS = 8400;
const MIN_CONF = 0.1;          // keep low-score boxes for ByteTrack's second association

// Collect chunks instead of pre-sizing from content-length: hosts like GitHub Pages gzip the model,
// so content-length is the compressed size and the decoded stream is larger.
export async function fetchWithProgress(url, onProgress, errMsg = 'โหลดโมเดลไม่สำเร็จ') {
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
    throw new Error('เปิดโมเดลไม่ได้\n' + errors.join('\n'));
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

  /** source: canvas/image of size w x h. Returns [{box:[x1,y1,x2,y2], score, kps:Float32Array(51)}] in source px. */
  async detect(source, w, h, iouThr = 0.5) {
    const s = Math.min(SIZE / w, SIZE / h), nw = Math.round(w * s), nh = Math.round(h * s);
    const px = (SIZE - nw) / 2, py = (SIZE - nh) / 2;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(source, px, py, nw, nh);
    const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data, inp = this.input, plane = SIZE * SIZE;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      inp[i] = rgba[j] / 255; inp[i + plane] = rgba[j + 1] / 255; inp[i + 2 * plane] = rgba[j + 2] / 255;
    }
    const out = await this.session.run({ [this.inputName]: new ort.Tensor('float32', inp, [1, 3, SIZE, SIZE]) });
    const o = out[this.outputName].data, N = NUM_ANCHORS;

    const cands = [];
    for (let i = 0; i < N; i++) {
      const score = o[4 * N + i];
      if (score < MIN_CONF) continue;
      const cx = o[i], cy = o[N + i], bw = o[2 * N + i], bh = o[3 * N + i];
      const box = [(cx - bw / 2 - px) / s, (cy - bh / 2 - py) / s, (cx + bw / 2 - px) / s, (cy + bh / 2 - py) / s];
      cands.push({ i, score, box });
    }
    cands.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const c of cands) {
      if (keep.every(k => iou(k.box, c.box) < iouThr)) keep.push(c);
      if (keep.length >= 50) break;
    }
    for (const k of keep) {
      const kps = new Float32Array(51);
      for (let j = 0; j < 17; j++) {
        kps[j * 3] = (o[(5 + j * 3) * N + k.i] - px) / s;
        kps[j * 3 + 1] = (o[(6 + j * 3) * N + k.i] - py) / s;
        kps[j * 3 + 2] = o[(7 + j * 3) * N + k.i];
      }
      k.kps = kps;
      k.box = [Math.max(0, k.box[0]), Math.max(0, k.box[1]), Math.min(w, k.box[2]), Math.min(h, k.box[3])];
      delete k.i;
    }
    for (const t of Object.values(out)) t.dispose?.();
    return keep;
  }
}
