// Step-4 HUD layout editor: drag panels to move them, drag the corner handle to resize. Draws on a canvas over a
// video frame with sample data; writes cfg.render.layout[name] = {x, y (top-left, fractions of the frame), scale}.
import { HudRenderer } from './hud.js';

const NAMES = ['topHud', 'playerPanel', 'courtMap'];
const HANDLE = 0.035;            // corner handle size, fraction of the frame height

export class LayoutEditor {
  /** onChange(layout) is called after each drag */
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.drag = null;
    this.active = false;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
  }

  /** frame: canvas of a video frame; cfg: app config (players, render toggles/layout, score); court: Court | null */
  async open(frame, cfg, court) {
    this.frame = frame; this.cfg = cfg; this.court = court;
    const c = this.canvas;
    c.width = frame.width; c.height = frame.height;
    this.hud = new HudRenderer(cfg, court, c.width, c.height);
    await this.hud.ready;
    this.active = true;
    c.style.touchAction = 'none';
    this.draw();
  }
  close() { this.active = false; this.drag = null; this.canvas.style.touchAction = ''; this.canvas.style.cursor = ''; }

  get scoring() { return !!(this.cfg.score?.enabled && this.cfg.render.shuttle); }
  rect(name) { return this.hud.rect(name, this.cfg.players.length, this.scoring ? 4 : 3); }   // 4 top panels with SCORE
  /** panels that are switched on, with their rectangles */
  rects() {
    const r = this.cfg.render;
    return NAMES.filter(n => r[n] && (n !== 'courtMap' || this.court)).map(n => ({ name: n, rect: this.rect(n) }));
  }

  draw() {
    if (!this.active) return;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height, u = H / 720;
    g.drawImage(this.frame, 0, 0, W, H);
    g.fillStyle = 'rgba(4,10,24,0.35)'; g.fillRect(0, 0, W, H);
    // sample data: names/colours/avatars from the cards, seeds on the court map, a 0-0 score when scoring is on
    const players = this.cfg.players.map((p, i) => ({ idx: i, name: p.name, color: p.color, team: p.team, pos: p.seed || null, head: null, show: true }));
    const stats = { distance: () => 0, stamina: () => 100, staminaFrac: () => 1 };
    const sh = { rallyTime: null, rallyCount: null, lastSpeed: null, live: false, score: this.scoring ? { A: 0, B: 0 } : null };
    const r = this.cfg.render;
    if (r.topHud) this.hud.topHud(g, sh, false);
    if (r.playerPanel) this.hud.playerPanel(g, players, stats);
    if (r.courtMap && this.court) this.hud.courtMap(g, players.filter(p => p.pos));
    // outlines + resize handles
    const hs = HANDLE * H;
    for (const { name, rect: [x, y, w, h] } of this.rects()) {
      const on = this.drag?.name === name;
      g.setLineDash([8 * u, 6 * u]); g.lineWidth = 2 * u;
      g.strokeStyle = on ? '#FFC400' : 'rgba(0,229,255,0.9)'; g.strokeRect(x, y, w, h);
      g.setLineDash([]);
      g.fillStyle = on ? '#FFC400' : '#00E5FF';
      g.beginPath(); g.moveTo(x + w, y + h - hs); g.lineTo(x + w, y + h); g.lineTo(x + w - hs, y + h); g.closePath(); g.fill();
    }
  }

  point(e) {
    const b = this.canvas.getBoundingClientRect();
    return [(e.clientX - b.left) * this.canvas.width / b.width, (e.clientY - b.top) * this.canvas.height / b.height];
  }
  /** topmost panel under p, and whether p is on its resize handle */
  hit([px, py]) {
    const hs = HANDLE * this.canvas.height * 1.6;
    for (const { name, rect: [x, y, w, h] } of this.rects().reverse()) {
      if (px >= x + w - hs && px <= x + w + 4 && py >= y + h - hs && py <= y + h + 4) return { name, resize: true };
      if (px >= x && px <= x + w && py >= y && py <= y + h) return { name, resize: false };
    }
    return null;
  }

  down(e) {
    if (!this.active) return;
    const p = this.point(e), h = this.hit(p);
    if (!h) return;
    const [x, y, w] = this.rect(h.name);
    this.drag = { ...h, start: p, x, y, w, scale: this.hud.scaleOf(h.name) };
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.draw();
  }
  move(e) {
    if (!this.active) return;
    const p = this.point(e);
    if (!this.drag) { const h = this.hit(p); this.canvas.style.cursor = h ? (h.resize ? 'nwse-resize' : 'move') : ''; return; }
    const d = this.drag, W = this.canvas.width, H = this.canvas.height, lay = this.cfg.render.layout;
    const cur = lay[d.name] || {};
    if (d.resize) {
      const scale = Math.min(Math.max(d.scale * (d.w + p[0] - d.start[0]) / d.w, 0.4), 2.5);
      lay[d.name] = { x: d.x / W, y: d.y / H, scale: +scale.toFixed(3) };       // keep the top-left fixed
    } else {
      lay[d.name] = { x: (d.x + p[0] - d.start[0]) / W, y: (d.y + p[1] - d.start[1]) / H, scale: cur.scale ?? d.scale };
    }
    this.draw();
  }
  up() {
    if (!this.drag) return;
    const name = this.drag.name, [x, y] = this.rect(name);   // store the clamped position
    const lay = this.cfg.render.layout;
    if (lay[name]) { lay[name].x = +(x / this.canvas.width).toFixed(4); lay[name].y = +(y / this.canvas.height).toFixed(4); }
    this.drag = null;
    this.draw();
    this.onChange?.(lay);
  }
}
