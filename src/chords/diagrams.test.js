import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVoicing, normalizeQuality, renderChordSVG, SUPPORTED_QUALITIES } from './diagrams.js';
import { mod12, parseChord } from './theory.js';

const OPEN_PCS = [4, 9, 2, 7, 11, 4];
const TONES = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], 6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 2], add9: [0, 4, 7, 2], madd9: [0, 3, 7, 2], sus2: [0, 2, 7], sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8], 5: [0, 7],
  mmaj7: [0, 3, 7, 11],
};
const THIRD = { '': 4, m: 3, 7: 4, m7: 3, maj7: 4, 6: 4, m6: 3, 9: 4, add9: 4, madd9: 3, dim: 3, dim7: 3, m7b5: 3, aug: 4, mmaj7: 3 };
const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function check(name, v, { quality, bass }) {
  assert.ok(v, `${name}: no voicing`);
  const c = parseChord(name);
  const tones = TONES[quality].map((t) => mod12(c.root + t));
  const sounded = v.frets.map((f, s) => (f >= 0 ? mod12(OPEN_PCS[s] + f) : null)).filter((p) => p !== null);
  const allowed = new Set(bass === undefined ? tones : [...tones, mod12(bass)]);
  for (const pc of sounded) assert.ok(allowed.has(pc), `${name}: ${v.frets} sounds a non-chord tone`);
  assert.equal(sounded[0], bass === undefined ? c.root : mod12(bass), `${name}: ${v.frets} wrong bass`);
  assert.ok(sounded.includes(c.root), `${name}: root missing`);
  if (THIRD[quality] !== undefined) assert.ok(sounded.includes(mod12(c.root + THIRD[quality])), `${name}: ${v.frets} third missing`);
  const fretted = v.frets.filter((f) => f > 0);
  if (fretted.length) assert.ok(Math.max(...fretted) - Math.min(...fretted) <= 3, `${name}: ${v.frets} span too wide`);
  assert.ok(v.baseFret >= 1 && v.baseFret <= 12, `${name}: baseFret ${v.baseFret}`);
  assert.ok(sounded.length >= (quality === '5' ? 2 : 4), `${name}: ${v.frets} too few strings`);
  // Fingers: barre counts once.
  const onBarre = v.barre ? v.frets.filter((f, s) => f === v.barre.fret && s >= v.barre.fromString && s <= v.barre.toString).length : 0;
  assert.ok(fretted.length - onBarre + (v.barre ? 1 : 0) <= 4, `${name}: ${v.frets} needs more than 4 fingers`);
}

test('every root × supported quality has a correct, playable voicing', () => {
  for (const root of ROOTS) {
    for (const q of SUPPORTED_QUALITIES) {
      const name = root + q;
      const v = getVoicing(name);
      check(name, v, { quality: q });
      assert.equal(v.approximate, false, name);
    }
  }
});

test('well-known open shapes', () => {
  assert.deepEqual(getVoicing('C').frets, [-1, 3, 2, 0, 1, 0]);
  assert.deepEqual(getVoicing('G').frets, [3, 2, 0, 0, 0, 3]);
  assert.deepEqual(getVoicing('Am').frets, [-1, 0, 2, 2, 1, 0]);
  assert.deepEqual(getVoicing('F').barre, { fret: 1, fromString: 0, toString: 5 });
  const bm = getVoicing('Bm');
  assert.deepEqual(bm.frets, [-1, 2, 4, 4, 3, 2]);
  assert.equal(bm.barre.fret, 2);
});

test('slash chords put the bass note lowest', () => {
  for (const [name, bass] of [['D/F#', 6], ['C/E', 4], ['G/B', 11], ['Am/G', 7], ['A/C#', 1], ['F/C', 0], ['Em/D', 2]]) {
    const v = getVoicing(name);
    const q = parseChord(name).quality;
    check(name, v, { quality: q, bass });
    assert.equal(v.bassIgnored, false, name);
  }
});

test('unusual qualities are simplified and flagged', () => {
  assert.deepEqual(normalizeQuality('m9'), { quality: 'm7', approximate: true });
  assert.deepEqual(normalizeQuality('13'), { quality: '7', approximate: true });
  assert.deepEqual(normalizeQuality('7#9'), { quality: '7', approximate: true });
  assert.deepEqual(normalizeQuality('6/9'), { quality: '6', approximate: true });
  assert.deepEqual(normalizeQuality('add11'), { quality: '', approximate: true });
  assert.deepEqual(normalizeQuality('M7'), { quality: 'maj7', approximate: false });
  for (const name of ['Cm9', 'G13', 'E7#9', 'C6/9', 'Dadd11', 'Bbmaj9', 'F#m11']) {
    const v = getVoicing(name);
    assert.ok(v, name);
    assert.equal(v.approximate, true, name);
  }
  assert.equal(getVoicing('Intro'), null);
});

test('renderChordSVG produces well-formed, escaped SVG', () => {
  const svg = renderChordSVG('F#m7', getVoicing('F#m7'));
  assert.match(svg, /^<svg [^>]*viewBox="0 0 100 132"/);
  assert.match(svg, /<\/svg>$/);
  const opens = (svg.match(/<(?!\/)[a-z]+[^>]*[^/]>/g) || []).length;
  const closes = (svg.match(/<\/[a-z]+>/g) || []).length;
  assert.equal(opens, closes);
  const evil = renderChordSVG('<b>&', null);
  assert.ok(evil.includes('&lt;b&gt;&amp;'));
  assert.ok(!evil.includes('<b>'));
  assert.match(renderChordSVG('Bb', getVoicing('Bb')), /fr<\/text>|stroke-width="4"/);
});
