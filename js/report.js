// After a render: per-player table + court-position heatmaps (step 4). Reads pipeline's result.report only.
import { COURT_L, COURT_W, NET_Y, courtLines } from './court.js';
import { t } from './i18n.js';

const CELL_W = 170, TOP = 34, PAD = 10;     // one court's width, the name strip above it, gap (canvas px)

/** One canvas: a court per player, shaded by where they stood. Far baseline at the top, as on the HUD's court map. */
export function drawHeatmaps(players) {
  const first = players[0]?.heat;
  if (!first) return null;
  const { nx, ny, cell, margin } = first, k = CELL_W / (nx * cell), H = Math.round(ny * cell * k);
  const c = document.createElement('canvas');
  c.width = players.length * (CELL_W + PAD) + PAD; c.height = H + TOP + PAD;
  const g = c.getContext('2d');
  g.fillStyle = '#081329'; g.fillRect(0, 0, c.width, c.height);
  const src = new OffscreenCanvas(nx, ny), sg = src.getContext('2d');
  players.forEach((p, i) => {
    const x0 = PAD + i * (CELL_W + PAD), y0 = TOP, X = x => x0 + (x + margin) * k, Y = y => y0 + (y + margin) * k;
    g.fillStyle = 'rgba(20,110,95,0.35)'; g.fillRect(X(0), Y(0), COURT_W * k, COURT_L * k);
    const img = sg.createImageData(nx, ny), max = Math.max(...p.heat.grid, 1);
    const [r, gr, b] = [1, 3, 5].map(o => Number.parseInt(p.color.slice(o, o + 2), 16));
    p.heat.grid.forEach((v, j) => {
      img.data[j * 4] = r; img.data[j * 4 + 1] = gr; img.data[j * 4 + 2] = b;
      img.data[j * 4 + 3] = Math.round(255 * Math.sqrt(v / max));   // sqrt: standing still would hide everything else
    });
    sg.putImageData(img, 0, 0);
    g.save();
    g.beginPath(); g.rect(x0, y0, CELL_W, H); g.clip();
    g.filter = `blur(${(0.3 * k).toFixed(1)}px)`; g.imageSmoothingEnabled = true;
    g.drawImage(src, x0, y0, CELL_W, H);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
    for (const [a, e] of courtLines()) { g.beginPath(); g.moveTo(X(a[0]), Y(a[1])); g.lineTo(X(e[0]), Y(e[1])); g.stroke(); }
    g.strokeStyle = '#00E5FF'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(-0.3), Y(NET_Y)); g.lineTo(X(COURT_W + 0.3), Y(NET_Y)); g.stroke();
    g.fillStyle = p.color; g.fillRect(x0, 10, 4, 16);
    g.fillStyle = '#e8f0ff'; g.font = '600 15px Kanit, sans-serif'; g.textBaseline = 'middle';
    g.fillText(p.name, x0 + 10, 18, CELL_W - 12);
  });
  return c;
}

const cell = text => { const td = document.createElement('td'); td.textContent = text; return td; };

/** Fills box with the table + heatmap; returns the heatmap canvas (for its download link) */
export function renderReport(box, report) {
  box.innerHTML = '';
  box.hidden = !report;
  if (!report) return null;
  const head = document.createElement('h3'); head.textContent = t('report.title');
  const table = document.createElement('table');
  const tr = document.createElement('tr');
  for (const k of ['report.player', 'report.move', 'report.avg', 'report.top', 'report.tracked']) {
    const th = document.createElement('th'); th.textContent = t(k); tr.appendChild(th);
  }
  table.appendChild(tr);
  for (const p of report.players) {
    const row = document.createElement('tr'), name = cell(p.name);
    name.style.borderLeft = `3px solid ${p.color}`;
    row.append(name, cell(p.distance.toFixed(1)), cell(p.avg.toFixed(2)), cell(p.top.toFixed(2)), cell(`${Math.round(p.seen * 100)}%`));
    table.appendChild(row);
  }
  const canvas = drawHeatmaps(report.players);
  const note = document.createElement('p'); note.className = 'hint';
  note.textContent = t(report.rallies ? 'report.noteRallies' : 'report.noteAll');
  box.append(head, table);
  if (canvas) box.append(canvas);
  box.append(note);
  return canvas;
}
