// Defaults + persistence (localStorage). Everything is UTF-8 / Thai-safe.
export const DEFAULT_CONFIG = {
  players: [],     // never preset: cards come from detection on the user's own clip
  court: { orientation: 'behind', marginM: 1.2 },
  rev: 1,          // saved configs below this get the migration in loadConfig()
  model: { file: 'models/yolo11s-pose.onnx', conf: 0.3, iou: 0.5, stride: 1, assist: true },   // assist: WASB fills TrackNetV3 gaps
  tracking: { maxSpeed: 7, maxJump: 1.5, lostTtl: 1.0 },
  stamina: { start: 100, drainPerMeter: 0.25, min: 5 },
  stats: { deadbandM: 0.15 },
  smoothing: { posAlpha: 0.45, tagAlpha: 0.25 },
  score: { enabled: false, review: true, start: { A: 0, B: 0 } },  // needs shuttle tracking; off: the guess was too often wrong
  highlight: { enabled: true, count: 5 },                          // extra reel of the best rallies; count 0 = all
  render: {
    ringRadiusM: 0.55, tags: true, topHud: true, playerPanel: true, courtMap: true, shuttle: true, showIds: false,
    theme: 'broadcast', frame: 'angled',  // hud.js THEMES / FRAMES
    ringStyle: 'neon', ringColor: 'player', teamColors: { A: '#FF5A36', B: '#2E9BFF' },   // floor ring: neon|solid|minimal, player|team|theme
    shuttleMark: true,    // faint circle on the shuttle
    // shot-speed badge: mode 'hit' (next to the hit point) | 'fixed' (layout spot 'speedBadge') | 'off';
    // secs shown before a 0.3 s fade; ranks = minimum km/h per rank (hud.js SPEED_RANKS, C below B)
    badge: { mode: 'hit', secs: 0.7, ranks: { SSS: 500, SS: 400, S: 300, A: 200, B: 100 } },
    // panel placement from the step-4 editor: {x, y (top-left, fractions of the frame), scale}; null = default spot
    layout: { topHud: null, playerPanel: null, courtMap: null },
    // output: 'overlay' = HUD on the video; 'landscape' 16:9 / 'portrait' 9:16 = video inset, panels around it (own layouts)
    stage: 'overlay',
    layoutLandscape: { topHud: null, playerPanel: null, courtMap: null },
    layoutPortrait: { topHud: null, playerPanel: null, courtMap: null },
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
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if ((saved.rev ?? 0) < 1 && saved.score) saved.score.enabled = false;   // rev 1: scoring became opt-in
    return merge(clone(DEFAULT_CONFIG), { ...saved, rev: DEFAULT_CONFIG.rev });
  } catch { return clone(DEFAULT_CONFIG); }
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
