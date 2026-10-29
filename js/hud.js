// Canvas HUD renderer (broadcast / game style). Thai text renders natively via canvas + Kanit.
import { COURT_L, COURT_W, NET_Y, courtLines } from './court.js';

export const FONT_THAI = 'HUD Thai';        // Kanit SemiBold
export const FONT_DISPLAY = 'HUD Display';  // Bebas Neue (Latin/numbers only)
const NAVY = '8,18,40', CYAN = '#00E5FF', LOW = '#FF5252', MUTED = '#9FB4D0';

// shot-speed tiers (all EST.): game-style rank shown at the shuttle right after a hit
export const SPEED_RANKS = [
  { min: 200, rank: 'SS', name: 'MONSTER SMASH', color: '#FF3D7F' },
  { min: 150, rank: 'S', name: 'SMASH', color: '#FF9100' },
  { min: 100, rank: 'A', name: 'POWER SHOT', color: '#FFC400' },
  { min: 60, rank: 'B', name: 'DRIVE', color: '#7CFF4F' },
  { min: 0, rank: 'C', name: 'TOUCH', color: '#9FB4D0' },
];
export const speedRank = kmh => SPEED_RANKS.find(r => kmh >= r.min);

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
  constructor(cfg, court, width, height) {
    this.cfg = cfg;
    this.court = court;
    this.W = width; this.H = height;
    this.s = height / 1080;
    const r = cfg.render;
    this.ringR = r.ringRadiusM;
    this.unit = Array.from({ length: 73 }, (_, i) => [Math.cos((i / 72) * 2 * Math.PI), Math.sin((i / 72) * 2 * Math.PI)]);
    this.avatars = cfg.players.map(p => {
      if (!p.avatar) return null;
      const img = new Image(); img.src = p.avatar; return img;
    });
    this.ready = Promise.all(this.avatars.map(a => a?.decode().catch(() => null)));
  }

  /** st: {t, players:[{idx,name,color,team,pos,head,trackId,show}], stats, shuttle, dets, preview} */
  render(ctx, st) {
    const r = this.cfg.render;
    const shown = st.players.filter(p => p.show && p.pos && p.head);
    if (r.showIds && st.dets) this.debugIds(ctx, st.dets);
    for (const p of shown) this.ring(ctx, p, st.t);
    if (st.shuttle && r.shuttle) this.shuttle(ctx, st.shuttle, st.t);
    for (const p of [...shown].sort((a, b) => a.head[1] - b.head[1])) this.tag(ctx, p, st.stats);
    if (r.topHud) this.topHud(ctx, st.shuttle, st.preview);
    if (r.playerPanel) this.playerPanel(ctx, st.players, st.stats);
    if (r.courtMap) this.courtMap(ctx, shown);
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
    const s = this.s, col = p.color;
    const outer = this.projCircle(p.pos, this.ringR);
    const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
    if (Math.max(...xs) - Math.min(...xs) > this.W || Math.max(...ys) - Math.min(...ys) > this.H) return;
    ctx.save();
    this.path(ctx, outer);
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

    roundRect(ctx, x0, y0, bw, bh, 6 * s);
    ctx.fillStyle = `rgba(${NAVY},0.82)`; ctx.fill();
    ctx.strokeStyle = rgba(col, 0.7); ctx.lineWidth = Math.max(1.5 * s, 1); ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(x0, y0 + 4 * s, 5 * s, bh - 8 * s);
    const ax = Math.min(Math.max(cx, x0 + 10 * s), x1 - 10 * s);
    ctx.beginPath(); ctx.moveTo(ax - aw / 2, y1 + 1); ctx.lineTo(ax + aw / 2, y1 + 1); ctx.lineTo(ax, y1 + ah); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();

    const base = y0 + 30 * s;
    ctx.textBaseline = 'alphabetic';
    ctx.font = fName; ctx.fillStyle = '#fff'; ctx.fillText(p.name, x0 + pad + 6 * s, base);
    const nx = x1 - pad - wNum;
    ctx.font = fNum; ctx.fillStyle = col; ctx.fillText(num, nx, base + 2 * s);
    ctx.font = fLbl; ctx.fillStyle = MUTED; ctx.fillText('STA', nx - 5 * s - wLbl, base);

    const bx0 = x0 + pad + 6 * s, bx1 = x1 - pad, by = y1 - 14 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(bx0, by, bx1 - bx0, 5 * s);
    ctx.fillStyle = frac < 0.3 ? LOW : col; ctx.fillRect(bx0, by, (bx1 - bx0) * frac, 5 * s);
    if (this.cfg.render.showIds && p.trackId != null) {
      ctx.font = fLbl; ctx.fillStyle = '#fff'; ctx.fillText(`#${p.trackId}`, x1 + 6 * s, y0 + 16 * s);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- top HUD
  topHud(ctx, sh, preview) {
    const s = this.s;
    const panels = [
      { label: 'RALLY TIME', value: sh?.rallyTime != null ? fmtTime(sh.rallyTime) : '--:--.--', unit: '', live: sh?.live },
      { label: 'RALLY COUNT', value: sh?.rallyCount != null ? String(sh.rallyCount) : '--', unit: 'SHOT' },
      { label: 'SHOT SPEED', value: sh?.lastSpeed != null ? String(sh.lastSpeed) : '--', unit: sh?.lastSpeed != null ? `KM/H ${speedRank(sh.lastSpeed).rank}` : 'KM/H', note: 'EST.' },
    ];
    if (sh?.score) panels.unshift({ label: 'SCORE A - B', value: `${sh.score.A} - ${sh.score.B}`, unit: '' });
    if (preview) panels[0].value = 'ANALYZING';
    const pw = 290 * s, ph = 96 * s, gap = 16 * s, skew = 18 * s;
    const total = panels.length * pw + (panels.length - 1) * gap;
    let x = (this.W - total) / 2;
    const y = 24 * s;
    ctx.save();
    for (const pnl of panels) {
      ctx.beginPath();
      ctx.moveTo(x + skew, y); ctx.lineTo(x + pw, y); ctx.lineTo(x + pw - skew, y + ph); ctx.lineTo(x, y + ph); ctx.closePath();
      ctx.fillStyle = `rgba(${NAVY},0.8)`; ctx.fill();
      ctx.strokeStyle = 'rgba(0,229,255,0.25)'; ctx.lineWidth = 1; ctx.stroke();
      // cyan accent line
      ctx.save();
      ctx.shadowColor = CYAN; ctx.shadowBlur = 10 * s;
      ctx.fillStyle = CYAN;
      ctx.beginPath();
      ctx.moveTo(x + 4 * s, y + ph - 4 * s); ctx.lineTo(x + pw - skew - 2 * s, y + ph - 4 * s);
      ctx.lineTo(x + pw - skew - 2.6 * s, y + ph); ctx.lineTo(x + 3.4 * s, y + ph); ctx.closePath(); ctx.fill();
      ctx.restore();

      const cx = x + pw / 2;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = font(21 * s, FONT_DISPLAY); ctx.fillStyle = MUTED;
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
      ctx.font = font(54 * s, FONT_DISPLAY); ctx.fillStyle = '#fff'; ctx.fillText(pnl.value, vx, y + 80 * s);
      if (pnl.unit) { ctx.font = font(22 * s, FONT_DISPLAY); ctx.fillStyle = CYAN; ctx.fillText(pnl.unit, vx + vw + 8 * s, y + 80 * s); }
      x += pw + gap;
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- bottom-left player panel
  playerPanel(ctx, players, stats) {
    const s = this.s, n = players.length;
    const w = 480 * s, headH = 34 * s, rowH = 64 * s, m = 28 * s;
    const x0 = m, y0 = this.H - m - headH - rowH * n;
    const colMove = x0 + 360 * s, colSta = x0 + w - 18 * s;
    ctx.save();
    roundRect(ctx, x0, y0, w, headH + rowH * n, 8 * s);
    ctx.fillStyle = `rgba(${NAVY},0.8)`; ctx.fill();
    ctx.fillStyle = CYAN; ctx.fillRect(x0, y0, w, 3 * s);
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(21 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText('PLAYERS', x0 + 18 * s, y0 + 25 * s);
    ctx.fillStyle = MUTED; ctx.textAlign = 'right';
    ctx.fillText('MOVE', colMove, y0 + 25 * s); ctx.fillText('STA', colSta, y0 + 25 * s);
    ctx.letterSpacing = '0px';

    const sorted = [...players].sort((a, b) => String(a.team).localeCompare(String(b.team)) || a.idx - b.idx);
    sorted.forEach((p, i) => {
      const ry = y0 + headH + i * rowH, col = p.color, frac = stats.staminaFrac(p.idx);
      if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(x0, ry, w, rowH); }
      if (i > 0 && sorted[i - 1].team !== p.team) { ctx.fillStyle = 'rgba(0,229,255,0.35)'; ctx.fillRect(x0 + 12 * s, ry, w - 24 * s, 1.5 * s); }
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
      ctx.textAlign = 'left'; ctx.font = font(24 * s, FONT_THAI); ctx.fillStyle = '#fff';
      ctx.fillText(p.name, nx, ry + 31 * s, colMove - nx - 70 * s);
      // segmented stamina bar
      const segs = 12, sw = 16 * s, sg = 3 * s, bx = x0 + 24 * s, by = ry + 46 * s, lit = Math.round(frac * segs);
      for (let k = 0; k < segs; k++) {
        ctx.fillStyle = k < lit ? (frac < 0.3 ? LOW : col) : 'rgba(255,255,255,0.14)';
        ctx.beginPath(); ctx.moveTo(bx + k * (sw + sg) + 3 * s, by); ctx.lineTo(bx + k * (sw + sg) + sw + 3 * s, by);
        ctx.lineTo(bx + k * (sw + sg) + sw, by + 8 * s); ctx.lineTo(bx + k * (sw + sg), by + 8 * s); ctx.closePath(); ctx.fill();
      }
      // MOVE + STA
      ctx.textAlign = 'right';
      ctx.font = font(18 * s, FONT_DISPLAY); ctx.fillStyle = MUTED; ctx.fillText('M', colMove, ry + 40 * s);
      const mw = ctx.measureText('M').width + 5 * s;
      ctx.font = font(34 * s, FONT_DISPLAY); ctx.fillStyle = '#fff';
      ctx.fillText(stats.distance(p.idx).toFixed(1), colMove - mw, ry + 40 * s);
      ctx.fillStyle = frac < 0.3 ? LOW : col; ctx.fillText(stats.stamina(p.idx).toFixed(0), colSta, ry + 40 * s);
    });
    ctx.restore();
  }

  // ---------------------------------------------------------------- bottom-right court map
  courtMap(ctx, shown) {
    const s = this.s, side = this.court.orientation === 'side';
    const longPx = 290 * s, shortPx = (longPx * COURT_W) / COURT_L;
    const [mw, mh] = side ? [longPx, shortPx] : [shortPx, longPx];
    const pad = 22 * s, titleH = 38 * s, margin = 28 * s;
    const pw = mw + pad * 2, ph = mh + pad * 2 + titleH;
    const px0 = this.W - margin - pw, py0 = this.H - margin - ph, ox = px0 + pad, oy = py0 + titleH + pad;
    const toMap = (x, y) => {
      x = Math.min(Math.max(x, -0.8), COURT_W + 0.8); y = Math.min(Math.max(y, -0.8), COURT_L + 0.8);
      return side ? [ox + (y / COURT_L) * mw, oy + (x / COURT_W) * mh] : [ox + (x / COURT_W) * mw, oy + (y / COURT_L) * mh];
    };
    ctx.save();
    roundRect(ctx, px0, py0, pw, ph, 8 * s); ctx.fillStyle = `rgba(${NAVY},0.8)`; ctx.fill();
    ctx.fillStyle = CYAN; ctx.fillRect(px0, py0, pw, 3 * s);
    ctx.font = font(24 * s, FONT_DISPLAY); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = `${1.5 * s}px`; ctx.fillText('COURT MAP', px0 + pad, py0 + 28 * s); ctx.letterSpacing = '0px';
    const [ax, ay] = toMap(0, 0), [bx, by] = toMap(COURT_W, COURT_L);
    ctx.fillStyle = 'rgba(20,110,95,0.6)'; ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1.5 * s, 1);
    for (const [a, b] of courtLines()) { ctx.beginPath(); ctx.moveTo(...toMap(...a)); ctx.lineTo(...toMap(...b)); ctx.stroke(); }
    ctx.strokeStyle = CYAN; ctx.lineWidth = Math.max(2.5 * s, 2);
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

  // ---------------------------------------------------------------- shuttle: LOCK ON + speed badge (no trail: gaps and
  // interpolated jumps drew long straight lines that looked nothing like the flight)
  shuttle(ctx, sh, t) {
    const s = this.s;
    ctx.save();
    if (sh.pos) {
      const [x, y] = sh.pos, r = 22 * s, L = 9 * s, rot = t * 2.2;
      ctx.shadowColor = CYAN; ctx.shadowBlur = 10 * s;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.5 * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = CYAN; ctx.lineWidth = Math.max(2.2 * s, 1.5);
      ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.stroke();
      ctx.translate(x, y); ctx.rotate(Math.sin(rot) * 0.25);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {         // corner brackets
        ctx.beginPath();
        ctx.moveTo(sx * r, sy * (r - L)); ctx.lineTo(sx * r, sy * r); ctx.lineTo(sx * (r - L), sy * r);
        ctx.stroke();
      }
      ctx.rotate(-Math.sin(rot) * 0.25);
      ctx.shadowBlur = 0;
      ctx.font = font(16 * s, FONT_DISPLAY); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.letterSpacing = `${1.5 * s}px`;
      const label = 'LOCK ON', lw = ctx.measureText(label).width + 10 * s;
      ctx.fillStyle = `rgba(${NAVY},0.8)`; ctx.fillRect(r + 4 * s, -r - 2 * s, lw, 18 * s);
      ctx.fillStyle = CYAN; ctx.fillText(label, r + 9 * s, -r + 12 * s);
      ctx.letterSpacing = '0px';
    }
    ctx.restore();
    if (sh.pos && sh.speedLabel) this.speedBadge(ctx, sh.pos[0], sh.pos[1], sh.speedLabel);
  }

  // ---------------------------------------------------------------- speed badge: rank + km/h, pops in after a hit
  speedBadge(ctx, x, y, { speed, age }) {
    const s = this.s, rk = speedRank(speed);
    const a = Math.max(0, 1 - Math.max(0, age - 0.9) / 0.35);
    if (a <= 0) return;
    const pop = age < 0.15 ? 1 + (1 - age / 0.15) * 0.45 : 1;
    ctx.save();
    ctx.globalAlpha = a;
    // impact burst for the top tiers
    if (rk.min >= 150 && age < 0.35) {
      const u = age / 0.35, n = rk.rank === 'SS' ? 16 : 10;
      ctx.strokeStyle = rk.color; ctx.lineWidth = 3 * s * (1 - u); ctx.shadowColor = rk.color; ctx.shadowBlur = 14 * s;
      for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2 + 0.3, r0 = (26 + 40 * u) * s, r1 = (40 + 80 * u) * s;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(th) * r0, y + Math.sin(th) * r0); ctx.lineTo(x + Math.cos(th) * r1, y + Math.sin(th) * r1); ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
    const num = String(speed), skew = 12 * s, rb = 64 * s, h = 72 * s, pad = 14 * s;
    ctx.font = font(52 * s, FONT_DISPLAY); const tw = ctx.measureText(num).width;
    ctx.font = font(17 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`;
    const uw = ctx.measureText('KM/H EST').width, nw = ctx.measureText(rk.name).width;
    ctx.letterSpacing = '0px';
    const w = rb + pad + Math.max(tw + 8 * s + uw, nw) + pad + skew;
    let bx = x + 34 * s, by = y - h - 30 * s;                      // up-right of the shuttle, flipped to stay in frame
    if (bx + w > this.W - 12 * s) bx = x - 34 * s - w;
    if (by < 12 * s) by = y + 30 * s;
    if (by + h > this.H - 12 * s) by = this.H - 12 * s - h;
    // leader line from the shuttle to the badge
    ctx.strokeStyle = rk.color; ctx.lineWidth = 1.5 * s;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx + (bx > x ? 0 : w), by + h / 2); ctx.stroke();
    ctx.translate(bx + w / 2, by + h / 2); ctx.scale(pop, pop); ctx.translate(-w / 2, -h / 2);
    const para = (x0, w0) => { ctx.beginPath(); ctx.moveTo(x0 + skew, 0); ctx.lineTo(x0 + w0, 0); ctx.lineTo(x0 + w0 - skew, h); ctx.lineTo(x0, h); ctx.closePath(); };
    para(0, w); ctx.fillStyle = `rgba(${NAVY},0.88)`; ctx.fill();
    ctx.strokeStyle = rgba(rk.color, 0.7); ctx.lineWidth = 1.5 * s; ctx.stroke();
    para(0, rb); ctx.fillStyle = rk.color; ctx.shadowColor = rk.color; ctx.shadowBlur = 18 * s; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = `rgb(${NAVY})`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = font((rk.rank.length > 1 ? 44 : 54) * s, FONT_DISPLAY); ctx.fillText(rk.rank, rb / 2 + 2 * s, h / 2 + 19 * s);
    ctx.textAlign = 'left';
    const tx = rb + pad;
    ctx.font = font(52 * s, FONT_DISPLAY); ctx.fillStyle = '#fff'; ctx.fillText(num, tx, 46 * s);
    ctx.font = font(17 * s, FONT_DISPLAY); ctx.letterSpacing = `${2 * s}px`;
    ctx.fillStyle = rk.color; ctx.fillText('KM/H EST', tx + tw + 8 * s, 44 * s);
    ctx.fillText(rk.name, tx, 64 * s);
    ctx.restore();
  }
}
