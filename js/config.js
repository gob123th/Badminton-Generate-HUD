// Defaults + persistence (localStorage). Everything is UTF-8 / Thai-safe.
export const DEFAULT_CONFIG = {
  players: [],     // never preset: cards come from detection on the user's own clip
  court: { orientation: 'behind', marginM: 1.2 },
  model: { file: 'models/yolo11s-pose.onnx', conf: 0.3, iou: 0.5, stride: 1 },
  tracking: { maxSpeed: 7, maxJump: 1.5, lostTtl: 1.0 },
  stamina: { start: 100, drainPerMeter: 0.25, min: 5 },
  stats: { deadbandM: 0.15 },
  smoothing: { posAlpha: 0.45, tagAlpha: 0.25 },
  score: { enabled: true, review: true, start: { A: 0, B: 0 } },   // needs shuttle tracking
  render: {
    ringRadiusM: 0.55, topHud: true, playerPanel: true, courtMap: true, shuttle: true, showIds: false,
    // panel placement from the step-4 editor: {x, y (top-left, fractions of the frame), scale}; null = default spot
    layout: { topHud: null, playerPanel: null, courtMap: null },
  },
};

const KEY = 'bhud.config.v3';
const LEGACY_KEYS = ['bhud.config.v2'];   // v2 shipped preset player names; carry over everything except players
const clone = o => JSON.parse(JSON.stringify(o));

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

function migrate() {
  try {
    if (localStorage.getItem(KEY)) return;
    for (const k of LEGACY_KEYS) {
      const old = localStorage.getItem(k);
      if (!old) continue;
      const cfg = JSON.parse(old); delete cfg.players;
      localStorage.setItem(KEY, JSON.stringify(cfg));
      break;
    }
    LEGACY_KEYS.forEach(k => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

export function loadConfig() {
  migrate();
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
  return null;
}
export function saveCorners(vid, corners) {
  try { localStorage.setItem(cornerKey(vid), JSON.stringify(corners)); } catch { /* ignore */ }
}
