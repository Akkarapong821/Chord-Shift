// Scale notes of the current key laid out on the guitar neck.
//
// Positions are what the player fingers: with a capo on fret c, a note shown
// at absolute fret c + f is named as the shape key's note at "fret f", so the
// labels line up with the chord shapes on the sheet. (A tuned-down guitar
// shifts every string equally, so fingerings and labels don't change.)
// Notes are spelled with one letter per scale degree (F# major has E#, not F).
//
// Pure functions only — renderFretboardSVG returns an SVG string.

import { mod12, parseNote } from './theory.js';

const OPEN_PCS = [4, 9, 2, 7, 11, 4]; // low E .. high e
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

// steps: semitones above the tonic; degrees: index into the 7-note parent
// scale (for spelling) and the label shown in degree mode.
export const SCALES = {
  major: { name: 'เมเจอร์', minor: false, steps: [0, 2, 4, 5, 7, 9, 11], degrees: [0, 1, 2, 3, 4, 5, 6], labels: ['1', '2', '3', '4', '5', '6', '7'] },
  minor: { name: 'ไมเนอร์', minor: true, steps: [0, 2, 3, 5, 7, 8, 10], degrees: [0, 1, 2, 3, 4, 5, 6], labels: ['1', '2', 'b3', '4', '5', 'b6', 'b7'] },
  majorPent: { name: 'เมเจอร์เพนทาโทนิก', minor: false, steps: [0, 2, 4, 7, 9], degrees: [0, 1, 2, 4, 5], labels: ['1', '2', '3', '5', '6'] },
  minorPent: { name: 'ไมเนอร์เพนทาโทนิก', minor: true, steps: [0, 3, 5, 7, 10], degrees: [0, 2, 3, 4, 6], labels: ['1', 'b3', '4', '5', 'b7'] },
};

// Tonic name as written ('F#', 'Db', 'Bb') -> spelled notes of the scale.
// scaleNotes('F#', 'major') -> [{ pc: 6, name: 'F#', label: '1' }, ... { pc: 5, name: 'E#', label: '7' }]
export function scaleNotes(tonicName, scaleKey) {
  const scale = SCALES[scaleKey];
  const tonic = parseNote(tonicName);
  const letter0 = LETTERS.indexOf(tonicName[0]);
  return scale.steps.map((step, i) => {
    const pc = mod12(tonic + step);
    const letter = (letter0 + scale.degrees[i]) % 7;
    let diff = mod12(pc - LETTER_PC[letter]);
    if (diff > 6) diff -= 12;
    const acc = diff > 0 ? '#'.repeat(diff) : 'b'.repeat(-diff);
    return { pc, name: LETTERS[letter] + acc, label: scale.labels[i], root: i === 0 };
  });
}

// Every scale note between the capo and lastFret.
// -> [{ string: 0..5 (0 = low E), fret (absolute), name, label, root }]
export function fretboardPositions({ tonicName, scaleKey, capo = 0, lastFret = 15 }) {
  const notes = scaleNotes(tonicName, scaleKey);
  const byPc = new Map(notes.map((n) => [n.pc, n]));
  const out = [];
  for (let s = 0; s < 6; s++) {
    for (let fret = capo; fret <= lastFret; fret++) {
      // Name relative to the capo, i.e. as the chord shapes are named.
      const note = byPc.get(mod12(OPEN_PCS[s] + fret - capo));
      if (note) out.push({ string: s, fret, ...note });
    }
  }
  return out;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Neck drawing: high e on top (like tab), open-string column, frets 1..lastFret,
// inlay dots, fret numbers, optional capo bar. labelMode: 'name' | 'degree'.
export function renderFretboardSVG({ tonicName, scaleKey, capo = 0, lastFret = 15, labelMode = 'name' }) {
  const openW = 34;
  const fretW = 50;
  const top = 14;
  const gap = 24;
  const left = 22;
  const nutX = left + openW;
  const W = nutX + fretW * lastFret + 12;
  const H = top + gap * 5 + 38;
  const y = (s) => top + (5 - s) * gap; // string 5 (high e) on top
  const fretX = (f) => nutX + f * fretW; // wire after fret f
  const noteX = (f) => (f === 0 ? left + openW / 2 : fretX(f) - fretW / 2);
  const parts = [];

  // Inlays
  for (const f of [3, 5, 7, 9, 15, 17, 19, 21]) {
    if (f <= lastFret) parts.push(`<circle cx="${noteX(f)}" cy="${top + gap * 2.5}" r="5" fill="currentColor" opacity="0.18"/>`);
  }
  if (lastFret >= 12) {
    for (const k of [1.5, 3.5]) parts.push(`<circle cx="${noteX(12)}" cy="${top + gap * k}" r="5" fill="currentColor" opacity="0.18"/>`);
  }
  // Frets, nut, strings
  for (let f = 1; f <= lastFret; f++) {
    parts.push(`<line x1="${fretX(f)}" y1="${top}" x2="${fretX(f)}" y2="${y(0)}" stroke="currentColor" stroke-width="1.5" opacity="0.45"/>`);
  }
  parts.push(`<line x1="${nutX}" y1="${top - 2}" x2="${nutX}" y2="${y(0) + 2}" stroke="currentColor" stroke-width="5"/>`);
  for (let s = 0; s < 6; s++) {
    parts.push(`<line x1="${left}" y1="${y(s)}" x2="${fretX(lastFret)}" y2="${y(s)}" stroke="currentColor" stroke-width="${1 + (5 - s) * 0.25}" opacity="0.6"/>`);
  }
  // Below-capo area is unplayable: dim it, draw the capo on that fret.
  if (capo > 0) {
    parts.push(`<rect x="${left}" y="${top - 6}" width="${fretX(capo) - fretW / 2 - 10 - left}" height="${gap * 5 + 12}" fill="var(--fb-shade, #000)" opacity="0.45"/>`);
    parts.push(`<rect x="${fretX(capo) - fretW / 2 - 12}" y="${top - 8}" width="9" height="${gap * 5 + 16}" rx="4" fill="var(--fb-capo, #888)"/>`);
  }
  // Fret numbers
  for (let f = 0; f <= lastFret; f++) {
    if (f === 0 || [3, 5, 7, 9, 12, 15, 17, 19, 21].includes(f) || f === capo) {
      parts.push(`<text x="${noteX(f)}" y="${y(0) + 28}" text-anchor="middle" font-size="12" fill="currentColor" opacity="${f === capo && capo ? 1 : 0.6}">${f}</text>`);
    }
  }
  // Notes
  for (const p of fretboardPositions({ tonicName, scaleKey, capo, lastFret })) {
    const cx = noteX(p.fret);
    const cy = y(p.string);
    const text = labelMode === 'degree' ? p.label : p.name;
    parts.push(
      p.root
        ? `<circle cx="${cx}" cy="${cy}" r="11" fill="var(--fb-root, #e8a33d)"/>`
        : `<circle cx="${cx}" cy="${cy}" r="11" fill="var(--fb-note-bg, #27221d)" stroke="var(--fb-note, currentColor)" stroke-width="1.5"/>`,
    );
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="${text.length > 2 ? 9 : 11}" font-weight="700" fill="${p.root ? 'var(--fb-root-text, #1a1408)' : 'currentColor'}">${escapeXml(text)}</text>`);
  }

  const label = `โน้ตสเกล ${tonicName} ${SCALES[scaleKey].name} บนคอกีตาร์`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(label)}" font-family="system-ui, sans-serif">${parts.join('')}</svg>`;
}
