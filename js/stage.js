// Interactive frame view: court calibration (click/drag 4 corners) and player assignment (click a box).
import { Court, orderCorners } from './court.js';
import { t } from './i18n.js';

const MAX_PX = 2560 * 1440;   // display canvas cap: a 4K frame + border was ~16 M px (WebKit/iOS canvas memory limit)


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
    this.k = 1;                  // canvas px per frame px (< 1 for big frames, see MAX_PX)
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    window.addEventListener('pointerup', () => {
      if (this.drag < 0) return;
      this.drag = -1; this.points = orderCorners(this.points);   // any click order; saved as TL, TR, BR, BL
      this.draw(); this.onChange?.();
    });
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
    const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / this.k / r.width;
    return [(e.clientX - r.left) * k - this.pad, (e.clientY - r.top) * k - this.pad];
  }
  // image px per CSS px, so handles stay the same on-screen size on a phone and a desktop
  unit() { const w = this.canvas.getBoundingClientRect().width; return w ? this.canvas.width / this.k / w : 1; }
  hitRadius(e) { return (e.pointerType === 'touch' ? 28 : 14) * this.unit(); }

  down(e) {
    if (!this.frame) return;
    const [x, y] = this.toImage(e);
    if (this.mode === 'calibrate') {
      const i = this.points.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < this.hitRadius(e));
      if (i >= 0) { this.drag = i; this.canvas.setPointerCapture(e.pointerId); this.draw(); return; }
      if (this.points.length < 4) {
        // keep dragging the new corner too: on touch the finger covers it, the loupe shows where it lands
        this.points.push([x, y]); this.drag = this.points.length - 1; this.canvas.setPointerCapture(e.pointerId);
        this.draw(); this.onChange?.(); return;
      }
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
    this.k = Math.min(1, Math.sqrt(MAX_PX / (W * H)));   // drawing stays in frame px, scaled down to the canvas
    const cw = Math.round(W * this.k), ch = Math.round(H * this.k);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(f, pad, pad);
    const s = f.height / 720;
    ctx.save();
    ctx.translate(pad, pad);
    if (this.mode === 'calibrate') {
      const court = this.court(), u = this.unit();
      if (court) court.drawLines(ctx, '#39ff88', Math.max(2 * s, 1.5 * u));
      ctx.font = `${Math.round(13 * u)}px "Kanit", sans-serif`;
      const ord = orderCorners(this.points);   // corner names only once all 4 are set (click order is free)
      this.points.forEach(([x, y], i) => {
        ctx.fillStyle = i === this.drag ? '#ffc400' : '#00E5FF'; ctx.strokeStyle = '#04121f'; ctx.lineWidth = 2 * u;
        ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3 * u;
        const label = ord.length === 4 ? t(`corner.${ord.indexOf(this.points[i])}`) : String(i + 1);
        ctx.strokeText(label, x + 10 * u, y - 9 * u); ctx.fillText(label, x + 10 * u, y - 9 * u);
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
    if (this.mode === 'calibrate' && this.drag >= 0) this.drawLoupe(this.points[this.drag]);
  }

  // magnified view of the dragged corner, in the top corner away from it
  drawLoupe([x, y]) {
    const ctx = this.ctx, u = this.unit(), D = 120 * u, zoom = 3, r = D / 2 / zoom, m = 8 * u;
    const CW = this.canvas.width / this.k;
    const cx = x + this.pad < CW / 2 ? CW - m - D / 2 : m + D / 2, cy = m + D / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, D / 2, 0, Math.PI * 2); ctx.fillStyle = '#0b1220'; ctx.fill(); ctx.clip();
    ctx.drawImage(this.frame, x - r, y - r, 2 * r, 2 * r, cx - D / 2, cy - D / 2, D, D);   // raw frame: the dot would hide the target
    ctx.restore();
    ctx.strokeStyle = '#ffc400'; ctx.lineWidth = 1.5 * u;
    ctx.beginPath(); ctx.moveTo(cx - D / 2, cy); ctx.lineTo(cx + D / 2, cy); ctx.moveTo(cx, cy - D / 2); ctx.lineTo(cx, cy + D / 2); ctx.stroke();
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.arc(cx, cy, D / 2, 0, Math.PI * 2); ctx.stroke();
  }
}
