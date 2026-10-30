// Export helpers: TXT, SRT, Word (.doc via HTML), JSON project.

export function fmtTime(sec, withMs = false) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base},${String(Math.round((sec % 1) * 1000) % 1000).padStart(3, '0')}` : base;
}

/** Merge consecutive turns by the same speaker into paragraphs. */
export function paragraphs(state) {
  const out = [];
  for (const t of state.turns) {
    const text = (t.text || '').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.spk === t.spk) { last.text += ' ' + text; last.end = t.end; }
    else out.push({ spk: t.spk, start: t.start, end: t.end, text });
  }
  return out;
}

const nameOf = (state, spk) => state.speakers.find((s) => s.id === spk)?.name || `ผู้พูด ${spk + 1}`;

export function toTxt(state) {
  const head = `${state.fileName || 'บทสนทนา'}\nผู้พูด ${state.speakers.length} คน\n\n`;
  return head + paragraphs(state).map((p) => `[${fmtTime(p.start)}] ${nameOf(state, p.spk)}: ${p.text}`).join('\n\n') + '\n';
}

export function toSrt(state) {
  return state.turns.filter((t) => (t.text || '').trim()).map((t, i) =>
    `${i + 1}\n${fmtTime(t.start, true)} --> ${fmtTime(t.end, true)}\n${nameOf(state, t.spk)}: ${t.text.trim()}\n`,
  ).join('\n');
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function toDoc(state) {
  const rows = paragraphs(state).map((p) => {
    const sp = state.speakers.find((s) => s.id === p.spk);
    return `<p style="margin:0 0 10pt"><span style="color:#888;font-size:10pt">[${fmtTime(p.start)}]</span> `
      + `<b style="color:${sp?.color || '#000'}">${esc(nameOf(state, p.spk))}:</b> ${esc(p.text)}</p>`;
  }).join('\n');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${esc(state.fileName || 'Transcript')}</title>
<style>body{font-family:"TH Sarabun New","Sarabun","Tahoma",sans-serif;font-size:16pt;line-height:1.4}</style></head>
<body><h2>${esc(state.fileName || 'บทสนทนา')}</h2>
<p style="color:#666">ผู้พูด ${state.speakers.length} คน · ความยาว ${fmtTime(state.duration || 0)}</p>
${rows}</body></html>`;
}

export function download(name, content, type) {
  const blob = new Blob([type.startsWith('text') || type.includes('msword') ? '﻿' : '', content], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
