import { STRING_NAMES } from './fretting.js';

// Render fretted notes as ASCII tab. Notes are laid out sequentially; a time
// gap noticeably longer than usual gets extra dashes so phrasing stays
// readable. Lines wrap at NOTES_PER_LINE columns, each block prefixed with the
// timestamp of its first note.

const NOTES_PER_LINE = 16;

export function renderTab(notes) {
  if (notes.length === 0) return 'ไม่พบโน้ต — ลองเพิ่มความไวการจับโน้ต';

  const gaps = [];
  for (let i = 1; i < notes.length; i++) {
    gaps.push(notes[i].startTimeSeconds - notes[i - 1].startTimeSeconds);
  }
  const medianGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0.25;

  const blocks = [];
  for (let start = 0; start < notes.length; start += NOTES_PER_LINE) {
    const chunk = notes.slice(start, start + NOTES_PER_LINE);
    blocks.push(renderBlock(chunk, medianGap));
  }
  return blocks.join('\n');
}

function renderBlock(notes, medianGap) {
  const lines = STRING_NAMES.map(() => '');
  // Display order: high e on top.
  const rowForString = (s) => 5 - s;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const label = String(note.fret);
    const longPause = i > 0 && notes[i].startTimeSeconds - notes[i - 1].startTimeSeconds > medianGap * 1.8;
    const pad = longPause ? '-----' : '--';
    const width = pad.length + label.length;
    for (let s = 0; s < 6; s++) {
      if (rowForString(note.string) === s) {
        lines[s] += pad + label;
      } else {
        lines[s] += '-'.repeat(width);
      }
    }
  }

  const names = ['e', 'B', 'G', 'D', 'A', 'E'];
  const stamp = formatTime(notes[0].startTimeSeconds);
  const body = lines.map((l, s) => `${names[s]}|${l}--|`).join('\n');
  return `[${stamp}]\n${body}\n`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
