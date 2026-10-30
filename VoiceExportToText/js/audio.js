// Decode any audio/video file to 16 kHz mono Float32 PCM.
// Streaming decode (WebCodecs via mediabunny) keeps memory low for multi-hour files;
// falls back to Web Audio decodeAudioData for anything mediabunny can't read.
import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from '../vendor/mediabunny.min.mjs';

export const SR = 16000;

class Growable {
  constructor(cap) { this.buf = new Float32Array(Math.max(cap, SR)); this.len = 0; }
  ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    const next = new Float32Array(Math.max(this.buf.length * 1.5, this.len + extra) | 0);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  push(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  result() { return this.buf.length === this.len ? this.buf : this.buf.slice(0, this.len); }
}

// Resamples a mono stream chunk-by-chunk with OfflineAudioContext (native, high quality).
// Each chunk is rendered with a small margin on both sides so chunk edges are seamless.
class ChunkResampler {
  constructor(srcRate, out) {
    this.srcRate = srcRate;
    this.out = out;
    this.ratio = SR / srcRate;
    this.chunk = Math.round(srcRate * 30);
    this.margin = Math.round(srcRate * 0.25);
    this.src = new Float32Array(this.chunk * 2 + this.margin * 4);
    this.srcLen = 0;        // samples stored in this.src
    this.srcOffset = 0;     // absolute index of this.src[0]
    this.done = 0;          // absolute native index already emitted
    this.emitted = 0;       // absolute 16 kHz samples emitted
  }
  async push(data) {
    if (this.srcLen + data.length > this.src.length) {
      const next = new Float32Array((this.srcLen + data.length) * 1.5 | 0);
      next.set(this.src.subarray(0, this.srcLen));
      this.src = next;
    }
    this.src.set(data, this.srcLen);
    this.srcLen += data.length;
    while (this.srcOffset + this.srcLen - this.done >= this.chunk + this.margin) {
      await this.render(this.done + this.chunk);
    }
  }
  async flush() {
    const end = this.srcOffset + this.srcLen;
    if (end > this.done) await this.render(end, true);
  }
  async render(end, final = false) {
    const absEnd = this.srcOffset + this.srcLen;
    const from = Math.max(this.srcOffset, this.done - this.margin);
    const to = final ? absEnd : Math.min(absEnd, end + this.margin);
    const slice = this.src.subarray(from - this.srcOffset, to - this.srcOffset);
    const outLen = Math.max(1, Math.round(slice.length * this.ratio));
    const ctx = new OfflineAudioContext(1, outLen, SR);
    const buf = ctx.createBuffer(1, slice.length, this.srcRate);
    buf.copyToChannel(slice, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.start();
    const rendered = (await ctx.startRendering()).getChannelData(0);

    const targetEnd = Math.round(end * this.ratio);
    const startIdx = Math.round((this.done - from) * this.ratio);
    const count = Math.max(0, Math.min(targetEnd - this.emitted, rendered.length - startIdx));
    this.out.push(rendered.subarray(startIdx, startIdx + count));
    this.emitted += count;
    this.done = end;

    // drop consumed samples, keep margin for the next chunk's left context
    const keepFrom = Math.max(this.srcOffset, this.done - this.margin);
    const drop = keepFrom - this.srcOffset;
    if (drop > 0) {
      this.src.copyWithin(0, drop, this.srcLen);
      this.srcLen -= drop;
      this.srcOffset = keepFrom;
    }
  }
}

async function decodeStreaming(file, onProgress) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('ไม่พบเสียงในไฟล์');
  if (!(await track.canDecode())) throw new Error(`browser ถอดรหัส codec "${track.codec}" ไม่ได้`);
  const duration = await input.computeDuration();
  const out = new Growable(Math.ceil(duration * SR) + SR);
  let resampler = null;
  let mono = new Float32Array(0);
  let plane = new Float32Array(0);

  const sink = new AudioSampleSink(track);
  for await (const s of sink.samples()) {
    try {
      const frames = s.numberOfFrames;
      const ch = s.numberOfChannels;
      if (!resampler && s.sampleRate !== SR) resampler = new ChunkResampler(s.sampleRate, out);
      if (mono.length < frames) { mono = new Float32Array(frames); plane = new Float32Array(frames); }
      const m = mono.subarray(0, frames);
      m.fill(0);
      for (let c = 0; c < ch; c++) {
        const p = plane.subarray(0, frames);
        s.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < frames; i++) m[i] += p[i];
      }
      if (ch > 1) for (let i = 0; i < frames; i++) m[i] /= ch;
      if (resampler) await resampler.push(m); else out.push(m);
      if (duration > 0) onProgress?.(Math.min(1, (s.timestamp + s.duration) / duration));
    } finally {
      s.close();
    }
  }
  if (resampler) await resampler.flush();
  return out.result();
}

async function decodeFallback(file, onProgress) {
  onProgress?.(0.1);
  const ctx = new AudioContext({ sampleRate: SR });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length, ch = buf.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    onProgress?.(1);
    return out;
  } finally {
    ctx.close();
  }
}

export async function decodeTo16kMono(file, onProgress) {
  try {
    return await decodeStreaming(file, onProgress);
  } catch (err) {
    console.warn('Streaming decode failed, falling back to decodeAudioData:', err);
    return await decodeFallback(file, onProgress);
  }
}

/** Peak-normalize to ~-1 dBFS so quiet recordings don't hurt the models. */
export function normalize(pcm) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  if (peak > 0 && (peak < 0.5 || peak > 1)) {
    const g = 0.89 / peak;
    for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
  }
  return pcm;
}
