// UI strings TH / EN. HUD labels drawn on the video stay English in both.
// Static HTML: data-i18n (innerHTML, trusted strings from this file only), data-i18n-title, data-i18n-aria.
const DICT = {
  th: {
    'browser.warn': '⚠️ เบราว์เซอร์นี้ยังไม่รองรับ — กรุณาเปิดด้วย <b>Google Chrome</b> (หรือ Microsoft Edge) บนคอมพิวเตอร์',
    'close': 'ปิด',
    'sub': 'สร้างวิดีโอแบดมินตันสไตล์ถ่ายทอดสด · ประมวลผลในเครื่องคุณ ไม่มีการอัปโหลดขึ้นเซิร์ฟเวอร์',
    'badge.checking': 'ตรวจสอบ GPU…',
    'badge.noGpu': 'WebGPU ✗ (ใช้ CPU — ช้ากว่า)',
    'noWebCodecs': 'เบราว์เซอร์นี้ไม่รองรับ WebCodecs — กรุณาใช้ Chrome หรือ Edge รุ่นล่าสุด',

    'step.video': 'วิดีโอ', 'step.court': 'สนาม', 'step.players': 'ผู้เล่น', 'step.render': 'สร้างวิดีโอ',
    'drop': 'ลากไฟล์วิดีโอมาวาง หรือคลิกเพื่อเลือก',
    'opening': 'กำลังเปิด {name}…',
    'videoInfo': '{w}×{h} · {fps} fps · {dur} นาที · {codec}',
    'noAudio': ' (ไม่มีเสียง)',
    'start': 'เริ่ม (วินาที)', 'end': 'จบ (วินาที)',
    'test15': 'ทดสอบ 15 วินาที', 'full': 'ทั้งคลิป',

    'orientation': 'มุมกล้อง',
    'orient.behind': 'หลัง/เฉียงหลังเส้นท้าย (เน็ตแนวนอน)', 'orient.side': 'ข้างสนาม (เน็ตแนวตั้ง)',
    'undo': 'ย้อนจุดล่าสุด', 'reset': 'เริ่มใหม่',
    'court.hint': 'คลิก <b>มุมนอกของสนามคู่</b> 4 มุมตามลำดับ <b>ซ้ายบน → ขวาบน → ขวาล่าง → ซ้ายล่าง</b> ตามที่เห็นในภาพ (มุมที่อยู่นอกภาพคลิกในขอบสีเข้มได้) ลากจุดเพื่อปรับ (ครบ 4 จุดแล้วคลิกตรงไหนก็ได้ มุมที่ใกล้สุดจะย้ายมา) ให้เส้นเขียวทับเส้นสนามจริง',
    'court.click': 'คลิกมุมที่ {n}/4', 'court.bad': 'มุมสนามไม่ถูกต้อง ลองคลิกใหม่',
    'court.ok': '✓ ตั้งค่าสนามแล้ว — ตรวจดูว่าเส้นเขียวทับเส้นสนามจริง',
    'corner.0': 'ซ้ายบน', 'corner.1': 'ขวาบน', 'corner.2': 'ขวาล่าง', 'corner.3': 'ซ้ายล่าง',

    'pick': 'เฟรมที่ใช้ตรวจจับ (วินาที)', 'seconds': 'วินาที', 'back1': 'ถอย 1 วินาที', 'fwd1': 'เดินหน้า 1 วินาที',
    'detect': '📸 ตรวจจับผู้เล่นจากเฟรมนี้', 'addPlayer': '+ เพิ่มเอง',
    'players.hint': 'ระบบตัดรูปผู้เล่นในสนามมาให้ ใส่ชื่อ/สี/ทีม ได้เลย · คลิกกรอบคนในภาพเพื่อเพิ่มคนที่หลุด · ฝั่ง <b>far</b> = หลังเน็ต, <b>near</b> = ฝั่งกล้อง · ถ้าเฟรมเริ่มมีคนยืนทับกัน เลื่อนไปเฟรมที่เห็นครบทุกคนแล้วกดตรวจจับ',
    'card.name': 'ชื่อผู้เล่น', 'card.color': 'สี', 'card.team': 'ทีม', 'card.side': 'ฝั่งเริ่ม', 'card.del': 'ลบ',
    'team': 'ทีม {t}', 'side.far': 'far · หลังเน็ต', 'side.near': 'near · ฝั่งกล้อง',
    'playerN': 'ผู้เล่น {n}',
    'detecting': 'กำลังตรวจจับ…',
    'found': 'พบ {n} คนในสนาม', 'foundOut': ' (นอกสนาม {n} คน — คลิกกรอบเพื่อเพิ่ม)',
    'importOk': 'นำเข้า config แล้ว', 'importBad': 'ไฟล์ config ไม่ถูกต้อง: {msg}',

    'model': 'โมเดล', 'model.s': 'YOLO11s-pose (แม่นกว่า)', 'model.n': 'YOLO11n-pose (เร็วกว่า)',
    'stride': 'ตรวจจับทุก', 'stride.1': '1 เฟรม', 'stride.2': '2 เฟรม (เร็วขึ้น)', 'stride.3': '3 เฟรม',
    'opt.topHud': 'HUD ด้านบน', 'opt.playerPanel': 'แผงผู้เล่นซ้ายล่าง', 'opt.courtMap': 'Court map',
    'opt.shuttle': 'ติดตามลูกขนไก่', 'opt.showIds': 'Debug IDs',
    'score.on': 'นับแต้ม (ต้องเปิดติดตามลูก)', 'score.startA': 'แต้มเริ่ม ทีม A', 'score.startB': 'ทีม B',
    'score.review': 'ตรวจ/แก้แต้มก่อนสร้างวิดีโอ',
    'saveDirect': 'บันทึกลงไฟล์โดยตรง (แนะนำสำหรับคลิปยาว)',
    'layout.hint': 'จัดวาง HUD บนภาพด้านขวา: ลากเพื่อย้าย · ลากมุมขวาล่างเพื่อปรับขนาด',
    'layout.reset': 'รีเซ็ตตำแหน่ง/ขนาด HUD', 'title.layout': 'จัดวาง HUD — ลากเพื่อย้าย · ลากมุมขวาล่างเพื่อปรับขนาด',
    'render': '▶ สร้างวิดีโอ', 'cancel': 'ยกเลิก',

    'title.empty': 'เลือกวิดีโอเพื่อเริ่ม', 'title.video': 'เฟรมเริ่มต้น',
    'title.court': 'ปรับเส้นสนาม — คลิก/ลาก 4 มุมนอกของสนามคู่',
    'title.players': 'ผู้เล่นที่ตรวจพบ — คลิกกรอบเพื่อเพิ่ม/เลือก', 'title.render': 'ผลลัพธ์',
    'title.processing': 'กำลังประมวลผล (พรีวิวสด)', 'title.analyzing': 'กำลังวิเคราะห์ (พรีวิวสด)',
    'title.encoding': 'กำลังสร้างวิดีโอ', 'title.result': 'ผลลัพธ์ (เฟรมสุดท้าย)', 'title.review': 'ตรวจแต้ม — คลิกแถวเพื่อเล่น rally นั้น · คลิกวิดีโอเพื่อหยุด/เล่นต่อ',
    'empty': 'ลากไฟล์วิดีโอแบดมินตัน (กล้องตั้งนิ่ง) มาวางที่ช่อง <b>1 วิดีโอ</b>',

    'needVideo': 'เลือกวิดีโอก่อน', 'needCourt': 'ตั้งค่าสนามก่อน', 'needPlayer': 'เพิ่มผู้เล่นอย่างน้อย 1 คน',
    'tooShort': 'ช่วงเวลาสั้นเกินไป', 'frameErr': 'อ่านเฟรมจากวิดีโอไม่ได้', 'frameAtErr': 'อ่านเฟรมที่เวลา {t} วินาทีไม่ได้',
    'longClip': 'คลิปยาว: เบราว์เซอร์นี้ต้องเก็บวิดีโอไว้ในหน่วยความจำจนเสร็จ อาจใช้ RAM มาก',
    'loadPlayerModel': 'กำลังโหลดโมเดลผู้เล่น {p}%', 'loadShuttleModel': 'กำลังโหลดโมเดลลูกขนไก่ {p}%',
    'phase.bg': 'เตรียมภาพพื้นหลัง', 'phase.analyze': 'วิเคราะห์', 'phase.render': 'สร้างวิดีโอ',
    'progress.frame': ' · เฟรม {a}/{b}', 'progress.eta': ' · เหลือ ~{t}',
    'canceled': 'ยกเลิกแล้ว', 'download': '⬇ ดาวน์โหลดวิดีโอ',
    'done': '✓ เสร็จแล้ว {n} เฟรม ({codec})', 'doneSaved': ' · บันทึกไฟล์แล้ว', 'doneShuttle': '\nRally {r} · ช็อต {s}',
    'doneScore': ' · สกอร์ {a}-{b}', 'doneToast': 'สร้างวิดีโอเสร็จแล้ว', 'error': 'ผิดพลาด: {msg}', 'fontErr': 'โหลดฟอนต์ไม่สำเร็จ: {msg}',

    'rv.head': 'ระบบเดาผู้ได้แต้ม {n} rally — ตรวจแล้วแก้ได้ แถว ⚠ = คนเสิร์ฟยืนผิดกล่องเทียบกับสกอร์ (อาจมีแต้มหลุด)',
    'rv.ok': '✓ ยืนยันแต้ม & สร้างวิดีโอ', 'rv.none': '— ไม่นับ', 'rv.addAfter': '+ แต้มหลุด', 'rv.addFirst': '+ แต้มหลุดก่อน rally แรก',
    'rv.manual': 'เพิ่มเอง', 'rv.final': 'สกอร์สุดท้าย {a}-{b}',
    'rv.by.serve': 'คนเสิร์ฟถัดไป', 'rv.by.land': 'จุดลูกตก', 'rv.by.last': 'คนตีลูกสุดท้าย', 'rv.by.null': 'ไม่มีหลักฐาน',
    'rv.warn': 'คนเสิร์ฟยืนผิดกล่องเทียบกับสกอร์ก่อนแต้มนี้ — อาจมีแต้มหลุดหรือเดาผิด',
    'rv.noRally': 'ไม่พบ rally — ไม่มีแต้มให้นับ',

    'err.noVideoTrack': 'ไม่พบ video track ในไฟล์นี้', 'err.decode': 'เบราว์เซอร์นี้ถอดรหัส {codec} ไม่ได้ (ลองใช้ Chrome / Edge)',
    'err.firstFrame': 'อ่านเฟรมแรกของวิดีโอไม่ได้', 'err.encode': 'เบราว์เซอร์นี้ไม่รองรับการ encode วิดีโอ (WebCodecs)',
    'err.modelFetch': 'โหลดโมเดลไม่สำเร็จ', 'err.modelOpen': 'เปิดโมเดลไม่ได้',
    'err.shuttleFetch': 'โหลดโมเดลลูกขนไก่ไม่สำเร็จ', 'err.shuttleOpen': 'เปิดโมเดลลูกขนไก่ไม่ได้',
  },
  en: {
    'browser.warn': '⚠️ This browser is not supported — please open the app in <b>Google Chrome</b> (or Microsoft Edge) on a computer',
    'close': 'Close',
    'sub': 'Broadcast-style badminton video · processed on your computer, nothing is uploaded',
    'badge.checking': 'Checking GPU…',
    'badge.noGpu': 'WebGPU ✗ (CPU — slower)',
    'noWebCodecs': 'This browser lacks WebCodecs — please use the latest Chrome or Edge',

    'step.video': 'Video', 'step.court': 'Court', 'step.players': 'Players', 'step.render': 'Render',
    'drop': 'Drop a video file here, or click to choose',
    'opening': 'Opening {name}…',
    'videoInfo': '{w}×{h} · {fps} fps · {dur} min · {codec}',
    'noAudio': ' (no audio)',
    'start': 'Start (s)', 'end': 'End (s)',
    'test15': 'Test 15 s', 'full': 'Whole clip',

    'orientation': 'Camera angle',
    'orient.behind': 'Behind / angled behind the baseline (net horizontal)', 'orient.side': 'Side of the court (net vertical)',
    'undo': 'Undo last point', 'reset': 'Start over',
    'court.hint': 'Click the <b>4 outer corners of the doubles court</b> in order <b>top-left → top-right → bottom-right → bottom-left</b> as seen in the image (corners outside the frame can be clicked in the dark border). Drag points to adjust (with all 4 placed, clicking anywhere moves the nearest corner) until the green lines sit on the real court lines.',
    'court.click': 'Click corner {n}/4', 'court.bad': 'Invalid court corners — try clicking again',
    'court.ok': '✓ Court set — check that the green lines sit on the real court lines',
    'corner.0': 'Top-left', 'corner.1': 'Top-right', 'corner.2': 'Bottom-right', 'corner.3': 'Bottom-left',

    'pick': 'Frame used for detection (s)', 'seconds': 'seconds', 'back1': 'Back 1 second', 'fwd1': 'Forward 1 second',
    'detect': '📸 Detect players in this frame', 'addPlayer': '+ Add manually',
    'players.hint': 'Players on court are cropped for you — set name / colour / team · click a box in the image to add someone who was missed · <b>far</b> = beyond the net, <b>near</b> = camera side · if players overlap at the start, move to a frame where everyone is visible and detect again',
    'card.name': 'Player name', 'card.color': 'Colour', 'card.team': 'Team', 'card.side': 'Starting side', 'card.del': 'Remove',
    'team': 'Team {t}', 'side.far': 'far · beyond net', 'side.near': 'near · camera side',
    'playerN': 'Player {n}',
    'detecting': 'Detecting…',
    'found': '{n} on court', 'foundOut': ' ({n} off court — click a box to add)',
    'importOk': 'Config imported', 'importBad': 'Invalid config file: {msg}',

    'model': 'Model', 'model.s': 'YOLO11s-pose (more accurate)', 'model.n': 'YOLO11n-pose (faster)',
    'stride': 'Detect every', 'stride.1': '1 frame', 'stride.2': '2 frames (faster)', 'stride.3': '3 frames',
    'opt.topHud': 'Top HUD', 'opt.playerPanel': 'Player panel (bottom-left)', 'opt.courtMap': 'Court map',
    'opt.shuttle': 'Track shuttle', 'opt.showIds': 'Debug IDs',
    'score.on': 'Count points (needs shuttle tracking)', 'score.startA': 'Start score team A', 'score.startB': 'Team B',
    'score.review': 'Review / fix points before rendering',
    'saveDirect': 'Save straight to a file (recommended for long clips)',
    'layout.hint': 'Arrange the HUD on the image: drag to move · drag the bottom-right corner to resize',
    'layout.reset': 'Reset HUD position/size', 'title.layout': 'HUD layout — drag to move · drag the bottom-right corner to resize',
    'render': '▶ Render video', 'cancel': 'Cancel',

    'title.empty': 'Choose a video to start', 'title.video': 'First frame',
    'title.court': 'Court lines — click/drag the 4 outer doubles corners',
    'title.players': 'Detected players — click a box to add/select', 'title.render': 'Result',
    'title.processing': 'Processing (live preview)', 'title.analyzing': 'Analyzing (live preview)',
    'title.encoding': 'Rendering video', 'title.result': 'Result (last frame)', 'title.review': 'Review points — click a row to play that rally · click the video to pause/resume',
    'empty': 'Drop a badminton video (fixed camera) into <b>1 Video</b>',

    'needVideo': 'Choose a video first', 'needCourt': 'Set up the court first', 'needPlayer': 'Add at least 1 player',
    'tooShort': 'Time range is too short', 'frameErr': 'Could not read a frame from the video', 'frameAtErr': 'Could not read the frame at {t} s',
    'longClip': 'Long clip: this browser keeps the whole video in memory until done — may use a lot of RAM',
    'loadPlayerModel': 'Loading player model {p}%', 'loadShuttleModel': 'Loading shuttle model {p}%',
    'phase.bg': 'Preparing background', 'phase.analyze': 'Analyzing', 'phase.render': 'Rendering',
    'progress.frame': ' · frame {a}/{b}', 'progress.eta': ' · ~{t} left',
    'canceled': 'Canceled', 'download': '⬇ Download video',
    'done': '✓ Done: {n} frames ({codec})', 'doneSaved': ' · file saved', 'doneShuttle': '\nRallies {r} · shots {s}',
    'doneScore': ' · score {a}-{b}', 'doneToast': 'Video ready', 'error': 'Error: {msg}', 'fontErr': 'Could not load fonts: {msg}',

    'rv.head': 'Point winners guessed for {n} rallies — check and fix. ⚠ rows = server stood in the wrong service court for the score (a point may be missing)',
    'rv.ok': '✓ Confirm points & render', 'rv.none': '— not a point', 'rv.addAfter': '+ missed point', 'rv.addFirst': '+ missed point before the first rally',
    'rv.manual': 'added', 'rv.final': 'Final score {a}-{b}',
    'rv.by.serve': 'next server', 'rv.by.land': 'landing spot', 'rv.by.last': 'last hitter', 'rv.by.null': 'no evidence',
    'rv.warn': 'Server stood in the wrong service court for the score before this point — a point may be missing or mis-guessed',
    'rv.noRally': 'No rallies found — nothing to score',

    'err.noVideoTrack': 'No video track in this file', 'err.decode': 'This browser cannot decode {codec} (try Chrome / Edge)',
    'err.firstFrame': 'Could not read the first video frame', 'err.encode': 'This browser cannot encode video (WebCodecs)',
    'err.modelFetch': 'Could not download the model', 'err.modelOpen': 'Could not open the model',
    'err.shuttleFetch': 'Could not download the shuttle model', 'err.shuttleOpen': 'Could not open the shuttle model',
  },
};
export const LANGS = ['th', 'en'];
const KEY = 'bhud.lang';
let lang = (() => {
  try { const l = localStorage.getItem(KEY); if (DICT[l]) return l; } catch { /* storage unavailable */ }
  return globalThis.navigator?.language?.startsWith('th') ? 'th' : 'en';
})();
const listeners = new Set();

export const getLang = () => lang;
export function t(key, vars = {}) {
  const s = DICT[lang][key] ?? DICT.th[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
export function onLangChange(fn) { listeners.add(fn); }
export function setLang(l) {
  if (!DICT[l]) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
  applyI18n();
  listeners.forEach(fn => fn(l));
}
export function applyI18n(root = document) {
  root.documentElement && (root.documentElement.lang = lang);
  root.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}
