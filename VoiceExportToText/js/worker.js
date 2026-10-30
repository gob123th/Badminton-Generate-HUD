// Inference worker: speaker diarization (pyannote segmentation + WeSpeaker embeddings + clustering)
// followed by Thai Whisper ASR per speaker turn. Everything runs locally in the browser.
import {
  env, pipeline, AutoProcessor, AutoModel, AutoModelForAudioFrameClassification,
} from '../vendor/transformers.min.js';
import { l2normalize, clusterSpeakers, centroids, nearest } from './cluster.js';
import { DIAR_MODELS, MODELS_DIR, VENDOR_DIR } from './models.js';

// Models and ONNX runtime are served from this folder only — no network, no browser cache.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODELS_DIR;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = VENDOR_DIR;

const SR = 16000;
const SEG_MODEL = DIAR_MODELS.seg.id;
const EMB_MODEL = DIAR_MODELS.emb.id;
const WIN_SEC = 10;
// pyannote segmentation-3.0 powerset classes (max 3 local speakers, max 2 overlapping)
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (stage, value, text) => post({ type: 'progress', stage, value, text });

self.onmessage = async (e) => {
  if (e.data?.type !== 'run') return;
  try {
    await run(e.data.audio, e.data.options);
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: err?.message || String(err) });
  }
};

async function pickDevice(pref) {
  if (pref === 'wasm') return 'wasm';
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return 'webgpu';
  } catch { /* no WebGPU */ }
  if (pref === 'webgpu') throw new Error('เครื่อง/browser นี้ไม่รองรับ WebGPU — เลือกโหมด WASM แทน');
  return 'wasm';
}

function makeLoadProgress(stage, label) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      progress(stage, l / t, `${label} ${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`);
    }
  };
}

async function run(audio, opt) {
  const total = audio.length / SR;
  const device = await pickDevice(opt.device);
  post({ type: 'info', device });

  // ---------------- 1) Diarization ----------------
  progress('load-diar', 0, 'กำลังโหลดโมเดลแยกผู้พูด');
  const segProc = await AutoProcessor.from_pretrained(SEG_MODEL);
  const segModel = await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, {
    device: 'wasm', dtype: 'fp32', progress_callback: makeLoadProgress('load-diar', 'โมเดลแยกผู้พูด'),
  });
  const embProc = await AutoProcessor.from_pretrained(EMB_MODEL);
  const embModel = await AutoModel.from_pretrained(EMB_MODEL, {
    device: 'wasm', dtype: 'fp32', progress_callback: makeLoadProgress('load-diar', 'โมเดลเสียงผู้พูด'),
  });
  progress('load-diar', 1, 'โหลดโมเดลแยกผู้พูดแล้ว');

  // 1a) local segmentation per 10 s window
  const winLen = WIN_SEC * SR;
  const nWin = Math.ceil(audio.length / winLen);
  const atoms = [];           // { start, end, win, locals: number[] }
  const padded = new Float32Array(winLen);
  for (let w = 0; w < nWin; w++) {
    const s0 = w * winLen;
    const chunk = audio.subarray(s0, Math.min(s0 + winLen, audio.length));
    padded.fill(0);
    padded.set(chunk);
    const { logits } = await segModel(await segProc(padded));
    const segs = segProc.post_process_speaker_diarization(logits, winLen)[0];
    const winEnd = (s0 + chunk.length) / SR;
    for (const sg of segs) {
      const locals = POWERSET[sg.id] || [];
      if (!locals.length) continue;
      const start = s0 / SR + sg.start;
      const end = Math.min(s0 / SR + sg.end, winEnd);
      if (end - start < 0.08) continue;
      atoms.push({ start, end, win: w, locals });
    }
    if (w % 5 === 0) progress('diar', 0.45 * (w + 1) / nWin, `วิเคราะห์ช่วงเสียงพูด ${fmt(Math.min((w + 1) * WIN_SEC, total))} / ${fmt(total)}`);
  }
  await segModel.dispose?.();

  if (!atoms.length) throw new Error('ไม่พบเสียงพูดในไฟล์นี้');

  // 1b) group single-speaker atoms by (window, local speaker) and embed each group
  const groups = new Map();   // key -> { key, intervals: [[s,e]], dur }
  for (const a of atoms) {
    if (a.locals.length !== 1) continue;
    const key = `${a.win}:${a.locals[0]}`;
    if (!groups.has(key)) groups.set(key, { key, intervals: [], dur: 0, first: a.start });
    const g = groups.get(key);
    g.intervals.push([a.start, a.end]);
    g.dur += a.end - a.start;
  }
  const glist = [...groups.values()].sort((x, y) => x.first - y.first);
  const embedded = [];
  let done = 0;
  for (const g of glist) {
    done++;
    if (g.dur < 0.3) continue;
    const pcm = gather(audio, g.intervals);
    if (pcm.length < SR * 0.3) continue;
    const inputs = await embProc(pcm);
    const out = await embModel(inputs);
    const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
    g.emb = l2normalize(t.data);
    embedded.push(g);
    if (done % 10 === 0) progress('diar', 0.45 + 0.5 * done / glist.length, `สกัดลักษณะเสียง ${done} / ${glist.length} ช่วง`);
  }
  await embModel.dispose?.();
  if (!embedded.length) throw new Error('ช่วงเสียงพูดสั้นเกินไปสำหรับการแยกผู้พูด');

  // 1c) cluster reliable (longer) groups, then attach short ones to the nearest centroid
  let reliable = embedded.filter((g) => g.dur >= 1.0);
  if (reliable.length < 2) reliable = embedded;
  const auto = opt.autoSpeakers;
  const { labels, count } = clusterSpeakers(
    reliable.map((g) => g.emb), reliable.map((g) => g.dur),
    {
      threshold: opt.threshold,
      minSpeakers: auto ? 1 : opt.minSpeakers,
      maxSpeakers: auto ? 20 : opt.maxSpeakers,
    },
  );
  reliable.forEach((g, i) => { g.spk = labels[i]; });
  const C = centroids(reliable.map((g) => g.emb), labels, count, reliable.map((g) => g.dur));
  for (const g of embedded) if (g.spk == null) g.spk = nearest(g.emb, C);

  // 1d) label atoms → turns
  let prevSpk = null;
  const labeled = [];
  for (const a of atoms) {
    let spk = null;
    if (a.locals.length === 1) {
      spk = groups.get(`${a.win}:${a.locals[0]}`)?.spk ?? null;
    } else {
      const cands = a.locals.map((l) => groups.get(`${a.win}:${l}`)?.spk).filter((v) => v != null);
      spk = cands.includes(prevSpk) ? prevSpk : (cands[0] ?? null);
    }
    if (spk == null) spk = prevSpk;  // too short to identify: continue previous speaker
    if (spk == null) continue;
    labeled.push({ start: a.start, end: a.end, spk });
    prevSpk = spk;
  }
  labeled.sort((x, y) => x.start - y.start);
  const turns = [];
  for (const a of labeled) {
    const last = turns[turns.length - 1];
    if (last && last.spk === a.spk && a.start - last.end <= 0.8) {
      last.end = Math.max(last.end, a.end);
    } else if (last && a.start < last.end) {
      // overlapping different speakers: start new turn after the current one
      if (a.end > last.end + 0.25) turns.push({ start: last.end, end: a.end, spk: a.spk });
    } else {
      turns.push({ start: a.start, end: a.end, spk: a.spk });
    }
  }
  // fold very short turns into the neighbour
  const cleaned = [];
  for (const t of turns) {
    if (t.end - t.start < 0.3 && cleaned.length) { cleaned[cleaned.length - 1].end = Math.max(cleaned[cleaned.length - 1].end, t.end); continue; }
    const last = cleaned[cleaned.length - 1];
    if (last && last.spk === t.spk && t.start - last.end <= 0.8) last.end = t.end; else cleaned.push(t);
  }
  // renumber speakers by first appearance
  const order = new Map();
  for (const t of cleaned) if (!order.has(t.spk)) order.set(t.spk, order.size);
  cleaned.forEach((t, i) => { t.id = i; t.spk = order.get(t.spk); });
  post({ type: 'diarized', turns: cleaned, speakerCount: order.size });
  progress('diar', 1, `พบผู้พูด ${order.size} คน · ${cleaned.length} ช่วงบทสนทนา`);

  // ---------------- 2) ASR ----------------
  const preset = opt.asr;
  progress('load-asr', 0, 'กำลังโหลดโมเดลถอดเสียง');
  const dtype = device === 'webgpu' ? preset.webgpu : preset.wasm;
  const asr = await pipeline('automatic-speech-recognition', preset.id, {
    device, dtype, progress_callback: makeLoadProgress('load-asr', 'โมเดลถอดเสียง'),
  });
  progress('load-asr', 1, 'โหลดโมเดลถอดเสียงแล้ว');

  const speechTotal = cleaned.reduce((s, t) => s + (t.end - t.start), 0);
  let speechDone = 0;
  const t0 = performance.now();
  let garbled = 0;
  for (const turn of cleaned) {
    const pieces = splitTurn(audio, turn.start, turn.end);
    const texts = [];
    for (const [s, e] of pieces) {
      const ps = Math.max(0, Math.floor((s - 0.15) * SR));
      const pe = Math.min(audio.length, Math.ceil((e + 0.15) * SR));
      const pcm = audio.slice(ps, pe);
      if (rms(pcm) < 0.003) continue;
      const out = await asr(pcm, {
        language: opt.language || 'thai',
        task: 'transcribe',
        max_new_tokens: 220,
      });
      const txt = cleanText(out.text, e - s);
      if (isGarbled(txt)) garbled++;
      if (txt) texts.push(txt);
    }
    speechDone += turn.end - turn.start;
    const elapsed = (performance.now() - t0) / 1000;
    const eta = speechDone > 0 ? elapsed * (speechTotal - speechDone) / speechDone : 0;
    post({ type: 'text', id: turn.id, text: texts.join(' ') });
    progress('asr', speechDone / speechTotal, `ถอดเสียง ${fmt(turn.end)} / ${fmt(total)} · เหลือประมาณ ${fmt(eta)}`);
    if (garbled >= 3 && turn.id < 15) post({ type: 'warn', message: 'ผลถอดเสียงดูผิดปกติ (อาจเป็นปัญหา WebGPU บนการ์ดจอนี้) — ลองเปลี่ยนโหมดประมวลผลเป็น WASM' });
  }
  await asr.dispose?.();
  post({ type: 'done' });
}

// ---------- helpers ----------
function gather(audio, intervals) {
  const parts = [];
  let n = 0;
  for (const [s, e] of intervals) {
    let a = Math.floor(s * SR), b = Math.ceil(e * SR);
    if (b - a > SR * 0.4) { a += SR * 0.04; b -= SR * 0.04; }   // trim edges (boundary bleed)
    a = Math.max(0, a | 0); b = Math.min(audio.length, b | 0);
    if (b > a) { parts.push(audio.subarray(a, b)); n += b - a; }
  }
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

/** Split a turn into ≤28 s pieces, cutting at the quietest 100 ms frame between 15 s and 28 s. */
function splitTurn(audio, start, end) {
  const out = [];
  let s = start;
  while (end - s > 28) {
    const lo = Math.floor((s + 15) * SR), hi = Math.floor((s + 28) * SR), step = SR / 10;
    let best = hi, bestE = Infinity;
    for (let i = lo; i + step <= hi; i += step) {
      const e = rms(audio.subarray(i, i + step));
      if (e < bestE) { bestE = e; best = i + step / 2; }
    }
    out.push([s, best / SR]);
    s = best / SR;
  }
  out.push([s, end]);
  return out;
}

const HALLUCINATIONS = [
  /^ขอบคุณ(ที่|สำหรับการ)รับชม.*$/, /^ซับไตเติ้ล.*$/, /^โปรดติดตามตอนต่อไป.*$/, /^กด(ไลค์|ติดตาม|subscribe).*$/i,
  /^(thank you|thanks) for watching.*$/i, /^subtitles? by.*$/i, /^\[.*\]$/, /^\(.*\)$/, /^♪+$/,
];
function cleanText(text, dur) {
  let t = (text || '').trim();
  // collapse looping repetitions (a classic Whisper failure)
  t = t.replace(/(.{2,40}?)(?:\s*\1){3,}/g, '$1');
  if (dur < 4 && HALLUCINATIONS.some((r) => r.test(t))) return '';
  return t;
}
function isGarbled(t) {
  if (!t) return false;
  return /^(.)\1{8,}$/.test(t.replace(/\s/g, '')) || /[!]{6,}/.test(t);
}

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
