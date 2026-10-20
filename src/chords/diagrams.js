// Guitar chord diagrams for Chord Shift.
//
// getVoicing() finds a fingering in standard tuning: a hand-checked open-chord
// dictionary first (the shapes guitarists expect to see), otherwise a search
// over every fret window for the best playable voicing — chord tones only,
// root (or slash bass) as the lowest note, required tones present, at most
// four fingers (a barre counts as one) and a 4-fret span. Exotic qualities are
// simplified to the nearest supported one and flagged `approximate`.
// renderChordSVG() draws the usual chord box as an SVG string.
//
// Pure functions only — no DOM — so this runs under `node --test`.
// String order everywhere: index 0 = low E ... 5 = high e. -1 muted, 0 open.

import { mod12, parseChord } from './theory.js';

const OPEN_PCS = [4, 9, 2, 7, 11, 4]; // E A D G B E
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAX_FRET = 15;
const MAX_SPAN = 3; // highest minus lowest fretted fret (4 fret positions)

// --- Qualities -------------------------------------------------------------

// Intervals above the root for each supported quality.
const QUALITY_TONES = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  9: [0, 4, 7, 10, 2],
  add9: [0, 4, 7, 2],
  madd9: [0, 3, 7, 2],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
  5: [0, 7],
  mmaj7: [0, 3, 7, 11],
};

export const SUPPORTED_QUALITIES = Object.keys(QUALITY_TONES);

// Exact spellings people write for each supported quality.
const SYNONYMS = {
  '': '', M: '', maj: '',
  m: 'm', min: 'm', '-': 'm',
  7: '7', dom7: '7',
  m7: 'm7', min7: 'm7', '-7': 'm7',
  maj7: 'maj7', M7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', ma7: 'maj7',
  6: '6', M6: '6', maj6: '6',
  m6: 'm6', min6: 'm6', '-6': 'm6',
  9: '9',
  add9: 'add9', '(add9)': 'add9', add2: 'add9', 2: 'sus2',
  madd9: 'madd9', 'm(add9)': 'madd9', madd2: 'madd9',
  sus2: 'sus2',
  sus4: 'sus4', sus: 'sus4', 4: 'sus4',
  '7sus4': '7sus4', '7sus': '7sus4', sus7: '7sus4',
  dim: 'dim', '°': 'dim', o: 'dim', mb5: 'dim',
  dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
  m7b5: 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', 'm7(b5)': 'm7b5', 'min7b5': 'm7b5',
  aug: 'aug', '+': 'aug', '#5': 'aug', '(#5)': 'aug',
  5: '5',
  mmaj7: 'mmaj7', mM7: 'mmaj7', 'm(maj7)': 'mmaj7', minmaj7: 'mmaj7', 'mΔ7': 'mmaj7',
};

// Quality string -> { quality: supported key, approximate }.
export function normalizeQuality(q) {
  if (Object.prototype.hasOwnProperty.call(SYNONYMS, q)) return { quality: SYNONYMS[q], approximate: false };
  const s = q.replace(/[()]/g, '');
  if (Object.prototype.hasOwnProperty.call(SYNONYMS, s)) return { quality: SYNONYMS[s], approximate: false };

  // Simplify: keep the family (minor / dominant / major 7th / sus / dim).
  let quality;
  if (/^(m|min|-)(?!aj)/.test(s)) {
    if (/maj7|M7/.test(s)) quality = 'mmaj7';
    else if (/b5/.test(s)) quality = 'm7b5';
    else if (/7|9|11|13/.test(s)) quality = 'm7';
    else if (/6/.test(s)) quality = 'm6';
    else quality = 'm';
  } else if (/^(dim|°)/.test(s)) quality = /7/.test(s) ? 'dim7' : 'dim';
  else if (/^(aug|\+)/.test(s)) quality = /7|9/.test(s) ? '7' : 'aug';
  else if (/^(maj|M|Δ)/.test(s)) quality = 'maj7';
  else if (/^6/.test(s)) quality = '6';
  else if (/sus2/.test(s)) quality = 'sus2';
  else if (/^11/.test(s) || /sus/.test(s)) quality = /7|9|11|13/.test(s) ? '7sus4' : 'sus4';
  else if (/^(7|9|13)/.test(s)) quality = '7';
  else quality = '';
  return { quality, approximate: true };
}

// --- Open-chord dictionary ---------------------------------------------------

// Standard open-position shapes, keyed by sharp root + supported quality.
const F = (s) => s.split('').map((c) => (c === 'x' ? -1 : parseInt(c, 16)));
const OPEN = {
  C: F('x32010'), Cmaj7: F('x32000'), C7: F('x32310'), Cadd9: F('x32030'), Csus4: F('x33011'),
  Csus2: F('x30013'), C6: F('x32210'),
  D: F('xx0232'), Dm: F('xx0231'), D7: F('xx0212'), Dm7: F('xx0211'), Dmaj7: F('xx0222'),
  Dsus2: F('xx0230'), Dsus4: F('xx0233'), D6: F('xx0202'), Dm6: F('xx0201'), Daug: F('xx0332'),
  Ddim7: F('xx0101'), D5: F('xx023x'), D7sus4: F('xx0213'),
  E: F('022100'), Em: F('022000'), E7: F('020100'), Em7: F('022030'), Emaj7: F('021100'),
  Esus4: F('022200'), E7sus4: F('020200'), E5: F('022xxx'), E6: F('022120'), Em6: F('022020'),
  Eadd9: F('022102'), E9: F('020102'), Emadd9: F('024000'),
  F: F('133211'), Fmaj7: F('xx3210'),
  G: F('320003'), G7: F('320001'), Gmaj7: F('320002'), G6: F('320000'), Gsus4: F('330013'),
  Gsus2: F('300033'),
  A: F('x02220'), Am: F('x02210'), A7: F('x02020'), Am7: F('x02010'), Amaj7: F('x02120'),
  Asus2: F('x02200'), Asus4: F('x02230'), A7sus4: F('x02030'), A6: F('x02222'), Am6: F('x02212'),
  Aadd9: F('x02420'), A5: F('x022xx'), Ammaj7: F('x02110'), Aaug: F('x03221'),
  B7: F('x21202'), B: F('x24442'), Bm: F('x24432'),
};

// --- Movable barre shapes ----------------------------------------------------

// Offsets from the root fret; null = muted. E-shape roots on the low E string,
// A-shape on the A string — the barre chords guitarists actually play.
const _ = null;
const E_SHAPES = {
  '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, _, 1, 1, 0, _], sus4: [0, 2, 2, 2, 0, 0], '7sus4': [0, 2, 0, 2, 0, 0], m7b5: [0, _, 0, 0, -1, _],
  dim7: [0, _, -1, 0, -1, _], 6: [0, _, -1, 1, 0, _], 5: [0, 2, 2, _, _, _], 9: [0, 2, 0, 1, 0, 2],
  dim: [0, 1, 2, 0, _, _],
};
const A_SHAPES = {
  '': [_, 0, 2, 2, 2, 0], m: [_, 0, 2, 2, 1, 0], 7: [_, 0, 2, 0, 2, 0], m7: [_, 0, 2, 0, 1, 0],
  maj7: [_, 0, 2, 1, 2, 0], 6: [_, 0, 2, 2, 2, 2], m6: [_, 0, 2, 2, 1, 2], sus2: [_, 0, 2, 2, 0, 0],
  sus4: [_, 0, 2, 2, 3, 0], '7sus4': [_, 0, 2, 0, 3, 0], 9: [_, 0, -1, 0, 0, 0], dim: [_, 0, 1, 2, 1, _],
  dim7: [_, 0, 1, -1, 1, _], m7b5: [_, 0, 1, 0, 1, _], aug: [_, 0, -1, -2, -2, _], mmaj7: [_, 0, 2, 1, 1, 0],
  5: [_, 0, 2, 2, _, _],
};

function placeShape(offsets, rootFret) {
  const frets = offsets.map((o) => (o === null ? -1 : rootFret + o));
  return frets.every((f, s) => offsets[s] === null || f >= 0) ? frets : null;
}

// Lowest-position E- or A-shape barre voicing, or null if neither fits.
function shapeVoicing(root, quality) {
  const options = [];
  for (const [shapes, stringPc] of [[E_SHAPES, 4], [A_SHAPES, 9]]) {
    const offsets = shapes[quality];
    if (!offsets) continue;
    let rootFret = mod12(root - stringPc);
    if (rootFret === 0) rootFret = 12; // open versions live in the dictionary
    const frets = placeShape(offsets, rootFret);
    if (frets && Math.max(...frets) <= MAX_FRET && isPlayable(frets, quality === '5' ? 2 : 4)) options.push(frets);
  }
  options.sort((a, b) => Math.max(...a) - Math.max(...b));
  return options[0] || null;
}

// --- Search ------------------------------------------------------------------

function soundedPcs(frets) {
  const out = [];
  frets.forEach((f, s) => {
    if (f >= 0) out.push(mod12(OPEN_PCS[s] + f));
  });
  return out;
}

// Tones a voicing must contain: everything except the fifth of 4+ note chords.
function requiredTones(root, quality) {
  const tones = QUALITY_TONES[quality];
  const req = tones.length >= 4 ? tones.filter((t) => t !== 7) : tones;
  return req.map((t) => mod12(root + t));
}

// Fingers needed. Five or more fretted notes need a barre: one finger laid
// flat at fret f from some string up to the high e, over strings that are all
// fretted at f or higher (no open or muted string under it). Try every such
// barre and keep the one that saves the most fingers.
function fingersNeeded(frets) {
  const fretted = frets.filter((f) => f > 0).length;
  let best = { count: fretted, barre: null };
  if (fretted <= 4) return best;
  for (let from = 0; from < 5; from++) {
    const f = frets[from];
    if (f <= 0 || !frets.slice(from).every((x) => x >= f)) continue;
    const onBarre = frets.slice(from).filter((x) => x === f).length;
    if (onBarre < 2) continue;
    const count = fretted - onBarre + 1;
    if (count < best.count) {
      let to = 5;
      while (frets[to] !== f) to--;
      best = { count, barre: { fret: f, fromString: from, toString: to } };
    }
  }
  return best;
}

function isPlayable(frets, minStrings) {
  const fretted = frets.filter((f) => f > 0);
  if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > MAX_SPAN) return false;
  if (frets.filter((f) => f >= 0).length < minStrings) return false;
  return fingersNeeded(frets).count <= 4;
}

function score(frets) {
  const sounded = frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0);
  const fretted = frets.filter((f) => f > 0);
  const low = fretted.length ? Math.min(...fretted) : 0;
  const high = fretted.length ? Math.max(...fretted) : 0;
  let gaps = 0;
  for (let s = sounded[0]; s <= sounded[sounded.length - 1]; s++) if (frets[s] < 0) gaps++;
  return (
    (high <= 3 ? 0 : low * 2.2) + // open position is easiest
    (high > 3 && frets.includes(0) ? 3 : 0) + // open strings mixed with a high shape are awkward
    (6 - sounded.length) * 2.5 +
    gaps * 6 +
    fingersNeeded(frets).count * 0.6 +
    (high - low) * 0.8 +
    sounded[0] * 0.5 // prefer a lower bass string
  );
}

// Exhaustive search over fret windows; returns the best frets or null.
function searchVoicing(root, quality, bass) {
  const tones = new Set(QUALITY_TONES[quality].map((t) => mod12(root + t)));
  const required = requiredTones(root, quality);
  const bassPc = bass === null ? root : bass;
  const minStrings = quality === '5' ? 2 : bass === null ? 4 : 4;
  let best = null;
  let bestScore = Infinity;

  for (let start = 1; start <= MAX_FRET - MAX_SPAN; start++) {
    const options = OPEN_PCS.map((open, s) => {
      const opts = [-1];
      if (tones.has(open) || open === bassPc) opts.push(0);
      for (let f = start; f <= start + MAX_SPAN; f++) {
        const pc = mod12(open + f);
        if (tones.has(pc) || pc === bassPc) opts.push(f);
      }
      return opts;
    });

    const frets = new Array(6);
    const walk = (s) => {
      if (s === 6) {
        const sounded = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
        if (!sounded.length) return;
        const pcs = sounded.map((i) => mod12(OPEN_PCS[i] + frets[i]));
        if (pcs[0] !== bassPc) return;
        // A slash bass outside the chord may only sound as the lowest note.
        if (!tones.has(bassPc) && pcs.slice(1).includes(bassPc)) return;
        if (!required.every((t) => pcs.includes(t))) return;
        if (!isPlayable(frets, minStrings)) return;
        const sc = score(frets);
        if (sc < bestScore) {
          bestScore = sc;
          best = [...frets];
        }
        return;
      }
      for (const f of options[s]) {
        frets[s] = f;
        walk(s + 1);
      }
    };
    walk(0);
  }
  return best;
}

// --- Fingering + layout ------------------------------------------------------

function assignFingers(frets, barre) {
  const fingers = frets.map(() => 0);
  let next = 1;
  if (barre) {
    for (let s = barre.fromString; s <= barre.toString; s++) if (frets[s] === barre.fret) fingers[s] = 1;
    next = 2;
  }
  const rest = frets
    .map((f, s) => ({ f, s }))
    .filter(({ f, s }) => f > 0 && fingers[s] === 0)
    .sort((a, b) => a.f - b.f || a.s - b.s);
  for (const { s } of rest) fingers[s] = Math.min(4, next++);
  return fingers;
}

function finish(frets, approximate, bassIgnored) {
  const fretted = frets.filter((f) => f > 0);
  const high = fretted.length ? Math.max(...fretted) : 0;
  const low = fretted.length ? Math.min(...fretted) : 1;
  const baseFret = high <= 4 ? 1 : low;
  const { barre } = fingersNeeded(frets);
  return { frets, baseFret, barre, fingers: assignFingers(frets, barre), approximate, bassIgnored };
}

const cache = new Map();

// 'F#m7' -> { frets, baseFret, barre, fingers, approximate, bassIgnored } | null
export function getVoicing(chordName) {
  if (cache.has(chordName)) return cache.get(chordName);
  const c = parseChord(chordName);
  if (!c) return null;
  const { quality, approximate } = normalizeQuality(c.quality);
  const key = SHARPS[c.root] + quality;

  let result = null;
  if (c.bass !== null && c.bass !== c.root) {
    const frets = searchVoicing(c.root, quality, c.bass);
    if (frets) result = finish(frets, approximate, false);
  }
  if (!result) {
    const frets = OPEN[key] || shapeVoicing(c.root, quality) || searchVoicing(c.root, quality, null);
    if (frets) result = finish([...frets], approximate, c.bass !== null && c.bass !== c.root);
  }
  cache.set(chordName, result);
  return result;
}

// --- SVG ---------------------------------------------------------------------

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Chord box: name, x/o markers, nut or "Nfr" label, 5 frets, dots, barre.
export function renderChordSVG(chordName, voicing, { width = 92 } = {}) {
  const VW = 100;
  const VH = 132;
  const left = 22;
  const gapX = 13;
  const top = 38;
  const gapY = 18;
  const right = left + gapX * 5;
  const bottom = top + gapY * 5;
  const x = (s) => left + s * gapX;
  const parts = [];

  parts.push(`<text x="${(left + right) / 2}" y="16" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor">${escapeXml(chordName)}</text>`);

  if (!voicing) {
    parts.push(`<text x="${(left + right) / 2}" y="${top + 40}" text-anchor="middle" font-size="12" fill="currentColor" opacity="0.6">?</text>`);
  } else {
    const { frets, baseFret, barre, fingers } = voicing;
    // Strings and frets
    for (let s = 0; s < 6; s++) parts.push(`<line x1="${x(s)}" y1="${top}" x2="${x(s)}" y2="${bottom}" stroke="currentColor" stroke-width="1" opacity="0.7"/>`);
    for (let r = 0; r <= 5; r++) {
      const y = top + r * gapY;
      const nut = r === 0 && baseFret === 1;
      parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="currentColor" stroke-width="${nut ? 4 : 1}" opacity="${nut ? 1 : 0.7}"/>`);
    }
    if (baseFret > 1) parts.push(`<text x="${left - 5}" y="${top + gapY * 0.5 + 4}" text-anchor="end" font-size="10" fill="currentColor">${baseFret}fr</text>`);

    // Open / muted markers
    frets.forEach((f, s) => {
      if (f === 0) parts.push(`<circle cx="${x(s)}" cy="${top - 9}" r="3.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`);
      if (f < 0) parts.push(`<path d="M${x(s) - 3.4} ${top - 12.4}l6.8 6.8M${x(s) + 3.4} ${top - 12.4}l-6.8 6.8" stroke="currentColor" stroke-width="1.3"/>`);
    });

    const cy = (f) => top + (f - baseFret + 0.5) * gapY;
    if (barre) {
      parts.push(`<rect x="${x(barre.fromString) - 5.5}" y="${cy(barre.fret) - 5.5}" width="${x(barre.toString) - x(barre.fromString) + 11}" height="11" rx="5.5" fill="var(--chord-dot, currentColor)"/>`);
    }
    frets.forEach((f, s) => {
      if (f <= 0) return;
      const onBarre = barre && f === barre.fret && s >= barre.fromString && s <= barre.toString;
      if (!onBarre) parts.push(`<circle cx="${x(s)}" cy="${cy(f)}" r="5.5" fill="var(--chord-dot, currentColor)"/>`);
      const finger = fingers && fingers[s];
      if (finger && (!onBarre || s === barre.fromString)) {
        parts.push(`<text x="${x(s)}" y="${cy(f) + 3.5}" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--chord-dot-text, #fff)">${finger}</text>`);
      }
    });
  }

  const height = Math.round((width * VH) / VW);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(chordName)}" font-family="system-ui, sans-serif">${parts.join('')}</svg>`;
}
