// Music theory helpers for Chord Shift: note / chord parsing, transposition,
// key detection, capo suggestions and tuning-label parsing.
//
// Pitch classes are integers 0..11 with C = 0. Chord names follow the usual
// lead-sheet grammar: root [A-G] + optional accidental, a quality built only
// from recognised tokens (m, maj7, sus4, add9, 7b9, 6/9 ...), and an optional
// /Bass note. Anything else (section labels, "x2", "N.C.") is not a chord, so
// the sheet code can safely leave it untouched. Unicode ♯/♭ are accepted on
// input and always written back as ASCII #/b.
//
// Pure functions only — no DOM — so everything here runs under `node --test`.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Conventional key spellings (fewest accidentals; F# over Gb, C#m over Dbm ...).
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEY_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

// --- Notes -----------------------------------------------------------------

export function mod12(n) {
  return ((n % 12) + 12) % 12;
}

// ASCII-fy accidentals: ♯ -> #, ♭ -> b.
function normalizeAccidentals(str) {
  return str.replace(/♯/g, '#').replace(/♭/g, 'b');
}

function accidentalOffset(acc) {
  if (acc === '#' || acc === '♯') return 1;
  if (acc === 'b' || acc === '♭') return -1;
  return 0;
}

// 'Bb' -> 10, 'C#' -> 1, 'Cb' -> 11, 'E#' -> 5. Invalid -> null.
export function parseNote(name) {
  if (typeof name !== 'string') return null;
  const m = /^([A-G])([#b♯♭]?)$/u.exec(name);
  if (!m) return null;
  return mod12(LETTER_PC[m[1]] + accidentalOffset(m[2]));
}

// 10, true -> 'Bb'; 10, false -> 'A#'.
export function noteName(pc, flats) {
  const i = mod12(Math.round(pc));
  return flats ? FLAT_NAMES[i] : SHARP_NAMES[i];
}

// --- Chords ----------------------------------------------------------------

// Quality tokens. Order matters: multi-letter words before 'm'/'M' so 'maj7'
// is read as maj+7 and not m+aj7 (which would fail anyway). '/digits' covers
// 6/9-style qualities; a '/Letter' tail is the bass note, handled separately.
const QUALITY_TOKEN = '(?:maj|min|dim|aug|sus|add|no|m|M|°|ø|Δ|\\+|-|[#b♯♭]?\\d+|\\(|\\)|,|/\\d+)';
const CHORD_RE = new RegExp(`^([A-G])([#b♯♭]?)((?:${QUALITY_TOKEN})*)(?:/([A-G])([#b♯♭]?))?$`, 'u');

function parensBalanced(str) {
  let depth = 0;
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

// 'F#m7b5/C#' -> { root: 6, rootName: 'F#', quality: 'm7b5', bass: 1, bassName: 'C#' }
// 'Am'        -> { root: 9, rootName: 'A', quality: 'm', bass: null, bassName: null }
// Names and quality come back with ♯/♭ normalised to #/b; spelling is kept
// (a written 'Cb' stays rootName 'Cb', root 11). Not a chord -> null.
export function parseChord(str) {
  if (typeof str !== 'string' || str === '') return null;
  const m = CHORD_RE.exec(str);
  if (!m) return null;
  const [, letter, acc, rawQuality, bassLetter, bassAcc] = m;
  if (!parensBalanced(rawQuality)) return null;
  // 'Mm', 'mm', 'MM' mean nothing (minor-major is written mM7 / mmaj7).
  if (/^(?:Mm|MM|mm(?!aj))/.test(rawQuality)) return null;
  const hasBass = bassLetter !== undefined;
  return {
    root: mod12(LETTER_PC[letter] + accidentalOffset(acc)),
    rootName: letter + normalizeAccidentals(acc),
    quality: normalizeAccidentals(rawQuality),
    bass: hasBass ? mod12(LETTER_PC[bassLetter] + accidentalOffset(bassAcc)) : null,
    bassName: hasBass ? bassLetter + normalizeAccidentals(bassAcc) : null,
  };
}

export function isChord(str) {
  return parseChord(str) !== null;
}

// 'F#m7/C#', 2, { flats: false } -> 'G#m7/D#'. The quality string is kept
// verbatim (accidentals ASCII-fied). When `flats` is not given, the chord
// keeps its own accidental style: a flat-spelled root (or, failing that, bass)
// stays flat, everything else is spelled with sharps. Non-chords are returned
// unchanged.
export function transposeChord(chord, semitones, { flats } = {}) {
  const c = parseChord(chord);
  if (!c) return chord;
  const shift = Math.round(Number(semitones) || 0);
  let useFlats = flats;
  if (useFlats === undefined || useFlats === null) {
    const accOf = (name) => (name && name.length > 1 ? name[1] : '');
    useFlats = (accOf(c.rootName) || accOf(c.bassName)) === 'b';
  }
  let out = noteName(c.root + shift, useFlats) + c.quality;
  if (c.bass !== null) out += '/' + noteName(c.bass + shift, useFlats);
  return out;
}

// Reduce a quality string to its underlying triad for key detection:
// 'maj' | 'min' | 'dim' | 'aug' | 'neutral' (sus / power chords, no third).
function triadOf(quality) {
  const q = quality;
  if (/^(dim|°|ø)/.test(q)) return 'dim';
  if (/^(m(?!aj)|min|-)/.test(q)) return /b5/.test(q) ? 'dim' : 'min';
  if (/^(aug|\+)/.test(q)) return 'aug';
  if (/sus/.test(q) || /^5$/.test(q) || /no3/.test(q)) return 'neutral';
  return 'maj';
}

function triadMatches(chordTriad, wanted) {
  if (chordTriad === wanted) return true;
  // A sus / power chord has no third, so it fits a major or minor degree.
  return chordTriad === 'neutral' && (wanted === 'maj' || wanted === 'min');
}

// --- Keys ------------------------------------------------------------------

// Diatonic triads per scale degree (semitones above the tonic).
const MAJOR_DEGREES = new Map([[0, 'maj'], [2, 'min'], [4, 'min'], [5, 'maj'], [7, 'maj'], [9, 'min'], [11, 'dim']]);
const MINOR_DEGREES = new Map([[0, 'min'], [2, 'dim'], [3, 'maj'], [5, 'min'], [7, 'min'], [8, 'maj'], [10, 'maj']]);

export function keyName(tonic, minor) {
  const i = mod12(tonic);
  return minor ? MINOR_KEY_NAMES[i] : MAJOR_KEY_NAMES[i];
}

// Score all 24 keys against the chord sequence (see spec):
//   +2 diatonic root with matching triad, +1 diatonic root with other quality,
//   -1 non-diatonic root; +3 if the first chord is the tonic chord, +3 if the
//   last one is. Ties: major first, then the key whose tonic chord appears
//   most, then the one whose tonic chord appears earliest.
export function detectKey(chords) {
  if (!Array.isArray(chords)) return null;
  const parsed = [];
  for (const name of chords) {
    const c = parseChord(name);
    if (c) parsed.push({ root: c.root, triad: triadOf(c.quality) });
  }
  if (parsed.length === 0) return null;

  const candidates = [];
  for (const minor of [false, true]) {
    const degrees = minor ? MINOR_DEGREES : MAJOR_DEGREES;
    const tonicTriad = minor ? 'min' : 'maj';
    for (let tonic = 0; tonic < 12; tonic++) {
      const isTonicChord = (c) => c.root === tonic && triadMatches(c.triad, tonicTriad);
      let score = 0;
      let tonicCount = 0;
      let firstTonic = Infinity;
      parsed.forEach((c, i) => {
        const wanted = degrees.get(mod12(c.root - tonic));
        if (wanted === undefined) score -= 1;
        else score += triadMatches(c.triad, wanted) ? 2 : 1;
        if (isTonicChord(c)) {
          tonicCount++;
          if (firstTonic === Infinity) firstTonic = i;
        }
      });
      if (isTonicChord(parsed[0])) score += 3;
      if (isTonicChord(parsed[parsed.length - 1])) score += 3;
      candidates.push({ tonic, minor, score, tonicCount, firstTonic });
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    Number(a.minor) - Number(b.minor) ||
    b.tonicCount - a.tonicCount ||
    a.firstTonic - b.firstTonic);
  const best = candidates[0];
  return { tonic: best.tonic, minor: best.minor, name: keyName(best.tonic, best.minor) };
}

// 'D' -> { tonic: 2, minor: false }; 'F#m' -> { tonic: 6, minor: true };
// also 'Key: Bb', 'คีย์ G', 'A minor', 'Key of Ebm (capo 1)'. Junk -> null.
export function parseKey(str) {
  if (typeof str !== 'string') return null;
  let s = normalizeAccidentals(str).trim();
  // Strip a leading "Key", "Key of", "Original key", "คีย์", "คีย์เพลง", "Tonality" ...
  s = s.replace(/^(?:original\s+)?(?:key|tonality|คีย์(?:เพลง|ต้นฉบับ)?)\s*(?:of\s+)?[:=\-–]?\s*/iu, '');
  // Anything after the key must be a separate remark ("G (capo 2)"), never
  // more letters glued on ('Do', 'Gm7', 'Hello' -> null).
  const m = /^([A-Ga-g])([#b]?)\s*(major|minor|maj|min|m|M|-|เมเจอร์|ไมเนอร์)?(?=$|[\s(),;/[\]])/u.exec(s);
  if (!m) return null;
  const tonic = parseNote(m[1].toUpperCase() + m[2]);
  const q = m[3] || '';
  const minor = q === 'm' || q === '-' || /^min/i.test(q) || q === 'ไมเนอร์';
  return { tonic, minor };
}

// Keys whose chords are normally spelled with flats. C major / A minor are
// included because their borrowed chords are usually Bb, Ab, Eb.
const FLAT_MAJOR_KEYS = new Set([0, 5, 10, 3, 8, 1]);   // C F Bb Eb Ab Db
const FLAT_MINOR_KEYS = new Set([9, 2, 7, 0, 5, 10, 3]); // Am Dm Gm Cm Fm Bbm Ebm

export function keyPrefersFlats(tonic, minor) {
  return (minor ? FLAT_MINOR_KEYS : FLAT_MAJOR_KEYS).has(mod12(tonic));
}

// Signed semitone shift in -5..+6 taking pitch class `from` to `to`.
export function shortestShift(from, to) {
  const d = mod12(to - from);
  return d > 6 ? d - 12 : d;
}

// --- Capo ------------------------------------------------------------------

export const EASY_MAJOR_KEYS = [0, 2, 4, 7, 9]; // C D E G A
export const EASY_MINOR_KEYS = [9, 4, 2];       // Am Em Dm

// For a sounding key, list which chord shapes each capo position needs.
// tuningOffset is the guitar's tuning vs standard (-1 = half step down): the
// shapes then sound that much lower, so they must be that much higher.
export function capoOptions({ soundTonic, minor, tuningOffset = 0, maxCapo = 7 }) {
  const easyKeys = minor ? EASY_MINOR_KEYS : EASY_MAJOR_KEYS;
  const out = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    const shapeTonic = mod12(soundTonic - capo - tuningOffset);
    out.push({
      capo,
      shapeTonic,
      shapeKeyName: keyName(shapeTonic, minor),
      easy: easyKeys.includes(shapeTonic),
    });
  }
  return out;
}

// --- Tuning ----------------------------------------------------------------

const STANDARD_TUNING_PCS = [4, 9, 2, 7, 11, 4]; // E A D G B E

// Offset of a "<note> standard" tuning from E standard, folded to -6..+5
// (Eb -> -1, D -> -2, C# -> -3, F -> +1).
function offsetFromE(pc) {
  const d = mod12(pc - 4);
  return d >= 6 ? d - 12 : d;
}

function parseLowerNote(str) {
  return parseNote(str.charAt(0).toUpperCase() + str.slice(1));
}

// Best-effort reading of a tuning note written on a sheet. Returns semitones vs
// standard EADGBE (-1 = half step down) or null when it can't tell (including
// non-uniform tunings such as Drop D).
//   'Tune down ½ tone to Eb' / 'half step down' / 'Eb tuning' -> -1
//   'tune down 1 tone' / 'whole step down' / 'D standard'      -> -2
//   'ตั้งสายลงครึ่งเสียง' / 'จูนลงครึ่งเสียง'                       -> -1
//   'standard'                                                  -> 0
export function parseTuning(text) {
  if (typeof text !== 'string') return null;
  const s = normalizeAccidentals(text)
    .toLowerCase()
    .replace(/½/g, '1/2')
    .replace(/(^|[^\d.])0?\.5(?!\d)/g, (_, pre) => pre + '1/2') // '0.5' / '.5' -> '1/2'
    .replace(/(\d)\.5(?!\d)/g, '$1 1/2')          // '1.5' -> '1 1/2'
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // Drop / open tunings retune single strings — not a uniform shift.
  if (/\bdrop\b|ดรอป|\bopen [a-g]\b/.test(s)) return null;

  // Six note names (e.g. 'Eb Ab Db Gb Bb Eb'): uniform shift of every string.
  const noteList = s.replace(/^(?:tuning|tune|จูนสาย|ตั้งสาย|จูน)\s*:?\s*/u, '');
  const six = /^([a-g][#b]?)[\s\-,]*([a-g][#b]?)[\s\-,]*([a-g][#b]?)[\s\-,]*([a-g][#b]?)[\s\-,]*([a-g][#b]?)[\s\-,]*([a-g][#b]?)$/.exec(noteList);
  if (six) {
    const shifts = six.slice(1).map((n, i) => mod12(parseLowerNote(n) - STANDARD_TUNING_PCS[i]));
    if (shifts.some((d) => d !== shifts[0])) return null;
    return offsetFromE(shifts[0] + 4);
  }

  // Direction + amount ("down 1/2 step", "ลงครึ่งเสียง", "up a whole tone").
  let sign = 0;
  if (/down|lower|flat|ลง|ต่ำ/u.test(s)) sign = -1;
  else if (/\bup\b|raise|higher|ขึ้น|สูง/u.test(s)) sign = 1;
  if (sign !== 0) {
    let amount = null;
    let m;
    if (/1 1\/2|one and a half|หนึ่งเสียงครึ่ง|1 เสียงครึ่ง/u.test(s)) amount = 3;
    else if (/1\/2|half|semi|ครึ่ง/u.test(s)) amount = 1;
    else if ((m = /(\d+) ?semi-?tones?/.exec(s))) amount = Number(m[1]);
    else if (/whole|full|\b(?:1|one|a) ?(?:tone|step)\b|เต็มเสียง|หนึ่งเสียง/u.test(s)) amount = 2;
    else if ((m = /(\d+) ?(?:tones?|steps?|เสียง)/u.exec(s))) amount = Number(m[1]) * 2;
    if (amount !== null) return sign * amount;
  }

  // Target note ("to Eb", "Eb tuning", "D standard", "Eb standard tuning").
  const target =
    /\bto ([a-g][#b]?)(?![a-z#])/.exec(s) ||
    /(?:^|[\s(:])([a-g][#b]?) ?(?:standard|std|tuning|tune)\b/.exec(s) ||
    /\b(?:standard|tuning) (?:in |of )?([a-g][#b]?)(?![a-z#])/.exec(s) ||
    /^([a-g][#b]?)$/.exec(s);
  if (target) return offsetFromE(parseLowerNote(target[1]));

  if (/standard|มาตรฐาน|normal|eadgbe|ปกติ/u.test(s)) return 0;
  return null;
}
