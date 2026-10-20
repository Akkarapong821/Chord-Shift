// Decide which OCR'd words on a chord sheet are chords.
//
// Tesseract (English model) reads the Latin chord names cleanly but turns Thai
// lyrics into garbage words with near-zero confidence. A word counts as a chord
// item when its text parses as a chord or as a bar sequence ('/D/D/G/Gm/',
// '|Am|F|'), it is confident enough, and it isn't glued to a garbage word on
// the same row (which would make it part of a lyric). Borderline words are
// returned as `recheck` so the caller can re-read just that box with a
// chord-only character whitelist. Rows mentioning tuning / capo / key become
// metadata instead of chords ('Tune down ½ tone to Eb' has an 'Eb' in it).
//
// Pure functions only — no DOM — so this runs under `node --test`.
// Word shape (Tesseract): { text, confidence, bbox: { x0, y0, x1, y1 } }.

import { isChord, parseTuning } from './theory.js';

const MIN_CONFIDENCE = 55;
const RECHECK_MIN_CONFIDENCE = 15;
const GARBAGE_CONFIDENCE = 45;

// Punctuation that may hug a chord ('(G)', 'Am,') — kept as separator tokens.
const EDGE_CHARS = '()[],.:;*';
const SEPARATORS = /([/|])/;

// --- Token parsing -----------------------------------------------------------

// 'Gm' -> { tokens: [{ type: 'chord', text: 'Gm' }] }
// '/D/D/G/Gm/' -> chords D D G Gm with '/' separators between them
// '(G)' -> '(' sep, 'G' chord, ')' sep. Not a chord item -> null.
export function parseChordText(text) {
  if (typeof text !== 'string') return null;
  let raw = text
    .trim()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    // Common OCR slip on small bold text: 'Bm' read as 'BMm'.
    .replace(/(^|[/|(])([A-G][#b]?)Mm(?![a-z])/g, '$1$2m');
  // In a bar line a capital J is always a misread '/' (no chord contains one).
  if (raw.includes('/')) raw = raw.replace(/J/g, '/').replace(/\/{2,}/g, '/');
  if (!raw) return null;

  let start = 0;
  let end = raw.length;
  while (start < end && EDGE_CHARS.includes(raw[start])) start++;
  while (end > start && EDGE_CHARS.includes(raw[end - 1])) end--;
  const core = raw.slice(start, end);
  if (!core) return null;

  const tokens = [];
  if (start > 0) tokens.push({ type: 'sep', text: raw.slice(0, start) });

  if (isChord(core) && !/^[/|]/.test(core)) {
    // A plain chord, including slash chords like D/F#.
    tokens.push({ type: 'chord', text: core });
  } else {
    // Bar notation: every piece between separators must be a chord.
    const parts = core.split(SEPARATORS).filter((p) => p !== '');
    if (!parts.some((p) => !SEPARATORS.test(p))) return null;
    for (const p of parts) {
      if (p === '/' || p === '|') tokens.push({ type: 'sep', text: p });
      else if (isChord(p)) tokens.push({ type: 'chord', text: p });
      else return null;
    }
  }

  if (end < raw.length) tokens.push({ type: 'sep', text: raw.slice(end) });
  return { tokens };
}

export function tokensText(tokens) {
  return tokens.map((t) => t.text).join('');
}

// Could a low-confidence word be a misread chord worth a whitelist re-read?
function looksChordish(text) {
  const t = text.trim();
  if (t.length === 0 || t.length > 24) return false;
  if (/[/|]/.test(t) && /[A-G]/.test(t)) return true;
  return /^[(\[]?[A-G]/.test(t) && t.length <= 8 && !/[a-z]{4,}/.test(t.replace(/maj|min|sus|add|dim|aug/g, ''));
}

// --- Rows --------------------------------------------------------------------

function verticalOverlap(a, b) {
  const top = Math.max(a.y0, b.y0);
  const bottom = Math.min(a.y1, b.y1);
  return Math.max(0, bottom - top) / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}

// Group words into visual rows (words whose boxes overlap vertically by half).
export function groupRows(words) {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  for (const w of sorted) {
    const row = rows.find((r) => r.some((o) => verticalOverlap(o.bbox, w.bbox) >= 0.5));
    if (row) row.push(w);
    else rows.push([w]);
  }
  for (const r of rows) r.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return rows.sort((a, b) => a[0].bbox.y0 - b[0].bbox.y0);
}

// --- Metadata rows -----------------------------------------------------------

const META_ROW = /\b(tune|tuning|tuned|capo|key)\b|จูน|ตั้งสาย|คาโป้|คีย์/i;

// OCR rarely gets '½' right: 'V2', 'Y2', '%', '12' in front of tone/step.
function fixHalf(text) {
  return text.replace(/(^|\s)(?:V2|v2|Y2|y2|%|12|1\/2|½)(?=\s*(?:tone|step|semi))/g, '$1½');
}

// Read tuning / capo / key out of one row's text.
export function parseMetaRow(text) {
  const fixed = fixHalf(text.replace(/\s+/g, ' ').trim());
  const out = {};
  const capo = /\bcapo\b\s*(?:fret\s*)?[:#=]?\s*(\d{1,2})|คาโป้\s*(?:ช่อง(?:ที่)?)?\s*(\d{1,2})/i.exec(fixed);
  if (capo) out.capo = Number(capo[1] || capo[2]);
  const key = /\bkey\b\s*(?:of\s*)?[:=]?\s*([A-G][#b]?m?)\b|คีย์\s*([A-G][#b]?m?)/i.exec(fixed);
  if (key) out.key = key[1] || key[2];
  if (/\btun(e|ing|ed)\b|จูน|ตั้งสาย/i.test(fixed)) {
    const semitones = parseTuning(fixed);
    // Real sheets tune down up to 1½ steps (or rarely up a half step); anything
    // else is a misread note name ('to Bb' for 'to Eb').
    if (semitones !== null && semitones >= -3 && semitones <= 1) out.tuning = { label: fixed, semitones };
  }
  return out;
}

// --- Classification ----------------------------------------------------------

// words -> { items, recheck, meta }
//   items:   [{ x, y, w, h, text, tokens, confidence }] accepted chord items
//   recheck: words worth re-reading with a chord-only whitelist
//   meta:    { tuning?, capo?, key? } from tuning/capo/key rows
export function classifyWords(words) {
  const items = [];
  const recheck = [];
  const meta = {};
  const metaBoxes = [];

  for (const row of groupRows(words.filter((w) => w.text && w.text.trim()))) {
    const rowText = row.map((w) => w.text).join(' ');
    if (META_ROW.test(rowText)) {
      Object.assign(meta, parseMetaRow(rowText));
      const x0 = Math.min(...row.map((w) => w.bbox.x0));
      const y0 = Math.min(...row.map((w) => w.bbox.y0));
      metaBoxes.push({ x: x0, y: y0, w: Math.max(...row.map((w) => w.bbox.x1)) - x0, h: Math.max(...row.map((w) => w.bbox.y1)) - y0 });
      continue;
    }

    row.forEach((w, i) => {
      const parsed = parseChordText(w.text);
      const confident = w.confidence >= MIN_CONFIDENCE;
      if (!parsed || !confident) {
        // A well-formed bar sequence is worth a second look at any confidence.
        const worthIt = w.confidence >= RECHECK_MIN_CONFIDENCE || isBarSequence(parsed, w.text);
        if (worthIt && looksChordish(w.text) && !gluedToGarbage(row, i)) recheck.push(w);
        return;
      }
      if (gluedToGarbage(row, i)) return;
      items.push(toItem(w, parsed.tokens));
    });
  }

  return { items: dropOutliers(items), recheck, meta, metaBoxes };
}

export function toItem(word, tokens) {
  const { x0, y0, x1, y1 } = word.bbox;
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    text: tokensText(tokens),
    tokens,
    confidence: Math.round(word.confidence),
  };
}

// A misread piece of a bar line: separators plus several chord letters.
function barish(text) {
  return /[/|]/.test(text) && (text.match(/[A-G]/g) || []).length >= 2;
}

// '/D/G/Am/' — two or more chords with bar separators.
export function isBarSequence(parsed, text) {
  return !!parsed && /[/|]/.test(text) && parsed.tokens.filter((t) => t.type === 'chord').length >= 2;
}

// A chord sits on its own row above the lyric; a "chord" touching a garbage
// (Thai) word on the same row is really a piece of lyric text. A shaky
// neighbour that itself looks like chords (half of a split bar line) is not
// garbage.
function gluedToGarbage(row, i) {
  const w = row[i];
  const h = w.bbox.y1 - w.bbox.y0;
  for (const j of [i - 1, i + 1]) {
    const o = row[j];
    if (!o || o.confidence >= GARBAGE_CONFIDENCE || parseChordText(o.text) || barish(o.text)) continue;
    // The lyric line right below can reach up into the chord's row (Thai
    // vowel/tone marks); a word whose middle sits below the chord, or that
    // overlaps it horizontally, is stacked under it — not beside it.
    if ((o.bbox.y0 + o.bbox.y1) / 2 > w.bbox.y1) continue;
    const gap = j < i ? w.bbox.x0 - o.bbox.x1 : o.bbox.x0 - w.bbox.x1;
    if (gap < -h * 0.3) continue;
    if (gap < h * 0.6) return true;
  }
  return false;
}

// Chord names on one sheet share a font size; drop boxes far off the median
// height (stray letters inside pictures, giant titles).
function dropOutliers(items) {
  if (items.length < 4) return items;
  const hs = items.map((it) => it.h).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)];
  return items.filter((it) => it.h >= median * 0.5 && it.h <= median * 2.2);
}

// --- Combining passes ----------------------------------------------------------

function overlapRatio(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

const chordCount = (it) => it.tokens.filter((t) => t.type === 'chord').length;
export const wordBox = (w) => ({ x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 });

// Does box overlap (≥30% of the smaller one) any of the items?
export function overlapsAny(items, box) {
  return items.some((k) => overlapRatio(k, box) > 0.3);
}

// Different Tesseract page-segmentation modes miss different chords, so the
// caller runs several and unions them here. Overlapping detections keep the
// one holding more chords (then the more confident one).
export function mergeDetections(results) {
  // A tuning/capo row found by any pass ('Tune down ½ tone to Eb') holds no
  // chords, even where another pass misread 'Tune' and kept the 'Eb'.
  const metaBoxes = results.flatMap((r) => r.metaBoxes || []);
  const onMetaRow = (box) => metaBoxes.some((m) => overlapRatio(m, box) > 0.5);

  const all = results.flatMap((r) => r.items).filter((it) => !onMetaRow(it));
  all.sort((a, b) => chordCount(b) - chordCount(a) || b.confidence - a.confidence);
  const items = [];
  for (const it of all) if (!overlapsAny(items, it)) items.push(it);

  // Widest first: a whole bar line is tried before the halves another pass
  // split it into; the caller skips a half once the whole line was read.
  const recheck = results
    .flatMap((r) => r.recheck)
    .filter((w) => !overlapsAny(items, wordBox(w)) && !onMetaRow(wordBox(w)))
    .sort((a, b) => (b.bbox.x1 - b.bbox.x0) - (a.bbox.x1 - a.bbox.x0));

  const meta = {};
  for (const r of results) for (const [k, v] of Object.entries(r.meta)) if (!(k in meta)) meta[k] = v;
  return { items: sortReadingOrder(items), recheck, meta };
}

// Top-to-bottom by visual row, then left-to-right (a chord a pixel higher
// than its row-mate further left must not jump ahead of it).
export function sortReadingOrder(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {
    const row = rows.find((r) => r.some((o) => verticalOverlap(
      { y0: o.y, y1: o.y + o.h },
      { y0: it.y, y1: it.y + it.h },
    ) >= 0.5));
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

// --- Text size -------------------------------------------------------------------

// Median height of the ink blobs (≈ letter height) on a binarised image, or
// null if there's no text. Used to scale every page so letters reach the size
// Tesseract reads best, whatever the screenshot's resolution.
export function medianBlobHeight(ink, width, height) {
  const seen = new Uint8Array(width * height);
  const heights = [];
  const stack = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    let y0 = Infinity;
    let y1 = -1;
    let n = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const y = (i / width) | 0;
      const x = i - y * width;
      n++;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && ink[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && ink[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && ink[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && ink[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }
    const h = y1 - y0 + 1;
    // Skip specks (tone marks, dots) and big shapes (lines, pictures).
    if (n >= 6 && h >= 4 && h <= height / 4) heights.push(h);
  }
  if (heights.length < 5) return null;
  heights.sort((a, b) => a - b);
  return heights[heights.length >> 1];
}

// --- Columns ---------------------------------------------------------------------

// Wide screenshots often lay a song out in side-by-side columns, which become
// unreadably small when fitted to a phone. Find vertical gutters (x ranges
// with no ink, at least `minGap` wide, with content on both sides) and return
// each column's content box: [{ x, y, w, h }] in ink pixels, or [] when the
// page is a single column.
export function findColumns(ink, width, height, { minGap = Math.max(12, width * 0.02), pad = 8 } = {}) {
  const colInk = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) colInk[x] += ink[row + x];
  }
  const empty = (x) => colInk[x] <= height * 0.002;

  // Content spans between gutters.
  const spans = [];
  let x = 0;
  while (x < width) {
    while (x < width && empty(x)) x++;
    if (x >= width) break;
    const start = x;
    let end = x;
    // Extend through gaps narrower than minGap.
    while (x < width) {
      if (!empty(x)) {
        end = x;
        x++;
        continue;
      }
      let gapEnd = x;
      while (gapEnd < width && empty(gapEnd)) gapEnd++;
      if (gapEnd - x >= minGap || gapEnd >= width) break;
      x = gapEnd;
    }
    spans.push([start, end]);
    while (x < width && empty(x)) x++;
  }

  const columns = spans.filter(([a, b]) => b - a >= width * 0.08);
  if (columns.length < 2) return [];

  return columns.map(([a, b]) => {
    let y0 = 0;
    let y1 = height - 1;
    const rowEmpty = (y) => {
      for (let i = a; i <= b; i++) if (ink[y * width + i]) return false;
      return true;
    };
    while (y0 < y1 && rowEmpty(y0)) y0++;
    while (y1 > y0 && rowEmpty(y1)) y1--;
    const x0 = Math.max(0, a - pad);
    const top = Math.max(0, y0 - pad);
    return { x: x0, y: top, w: Math.min(width - 1, b + pad) - x0 + 1, h: Math.min(height - 1, y1 + pad) - top + 1 };
  });
}

// OCR sometimes stretches a chord's box down over the Thai marks of the
// lyric below; painting the new chord over that box wipes lyric pixels. Keep
// only the band of rows (separated by blank rows) holding the most ink, and
// shrink the sides to it. box/result in ink pixels.
export function tightenBox(ink, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.w));
  const y0 = Math.max(0, Math.floor(box.y));
  const y1 = Math.min(height - 1, Math.ceil(box.y + box.h));
  const rowInk = [];
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    for (let x = x0; x <= x1; x++) n += ink[y * width + x];
    rowInk.push(n);
  }
  let best = null;
  for (let i = 0; i < rowInk.length;) {
    if (!rowInk[i]) {
      i++;
      continue;
    }
    let j = i;
    let total = 0;
    while (j < rowInk.length && rowInk[j]) total += rowInk[j++];
    if (!best || total > best.total) best = { from: i, to: j - 1, total };
    i = j;
  }
  if (!best) return box;
  let left = x1;
  let right = x0;
  for (let y = y0 + best.from; y <= y0 + best.to; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!ink[y * width + x]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return { x: left, y: y0 + best.from, w: right - left + 1, h: best.to - best.from + 1 };
}

// --- Ink lookup (for "add a missed chord" taps) --------------------------------

// Find the run of ink nearest to (x, y) on a binarised image (`ink[i]` truthy
// = dark pixel, row-major, `width` wide) and return its bounding box. Pieces
// on the same row closer than ~0.6 letter heights are joined, so 'Gm7' or
// '/D/G/' comes back whole. `letterH` is the typical chord letter height.
export function inkBoxNear(ink, width, height, x, y, letterH) {
  if (!(x >= 0 && y >= 0 && x < width && y < height)) return null;
  const h = Math.max(6, letterH);
  const x0 = Math.max(0, Math.floor(x - h * 4));
  const x1 = Math.min(width - 1, Math.ceil(x + h * 4));
  const y0 = Math.max(0, Math.floor(y - h * 1.2));
  const y1 = Math.min(height - 1, Math.ceil(y + h * 1.2));

  // Connected components (4-neighbour) inside the search window.
  const seen = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
  const idx = (px, py) => (py - y0) * (x1 - x0 + 1) + (px - x0);
  const comps = [];
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      if (!ink[py * width + px] || seen[idx(px, py)]) continue;
      const box = { x0: px, y0: py, x1: px, y1: py, n: 0 };
      const stack = [[px, py]];
      seen[idx(px, py)] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        box.n++;
        if (cx < box.x0) box.x0 = cx;
        if (cx > box.x1) box.x1 = cx;
        if (cy < box.y0) box.y0 = cy;
        if (cy > box.y1) box.y1 = cy;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
          if (!ink[ny * width + nx] || seen[idx(nx, ny)]) continue;
          seen[idx(nx, ny)] = 1;
          stack.push([nx, ny]);
        }
      }
      if (box.n >= 3) comps.push(box);
    }
  }
  if (!comps.length) return null;

  // Nearest component to the tap (distance to its box).
  const dist = (b) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
  let box = comps.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  if (dist(box) > h * 1.5) return null;
  box = { ...box };

  // Grow sideways through neighbours on the same row.
  let grown = true;
  while (grown) {
    grown = false;
    for (const c of comps) {
      if (c.x0 >= box.x0 && c.x1 <= box.x1 && c.y0 >= box.y0 && c.y1 <= box.y1) continue;
      const overlap = Math.min(c.y1, box.y1) - Math.max(c.y0, box.y0);
      const gap = Math.max(c.x0 - box.x1, box.x0 - c.x1);
      if (overlap > Math.min(c.y1 - c.y0, box.y1 - box.y0) * 0.3 && gap < h * 0.6) {
        box.x0 = Math.min(box.x0, c.x0);
        box.x1 = Math.max(box.x1, c.x1);
        box.y0 = Math.min(box.y0, c.y0);
        box.y1 = Math.max(box.y1, c.y1);
        grown = true;
      }
    }
  }
  return { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 };
}

// Typical chord letter height on the page (for sizing new boxes).
export function medianHeight(items, fallback = 20) {
  if (!items.length) return fallback;
  const hs = items.map((it) => it.h).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}
