// Defaults + persistence (localStorage). Everything is UTF-8 / Thai-safe.
export const DEFAULT_CONFIG = {
  players: [
    { name: 'หมู', color: '#FFC400', team: 'A', side: 'far' },
    { name: 'กอล์ฟ', color: '#00E5FF', team: 'A', side: 'far' },
    { name: 'วา', color: '#FF3D7F', team: 'B', side: 'near' },
    { name: 'มาร์ค', color: '#7CFF4F', team: 'B', side: 'near' },
  ],
  court: { orientation: 'behind', marginM: 1.2 },
  model: { file: 'models/yolo11s-pose.onnx', conf: 0.3, iou: 0.5, stride: 1 },
  tracking: { maxSpeed: 7, maxJump: 1.5, lostTtl: 1.0 },
  stamina: { start: 100, drainPerMeter: 0.25, min: 5 },
  stats: { deadbandM: 0.15 },
  smoothing: { posAlpha: 0.45, tagAlpha: 0.25 },
  render: { ringRadiusM: 0.55, topHud: true, playerPanel: true, courtMap: true, shuttle: true, showIds: false },
};

// Court corners already measured for known clips (file name → corners TL, TR, BR, BL in px).
export const PRESET_CORNERS = {
  'กอล์ฟ หมู vs วา มาร์ค.mp4': { size: [1280, 720], corners: [[-82.3, 339.7], [387.7, 317.3], [1415.1, 508.5], [539.5, 970.8]] },
};

const KEY = 'bhud.config.v2';
const clone = o => JSON.parse(JSON.stringify(o));

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

export function loadConfig() {
  try { return merge(clone(DEFAULT_CONFIG), JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return clone(DEFAULT_CONFIG); }
}
export function saveConfig(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* storage unavailable */ }
}
export function importConfig(text) { return merge(clone(DEFAULT_CONFIG), JSON.parse(text)); }

const cornerKey = vid => `bhud.corners.${vid.file.name}|${vid.file.size}|${vid.width}x${vid.height}`;
export function loadCorners(vid) {
  try {
    const saved = JSON.parse(localStorage.getItem(cornerKey(vid)) || 'null');
    if (saved?.length === 4) return saved;
  } catch { /* ignore */ }
  const preset = PRESET_CORNERS[vid.file.name];
  if (preset && preset.size[0] === vid.width && preset.size[1] === vid.height) return clone(preset.corners);
  return null;
}
export function saveCorners(vid, corners) {
  try { localStorage.setItem(cornerKey(vid), JSON.stringify(corners)); } catch { /* ignore */ }
}
