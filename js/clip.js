// Plays a span of the source video on a canvas with an overlay drawn on every frame (score review: watch a rally).
export class ClipPlayer {
  constructor(file, canvas, host) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.url = URL.createObjectURL(file);
    // must stay rendered for requestVideoFrameCallback; CSS keeps it invisible
    this.video = Object.assign(document.createElement('video'), { src: this.url, playsInline: true, preload: 'auto', className: 'clip-src' });
    host.appendChild(this.video);
    this.token = 0;
    this.span = null;
  }

  /** Play source seconds [t0, t1]; overlay(ctx, mediaTime) draws on top of each frame. Stops (paused) at t1. */
  async play(t0, t1, overlay) {
    const v = this.video, tok = ++this.token;
    this.span = { t0, t1, overlay, done: false };
    v.pause();
    v.currentTime = t0;
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    if (tok !== this.token) return;
    const step = (now, meta) => {
      if (tok !== this.token) return;
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      overlay?.(this.ctx, meta.mediaTime);
      if (meta.mediaTime >= t1) { v.pause(); this.span.done = true; return; }
      v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
    this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);   // first frame even if playback is blocked
    overlay?.(this.ctx, t0);
    await this.start();
  }

  // autoplay with sound needs a fresh user gesture (lost while seeking a long file): fall back to muted
  async start() {
    try { await this.video.play(); }
    catch (e) { if (e.name === 'NotAllowedError') { this.video.muted = true; await this.video.play().catch(() => {}); } }
  }

  /** Pause / resume; replays the span when it already finished. */
  toggle() {
    const v = this.video, sp = this.span;
    if (!sp) return;
    if (sp.done) this.play(sp.t0, sp.t1, sp.overlay);
    else if (v.paused) this.start();
    else v.pause();
  }

  destroy() {
    this.token++;
    this.video.pause();
    this.video.remove();
    URL.revokeObjectURL(this.url);
  }
}
