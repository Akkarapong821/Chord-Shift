import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capoOptions, detectKey, isChord, keyName, keyPrefersFlats, mod12, noteName, parseChord,
  parseKey, parseNote, parseTuning, shortestShift, transposeChord,
} from './theory.js';

test('mod12 / parseNote / noteName', () => {
  assert.equal(mod12(-1), 11);
  assert.equal(mod12(25), 1);
  assert.equal(parseNote('Bb'), 10);
  assert.equal(parseNote('C#'), 1);
  assert.equal(parseNote('Cb'), 11);
  assert.equal(parseNote('E#'), 5);
  assert.equal(parseNote('B♭'), 10);
  assert.equal(parseNote('H'), null);
  assert.equal(noteName(10, true), 'Bb');
  assert.equal(noteName(10, false), 'A#');
});

test('parseChord accepts real chord names', () => {
  const ok = ['C', 'Cm', 'C7', 'Cmaj7', 'CM7', 'Cm7', 'Cm7b5', 'Cdim', 'Cdim7', 'C°', 'Caug', 'C+', 'Csus',
    'Csus2', 'Csus4', 'C7sus4', 'Cadd9', 'Cmadd9', 'C6', 'Cm6', 'C9', 'Cm9', 'C11', 'C13', 'C7#9', 'C7b9',
    'C(add9)', 'C6/9', 'C5', 'Cmmaj7', 'C/E', 'Am7/G', 'D/F#', 'Bb', 'Ebm', 'F#m7b5', 'G♯m'];
  for (const c of ok) assert.ok(isChord(c), c);
  assert.deepEqual(parseChord('F#m7b5/C#'), { root: 6, rootName: 'F#', quality: 'm7b5', bass: 1, bassName: 'C#' });
  assert.deepEqual(parseChord('Am'), { root: 9, rootName: 'A', quality: 'm', bass: null, bassName: null });
});

test('parseChord rejects words', () => {
  for (const w of ['', 'Intro', 'Instru', 'Outro', 'Hm', 'x2', 'N.C.', 'Do', 'Am I', 'Cat', 'Bbb7x', 'vite', 'a', 'C(add9', 'BMm', 'Cmm']) {
    assert.equal(isChord(w), false, w);
  }
});

test('transposeChord', () => {
  assert.equal(transposeChord('F#m7/C#', 2, { flats: false }), 'G#m7/D#');
  assert.equal(transposeChord('D', 5, { flats: false }), 'G');
  assert.equal(transposeChord('Gm', -1, { flats: true }), 'Gbm');
  assert.equal(transposeChord('Bm', 1, { flats: false }), 'Cm');
  assert.equal(transposeChord('Cmaj7(#11)/G', 3, { flats: true }), 'Ebmaj7(#11)/Bb');
  assert.equal(transposeChord('Intro', 3), 'Intro');
  // Round trip over every shift and both spellings.
  for (const c of ['C', 'Dm7', 'F#m7b5/C#', 'Bbmaj7', 'G7sus4', 'Ab6/9']) {
    for (let n = -11; n <= 11; n++) {
      for (const flats of [true, false]) {
        const there = transposeChord(c, n, { flats });
        const back = parseChord(transposeChord(there, -n, { flats }));
        const orig = parseChord(c);
        assert.equal(back.root, orig.root, `${c} ${n}`);
        assert.equal(back.quality, orig.quality);
        assert.equal(back.bass, orig.bass);
      }
    }
  }
});

test('detectKey', () => {
  const sample = ['D', 'D', 'G', 'Gm', 'D', 'G', 'D', 'G', 'Bm', 'A', 'G', 'Gm', 'D', 'Bm', 'G', 'A', 'D', 'Bm',
    'G', 'A', 'D', 'D', 'G', 'D', 'G', 'D', 'D', 'Bm', 'B', 'G', 'G', 'A', 'A', 'D'];
  assert.equal(detectKey(sample).name, 'D');
  assert.equal(detectKey(['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E']).name, 'Am');
  assert.equal(detectKey(['C', 'G', 'Am', 'F']).name, 'C');
  assert.equal(detectKey(['Bb', 'F', 'Gm', 'Eb']).name, 'Bb');
  assert.equal(detectKey([]), null);
  assert.equal(detectKey(['Intro']), null);
});

test('keys, flats, shifts', () => {
  assert.equal(keyName(1, false), 'Db');
  assert.equal(keyName(1, true), 'C#m');
  assert.deepEqual(parseKey('Key: Bb'), { tonic: 10, minor: false });
  assert.deepEqual(parseKey('F#m'), { tonic: 6, minor: true });
  assert.deepEqual(parseKey('คีย์ G'), { tonic: 7, minor: false });
  assert.equal(parseKey('Hello'), null);
  assert.equal(keyPrefersFlats(5, false), true);   // F
  assert.equal(keyPrefersFlats(7, false), false);  // G
  assert.equal(keyPrefersFlats(2, true), true);    // Dm
  assert.equal(shortestShift(2, 7), 5);
  assert.equal(shortestShift(2, 9), -5);
  assert.equal(shortestShift(0, 6), 6);
});

test('capoOptions', () => {
  const opts = capoOptions({ soundTonic: 1, minor: false });
  assert.deepEqual(opts[1], { capo: 1, shapeTonic: 0, shapeKeyName: 'C', easy: true });
  assert.equal(opts[4].shapeKeyName, 'A');
  assert.equal(opts[6].shapeKeyName, 'G');
  assert.equal(opts[0].easy, false);
  // D shapes on a guitar tuned half a step down sound C#.
  assert.equal(capoOptions({ soundTonic: 1, minor: false, tuningOffset: -1 })[0].shapeKeyName, 'D');
});

test('parseTuning', () => {
  assert.equal(parseTuning('Tune down ½ tone to Eb'), -1);
  assert.equal(parseTuning('half step down'), -1);
  assert.equal(parseTuning('Eb tuning'), -1);
  assert.equal(parseTuning('tune down 1 tone'), -2);
  assert.equal(parseTuning('whole step down'), -2);
  assert.equal(parseTuning('D standard'), -2);
  assert.equal(parseTuning('ตั้งสายลงครึ่งเสียง'), -1);
  assert.equal(parseTuning('จูนลงครึ่งเสียง'), -1);
  assert.equal(parseTuning('standard'), 0);
  assert.equal(parseTuning('Drop D'), null);
  assert.equal(parseTuning('banana'), null);
});
