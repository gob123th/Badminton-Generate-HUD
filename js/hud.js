// Canvas HUD renderer (broadcast / game style). Thai text renders natively via canvas + Kanit.
import { COURT_L, COURT_W, NET_Y, courtLines } from './court.js';

export const FONT_THAI = 'HUD Thai';        // Kanit SemiBold
export const FONT_DISPLAY = 'HUD Display';  // Bebas Neue (Latin/numbers only)
const DARK = '8,18,40', LOW = '#FF5252';

// HUD colour themes (step 4): panel = rgb of the panel fill, glow = shadow-blur multiplier
export const THEMES = {
  broadcast: { panel: '8,18,40', accent: '#00E5FF', muted: '#9FB4D0', text: '#FFFFFF', glow: 1 },
  esports: { panel: '26,6,42', accent: '#FF2BD6', muted: '#C9A6E6', text: '#FFFFFF', glow: 1.4 },
  gold: { panel: '16,13,8', accent: '#FFC400', muted: '#CDBF96', text: '#FFFFFF', glow: 0.8 },
  volt: { panel: '8,22,14', accent: '#B6FF2E', muted: '#A2C79C', text: '#FFFFFF', glow: 1 },
  light: { panel: '246,248,251', accent: '#1F6BFF', muted: '#5A6A80', text: '#0B1220', glow: 0 },
};
export const RING_STYLES = ['neon', 'solid', 'minimal'];
export const FRAMES = ['angled', 'rounded', 'tech'];   // panel shape: slanted / pill / square with glowing corners

// output canvas (cfg.render.stage): HUD over the video, or the video inset in a 16:9 / 9:16 canvas with the panels
// around it. Each stage keeps its own panel layout in cfg.render[layoutKey(stage)]
export const STAGES = ['overlay', 'landscape', 'portrait'];
export const layoutKey = stage => ({ landscape: 'layoutLandscape', portrait: 'layoutPortrait' }[stage] || 'layout');
const TOP_W1 = 4 * 290 + 3 * 16;        // top HUD width at scale 1 with the SCORE panel
const even = v => Math.round(v / 2) * 2;

// shot-speed tiers (all EST.): game-style rank shown after a hit; thresholds (km/h) come from cfg.render.badge.ranks
// (step 4), C is everything below B
export const SPEED_RANKS = [
  { rank: 'SSS', name: 'GODLIKE SMASH', color: '#D96BFF' },
  { rank: 'SS', name: 'MONSTER SMASH', color: '#FF3D7F' },
  { rank: 'S', name: 'SMASH', color: '#FF9100' },
  { rank: 'A', name: 'POWER SHOT', color: '#FFC400' },
  { rank: 'B', name: 'DRIVE', color: '#7CFF4F' },
  { rank: 'C', name: 'TOUCH', color: '#9FB4D0' },
];
export const RANK_MIN = { SSS: 500, SS: 400, S: 300, A: 200, B: 100 };
export const speedRank = (kmh, min = RANK_MIN) => SPEED_RANKS.find(r => r.rank === 'C' || kmh >= (min[r.rank] ?? RANK_MIN[r.rank]));
const BADGE_FADE = 0.3;                       // fade-out after cfg.render.badge.secs
const BADGE_W = 300, BADGE_H = 72;            // badge size at scale 1 (fits 3 digits + the longest rank name)

const rgba = (hex, a) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};
const font = (size, fam) => `${Math.round(size)}px "${fam}", "Kanit", "Noto Sans Thai", sans-serif`;
const fmtTime = s => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
};

export async function loadFonts(base = 'fonts/') {
  const faces = [
    new FontFace(FONT_THAI, `url(${base}Kanit-SemiBold.ttf)`),
    new FontFace(FONT_DISPLAY, `url(${base}BebasNeue-Regular.ttf)`),
  ];
  for (const f of faces) document.fonts.add(await f.load());
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export class HudRenderer {
  /** width/height = the video; opts.stage overrides cfg.render.stage (pass-1 preview draws over the video) */
  constructor(cfg, court, width, height, { stage } = {}) {
    this.cfg = cfg;
    this.court = court;
    this.W = width; this.H = height;
    this.s = height / 1080;
    this.stage = STAGES.includes(stage ?? cfg.render.stage) ? (stage ?? cfg.render.stage) : 'overlay';
    this.geometry();
    const r = cfg.render;
    this.ringR = r.ringRadiusM;
    this.unit = Array.from({ length: 73 }, (_, i) => [Math.cos((i / 72) * 2 * Math.PI), Math.sin((i / 72) * 2 * Math.PI)]);
    this.avatars = cfg.players.map(p => {
      if (!p.avatar) return null;
      const img = new Image(); img.src = p.avatar; return img;
    });
    this.ready = Promise.all(this.avatars.map(a => a?.decode().catch(() => null)));
  }

  /**
   * Output size OW × OH and the video's rect in it. landscape: video top-left, top HUD under it, player panel + court
   * map in a right column. portrait (9:16, width = video height): top HUD, video at full width, then the player panel
   * and court map side by side, block centred vertically; panels default to the scale that fills the width.
   */
  geometry() {
    const W = this.W, H = this.H, s = this.s, m = 28 * s;
    this.defScale = {};
    if (this.stage === 'landscape') {
      let vw = W - (480 * s + 3 * m), vh = (vw * H) / W;
      if (vh > H - 96 * s - 3 * m) { vh = H - 96 * s - 3 * m; vw = (vh * W) / H; }
      this.OW = W; this.OH = H; this.video = [m, m, vw, vh];
    } else if (this.stage === 'portrait') {
      const OW = even(H), OH = even((OW * 16) / 9), vh = (OW * H) / W;
      const kTop = (OW - 2 * m) / (TOP_W1 * s), [mw, mh] = this.mapInner(1);
      const kRow = (OW - 3 * m) / ((480 + mw + 44) * s), n = this.cfg.players.length;
      const rowH = Math.max((34 + 64 * n) * s * kRow, (mh + 82) * s * kRow);
      const total = 96 * s * kTop + m + vh + m + rowH, top = Math.max(m, (OH - total) / 2);
      this.OW = OW; this.OH = OH; this.video = [0, top + 96 * s * kTop + m, OW, vh];
      this.defScale = { topHud: kTop, playerPanel: kRow, courtMap: kRow };
    } else { this.OW = W; this.OH = H; this.video = [0, 0, W, H]; }
  }
  get inset() { return this.stage !== 'overlay'; }
  /** run draw(ctx) in video pixel coordinates (rings, tags, shuttle live in the video) */
  inVideo(ctx, draw) {
    ctx.save();
    if (this.inset) {
      const [x, y, w, h] = this.video;
      ctx.translate(x, y); ctx.scale(w / this.W, h / this.H);
      ctx.beginPath(); ctx.rect(0, 0, this.W, this.H); ctx.clip();
    }
    draw(ctx);
    ctx.restore();
  }
  /** video frame (+ the themed background around it for an inset stage) */
  drawBase(ctx, src) {
    if (!this.inset) { ctx.drawImage(src, 0, 0, this.W, this.H); return; }
    const th = this.th, [x, y, w, h] = this.video, s = this.s;
    const dim = th.panel.split(',').map(v => Math.round(v * 0.72)).join(',');
    const g = ctx.createLinearGradient(0, 0, this.OW * 0.3, this.OH);
    g.addColorStop(0, `rgb(${th.panel})`); g.addColorStop(1, `rgb(${dim})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.OW, this.OH);
    ctx.drawImage(src, x, y, w, h);
    ctx.save();
    ctx.strokeStyle = th.accent; ctx.lineWidth = Math.max(2 * s, 1.5); ctx.shadowColor = th.accent; ctx.shadowBlur = 12 * s * th.glow;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /** st: {t, players:[{idx,name,color,team,pos,head,trackId,show}], stats, shuttle, dets, preview} */
  render(ctx, st) {
    const r = this.cfg.render;
    const shown = st.players.filter(p => p.show && p.pos && p.head);
    this.inVideo(ctx, g => {
      if (r.showIds && st.dets) this.debugIds(g, st.dets);
      for (const p of shown) this.ring(g, p, st.t);
      if (st.shuttle && r.shuttle) this.shuttle(g, st.shuttle, r.badge?.mode === 'hit');
      if (r.tags !== false) for (const p of [...shown].sort((a, b) => a.head[1] - b.head[1])) this.tag(g, p, st.stats);
    });
    if (r.topHud) this.topHud(ctx, st.shuttle, st.preview);
    if (r.playerPanel) this.playerPanel(ctx, st.players, st.stats);
    if (r.courtMap) this.courtMap(ctx, shown);
    if (st.shuttle?.speedLabel && r.shuttle && r.badge?.mode === 'fixed') this.speedBadge(ctx, st.shuttle.speedLabel);
  }

  /** colour theme (read per draw so the step-4 preview follows the select) */
  get th() { return THEMES[this.cfg.render.theme] || THEMES.broadcast; }
  /** floor-ring colour: the player's card colour, their team's colour, or the theme accent */
  ringColor(p) {
    const r = this.cfg.render;
    if (r.ringColor === 'team') return r.teamColors?.[p.team] || p.color;
    if (r.ringColor === 'theme') return this.th.accent;
    return p.color;
  }

  // ---------------------------------------------------------------- panel frame (cfg.render.frame)
  /** path of a panel: 'angled' = parallelogram when skew > 0 (else rounded by r), 'rounded' = pill, 'tech' = square */
  frame(ctx, x, y, w, h, { skew = 0, r = 8 } = {}) {
    const f = this.cfg.render.frame, s = this.s;
    ctx.beginPath();
    if (f === 'rounded') ctx.roundRect(x, y, w, h, Math.min(h / 2, 22 * s));
    else if (f === 'tech') ctx.rect(x, y, w, h);
    else if (skew) { ctx.moveTo(x + skew, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - skew, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
    else ctx.roundRect(x, y, w, h, r * s);
  }
  /** fill a strip inside the panel frame (accent bars), clipped so it follows rounded corners */
  frameFill(ctx, box, opts, x, y, w, h) {
    ctx.save(); this.frame(ctx, ...box, opts); ctx.clip(); ctx.fillRect(x, y, w, h); ctx.restore();
  }
  /** 'tech' frame: glowing corner brackets */
  corners(ctx, x, y, w, h, col = this.th.accent) {
    if (this.cfg.render.frame !== 'tech') return;
    const s = this.s, L = Math.min(16 * s, w / 4, h / 3);
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(2.5 * s, 1.5); ctx.shadowColor = col; ctx.shadowBlur = 8 * s * this.th.glow;
    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) {
      ctx.beginPath(); ctx.moveTo(cx, cy + dy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * L, cy); ctx.stroke();
    }
    ctx.restore();
  }
  get angled() { return !this.cfg.render.frame || this.cfg.render.frame === 'angled'; }

  // ---------------------------------------------------------------- panel layout (user-placed in step 4)
  /** this stage's saved panel layout {topHud, playerPanel, courtMap} (may be undefined) */
  get layout() { return this.cfg.render[layoutKey(this.stage)]; }
  rankOf(kmh) { return speedRank(kmh, this.cfg.render.badge?.ranks); }
  /** seconds a speed badge stays up after the hit, fade included (pipeline passes it to shuttleStateAt) */
  get badgeSecs() { return (this.cfg.render.badge?.secs ?? 0.7) + BADGE_FADE; }
  /** size multiplier of a panel: layout[name].scale, else the stage default */
  scaleOf(name) { return Math.min(Math.max(this.layout?.[name]?.scale ?? this.defScale[name] ?? 1, 0.4), 2.5); }
  mapInner(s) {
    const longPx = 290 * s, shortPx = (longPx * COURT_W) / COURT_L;
    return this.court?.orientation === 'side' ? [longPx, shortPx] : [shortPx, longPx];
  }
  /**
   * [x, y, w, h] of a panel ('topHud' | 'playerPanel' | 'courtMap') in the output: the stage's default spot, or
   * layout[name] = {x, y, scale} with x, y = top-left as fractions of the output (resolution independent). Clamped.
   */
  rect(name, nPlayers = this.cfg.players.length, nTop = 3) {
    const s = this.s * this.scaleOf(name), m = 28 * this.s, W = this.OW, H = this.OH, [vx, vy, vw, vh] = this.video;
    let w, h;
    if (name === 'topHud') { w = nTop * 290 * s + (nTop - 1) * 16 * s; h = 96 * s; }
    else if (name === 'playerPanel') { w = 480 * s; h = 34 * s + 64 * s * nPlayers; }
    else if (name === 'speedBadge') { w = BADGE_W * s; h = BADGE_H * s; }
    else { const [mw, mh] = this.mapInner(s); w = mw + 44 * s; h = mh + 82 * s; }
    let x, y;
    if (name === 'speedBadge') { x = vx + vw - m - w; y = vy + vh * 0.3; }   // fixed-mode default: right side of the video
    else if (this.stage === 'landscape') {
      if (name === 'topHud') { x = vx + (vw - w) / 2; y = vy + vh + m; }
      else if (name === 'playerPanel') { x = W - m - w; y = m; }
      else {                                  // centred under the player panel
        const k = this.s * this.scaleOf('playerPanel');
        x = W - m - (480 * k + w) / 2; y = 2 * m + (34 + 64 * nPlayers) * k;
      }
    } else if (this.stage === 'portrait') {
      if (name === 'topHud') { x = (W - w) / 2; y = vy - m - h; }
      else if (name === 'playerPanel') { x = m; y = vy + vh + m; }
      else { x = W - m - w; y = vy + vh + m; }
    } else if (name === 'topHud') { x = (W - w) / 2; y = 24 * this.s; }
    else if (name === 'playerPanel') { x = m; y = H - m - h; }
    else { x = W - m - w; y = H - m - h; }
    const l = this.layout?.[name];
    if (l?.x != null) { x = l.x * W; y = l.y * H; }
    return [Math.min(Math.max(x, 0), Math.max(0, W - w)), Math.min(Math.max(y, 0), Math.max(0, H - h)), w, h];
  }

  // ---------------------------------------------------------------- floor ring
  projCircle(c, radius, pts = this.unit) {
    return pts.map(([ux, uy]) => this.court.toImg(c[0] + ux * radius, c[1] + uy * radius));
  }
  path(ctx, pts, close = true) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  }
  ring(ctx, p, t) {
    const s = this.s, col = this.ringColor(p), style = this.cfg.render.ringStyle;
    const outer = this.projCircle(p.pos, this.ringR);
    const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
    if (Math.max(...xs) - Math.min(...xs) > this.W || Math.max(...ys) - Math.min(...ys) > this.H) return;
    ctx.save();
    this.path(ctx, outer);
    if (style === 'minimal') {                       // one thin line, no fill / glow
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2 * s, 1.5); ctx.stroke();
      ctx.restore();
      return;
    }
    if (style === 'solid') {                         // filled disc + rim, no spinning arcs
      ctx.fillStyle = rgba(col, 0.45); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(4 * s, 2); ctx.stroke();
      this.path(ctx, this.projCircle(p.pos, this.ringR * 0.45));
      ctx.fillStyle = rgba(col, 0.6); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.fillStyle = rgba(col, 0.18); ctx.fill();
    ctx.shadowColor = col; ctx.shadowBlur = 18 * s;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(3 * s, 2); ctx.stroke();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    this.path(ctx, this.projCircle(p.pos, this.ringR * 0.7));
    ctx.strokeStyle = rgba(col, 0.7); ctx.lineWidth = Math.max(1.5 * s, 1); ctx.stroke();
    ctx.shadowColor = col; ctx.shadowBlur = 10 * s;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(3 * s, 2); ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      const a0 = ((t * 90 + k * 120) * Math.PI) / 180;
      const arc = Array.from({ length: 12 }, (_, i) => { const a = a0 + (i / 11) * (38 * Math.PI) / 180; return [Math.cos(a), Math.sin(a)]; });
      this.path(ctx, this.projCircle(p.pos, this.ringR * 1.22, arc), false);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- name tag
  tag(ctx, p, stats) {
    const s = this.s, col = p.color, frac = stats.staminaFrac(p.idx), num = stats.stamina(p.idx).toFixed(0);
    ctx.save();
    const fName = font(24 * s, FONT_THAI), fNum = font(32 * s, FONT_DISPLAY), fLbl = font(17 * s, FONT_DISPLAY);
    ctx.font = fName; const wName = ctx.measureText(p.name).width;
    ctx.font = fLbl; const wLbl = ctx.measureText('STA').width;
    ctx.font = fNum; const wNum = ctx.measureText(num).width;
    const pad = 12 * s, gap = 14 * s;
    const bw = Math.max(pad + 6 * s + wName + gap + wLbl + 5 * s + wNum + pad, 150 * s), bh = 54 * s, ah = 11 * s, aw = 18 * s;
    const cx = p.head[0];
    const x0 = Math.min(Math.max(cx - bw / 2, 4), this.W - bw - 4);
    const y0 = Math.max(p.head[1] - 10 * s - ah - bh, 4), y1 = y0 + bh, x1 = x0 + bw;

    this.frame(ctx, x0, y0, bw, bh, { r: 6 });
    ctx.fillStyle = `rgba(${this.th.panel},0.82)`; ctx.fill();
    ctx.strokeStyle = rgba(col, 0.7); ctx.lineWidth = Math.max(1.5 * s, 1); ctx.stroke();
    ctx.fillStyle = col; this.frameFill(ctx, [x0, y0, bw, bh], { r: 6 }, x0, y0 + 4 * s, 5 * s, bh - 8 * s);
    this.corners(ctx, x0, y0, bw, bh, col);
    const ax = Math.min(Math.max(cx, x0 + 10 * s), x1 - 10 * s);
    ctx.beginPath(); ctx.moveTo(ax - aw / 2, y1 + 1); ctx.lineTo(ax + aw / 2, y1 + 1); ctx.lineTo(ax, y1 + ah); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();

    const base = y0 + 30 * s;
    ctx.textBaseline = 'alphabetic';
    ctx.font = fName; ctx.fillStyle = this.th.text; ctx.fillText(p.name, x0 + pad + 6 * s, base);
    const nx = x1 - pad - wNum;
    ctx.font = fNum; ctx.fillStyle = col; ctx.fillText(num, nx, base + 2 * s);
    ctx.font = fLbl; ctx.fillStyle = this.th.muted; ctx.fillText('STA', nx - 5 * s - wLbl, base);

    const bx0 = x0 + pad + 6 * s, bx1 = x1 - pad, by = y1 - 14 * s;
    ctx.fillStyle = rgba(this.th.text, 0.18); ctx.fillRect(bx0, by, bx1 - bx0, 5 * s);
    ctx.fillStyle = frac < 0.3 ? LOW : col; ctx.fillRect(bx0, by, (bx1 - bx0) * frac, 5 * s);
    if (this.cfg.render.showIds && p.trackId != null) {
      ctx.font = fLbl; ctx.fillStyle = this.th.text; ctx.fillText(`#${p.trackId}`, x1 + 6 * s, y0 + 16 * s);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- top HUD
  topHud(ctx, sh, preview) {
    const s = this.s * this.scaleOf('topHud');
    const panels = [
      { label: 'RALLY TIME', value: sh?.rallyTime != null ? fmtTime(sh.rallyTime) : '--:--.--', unit: '', live: sh?.live },
      { label: 'RALLY COUNT', value: sh?.rallyCount != null ? String(sh.rallyCount) : '--', unit: 'SHOT' },
      { label: 'SHOT SPEED', value: sh?.lastSpeed != null ? String(sh.lastSpeed) : '--', unit: sh?.lastSpeed != null ? `KM/H ${this.rankOf(sh.lastSpeed).rank}` : 'KM/H', note: 'EST.' },
    ];
    if (sh?.score) panels.unshift({ label: 'SCORE A - B', value: `${sh.score.A} - ${sh.score.B}`, unit: '' });
    if (preview) panels[0].value = 'ANALYZING';
    const pw = 290 * s, ph = 96 * s, gap = 16 * s, skew = 18 * s;
    let [x, y] = this.rect('topHud', 0, panels.length);
    ctx.save();
    for (const pnl of panels) {
      this.frame(ctx, x, y, pw, ph, { skew });
      ctx.fillStyle = `rgba(${this.th.panel},0.8)`; ctx.fill();
      ctx.strokeStyle = rgba(this.th.accent, 0.25); ctx.lineWidth = 1; ctx.stroke();
      // accent line along the bottom edge
      ctx.save();
      ctx.shadowColor = this.th.accent; ctx.shadowBlur = 10 * s * this.th.glow;
      ctx.fillStyle = this.th.accent;
      if (this.angled) {
        ctx.beginPath();
        ctx.moveTo(x + 4 * s, y + ph - 4 * s); ctx.lineTo(x + pw - skew - 2 * s, y + ph - 4 * s);
        ctx.lineTo(x + pw - skew - 2.6 * s, y + ph); ctx.lineTo(x + 3.4 * s, y + ph); ctx.closePath(); ctx.fill();
      } else this.frameFill(ctx, [x, y, pw, ph], {}, x, y + ph - 4 * s, pw, 4 * s);
      ctx.restore();
      this.corners(ctx, x, y, pw, ph);

      const cx = x + pw / 2;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = font(21 * s, FONT_DISPLAY); ctx.fillStyle = this.th.muted;
      ctx.letterSpacing = `${2 * s}px`;
      ctx.fillText(pnl.label + (pnl.note ? ` (${pnl.note})` : ''), cx, y + 28 * s);
      if (pnl.live) {                                  // pulsing live dot
        ctx.save(); ctx.fillStyle = '#FF3D3D'; ctx.shadowColor = '#FF3D3D'; ctx.shadowBlur = 8 * s;
        ctx.beginPath(); ctx.arc(x + skew + 16 * s, y + 21 * s, 5 * s, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      ctx.letterSpacing = '0px';
      ctx.font = font(54 * s, FONT_DISPLAY);
      const vw = ctx.measureText(pnl.value).width;
      ctx.font = font(22 * s, FONT_DISPLAY);
      const uw = pnl.unit ? ctx.measureText(pnl.unit).width + 8 * s : 0;
      const vx = cx - (vw + uw) / 2;
      ctx.textAlign = 'left';
      ctx.font = font(54 * s, FONT_DISPLAY); ctx.fillStyle = this.th.text; ctx.fillText(pnl.value, vx, y + 80 * s);
      if (pnl.unit) { ctx.font = font(22 * s, FONT_DISPLAY); ctx.fillStyle = this.th.accent; ctx.fillText(pnl.unit, vx + vw + 8 * s, y + 80 * s); }
      x += pw + gap;
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- bottom-left player panel
  playerPanel(ctx, players, stats) {
    const s = this.s * this.scaleOf('playerPanel'), n = players.length;
    const headH = 34 * s, rowH = 64 * s;
    const [x0, y0, w] = this.rect('playerPanel', n);
    const colMove = x0 + 360 * s, colSta = x0 + w - 18 * s;
    ctx.save();
    const box = [x0, y0, w, headH + rowH * n];
    this.frame(ctx, ...box);
    ctx.fillStyle = `rgba(${this.th.panel},0.8)`; ctx.fill();
    ctx.fillStyle = this.th.accent; this.frameFill(ctx, box, {}, x0, y0, w, 3 * s);
    this.corners(ctx, ...box);
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(21 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`;
    ctx.fillStyle = this.th.text; ctx.textAlign = 'left'; ctx.fillText('PLAYERS', x0 + 18 * s, y0 + 25 * s);
    ctx.fillStyle = this.th.muted; ctx.textAlign = 'right';
    ctx.fillText('MOVE', colMove, y0 + 25 * s); ctx.fillText('STA', colSta, y0 + 25 * s);
    ctx.letterSpacing = '0px';

    const sorted = [...players].sort((a, b) => String(a.team).localeCompare(String(b.team)) || a.idx - b.idx);
    sorted.forEach((p, i) => {
      const ry = y0 + headH + i * rowH, col = p.color, frac = stats.staminaFrac(p.idx);
      if (i % 2 === 0) { ctx.fillStyle = rgba(this.th.text, 0.05); this.frameFill(ctx, box, {}, x0, ry, w, rowH); }
      if (i > 0 && sorted[i - 1].team !== p.team) { ctx.fillStyle = rgba(this.th.accent, 0.35); ctx.fillRect(x0 + 12 * s, ry, w - 24 * s, 1.5 * s); }
      ctx.fillStyle = col; ctx.fillRect(x0 + 10 * s, ry + 10 * s, 5 * s, rowH - 20 * s);
      // team badge
      ctx.font = font(18 * s, FONT_DISPLAY); ctx.textAlign = 'center';
      roundRect(ctx, x0 + 24 * s, ry + 12 * s, 22 * s, 20 * s, 3 * s);
      ctx.fillStyle = rgba(col, 0.22); ctx.fill();
      ctx.fillStyle = col; ctx.fillText(String(p.team || '').slice(0, 2), x0 + 35 * s, ry + 28.5 * s);
      // avatar + name
      let nx = x0 + 56 * s;
      const av = this.avatars[p.idx];
      if (av?.complete && av.naturalWidth) {
        const a = 34 * s, ax = x0 + 54 * s, ay = ry + 7 * s;
        ctx.save(); roundRect(ctx, ax, ay, a, a, 6 * s); ctx.clip(); ctx.drawImage(av, ax, ay, a, a); ctx.restore();
        roundRect(ctx, ax, ay, a, a, 6 * s); ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5 * s, 1); ctx.stroke();
        nx = ax + a + 10 * s;
      }
      ctx.textAlign = 'left'; ctx.font = font(24 * s, FONT_THAI); ctx.fillStyle = this.th.text;
      ctx.fillText(p.name, nx, ry + 31 * s, colMove - nx - 70 * s);
      // segmented stamina bar
      const segs = 12, sw = 16 * s, sg = 3 * s, bx = x0 + 24 * s, by = ry + 46 * s, lit = Math.round(frac * segs);
      for (let k = 0; k < segs; k++) {
        ctx.fillStyle = k < lit ? (frac < 0.3 ? LOW : col) : rgba(this.th.text, 0.14);
        ctx.beginPath(); ctx.moveTo(bx + k * (sw + sg) + 3 * s, by); ctx.lineTo(bx + k * (sw + sg) + sw + 3 * s, by);
        ctx.lineTo(bx + k * (sw + sg) + sw, by + 8 * s); ctx.lineTo(bx + k * (sw + sg), by + 8 * s); ctx.closePath(); ctx.fill();
      }
      // MOVE + STA
      ctx.textAlign = 'right';
      ctx.font = font(18 * s, FONT_DISPLAY); ctx.fillStyle = this.th.muted; ctx.fillText('M', colMove, ry + 40 * s);
      const mw = ctx.measureText('M').width + 5 * s;
      ctx.font = font(34 * s, FONT_DISPLAY); ctx.fillStyle = this.th.text;
      ctx.fillText(stats.distance(p.idx).toFixed(1), colMove - mw, ry + 40 * s);
      ctx.fillStyle = frac < 0.3 ? LOW : col; ctx.fillText(stats.stamina(p.idx).toFixed(0), colSta, ry + 40 * s);
    });
    ctx.restore();
  }

  // ---------------------------------------------------------------- bottom-right court map
  courtMap(ctx, shown) {
    const s = this.s * this.scaleOf('courtMap'), side = this.court.orientation === 'side';
    const [mw, mh] = this.mapInner(s);
    const pad = 22 * s, titleH = 38 * s;
    const [px0, py0, pw, ph] = this.rect('courtMap');
    const ox = px0 + pad, oy = py0 + titleH + pad;
    const toMap = (x, y) => {
      x = Math.min(Math.max(x, -0.8), COURT_W + 0.8); y = Math.min(Math.max(y, -0.8), COURT_L + 0.8);
      return side ? [ox + (y / COURT_L) * mw, oy + (x / COURT_W) * mh] : [ox + (x / COURT_W) * mw, oy + (y / COURT_L) * mh];
    };
    ctx.save();
    this.frame(ctx, px0, py0, pw, ph); ctx.fillStyle = `rgba(${this.th.panel},0.8)`; ctx.fill();
    ctx.fillStyle = this.th.accent; this.frameFill(ctx, [px0, py0, pw, ph], {}, px0, py0, pw, 3 * s);
    this.corners(ctx, px0, py0, pw, ph);
    ctx.font = font(24 * s, FONT_DISPLAY); ctx.fillStyle = this.th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = `${1.5 * s}px`; ctx.fillText('COURT MAP', px0 + pad, py0 + 28 * s); ctx.letterSpacing = '0px';
    const [ax, ay] = toMap(0, 0), [bx, by] = toMap(COURT_W, COURT_L);
    ctx.fillStyle = 'rgba(20,110,95,0.6)'; ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1.5 * s, 1);
    for (const [a, b] of courtLines()) { ctx.beginPath(); ctx.moveTo(...toMap(...a)); ctx.lineTo(...toMap(...b)); ctx.stroke(); }
    ctx.strokeStyle = this.th.accent; ctx.lineWidth = Math.max(2.5 * s, 2);
    ctx.beginPath(); ctx.moveTo(...toMap(-0.3, NET_Y)); ctx.lineTo(...toMap(COURT_W + 0.3, NET_Y)); ctx.stroke();
    for (const p of shown) {
      const [x, y] = toMap(...p.pos), r = 6.5 * s;
      ctx.fillStyle = rgba(p.color, 0.3); ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5 * s, 1); ctx.stroke();
    }
    ctx.restore();
  }

  debugIds(ctx, dets) {
    const s = this.s;
    ctx.save();
    this.court.drawLines(ctx, 'rgba(0,255,100,0.6)', 1);
    ctx.font = font(22 * s, FONT_DISPLAY); ctx.textBaseline = 'top';
    for (const d of dets) {
      const [x1, y1, x2, y2] = d.box;
      ctx.strokeStyle = 'rgba(200,200,200,0.8)'; ctx.lineWidth = 1; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = '#ff0'; ctx.beginPath(); ctx.arc(d.foot[0], d.foot[1], 4, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeText(`ID ${d.tid}`, x1 + 3, y2 + 2);
      ctx.fillStyle = '#fff'; ctx.fillText(`ID ${d.tid}`, x1 + 3, y2 + 2);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- shuttle: faint circle + speed badge (no trail: gaps
  // and interpolated jumps drew long straight lines that looked nothing like the flight; the LOCK ON brackets + label
  // were in the way)
  shuttle(ctx, sh, badge) {
    const s = this.s;
    if (sh.pos && this.cfg.render.shuttleMark !== false) {
      const [x, y] = sh.pos;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.strokeStyle = rgba(this.th.accent, 0.45);
      ctx.lineWidth = Math.max(1.5 * s, 1);
      ctx.beginPath(); ctx.arc(x, y, 13 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (badge && sh.speedLabel?.at) this.speedBadge(ctx, sh.speedLabel, sh.speedLabel.at);
  }

  // ---------------------------------------------------------------- highlight reel: clip banner + fade between clips
  /** clip: {index, total, shots, top (km/h | null)}; age / left = seconds since the clip start / until its end */
  highlight(ctx, clip, age, left) {
    const s = this.s, th = this.th, fade = 0.3;
    ctx.save();
    if (age < 2.4) {
      const a = Math.min(1, age / 0.25, (2.4 - age) / 0.4), slide = (1 - Math.min(1, age / 0.25)) * 60 * s;
      const title = `HIGHLIGHT ${clip.index}/${clip.total}`;
      const sub = `${clip.shots} SHOTS` + (clip.top != null ? `  ·  TOP ${clip.top} KM/H ${this.rankOf(clip.top).rank} (EST.)` : '');
      ctx.globalAlpha = a;
      ctx.font = font(46 * s, FONT_DISPLAY); ctx.letterSpacing = `${3 * s}px`; const tw = ctx.measureText(title).width;
      ctx.font = font(22 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`; const sw = ctx.measureText(sub).width;
      const pad = 22 * s, skew = 20 * s, w = Math.max(tw, sw) + pad * 2 + skew, h = 96 * s;
      const x = this.video[0] + 28 * this.s - slide, y = this.video[1] + this.video[3] * 0.36;
      this.frame(ctx, x, y, w, h, { skew });
      ctx.fillStyle = `rgba(${th.panel},0.88)`; ctx.fill();
      ctx.shadowColor = th.accent; ctx.shadowBlur = 14 * s * th.glow;
      ctx.fillStyle = th.accent; this.frameFill(ctx, [x, y, w, h], { skew }, x + (this.angled ? skew * 0.6 : 0), y, 6 * s, h);
      ctx.shadowBlur = 0;
      this.corners(ctx, x, y, w, h);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.font = font(46 * s, FONT_DISPLAY); ctx.letterSpacing = `${3 * s}px`; ctx.fillStyle = th.text;
      ctx.fillText(title, x + skew + pad, y + 50 * s);
      ctx.font = font(22 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`; ctx.fillStyle = th.accent;
      ctx.fillText(sub, x + skew + pad, y + 80 * s);
      ctx.letterSpacing = '0px';
    }
    const dark = Math.max(0, 1 - age / fade, 1 - left / fade);       // dip to black at the cuts
    if (dark > 0) { ctx.globalAlpha = dark; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.OW, this.OH); }
    ctx.restore();
  }

  // ---------------------------------------------------------------- speed badge: rank + km/h, pops in after a hit,
  // stays for cfg.render.badge.secs and fades. at = hit point (video px, mode 'hit': next to it, with a leader line);
  // no at = mode 'fixed': the 'speedBadge' panel spot (output px, placed in the step-4 layout editor)
  speedBadge(ctx, { speed, age }, at = null) {
    const rk = this.rankOf(speed), secs = this.cfg.render.badge?.secs ?? 0.7;
    const a = Math.max(0, 1 - Math.max(0, age - secs) / BADGE_FADE);
    if (a <= 0) return;
    const pop = age < 0.15 ? 1 + (1 - age / 0.15) * 0.45 : 1;
    const s = at ? this.s : this.s * this.scaleOf('speedBadge'), w = BADGE_W * s, h = BADGE_H * s;
    let bx, by;
    ctx.save();
    ctx.globalAlpha = a;
    if (at) {
      const [x, y] = at;
      bx = x + 34 * s; by = y - h - 30 * s;                         // up-right of the hit, flipped to stay in frame
      if (bx + w > this.W - 12 * s) bx = x - 34 * s - w;
      if (by < 12 * s) by = y + 30 * s;
      if (by + h > this.H - 12 * s) by = this.H - 12 * s - h;
      // impact burst for the top tiers
      if (['S', 'SS', 'SSS'].includes(rk.rank) && age < 0.35) {
        const u = age / 0.35, n = rk.rank === 'S' ? 10 : 16;
        ctx.strokeStyle = rk.color; ctx.lineWidth = 3 * s * (1 - u); ctx.shadowColor = rk.color; ctx.shadowBlur = 14 * s;
        for (let k = 0; k < n; k++) {
          const th = (k / n) * Math.PI * 2 + 0.3, r0 = (26 + 40 * u) * s, r1 = (40 + 80 * u) * s;
          ctx.beginPath(); ctx.moveTo(x + Math.cos(th) * r0, y + Math.sin(th) * r0); ctx.lineTo(x + Math.cos(th) * r1, y + Math.sin(th) * r1); ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }
      // leader line from the hit to the badge
      ctx.strokeStyle = rk.color; ctx.lineWidth = 1.5 * s;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx + (bx > x ? 0 : w), by + h / 2); ctx.stroke();
    } else [bx, by] = this.rect('speedBadge');
    const num = String(speed), skew = 12 * s, rb = 64 * s, pad = 14 * s;
    ctx.font = font(52 * s, FONT_DISPLAY); const tw = ctx.measureText(num).width;
    ctx.translate(bx + w / 2, by + h / 2); ctx.scale(pop, pop); ctx.translate(-w / 2, -h / 2);
    this.frame(ctx, 0, 0, w, h, { skew }); ctx.fillStyle = `rgba(${this.th.panel},0.88)`; ctx.fill();
    ctx.strokeStyle = rgba(rk.color, 0.7); ctx.lineWidth = 1.5 * s; ctx.stroke();
    ctx.fillStyle = rk.color; ctx.shadowColor = rk.color; ctx.shadowBlur = 18 * s;
    if (this.angled) { this.frame(ctx, 0, 0, rb, h, { skew }); ctx.fill(); }      // rank block
    else this.frameFill(ctx, [0, 0, w, h], {}, 0, 0, rb, h);
    ctx.shadowBlur = 0;
    this.corners(ctx, 0, 0, w, h, rk.color);
    ctx.fillStyle = `rgb(${DARK})`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = font([54, 44, 34][rk.rank.length - 1] * s, FONT_DISPLAY); ctx.fillText(rk.rank, rb / 2 + 2 * s, h / 2 + [19, 16, 12][rk.rank.length - 1] * s);
    ctx.textAlign = 'left';
    const tx = rb + pad;
    ctx.font = font(52 * s, FONT_DISPLAY); ctx.fillStyle = this.th.text; ctx.fillText(num, tx, 46 * s);
    ctx.font = font(17 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`;
    ctx.fillStyle = rk.color; ctx.fillText('KM/H EST', tx + tw + 8 * s, 44 * s);
    ctx.fillText(rk.name, tx, 64 * s);
    ctx.restore();
  }
}
