// Interactive frame view: court calibration (click/drag 4 corners) and player assignment (click a box).
import { Court } from './court.js';

const LABELS = ['ซ้ายบน', 'ขวาบน', 'ขวาล่าง', 'ซ้ายล่าง'];

export class Stage {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.mode = 'calibrate';
    this.frame = null;
    this.points = [];
    this.orientation = 'behind';
    this.dets = [];
    this.labels = new Map();     // det index -> {name, color}
    this.onPickDet = null;
    this.drag = -1;
    this.padPx = 0;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    window.addEventListener('pointerup', () => { if (this.drag >= 0) { this.drag = -1; this.onChange?.(); } });
  }

  get pad() { return this.mode === 'calibrate' ? this.padPx : 0; }
  // border wide enough for off-frame corners; only refit outside a drag so the canvas doesn't resize under the pointer
  fitPad() {
    const f = this.frame;
    if (!f) return;
    let need = 0.12 * Math.max(f.width, f.height);
    for (const [x, y] of this.points) need = Math.max(need, -x, -y, x - f.width, y - f.height);
    this.padPx = Math.round(need + 0.03 * f.height);
  }

  setFrame(frame) {
    this.frame = frame;
    this.fitPad();
    this.draw();
  }
  setMode(mode) { this.mode = mode; this.fitPad(); this.draw(); }

  toImage(e) {
    const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / r.width;
    return [(e.clientX - r.left) * k - this.pad, (e.clientY - r.top) * k - this.pad];
  }
  hitRadius() { return 14 * this.canvas.width / this.canvas.getBoundingClientRect().width; }

  down(e) {
    if (!this.frame) return;
    const [x, y] = this.toImage(e);
    if (this.mode === 'calibrate') {
      const i = this.points.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < this.hitRadius());
      if (i >= 0) { this.drag = i; this.canvas.setPointerCapture(e.pointerId); return; }
      if (this.points.length < 4) { this.points.push([x, y]); this.draw(); this.onChange?.(); return; }
      // all 4 set: snap the nearest corner to the click and keep dragging it
      let near = 0;
      this.points.forEach((p, j) => { if (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(this.points[near][0] - x, this.points[near][1] - y)) near = j; });
      this.points[near] = [x, y]; this.drag = near; this.canvas.setPointerCapture(e.pointerId); this.draw();
    } else if (this.mode === 'assign') {
      let best = -1, area = Infinity;
      this.dets.forEach((d, i) => {
        const [x1, y1, x2, y2] = d.box, a = (x2 - x1) * (y2 - y1);
        if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && a < area) { best = i; area = a; }
      });
      if (best >= 0) this.onPickDet?.(best);
    }
  }
  move(e) {
    if (this.drag < 0) return;
    this.points[this.drag] = this.toImage(e);
    this.draw();
  }

  undo() { this.points.pop(); this.draw(); this.onChange?.(); }
  reset() { this.points = []; this.fitPad(); this.draw(); this.onChange?.(); }

  court() {
    if (this.points.length !== 4) return null;
    try { return new Court(this.points, this.orientation); } catch { return null; }
  }

  draw() {
    const f = this.frame, ctx = this.ctx;
    if (!f) return;
    const pad = this.pad, W = f.width + pad * 2, H = f.height + pad * 2;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(f, pad, pad);
    const s = f.height / 720;
    ctx.save();
    ctx.translate(pad, pad);
    if (this.mode === 'calibrate') {
      const court = this.court();
      if (court) court.drawLines(ctx, '#39ff88', 2 * s);
      ctx.font = `${Math.round(20 * s)}px "Kanit", sans-serif`;
      this.points.forEach(([x, y], i) => {
        ctx.fillStyle = '#00E5FF'; ctx.strokeStyle = '#04121f'; ctx.lineWidth = 3 * s;
        ctx.beginPath(); ctx.arc(x, y, 9 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 4 * s;
        ctx.strokeText(`${i + 1} ${LABELS[i]}`, x + 13 * s, y - 12 * s); ctx.fillText(`${i + 1} ${LABELS[i]}`, x + 13 * s, y - 12 * s);
      });
    } else if (this.mode === 'assign') {
      ctx.font = `${Math.round(22 * s)}px "Kanit", sans-serif`;
      this.dets.forEach((d, i) => {
        const [x1, y1, x2, y2] = d.box, lab = this.labels.get(i);
        ctx.lineWidth = 3 * s; ctx.strokeStyle = lab ? lab.color : 'rgba(255,255,255,0.7)';
        ctx.setLineDash(lab ? [] : [8 * s, 6 * s]); ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); ctx.setLineDash([]);
        if (lab) {
          const tw = ctx.measureText(lab.name).width + 16 * s;
          ctx.fillStyle = lab.color; ctx.fillRect(x1, y1 - 32 * s, tw, 30 * s);
          ctx.fillStyle = '#04121f'; ctx.fillText(lab.name, x1 + 8 * s, y1 - 10 * s);
        }
      });
    }
    ctx.restore();
  }
}
