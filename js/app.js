import { loadConfig, saveConfig, importConfig, loadCorners, saveCorners } from './config.js';
import { openVideo, grabFrame, renderVideo } from './pipeline.js';
import { PoseDetector } from './detector.js';
import { ShuttleTracker } from './shuttle.js';
import { footPoint, torsoHist, similarity } from './players.js';
import { Court } from './court.js';
import { Stage } from './stage.js';
import { loadFonts } from './hud.js';
import { buildScore } from './rally.js';
import { ClipPlayer } from './clip.js';
import { LayoutEditor } from './layout.js';
import { t, setLang, getLang, onLangChange, applyI18n } from './i18n.js';

const $ = id => document.getElementById(id);
const PALETTE = ['#00E5FF', '#FF3D7F', '#FFC400', '#7CFF4F', '#B388FF', '#FF9100'];
const SHUTTLE_MODEL = 'models/tracknetv3.onnx';
const state = {
  cfg: loadConfig(), vid: null, frame: null, frameT: 0,
  detector: null, detectorUrl: null, shuttle: null,
  dets: [], hl: -1, busy: false, abort: null,
};
const stage = new Stage($('stage'), { onChange: onCourtChange });
const layoutEd = new LayoutEditor($('out'), () => save());

// ------------------------------------------------------------------ helpers
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// status lines / stage title keep a text function so they re-translate when the language changes
const live = new Map();
function setText(id, text, cls) {
  const el = $(id), fn = typeof text === 'function' ? text : () => text;
  live.set(id, { fn, cls }); el.textContent = fn();
  if (cls != null) el.className = cls;
}
const setStatus = (id, text, cls = '') => setText(id, text, `status ${cls}`);
const setTitle = text => setText('stage-title', text);
function toast(text, ms = 4000) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, ms);
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
  state.step = step;
  if (state.busy) return;
  setTitle(() => t(state.vid ? `title.${step}` : 'title.empty'));
  if (step === 'render' && state.frame) { openLayout(); return; }   // step 4: drag / resize the HUD panels
  layoutEd.close();
  if (state.frame) {
    $('stage').hidden = false; $('out').hidden = true;
    stage.setMode(step === 'players' ? 'assign' : 'calibrate');
  }
}
async function openLayout() {
  $('stage').hidden = true; $('out').hidden = false;
  await state.fontsReady;
  await layoutEd.open(state.frame, state.cfg, stage.court());
  setTitle(() => t('title.layout'));
}

// ------------------------------------------------------------------ capability badge
(async () => {
  const b = $('badge-gpu');
  const enc = 'VideoEncoder' in window;
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { /* no webgpu */ }
  delete b.dataset.i18n;
  setText('badge-gpu', () => `${gpu ? 'WebGPU ✓' : t('badge.noGpu')} · ${enc ? 'WebCodecs ✓' : 'WebCodecs ✗'}`, `badge ${gpu && enc ? 'ok' : 'warn'}`);
  if (!enc) toast(t('noWebCodecs'), 8000);
})();
// only Chromium (Chrome/Edge) is tested; Safari, Firefox and every iOS browser (WebKit) lack userAgentData
if (!navigator.userAgentData?.brands?.some(b => b.brand === 'Chromium')) {
  $('browser-warn').hidden = false;
  $('browser-warn-x').onclick = () => { $('browser-warn').hidden = true; };
}

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
        <input type="text" placeholder="${t('card.name')}">
        <div class="line">
          <input type="color" title="${t('card.color')}">
          <select title="${t('card.team')}"><option value="A">${t('team', { t: 'A' })}</option><option value="B">${t('team', { t: 'B' })}</option></select>
          <select title="${t('card.side')}"><option value="far">${t('side.far')}</option><option value="near">${t('side.near')}</option></select>
        </div>
      </div>
      <button class="x ghost" title="${t('card.del')}">✕</button>`;
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
    name: prev?.name ?? t('playerN', { n: i + 1 }),
    color: prev?.color ?? PALETTE[i % PALETTE.length],
    team: prev?.team ?? (side === 'far' ? 'A' : 'B'),
    side,
    thumb: crop(state.frame, d.box, 'thumb'),
    avatar: crop(state.frame, d.box, 'avatar'),
    seed: d.court.map(v => +v.toFixed(3)), seedT: state.frameT, detIndex: i,
    hist: Array.from(torsoHist(state.frame.getContext('2d'), d.box) || []).map(v => +v.toFixed(4)),
  };
}

/** fresh[i] → previous card of the same person: same court side, most similar shirt (frames may reorder players) */
function matchCards(prev, fresh) {
  const pairs = [];
  fresh.forEach((f, i) => prev.forEach((p, j) => {
    if (p.side !== f.side) return;
    pairs.push({ i, j, s: p.hist?.length === 16 && f.hist.length === 16 ? similarity(p.hist, f.hist) : 0 });
  }));
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const match = [], used = new Set();
  for (const { i, j } of pairs) if (!match[i] && !used.has(j)) { match[i] = prev[j]; used.add(j); }
  return match;
}

// one detector session: runs are queued, and rendering waits for them (concurrent session.run hung the page)
let detectRun = Promise.resolve();
const detectPlayers = () => (detectRun = detectRun.then(detectPlayersNow));
async function detectPlayersNow() {
  if (state.busy) return;
  if (!state.vid) return toast(t('needVideo'));
  if (!state.frame) await refreshFrame();
  if (!state.frame) return setStatus('assign-status', () => t('frameErr'), 'err');
  const court = stage.court();
  if (!court) { activate('court'); return toast(t('needCourt')); }
  activate('players');
  try {
    const det = await getDetector('assign-status');
    setStatus('assign-status', () => t('detecting'));
    const { width: W, height: H } = state.frame;
    const raw = await det.detect(state.frame, W, H, state.cfg.model.iou, court.farTiles(W, H));
    const dets = raw.filter(d => d.score >= state.cfg.model.conf).map(d => {
      const f = footPoint(d), c = court.toCourt(f[0], f[1]);
      return { ...d, foot: f, court: c };
    });
    const inCourt = dets.filter(d => court.inPlay(d.court));
    // far side first, then near; left → right on court
    inCourt.sort((a, b) => (a.court[1] < 6.7 ? 0 : 1) - (b.court[1] < 6.7 ? 0 : 1) || a.court[0] - b.court[0]);
    state.dets = inCourt.concat(dets.filter(d => !court.inPlay(d.court)));   // outsiders clickable too
    stage.dets = state.dets;
    const fresh = inCourt.map((d, i) => playerFromDet(d, i, null));
    const prev = state.cfg.players;
    const match = prev.length === fresh.length ? matchCards(prev, fresh) : []; // same line-up → keep names/colors
    state.cfg.players = fresh.map((p, i) => match[i] ? { ...p, name: match[i].name, color: match[i].color, team: match[i].team } : p);
    state.hl = state.cfg.players.length ? 0 : -1;
    save(); renderCards(); labelStage();
    const nIn = inCourt.length, nOut = dets.length - inCourt.length;
    setStatus('assign-status', () => t('found', { n: nIn }) + (nOut ? t('foundOut', { n: nOut }) : ''), nIn ? 'ok' : 'warn');
    if (inCourt.length) $('cards').querySelector('input[type=text]')?.focus();
  } catch (e) { setStatus('assign-status', e.message, 'err'); }
}
$('btn-detect').onclick = detectPlayers;
stage.onPickDet = di => {
  const existing = state.cfg.players.findIndex(p => p.detIndex === di && p.seedT === state.frameT);
  if (existing >= 0) { state.hl = existing; renderCards(); labelStage(); return; }
  const n = state.cfg.players.length;
  state.cfg.players.push(playerFromDet(state.dets[di], di, null));
  state.cfg.players[n].name = t('playerN', { n: n + 1 });
  state.cfg.players[n].color = PALETTE[n % PALETTE.length];
  state.hl = n; save(); renderCards(); labelStage();
};
$('btn-add-player').onclick = () => {
  const n = state.cfg.players.length;
  state.cfg.players.push({ name: t('playerN', { n: n + 1 }), color: PALETTE[n % PALETTE.length], team: n % 2 ? 'B' : 'A', side: n % 2 ? 'near' : 'far' });
  save(); renderCards();
};
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'badminton-hud-config.json' });
  a.click(); URL.revokeObjectURL(a.href);
};
$('import').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { state.cfg = importConfig(await f.text()); save(); syncControls(); renderCards(); toast(t('importOk')); }
  catch (err) { toast(t('importBad', { msg: err.message })); }
  e.target.value = '';
};

// ------------------------------------------------------------------ render options
const TOGGLES = ['topHud', 'playerPanel', 'courtMap', 'shuttle', 'showIds'];
function syncControls() {
  for (const k of TOGGLES) $('r-' + k).checked = !!state.cfg.render[k];
  $('model').value = state.cfg.model.file;
  $('stride').value = String(state.cfg.model.stride);
  $('orientation').value = state.cfg.court.orientation;
  $('score-on').checked = !!state.cfg.score.enabled;
  $('score-review').checked = !!state.cfg.score.review;
  $('score-a').value = state.cfg.score.start.A; $('score-b').value = state.cfg.score.start.B;
  syncScoreOpts();
}
const syncScoreOpts = () => $('score-on').closest('.score-opts').classList.toggle('off', !state.cfg.score.enabled || !state.cfg.render.shuttle);
for (const k of TOGGLES) $('r-' + k).onchange = e => { state.cfg.render[k] = e.target.checked; save(); syncScoreOpts(); layoutEd.draw(); };
$('score-on').onchange = e => { state.cfg.score.enabled = e.target.checked; save(); syncScoreOpts(); layoutEd.draw(); };
$('btn-layout-reset').onclick = () => {
  state.cfg.render.layout = { topHud: null, playerPanel: null, courtMap: null };
  save(); if (layoutEd.active) openLayout();
};
$('score-review').onchange = e => { state.cfg.score.review = e.target.checked; save(); };
for (const k of ['A', 'B']) $('score-' + k.toLowerCase()).onchange = e => { state.cfg.score.start[k] = Math.max(0, Math.round(+e.target.value || 0)); e.target.value = state.cfg.score.start[k]; save(); };
$('model').onchange = e => { state.cfg.model.file = e.target.value; save(); };
$('stride').onchange = e => { state.cfg.model.stride = +e.target.value; save(); };
$('orientation').onchange = e => { state.cfg.court.orientation = e.target.value; stage.orientation = e.target.value; stage.draw(); onCourtChange(); save(); };

// ------------------------------------------------------------------ video
async function loadVideo(file) {
  if (state.busy) return;
  setText('drop-text', () => t('opening', { name: file.name }));
  try { state.vid = await openVideo(file); }
  catch (e) { setText('drop-text', () => t('drop')); toast(e.message, 8000); return; }
  const v = state.vid;
  setText('drop-text', '📹 ' + file.name);
  setText('video-info', () => t('videoInfo', { w: v.width, h: v.height, fps: v.fps.toFixed(2), dur: fmt(v.duration), codec: v.codec }) + (v.audioCodec ? ' + ' + v.audioCodec : t('noAudio')));
  $('start').value = 0; $('end').value = v.duration.toFixed(1); $('start').max = $('end').max = v.duration;
  $('pick-t').max = $('pick-n').max = v.duration;
  $('empty').hidden = true;
  stage.points = loadCorners(v) || [];
  stage.orientation = state.cfg.court.orientation;
  await refreshFrame();
  onCourtChange();
  if (!stage.court()) activate('court');
}
async function refreshFrame(sec = range().start) {
  sec = Math.min(Math.max(sec, 0), state.vid.duration);
  $('pick-t').value = $('pick-n').value = sec.toFixed(1);
  const src = await grabFrame(state.vid, sec);
  if (!src) { toast(t('frameAtErr', { t: sec.toFixed(1) })); return; }
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  state.frame = c; state.frameT = +sec.toFixed(3);
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
// players step: pick another frame to detect from (e.g. when players overlap at the start)
let pickTimer;
const pickFrame = sec => {
  if (!state.vid || state.busy) return;
  $('pick-t').value = $('pick-n').value = (+sec).toFixed(1);
  clearTimeout(pickTimer);
  pickTimer = setTimeout(async () => { await refreshFrame(+sec); activate('players'); labelStage(); }, 250);
};
$('pick-t').oninput = e => pickFrame(e.target.value);
$('pick-n').onchange = e => pickFrame(e.target.value);
$('pick-prev').onclick = () => pickFrame(Math.max(+$('pick-n').value - 1, 0));
$('pick-next').onclick = () => pickFrame(Math.min(+$('pick-n').value + 1, state.vid?.duration || 0));
$('btn-test15').onclick = () => { if (!state.vid) return; $('end').value = Math.min(range().start + 15, state.vid.duration).toFixed(1); };
$('btn-full').onclick = () => { if (!state.vid) return; $('start').value = 0; $('end').value = state.vid.duration.toFixed(1); refreshFrame(); };

// ------------------------------------------------------------------ court
let hadCourt = false;
function onCourtChange() {
  if (!state.vid) return;
  const n = stage.points.length;
  if (n < 4) { hadCourt = false; setStatus('court-status', () => t('court.click', { n: n + 1 }), 'warn'); return; }
  const court = stage.court();
  if (!court) { setStatus('court-status', () => t('court.bad'), 'err'); return; }
  saveCorners(state.vid, stage.points.map(p => p.map(v => +v.toFixed(1))));
  setStatus('court-status', () => t('court.ok'), 'ok');
  if (!hadCourt && stage.drag < 0 && !state.dets.length && state.frame) { hadCourt = true; detectPlayers(); }
  hadCourt = true;
}
$('btn-undo').onclick = () => stage.undo();
$('btn-reset').onclick = () => stage.reset();

// ------------------------------------------------------------------ models
async function getDetector(statusId) {
  const url = state.cfg.model.file;
  if (state.detector && state.detectorUrl === url) return state.detector;
  state.detector = await PoseDetector.create(url, p => setStatus(statusId, () => t('loadPlayerModel', { p: (p * 100).toFixed(0) })));
  state.detectorUrl = url;
  setStatus(statusId, '');
  return state.detector;
}
async function getShuttle(statusId) {
  if (state.shuttle) return state.shuttle;
  state.shuttle = await ShuttleTracker.create(SHUTTLE_MODEL, p => setStatus(statusId, () => t('loadShuttleModel', { p: (p * 100).toFixed(0) })));
  setStatus(statusId, '');
  return state.shuttle;
}

// ------------------------------------------------------------------ score review (pipeline pauses here)
const BY = { serve: 'rv.by.serve', land: 'rv.by.land', last: 'rv.by.last' };
function reviewScore({ an, auto, ctx, start, time }) {
  const winners = auto.map(a => a.winner), extras = [];
  const box = $('review'), list = $('review-rows');
  let sel = -1;
  // click a rally row → play it (1 s before the serve to 1.5 s after the end) with the analysed shuttle drawn on top
  const fps = state.vid.fps, last = an.pos.length - 1, out = $('out');
  const player = new ClipPlayer(state.vid.file, out, out.parentElement);
  out.onclick = () => player.toggle();
  const play = i => {
    sel = i; draw();
    const r = an.rallies[i], hits = new Set(r.hits.map(h => h.frame)), u = out.height / 720;
    player.play(time(Math.max(0, r.start - fps)), time(Math.min(last, r.end + Math.round(1.5 * fps))), (g, mt) => {
      const f = Math.round((mt - time(0)) * fps);
      g.save();
      g.lineCap = 'round'; g.strokeStyle = 'rgba(0,229,255,0.85)'; g.lineWidth = 3 * u;
      g.beginPath();
      for (let k = Math.max(0, f - 12), on = false; k <= Math.min(f, last); k++) {
        const p = an.pos[k];
        if (!p) { on = false; continue; }
        on ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); on = true;
      }
      g.stroke();
      const p = an.pos[Math.min(Math.max(f, 0), last)];
      if (p) { g.fillStyle = '#fff'; g.beginPath(); g.arc(p[0], p[1], 6 * u, 0, Math.PI * 2); g.fill(); }
      for (let k = f - 6; k <= f; k++) {
        if (!hits.has(k) || !an.pos[k]) continue;
        g.strokeStyle = '#FFC400'; g.lineWidth = 3 * u;
        g.beginPath(); g.arc(an.pos[k][0], an.pos[k][1], (14 + (f - k) * 4) * u, 0, Math.PI * 2); g.stroke();
      }
      g.font = `${Math.round(28 * u)}px "HUD Display", sans-serif`; g.fillStyle = 'rgba(8,18,40,0.8)';
      g.fillRect(12 * u, 12 * u, 260 * u, 40 * u);
      g.fillStyle = '#00E5FF'; g.fillText(`RALLY #${i + 1}  ·  ${fmt(mt - range().start)}`, 22 * u, 42 * u);
      g.restore();
    });
  };
  const pick = (value, onChange, none = true) => {
    const s = document.createElement('select');
    s.innerHTML = `<option value="A">${t('team', { t: 'A' })}</option><option value="B">${t('team', { t: 'B' })}</option>`
      + (none ? `<option value="">${t('rv.none')}</option>` : '');
    s.value = value ?? '';
    s.onclick = e => e.stopPropagation();
    s.onchange = () => { onChange(s.value || null); draw(); };
    return s;
  };
  const button = (text, onClick) => Object.assign(document.createElement('button'), {
    className: 'ghost', textContent: text, onclick: e => { e.stopPropagation(); onClick(); draw(); },
  });
  function draw() {
    const sc = buildScore(an, winners, extras, start, ctx);
    setText('review-head', () => t(an.rallies.length ? 'rv.head' : 'rv.noRally', { n: an.rallies.length }), 'hint');
    setText('review-final', () => t('rv.final', { a: sc.final.A, b: sc.final.B }), 'review-final');
    list.innerHTML = '';
    if (extras.some(e => e.after < 0) || an.rallies.length) {
      const li = document.createElement('li');
      li.appendChild(button(t('rv.addFirst'), () => extras.push({ after: -1, winner: 'A' })));
      li.style.gridTemplateColumns = '1fr';
      list.appendChild(li);
    }
    sc.rows.forEach(row => {
      const li = document.createElement('li');
      li.className = (row.extra ? 'extra ' : '') + (row.serveWarn ? 'warn ' : '') + (sel === row.rally && !row.extra ? 'sel' : '');
      if (row.serveWarn) li.title = t('rv.warn');
      const num = row.extra ? '+' : `#${row.rally + 1}`;
      const a = auto[row.rally];
      const by = row.extra ? t('rv.manual') : `${fmt(time(row.frame) - range().start)} · ${t(BY[a?.by] ?? 'rv.by.null')}`;
      li.innerHTML = `<span class="num">${num}</span><span class="sc">${row.A}-${row.B}</span><span class="by"></span><span class="acts"></span>`;
      li.querySelector('.by').textContent = by;
      const acts = li.querySelector('.acts');
      if (row.extra) {
        const e = extras.filter(x => x.after === row.rally)[sc.rows.filter(r => r.extra && r.rally === row.rally).indexOf(row)];
        acts.append(pick(e.winner, v => { e.winner = v; }, false), button('✕', () => extras.splice(extras.indexOf(e), 1)));
      } else {
        acts.append(pick(winners[row.rally], v => { winners[row.rally] = v; }), button(t('rv.addAfter'), () => extras.push({ after: row.rally, winner: 'A' })));
        li.onclick = () => play(row.rally);
      }
      list.appendChild(li);
    });
  }
  box.hidden = false; draw();
  setTitle(() => t('title.review'));
  return new Promise(resolve => {
    const done = v => {
      box.hidden = true; player.destroy(); out.onclick = null;
      state.abort.signal.removeEventListener('abort', onAbort); resolve(v);
    };
    const onAbort = () => done(null);
    state.abort.signal.addEventListener('abort', onAbort);
    $('btn-review-ok').onclick = () => done({ winners: [...winners], extras: extras.map(e => ({ ...e })) });
  });
}

// ------------------------------------------------------------------ render
$('btn-render').onclick = async () => {
  if (state.busy) return;
  if (!state.vid) return toast(t('needVideo'));
  await detectRun;
  const court = stage.court();
  if (!court) { activate('court'); return toast(t('needCourt')); }
  if (!state.cfg.players.length) { activate('players'); return toast(t('needPlayer')); }
  const { start, end } = range();
  if (end - start < 0.5) return toast(t('tooShort'));

  let fileHandle = null;
  if ($('save-direct').checked && 'showSaveFilePicker' in window) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: state.vid.file.name.replace(/\.[^.]+$/, '') + '_hud.mp4',
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) { if (e.name === 'AbortError') return; }
  } else if (end - start > 120) {
    toast(t('longClip'));
  }

  layoutEd.close();
  state.busy = true; state.abort = new AbortController();
  $('btn-render').disabled = true; $('btn-cancel').disabled = false; $('downloads').innerHTML = '';
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', s.dataset.step === 'render'));
  const out = $('out');
  $('stage').hidden = true; out.hidden = false;
  setTitle(() => t('title.processing'));
  const onBeforeUnload = e => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', onBeforeUnload);
  try {
    await state.fontsReady;
    const detector = await getDetector('render-status');
    const shuttle = state.cfg.render.shuttle ? await getShuttle('render-status') : null;
    const cfg = structuredClone(state.cfg);
    const seeds = {};
    cfg.players.forEach((p, i) => { if (p.seed && Math.abs((p.seedT ?? -1) - start) < 0.05) seeds[i] = p.seed; });
    const res = await renderVideo({
      vid: state.vid, cfg, court: new Court(stage.points, cfg.court.orientation, cfg.court.marginM),
      detector, shuttle, seeds, start, end, canvas: out, fileHandle, signal: state.abort.signal,
      review: cfg.score.enabled && cfg.score.review ? reviewScore : null,
      onProgress: p => {
        $('bar').style.width = `${Math.min(100, p.frac * 100).toFixed(1)}%`;
        setTitle(() => t(p.phase === 'render' ? 'title.encoding' : 'title.analyzing'));
        setStatus('render-status', () => t(`phase.${p.phase}`) + (p.frame ? t('progress.frame', { a: p.frame, b: p.total }) : '') + (p.eta != null ? t('progress.eta', { t: fmt(p.eta) }) : ''));
      },
    });
    if (!res) { setStatus('render-status', () => t('canceled'), 'warn'); return; }
    $('bar').style.width = '100%';
    const dl = $('downloads');
    const base = state.vid.file.name.replace(/\.[^.]+$/, '') + '_hud';
    if (res.blob) dl.appendChild(Object.assign(document.createElement('a'), { href: URL.createObjectURL(res.blob), download: base + '.mp4', className: 'button primary', textContent: t('download') }));
    const js = new Blob([JSON.stringify(res.stats, null, 2)], { type: 'application/json' });
    dl.appendChild(Object.assign(document.createElement('a'), { href: URL.createObjectURL(js), download: base + '.stats.json', className: 'button', textContent: '⬇ stats.json' }));
    const sh = res.stats.shuttle, scf = res.stats.score?.final;
    setStatus('render-status', () => t('done', { n: res.frames, codec: res.codec.toUpperCase() }) + (fileHandle ? t('doneSaved') : '')
      + (scf ? t('doneScore', { a: scf.A, b: scf.B }) : '') + (sh ? t('doneShuttle', { r: sh.rallies.length, s: sh.shots.length }) : ''), 'ok');
    setTitle(() => t('title.result'));
    window.__lastResult = res;
    toast(t('doneToast'));
  } catch (e) {
    console.error(e);
    setStatus('render-status', () => t('error', { msg: e.message || e }), 'err');
  } finally {
    state.busy = false; $('review').hidden = true;
    $('btn-render').disabled = false; $('btn-cancel').disabled = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
};
$('btn-cancel').onclick = () => state.abort?.abort();
// any interaction inside a step (heading, buttons, inputs) makes it the active step, so the stage mode follows
document.querySelectorAll('.step').forEach(sec => sec.addEventListener('pointerdown', () => {
  if (!sec.classList.contains('active')) activate(sec.dataset.step);
}));

// ------------------------------------------------------------------ language
const syncLangButtons = () => document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === getLang()));
document.querySelectorAll('[data-lang]').forEach(b => { b.onclick = () => setLang(b.dataset.lang); });
onLangChange(() => {
  syncLangButtons();
  for (const [id, { fn }] of live) $(id).textContent = fn();
  renderCards(); stage.draw();
});

// ------------------------------------------------------------------ init
applyI18n(); syncLangButtons();
syncControls();
renderCards();
activate('video');
state.fontsReady = loadFonts().catch(e => toast(t('fontErr', { msg: e.message })));
window.__app = { state, stage, loadVideo, detectPlayers };
