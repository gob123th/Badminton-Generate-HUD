import { decodeTo16kMono, normalize, SR } from './audio.js';
import { toTxt, toSrt, toDoc, download, fmtTime, paragraphs } from './export.js';
import { ASR_MODELS, DIAR_MODELS, missingFiles } from './models.js';

// ---------- config ----------
const MODELS = ASR_MODELS;
const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f', '#9333ea', '#0f766e'];
const STORE_KEY = 'voice2text:last';

// ---------- dom ----------
const $ = (s) => document.querySelector(s);
const el = {
  file: $('#fileInput'), drop: $('#dropZone'), dropText: $('#dropText'), dropSub: $('#dropSub'),
  model: $('#modelSelect'), modelHint: $('#modelHint'), device: $('#deviceSelect'),
  rangeRow: $('#rangeRow'), minSpk: $('#minSpk'), maxSpk: $('#maxSpk'),
  thr: $('#threshold'), thrVal: $('#thrVal'), custom: $('#customModel'),
  start: $('#startBtn'), cancel: $('#cancelBtn'), restore: $('#restoreBtn'), project: $('#projectInput'),
  progressCard: $('#progressCard'), steps: $('#steps'), warn: $('#warnBox'),
  result: $('#resultCard'), title: $('#resultTitle'), meta: $('#resultMeta'),
  speakers: $('#speakers'), transcript: $('#transcript'), search: $('#searchBox'), follow: $('#followChk'),
  player: $('#player'), audio: $('#audio'), rate: $('#rate'), attach: $('#attachAudio'),
  env: $('#envBadge'), toast: $('#toast'), copy: $('#copyBtn'),
};

let file = null;
let worker = null;
let state = null;     // { fileName, duration, speakers:[{id,name,color}], turns:[{id,start,end,spk,text,pending}] }
let audioUrl = null;

// ---------- init ----------
if (location.protocol === 'file:') $('#fileBanner').hidden = false;
for (const m of MODELS) el.model.add(new Option(m.label, m.key));
el.model.onchange = checkModels;
el.device.onchange = checkModels;
let modelsReady = false;
let gpuAvailable = false;

// Verify the selected models exist under ./models before allowing a run.
async function checkModels() {
  const m = MODELS.find((x) => x.key === el.model.value);
  el.modelHint.textContent = m.hint;
  el.modelHint.classList.remove('bad');
  if (location.protocol === 'file:') return;
  const dev = el.device.value === 'wasm' || (el.device.value === 'auto' && !gpuAvailable) ? 'wasm' : 'webgpu';
  const custom = el.custom.value.trim();
  const checks = [
    [DIAR_MODELS.seg.id, DIAR_MODELS.seg.files],
    [DIAR_MODELS.emb.id, DIAR_MODELS.emb.files],
    custom ? [custom, ['config.json']] : [m.id, [...m.files.common, ...m.files[dev]]],
  ];
  const missing = [];
  for (const [id, files] of checks) (await missingFiles(id, files)).forEach((f) => missing.push(`${id}/${f}`));
  modelsReady = missing.length === 0;
  if (!modelsReady) {
    el.modelHint.textContent = `ไม่พบไฟล์โมเดล ${missing.length} ไฟล์ใน models/ — ดับเบิลคลิก download-models.command ก่อน (เช่น ${missing[0]})`;
    el.modelHint.classList.add('bad');
  }
  el.start.disabled = !file || !modelsReady || !!worker;
}
el.custom.onchange = checkModels;
el.thr.oninput = () => { el.thrVal.textContent = (+el.thr.value).toFixed(2); };
document.querySelectorAll('input[name=spkMode]').forEach((r) => r.onchange = () => {
  el.rangeRow.hidden = document.querySelector('input[name=spkMode]:checked').value !== 'range';
});
(async () => {
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { /* ignore */ }
  gpuAvailable = gpu;
  el.env.textContent = gpu ? 'WebGPU พร้อม' : 'ไม่มี WebGPU · ใช้ CPU';
  el.env.classList.add(gpu ? 'ok' : 'slow');
  checkModels();
})();
try { if (localStorage.getItem(STORE_KEY)) el.restore.hidden = false; } catch { /* storage blocked */ }

// ---------- file selection ----------
function setFile(f) {
  if (!f) return;
  file = f;
  el.dropText.textContent = f.name;
  el.dropSub.textContent = `${(f.size / 1048576).toFixed(1)} MB`;
  el.drop.classList.add('has-file');
  el.start.disabled = !modelsReady;
  setAudioSource(f);
}
el.file.onchange = () => setFile(el.file.files[0]);
['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

function setAudioSource(f) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(f);
  el.audio.src = audioUrl;
  el.player.hidden = false;
  el.attach.hidden = true;
}
el.rate.onchange = () => { el.audio.playbackRate = +el.rate.value; };
el.attach.querySelector('input').onchange = (e) => setAudioSource(e.target.files[0]);

// ---------- run ----------
el.start.onclick = start;
el.cancel.onclick = () => {
  stopWorker();
  setRunning(false);
  toast('ยกเลิกแล้ว');
};

function setRunning(on) {
  el.start.disabled = on || !file || !modelsReady;
  el.cancel.hidden = !on;
  el.model.disabled = el.device.disabled = on;
}
function stopWorker() { worker?.terminate(); worker = null; }

async function start() {
  if (!file) return;
  stopWorker();
  setRunning(true);
  resetSteps();
  el.progressCard.hidden = false;
  el.warn.hidden = true;
  el.progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const preset = { ...MODELS.find((m) => m.key === el.model.value) };
  const custom = el.custom.value.trim();
  if (custom) Object.assign(preset, { id: custom, webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, wasm: 'q8' });
  delete preset.files;
  const auto = document.querySelector('input[name=spkMode]:checked').value === 'auto';
  const minSpeakers = Math.max(1, +el.minSpk.value || 1);
  const maxSpeakers = Math.max(minSpeakers, +el.maxSpk.value || minSpeakers);

  let pcm;
  try {
    stage('decode', 0, 'กำลังอ่านไฟล์…');
    pcm = normalize(await decodeTo16kMono(file, (p) => stage('decode', p, `${Math.round(p * 100)}%`)));
    stage('decode', 1, `ความยาว ${fmtTime(pcm.length / SR)}`);
  } catch (err) {
    fail(`อ่านไฟล์เสียงไม่ได้: ${err.message}`);
    return;
  }

  state = { fileName: file.name, duration: pcm.length / SR, speakers: [], turns: [], model: preset.id, createdAt: new Date().toISOString() };

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => fail(e.message || 'worker error');
  worker.onmessage = ({ data: m }) => {
    switch (m.type) {
      case 'progress': stage(m.stage, m.value, m.text); break;
      case 'info': el.env.textContent = m.device === 'webgpu' ? 'กำลังใช้ WebGPU' : 'กำลังใช้ CPU (WASM)'; break;
      case 'warn': el.warn.textContent = m.message; el.warn.hidden = false; break;
      case 'diarized':
        state.speakers = Array.from({ length: m.speakerCount }, (_, i) => ({ id: i, name: `ผู้พูด ${i + 1}`, color: COLORS[i % COLORS.length] }));
        state.turns = m.turns.map((t) => ({ ...t, text: '', pending: true }));
        showResult();
        break;
      case 'text': {
        const t = state.turns[m.id];
        if (!t) break;
        t.text = m.text; t.pending = false;
        updateTurnText(t);
        saveSoon();
        break;
      }
      case 'done':
        state.turns.forEach((t) => { t.pending = false; });
        renderTranscript();
        save();
        setRunning(false);
        stopWorker();
        toast('ถอดเสียงเสร็จแล้ว');
        break;
      case 'error': fail(m.message); break;
    }
  };
  const options = {
    device: el.device.value, asr: preset, language: 'thai', threshold: +el.thr.value,
    autoSpeakers: auto, minSpeakers, maxSpeakers,
  };
  worker.postMessage({ type: 'run', audio: pcm, options }, [pcm.buffer]);
}

function fail(msg) {
  console.error(msg);
  el.warn.textContent = `เกิดข้อผิดพลาด: ${msg}`;
  el.warn.hidden = false;
  el.steps.querySelector('li.active')?.classList.add('error');
  setRunning(false);
  stopWorker();
}

// ---------- progress ----------
const ORDER = ['decode', 'load-diar', 'diar', 'load-asr', 'asr'];
function resetSteps() {
  el.steps.querySelectorAll('li').forEach((li) => {
    li.className = '';
    li.querySelector('i').style.width = '0';
    li.querySelector('small').textContent = '';
  });
}
function stage(name, value, text) {
  const idx = ORDER.indexOf(name);
  el.steps.querySelectorAll('li').forEach((li, i) => {
    if (i < idx) { li.classList.add('done'); li.classList.remove('active'); li.querySelector('i').style.width = '100%'; }
  });
  const li = el.steps.querySelector(`li[data-stage="${name}"]`);
  if (!li) return;
  li.classList.add('active');
  li.querySelector('i').style.width = `${Math.round(Math.min(1, value) * 100)}%`;
  if (text) li.querySelector('small').textContent = text;
  if (value >= 1 && name !== 'asr') { li.classList.add('done'); li.classList.remove('active'); }
  if (value >= 1 && name === 'asr') li.classList.add('done');
}

// ---------- result rendering ----------
function showResult() {
  el.result.hidden = false;
  el.title.textContent = state.fileName || 'บทสนทนา';
  renderSpeakers();
  renderTranscript();
}

function renderMeta() {
  const words = state.turns.reduce((n, t) => n + (t.text ? t.text.length : 0), 0);
  el.meta.textContent = `ผู้พูด ${state.speakers.length} คน · ${state.turns.length} ช่วง · ความยาว ${fmtTime(state.duration)} · ${words.toLocaleString()} ตัวอักษร`;
}

function speakerOf(id) { return state.speakers.find((s) => s.id === id) || { id, name: `ผู้พูด ${id + 1}`, color: '#666' }; }

function renderSpeakers() {
  el.speakers.innerHTML = '';
  for (const sp of state.speakers) {
    const talk = state.turns.filter((t) => t.spk === sp.id).reduce((s, t) => s + t.end - t.start, 0);
    const chip = document.createElement('div');
    chip.className = 'spk-chip';
    chip.style.setProperty('--c', sp.color);
    chip.innerHTML = `
      <span class="swatch"></span>
      <input class="spk-name" value="" aria-label="ชื่อผู้พูด">
      <span class="spk-time" title="เวลาพูดรวม">${fmtTime(talk)}</span>
      <select class="spk-merge" title="รวมผู้พูดนี้เข้ากับคนอื่น"><option value="">รวมกับ…</option></select>`;
    const name = chip.querySelector('.spk-name');
    name.value = sp.name;
    name.oninput = () => { sp.name = name.value || `ผู้พูด ${sp.id + 1}`; refreshBadges(); saveSoon(); };
    const merge = chip.querySelector('.spk-merge');
    for (const o of state.speakers) if (o.id !== sp.id) merge.add(new Option(o.name, o.id));
    merge.onchange = () => {
      const to = +merge.value;
      if (merge.value === '') return;
      state.turns.forEach((t) => { if (t.spk === sp.id) t.spk = to; });
      state.speakers = state.speakers.filter((s) => s.id !== sp.id);
      renderSpeakers(); renderTranscript(); save();
      toast(`รวม "${sp.name}" เข้ากับ "${speakerOf(to).name}" แล้ว`);
    };
    el.speakers.appendChild(chip);
  }
  renderMeta();
}

function renderTranscript() {
  const q = el.search.value.trim();
  const frag = document.createDocumentFragment();
  let prevSpk = null;
  for (const t of state.turns) {
    const row = document.createElement('div');
    row.className = 'turn';
    row.dataset.id = t.id;
    if (t.spk === prevSpk) row.classList.add('cont');
    prevSpk = t.spk;
    const sp = speakerOf(t.spk);
    row.style.setProperty('--c', sp.color);
    row.innerHTML = `
      <div class="turn-side">
        <button class="badge" title="เปลี่ยนผู้พูด"></button>
        <button class="time" title="เล่นจากตรงนี้">${fmtTime(t.start)}</button>
      </div>
      <div class="text" contenteditable="${t.pending ? 'false' : 'true'}" spellcheck="false"></div>`;
    row.querySelector('.badge').textContent = sp.name;
    const txt = row.querySelector('.text');
    if (t.pending) { txt.classList.add('pending'); txt.textContent = 'กำลังถอดเสียง…'; } else txt.textContent = t.text || '';
    if (q && !(t.text || '').includes(q)) row.hidden = true;
    frag.appendChild(row);
  }
  el.transcript.replaceChildren(frag);
  renderMeta();
}

function updateTurnText(t) {
  const row = el.transcript.querySelector(`.turn[data-id="${t.id}"]`);
  if (!row) return;
  const txt = row.querySelector('.text');
  txt.classList.remove('pending');
  txt.contentEditable = 'true';
  txt.textContent = t.text || '';
  if (!t.text) row.classList.add('empty');
  if (t.id % 20 === 0) renderMeta();
}

function refreshBadges() {
  el.transcript.querySelectorAll('.turn').forEach((row) => {
    const t = state.turns[+row.dataset.id];
    const sp = speakerOf(t.spk);
    row.querySelector('.badge').textContent = sp.name;
    row.style.setProperty('--c', sp.color);
  });
  el.speakers.querySelectorAll('.spk-merge').forEach((sel) => {
    [...sel.options].forEach((o) => { if (o.value !== '') o.text = speakerOf(+o.value).name; });
  });
}

// transcript interactions (event delegation)
el.transcript.addEventListener('click', (e) => {
  const row = e.target.closest('.turn');
  if (!row) return;
  const t = state.turns[+row.dataset.id];
  if (e.target.closest('.time')) { playFrom(t.start); return; }
  if (e.target.closest('.badge')) { openSpeakerMenu(e.target.closest('.badge'), t); }
});
el.transcript.addEventListener('input', (e) => {
  const row = e.target.closest('.turn');
  if (!row || !e.target.classList.contains('text')) return;
  state.turns[+row.dataset.id].text = e.target.textContent;
  saveSoon();
});
el.search.oninput = () => renderTranscript();

function openSpeakerMenu(anchor, turn) {
  document.querySelector('.menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'menu';
  for (const sp of state.speakers) {
    const b = document.createElement('button');
    b.textContent = sp.name;
    b.style.setProperty('--c', sp.color);
    if (sp.id === turn.spk) b.classList.add('current');
    b.onclick = () => { turn.spk = sp.id; finish(); };
    menu.appendChild(b);
  }
  const add = document.createElement('button');
  add.textContent = '+ ผู้พูดใหม่';
  add.className = 'add';
  add.onclick = () => {
    const id = Math.max(-1, ...state.speakers.map((s) => s.id)) + 1;
    state.speakers.push({ id, name: `ผู้พูด ${id + 1}`, color: COLORS[id % COLORS.length] });
    turn.spk = id;
    finish();
  };
  menu.appendChild(add);
  function finish() { menu.remove(); renderSpeakers(); renderTranscript(); save(); }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${window.scrollY + r.bottom + 4}px`;
  menu.style.left = `${Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 12)}px`;
  setTimeout(() => document.addEventListener('click', function close(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
  }), 0);
}

// ---------- playback ----------
function playFrom(sec) {
  if (!el.audio.src) { toast('เลือกไฟล์เสียงเพื่อฟังก่อน'); el.attach.hidden = false; el.player.hidden = false; return; }
  el.audio.currentTime = Math.max(0, sec - 0.1);
  el.audio.play();
}
let playingId = -1;
el.audio.addEventListener('timeupdate', () => {
  if (!state?.turns.length) return;
  const now = el.audio.currentTime;
  let lo = 0, hi = state.turns.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = state.turns[mid];
    if (now < t.start) hi = mid - 1;
    else if (now > t.end + 0.3) lo = mid + 1;
    else { found = mid; break; }
  }
  if (found === playingId) return;
  el.transcript.querySelector('.turn.playing')?.classList.remove('playing');
  playingId = found;
  if (found < 0) return;
  const row = el.transcript.querySelector(`.turn[data-id="${state.turns[found].id}"]`);
  row?.classList.add('playing');
  if (el.follow.checked && row && !el.audio.paused && document.activeElement?.contentEditable !== 'true') {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

// ---------- export / persistence ----------
document.querySelectorAll('[data-export]').forEach((b) => b.onclick = () => {
  if (!state) return;
  const base = (state.fileName || 'transcript').replace(/\.[^.]+$/, '');
  const kind = b.dataset.export;
  if (kind === 'txt') download(`${base}.txt`, toTxt(state), 'text/plain');
  if (kind === 'srt') download(`${base}.srt`, toSrt(state), 'text/plain');
  if (kind === 'doc') download(`${base}.doc`, toDoc(state), 'application/msword');
  if (kind === 'json') download(`${base}.transcript.json`, JSON.stringify(state, null, 1), 'application/json');
});
el.copy.onclick = async () => {
  if (!state) return;
  const text = paragraphs(state).map((p) => `${speakerOf(p.spk).name}: ${p.text}`).join('\n\n');
  try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว'); } catch { toast('คัดลอกไม่สำเร็จ'); }
};

let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 800); }
function save() {
  if (!state) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota / blocked */ }
}
function loadProject(obj) {
  if (!obj || !Array.isArray(obj.turns) || !Array.isArray(obj.speakers)) { toast('ไฟล์โปรเจกต์ไม่ถูกต้อง'); return; }
  obj.turns.forEach((t, i) => { t.id = i; t.pending = false; });
  state = obj;
  showResult();
  if (!file || file.name !== state.fileName) { el.player.hidden = false; el.attach.hidden = false; }
  el.result.scrollIntoView({ behavior: 'smooth' });
}
el.restore.onclick = () => {
  try { loadProject(JSON.parse(localStorage.getItem(STORE_KEY))); } catch { toast('กู้คืนไม่สำเร็จ'); }
};
el.project.onchange = async () => {
  const f = el.project.files[0];
  if (!f) return;
  try { loadProject(JSON.parse(await f.text())); } catch { toast('อ่านไฟล์ JSON ไม่ได้'); }
  el.project.value = '';
};

window.addEventListener('beforeunload', (e) => { if (worker) { e.preventDefault(); e.returnValue = ''; } });

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}
