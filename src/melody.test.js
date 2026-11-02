import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMelody, extractElectricGuitarMelody } from './melody.js';
import { assignFrets, TUNING } from './fretting.js';
import { renderTab } from './tab.js';

const note = (pitchMidi, startTimeSeconds, amplitude = 0.7, durationSeconds = 0.3) =>
  ({ pitchMidi, startTimeSeconds, amplitude, durationSeconds });

test('electric lead follows a continuous phrase through louder accompaniment', () => {
  const notes = [note(76, 0), note(78, .2), note(55, .2, .9), note(80, .4), note(57, .4, .9), note(81, .6)];
  const snapshot = structuredClone(notes);
  const lead = extractElectricGuitarMelody(notes);
  assert.deepEqual(lead.map(n => n.pitchMidi), [76, 78, 80, 81]);
  assert.deepEqual(notes, snapshot);
  for (let i = 0; i < lead.length - 1; i++) {
    assert.ok(lead[i].startTimeSeconds + lead[i].durationSeconds <= lead[i + 1].startTimeSeconds);
  }
});

test('lead range excludes bass and harmonics outside playable pitches', () => {
  const notes = [note(40, 0), note(76, 0), note(100, 0, 1), note(88, .5)];
  assert.deepEqual(extractElectricGuitarMelody(notes).map(n => n.pitchMidi), [76, 88]);
  assert.deepEqual(extractElectricGuitarMelody([note(40, 0)], { minPitch: 40 }).map(n => n.pitchMidi), [40]);
  assert.deepEqual(extractElectricGuitarMelody([note(40, 0)]), []);
  assert.deepEqual(extractElectricGuitarMelody([]), []);
});

test('fast repeated picking survives and an isolated large leap remains', () => {
  const notes = [note(64, 0), note(64, .06), note(67, .12), note(88, .18)];
  assert.deepEqual(extractElectricGuitarMelody(notes).map(n => n.pitchMidi), [64, 64, 67, 88]);
});

test('a new phrase can change register after a rest', () => {
  const notes = [note(76, 0), note(55, 2, .9), note(76, 2, .5)];
  assert.deepEqual(extractElectricGuitarMelody(notes).map(n => n.pitchMidi), [76, 55]);
});

test('general melody retains its loudest-note behavior', () => {
  assert.deepEqual(extractMelody([note(64, 0), note(52, 0, .95)]).map(n => n.pitchMidi), [52]);
});

test('electric fretting preserves every playable pitch through fret 24', () => {
  const notes = Array.from({ length: 49 }, (_, i) => note(40 + i, i * .1));
  const fretted = assignFrets(notes, { maxFret: 24, octaveShift: false });
  assert.equal(fretted.length, notes.length);
  fretted.forEach((n, i) => {
    assert.equal(n.pitchMidi, notes[i].pitchMidi);
    assert.equal(TUNING[n.string] + n.fret, n.pitchMidi);
    assert.ok(n.fret >= 0 && n.fret <= 24);
  });
  assert.equal(fretted.at(-1).fret, 24);
});

test('smaller neck filters unplayable pitches without transposing electric lead', () => {
  const notes = [note(39, 0), note(86, .3), note(88, .6)];
  assert.deepEqual(assignFrets(notes, { maxFret: 22, octaveShift: false }).map(n => n.pitchMidi), [86]);
  assert.deepEqual(assignFrets([note(88, 0)]).map(n => n.pitchMidi), [76]);
  assert.deepEqual(assignFrets([]), []);
  assert.throws(() => assignFrets(notes, { maxFret: 25 }), RangeError);
});

test('electric solo produces aligned six-string TAB with original timestamp and high fret', () => {
  const notes = extractElectricGuitarMelody([note(40, 65), note(88, 65), note(86, 65.3)]);
  const tab = renderTab(assignFrets(notes, { maxFret: 24, octaveShift: false }));
  assert.match(tab, /^\[1:05\]\ne\|--24--22--\|/);
  const strings = tab.trim().split('\n').slice(1);
  assert.equal(strings.length, 6);
  assert.equal(new Set(strings.map(line => line.length)).size, 1);
});
