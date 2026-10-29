import { loadConfig, saveConfig, importConfig, loadCorners, saveCorners } from './config.js';
import { openVideo, grabFrame, renderVideo } from './pipeline.js';
import { PoseDetector } from './detector.js';
import { ShuttleTracker } from './shuttle.js';
import { footPoint } from './players.js';
import { Court } from './court.js';
import { Stage } from './stage.js';
import { loadFonts } from './hud.js';

const $ = id => document.getElementById(id);
const PALETTE = ['#00E5FF', '#FF3D7F', '#FFC400', '#7CFF4F', '#B388FF', '#FF9100'];
const SHUTTLE_MODEL = 'models/tracknetv3.onnx';
const state = {
  cfg: loadConfig(), vid: null, frame: null, frameT: 0,
  detector: null, detectorUrl: null, shuttle: null,
  dets: [], hl: -1, busy: false, abort: null,
};
const stage = new Stage($('stage'), { onChange: onCourtChange });

// ------------------------------------------------------------------ helpers
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function setStatus(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `status ${cls}`; }
function toast(text, ms = 4000) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const save = () => saveConfig(state.cfg);
const range = () => {
  const d = state.vid?.duration || 0;
  const start = Math.min(Math.max(+$('start').value || 0, 0), d);
  const end = Math.min(Math.max(+$('end').value || d, start), d);
  return { start, end };
};
function activate(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', s.dataset.step === step));
  const titles = {
    video: 'เฟรมเริ่มต้น', court: 'ปรับเส้นสนาม — คลิก/ลาก 4 มุมนอกของสนามคู่',
    players: 'ผู้เล่นที่ตรวจพบ — คลิกกรอบเพื่อเพิ่ม/เลือก', render: 'ผลลัพธ์',
  };
  $('stage-title').textContent = state.vid ? titles[step] : 'เลือกวิดีโอเพื่อเริ่ม';
  if (state.busy) return;
  const showOut = step === 'render' && $('out').width > 0 && !$('out').hidden;
  if (!showOut && state.frame) {
    $('stage').hidden = false; $('out').hidden = true;
    stage.setMode(step === 'players' ? 'assign' : 'calibrate');
  }
}

// ------------------------------------------------------------------ capability badge
(async () => {
  const b = $('badge-gpu');
  const enc = 'VideoEncoder' in window;
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { /* no webgpu */ }
  b.textContent = `${gpu ? 'WebGPU ✓' : 'WebGPU ✗ (ใช้ CPU — ช้ากว่า)'} · ${enc ? 'WebCodecs ✓' : 'WebCodecs ✗'}`;
  b.className = `badge ${gpu && enc ? 'ok' : 'warn'}`;
  if (!enc) toast('เบราว์เซอร์นี้ไม่รองรับ WebCodecs — กรุณาใช้ Chrome หรือ Edge รุ่นล่าสุด', 8000);
})();

// ------------------------------------------------------------------ player cards
function crop(src, box, kind) {
  const [x1, y1, x2, y2] = box, bw = x2 - x1, bh = y2 - y1;
  let sx, sy, sw, sh, ow, oh;
  if (kind === 'avatar') {           // square around head + shoulders
    sw = sh = Math.max(bw * 1.05, bh * 0.42); sx = (x1 + x2) / 2 - sw / 2; sy = y1 - bh * 0.04; ow = oh = 96;
  } else {                           // full body
    sw = bw * 1.15; sh = bh * 1.06; sx = (x1 + x2) / 2 - sw / 2; sy = y1 - bh * 0.03;
    ow = 116; oh = Math.round(116 * (sh / sw)); if (oh > 172) { oh = 172; }
  }
  const c = document.createElement('canvas'); c.width = ow; c.height = oh;
  const g = c.getContext('2d');
  g.fillStyle = '#0b1730'; g.fillRect(0, 0, ow, oh);
  const k = Math.min(ow / sw, oh / sh);
  g.drawImage(src, sx, sy, sw, sh, (ow - sw * k) / 2, (oh - sh * k) / 2, sw * k, sh * k);
  return c.toDataURL('image/jpeg', 0.85);
}

function renderCards() {
  const box = $('cards');
  box.innerHTML = '';
  state.cfg.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (i === state.hl ? ' hl' : '');
    card.style.setProperty('--c', p.color);
    card.innerHTML = `
      ${p.thumb ? `<img class="thumb" alt="">` : '<div class="thumb">👤</div>'}
      <div class="fields">
        <input type="text" placeholder="ชื่อผู้เล่น">
        <div class="line">
          <input type="color" title="สี">
          <select title="ทีม"><option value="A">ทีม A</option><option value="B">ทีม B</option></select>
          <select title="ฝั่งเริ่ม"><option value="far">far · หลังเน็ต</option><option value="near">near · ฝั่งกล้อง</option></select>
        </div>
      </div>
      <button class="x ghost" title="ลบ">✕</button>`;
    if (p.thumb) card.querySelector('img').src = p.thumb;
    const [name, color, team, side] = card.querySelectorAll('input[type=text], input[type=color], select');
    name.value = p.name; color.value = p.color; team.value = p.team; side.value = p.side;
    name.oninput = () => { p.name = name.value; save(); labelStage(); };
    color.oninput = () => { p.color = color.value.toUpperCase(); card.style.setProperty('--c', p.color); save(); labelStage(); };
    team.onchange = () => { p.team = team.value; save(); };
    side.onchange = () => { p.side = side.value; save(); };
    card.querySelector('.x').onclick = e => {
      e.stopPropagation();
      state.cfg.players.splice(i, 1); state.hl = -1; save(); renderCards(); labelStage();
    };
    card.onclick = e => { if (e.target.tagName === 'DIV' || e.target.tagName === 'IMG') { state.hl = i; renderCards(); labelStage(); } };
    box.appendChild(card);
  });
}

function labelStage() {
  stage.labels.clear();
  state.cfg.players.forEach((p, i) => {
    if (p.detIndex != null && p.seedT === state.frameT && state.dets[p.detIndex]) stage.labels.set(p.detIndex, { name: p.name || '?', color: p.color, hl: i === state.hl });
  });
  stage.draw();
}

function playerFromDet(d, i, prev) {
  const side = d.court[1] < 6.7 ? 'far' : 'near';
  return {
    name: prev?.name ?? `ผู้เล่น ${i + 1}`,
    color: prev?.color ?? PALETTE[i % PALETTE.length],
    team: prev?.team ?? (side === 'far' ? 'A' : 'B'),
    side,
    thumb: crop(state.frame, d.box, 'thumb'),
    avatar: crop(state.frame, d.box, 'avatar'),
    seed: d.court.map(v => +v.toFixed(3)), seedT: state.frameT, detIndex: i,
  };
}

async function detectPlayers() {
  if (!state.vid) return toast('เลือกวิดีโอก่อน');
  if (!state.frame) await refreshFrame();
  if (!state.frame) return setStatus('assign-status', 'อ่านเฟรมจากวิดีโอไม่ได้', 'err');
  const court = stage.court();
  if (!court) { activate('court'); return toast('ตั้งค่าสนามก่อน'); }
  activate('players');
  try {
    const det = await getDetector('assign-status');
    setStatus('assign-status', 'กำลังตรวจจับ…');
    const raw = await det.detect(state.frame, state.frame.width, state.frame.height, state.cfg.model.iou);
    const dets = raw.filter(d => d.score >= state.cfg.model.conf).map(d => {
      const f = footPoint(d), c = court.toCourt(f[0], f[1]);
      return { ...d, foot: f, court: c };
    });
    const inCourt = dets.filter(d => court.inPlay(d.court));
    // far side first, then near; left → right on court
    inCourt.sort((a, b) => (a.court[1] < 6.7 ? 0 : 1) - (b.court[1] < 6.7 ? 0 : 1) || a.court[0] - b.court[0]);
    state.dets = inCourt.concat(dets.filter(d => !court.inPlay(d.court)));   // outsiders clickable too
    stage.dets = state.dets;
    const prev = state.cfg.players;
    const reuse = prev.length === inCourt.length;                              // same line-up → keep names/colors
    state.cfg.players = inCourt.map((d, i) => playerFromDet(d, i, reuse ? prev[i] : null));
    state.hl = state.cfg.players.length ? 0 : -1;
    save(); renderCards(); labelStage();
    setStatus('assign-status', `พบ ${inCourt.length} คนในสนาม${dets.length > inCourt.length ? ` (นอกสนาม ${dets.length - inCourt.length} คน — คลิกกรอบเพื่อเพิ่ม)` : ''}`, inCourt.length ? 'ok' : 'warn');
    if (inCourt.length) $('cards').querySelector('input[type=text]')?.focus();
  } catch (e) { setStatus('assign-status', e.message, 'err'); }
}
$('btn-detect').onclick = detectPlayers;
stage.onPickDet = di => {
  const existing = state.cfg.players.findIndex(p => p.detIndex === di && p.seedT === state.frameT);
  if (existing >= 0) { state.hl = existing; renderCards(); labelStage(); return; }
  const n = state.cfg.players.length;
  state.cfg.players.push(playerFromDet(state.dets[di], di, null));
  state.cfg.players[n].name = `ผู้เล่น ${n + 1}`;
  state.cfg.players[n].color = PALETTE[n % PALETTE.length];
  state.hl = n; save(); renderCards(); labelStage();
};
$('btn-add-player').onclick = () => {
  const n = state.cfg.players.length;
  state.cfg.players.push({ name: `ผู้เล่น ${n + 1}`, color: PALETTE[n % PALETTE.length], team: n % 2 ? 'B' : 'A', side: n % 2 ? 'near' : 'far' });
  save(); renderCards();
};
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'badminton-hud-config.json' });
  a.click(); URL.revokeObjectURL(a.href);
};
$('import').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { state.cfg = importConfig(await f.text()); save(); syncControls(); renderCards(); toast('นำเข้า config แล้ว'); }
  catch (err) { toast('ไฟล์ config ไม่ถูกต้อง: ' + err.message); }
  e.target.value = '';
};

// ------------------------------------------------------------------ render options
const TOGGLES = ['topHud', 'playerPanel', 'courtMap', 'shuttle', 'showIds'];
function syncControls() {
  for (const k of TOGGLES) $('r-' + k).checked = !!state.cfg.render[k];
  $('model').value = state.cfg.model.file;
  $('stride').value = String(state.cfg.model.stride);
  $('orientation').value = state.cfg.court.orientation;
}
for (const k of TOGGLES) $('r-' + k).onchange = e => { state.cfg.render[k] = e.target.checked; save(); };
$('model').onchange = e => { state.cfg.model.file = e.target.value; save(); };
$('stride').onchange = e => { state.cfg.model.stride = +e.target.value; save(); };
$('orientation').onchange = e => { state.cfg.court.orientation = e.target.value; stage.orientation = e.target.value; stage.draw(); onCourtChange(); save(); };

// ------------------------------------------------------------------ video
async function loadVideo(file) {
  if (state.busy) return;
  $('drop-text').textContent = 'กำลังเปิด ' + file.name + '…';
  try { state.vid = await openVideo(file); }
  catch (e) { $('drop-text').textContent = 'ลากไฟล์วิดีโอมาวาง หรือคลิกเพื่อเลือก'; toast(e.message, 8000); return; }
  const v = state.vid;
  $('drop-text').textContent = '📹 ' + file.name;
  $('video-info').textContent = `${v.width}×${v.height} · ${v.fps.toFixed(2)} fps · ${fmt(v.duration)} นาที · ${v.codec}${v.audioCodec ? ' + ' + v.audioCodec : ' (ไม่มีเสียง)'}`;
  $('start').value = 0; $('end').value = v.duration.toFixed(1); $('start').max = $('end').max = v.duration;
  $('empty').hidden = true;
  stage.points = loadCorners(v) || [];
  stage.orientation = state.cfg.court.orientation;
  await refreshFrame();
  onCourtChange();
  if (!stage.court()) activate('court');
}
async function refreshFrame() {
  const t = range().start;
  const src = await grabFrame(state.vid, t);
  if (!src) { toast('อ่านเฟรมที่เวลา ' + t + ' วินาทีไม่ได้'); return; }
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  state.frame = c; state.frameT = +t.toFixed(3);
  state.dets = []; stage.dets = []; stage.labels.clear();
  stage.setFrame(c);
  $('stage').hidden = false; $('out').hidden = true;
}
$('file').onchange = e => e.target.files[0] && loadVideo(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && loadVideo(e.dataTransfer.files[0]));
let startTimer;
$('start').oninput = () => { clearTimeout(startTimer); startTimer = setTimeout(() => state.vid && refreshFrame(), 300); };
$('btn-test15').onclick = () => { if (!state.vid) return; $('end').value = Math.min(range().start + 15, state.vid.duration).toFixed(1); };
$('btn-full').onclick = () => { if (!state.vid) return; $('start').value = 0; $('end').value = state.vid.duration.toFixed(1); refreshFrame(); };

// ------------------------------------------------------------------ court
let hadCourt = false;
function onCourtChange() {
  if (!state.vid) return;
  const n = stage.points.length;
  if (n < 4) { hadCourt = false; setStatus('court-status', `คลิกมุมที่ ${n + 1}/4`, 'warn'); return; }
  const court = stage.court();
  if (!court) { setStatus('court-status', 'มุมสนามไม่ถูกต้อง ลองคลิกใหม่', 'err'); return; }
  saveCorners(state.vid, stage.points.map(p => p.map(v => +v.toFixed(1))));
  setStatus('court-status', '✓ ตั้งค่าสนามแล้ว — ตรวจดูว่าเส้นเขียวทับเส้นสนามจริง', 'ok');
  if (!hadCourt && stage.drag < 0 && !state.dets.length && state.frame) { hadCourt = true; detectPlayers(); }
  hadCourt = true;
}
$('btn-undo').onclick = () => stage.undo();
$('btn-reset').onclick = () => stage.reset();

// ------------------------------------------------------------------ models
async function getDetector(statusId) {
  const url = state.cfg.model.file;
  if (state.detector && state.detectorUrl === url) return state.detector;
  state.detector = await PoseDetector.create(url, p => setStatus(statusId, `กำลังโหลดโมเดลผู้เล่น ${(p * 100).toFixed(0)}%`));
  state.detectorUrl = url;
  setStatus(statusId, '');
  return state.detector;
}
async function getShuttle(statusId) {
  if (state.shuttle) return state.shuttle;
  state.shuttle = await ShuttleTracker.create(SHUTTLE_MODEL, p => setStatus(statusId, `กำลังโหลดโมเดลลูกขนไก่ ${(p * 100).toFixed(0)}%`));
  setStatus(statusId, '');
  return state.shuttle;
}

// ------------------------------------------------------------------ render
$('btn-render').onclick = async () => {
  if (state.busy) return;
  if (!state.vid) return toast('เลือกวิดีโอก่อน');
  const court = stage.court();
  if (!court) { activate('court'); return toast('ตั้งค่าสนามก่อน'); }
  if (!state.cfg.players.length) { activate('players'); return toast('เพิ่มผู้เล่นอย่างน้อย 1 คน'); }
  const { start, end } = range();
  if (end - start < 0.5) return toast('ช่วงเวลาสั้นเกินไป');

  let fileHandle = null;
  if ($('save-direct').checked && 'showSaveFilePicker' in window) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: state.vid.file.name.replace(/\.[^.]+$/, '') + '_hud.mp4',
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) { if (e.name === 'AbortError') return; }
  } else if (end - start > 120) {
    toast('คลิปยาว: เบราว์เซอร์นี้ต้องเก็บวิดีโอไว้ในหน่วยความจำจนเสร็จ อาจใช้ RAM มาก');
  }

  state.busy = true; state.abort = new AbortController();
  $('btn-render').disabled = true; $('btn-cancel').disabled = false; $('downloads').innerHTML = '';
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', s.dataset.step === 'render'));
  const out = $('out');
  $('stage').hidden = true; out.hidden = false;
  $('stage-title').textContent = 'กำลังประมวลผล (พรีวิวสด)';
  const onBeforeUnload = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', onBeforeUnload);
  try {
    await state.fontsReady;
    const detector = await getDetector('render-status');
    const shuttle = state.cfg.render.shuttle ? await getShuttle('render-status') : null;
    const cfg = structuredClone(state.cfg);
    const seeds = {};
    cfg.players.forEach((p, i) => { if (p.seed && Math.abs((p.seedT ?? -1) - start) < 0.05) seeds[i] = p.seed; });
    const phases = { bg: 'เตรียมภาพพื้นหลัง', analyze: 'วิเคราะห์', render: 'สร้างวิดีโอ' };
    const res = await renderVideo({
      vid: state.vid, cfg, court: new Court(stage.points, cfg.court.orientation, cfg.court.marginM),
      detector, shuttle, seeds, start, end, canvas: out, fileHandle, signal: state.abort.signal,
      onProgress: p => {
        $('bar').style.width = `${Math.min(100, p.frac * 100).toFixed(1)}%`;
        $('stage-title').textContent = p.phase === 'render' ? 'กำลังสร้างวิดีโอ' : 'กำลังวิเคราะห์ (พรีวิวสด)';
        $('render-status').textContent = `${phases[p.phase]}${p.frame ? ` · เฟรม ${p.frame}/${p.total}` : ''}${p.eta != null ? ` · เหลือ ~${fmt(p.eta)}` : ''}`;
      },
    });
    if (!res) { setStatus('render-status', 'ยกเลิกแล้ว', 'warn'); return; }
    $('bar').style.width = '100%';
    const dl = $('downloads');
    const base = state.vid.file.name.replace(/\.[^.]+$/, '') + '_hud';
    if (res.blob) dl.appendChild(Object.assign(document.createElement('a'), { href: URL.createObjectURL(res.blob), download: base + '.mp4', className: 'button primary', textContent: '⬇ ดาวน์โหลดวิดีโอ' }));
    const js = new Blob([JSON.stringify(res.stats, null, 2)], { type: 'application/json' });
    dl.appendChild(Object.assign(document.createElement('a'), { href: URL.createObjectURL(js), download: base + '.stats.json', className: 'button', textContent: '⬇ stats.json' }));
    const sh = res.stats.shuttle;
    setStatus('render-status', `✓ เสร็จแล้ว ${res.frames} เฟรม (${res.codec.toUpperCase()})${fileHandle ? ' · บันทึกไฟล์แล้ว' : ''}${sh ? `\nRally ${sh.rallies.length} · ช็อต ${sh.shots.length}` : ''}`, 'ok');
    $('stage-title').textContent = 'ผลลัพธ์ (เฟรมสุดท้าย)';
    window.__lastResult = res;
    toast('สร้างวิดีโอเสร็จแล้ว');
  } catch (e) {
    console.error(e);
    setStatus('render-status', 'ผิดพลาด: ' + (e.message || e), 'err');
  } finally {
    state.busy = false;
    $('btn-render').disabled = false; $('btn-cancel').disabled = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
};
$('btn-cancel').onclick = () => state.abort?.abort();
document.querySelectorAll('.step h2').forEach(h => { h.onclick = () => activate(h.parentElement.dataset.step); });

// ------------------------------------------------------------------ init
syncControls();
renderCards();
activate('video');
state.fontsReady = loadFonts().catch(e => toast('โหลดฟอนต์ไม่สำเร็จ: ' + e.message));
window.__app = { state, stage, loadVideo, detectPlayers };
