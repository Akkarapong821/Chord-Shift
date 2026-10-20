import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fretboardPositions, renderFretboardSVG, scaleNotes } from './fretboard.js';

const names = (tonic, scale) => scaleNotes(tonic, scale).map((n) => n.name).join(' ');

test('scales are spelled one letter per degree', () => {
  assert.equal(names('C', 'major'), 'C D E F G A B');
  assert.equal(names('G', 'major'), 'G A B C D E F#');
  assert.equal(names('F#', 'major'), 'F# G# A# B C# D# E#');
  assert.equal(names('Db', 'major'), 'Db Eb F Gb Ab Bb C');
  assert.equal(names('A', 'minor'), 'A B C D E F G');
  assert.equal(names('Eb', 'minor'), 'Eb F Gb Ab Bb Cb Db');
  assert.equal(names('G', 'majorPent'), 'G A B D E');
  assert.equal(names('E', 'minorPent'), 'E G A B D');
  assert.deepEqual(scaleNotes('E', 'minorPent').map((n) => n.label), ['1', 'b3', '4', '5', 'b7']);
});

test('fretboard positions', () => {
  const pos = fretboardPositions({ tonicName: 'G', scaleKey: 'major', lastFret: 12 });
  // 7 notes per octave on each string, 13 frets (0..12) -> 7 or 8 per string.
  for (let s = 0; s < 6; s++) {
    const n = pos.filter((p) => p.string === s).length;
    assert.ok(n === 7 || n === 8, `string ${s}: ${n}`);
  }
  const at = (s, f) => pos.find((p) => p.string === s && p.fret === f);
  assert.equal(at(0, 3).name, 'G');
  assert.equal(at(0, 3).root, true);
  assert.equal(at(0, 2).name, 'F#');
  assert.equal(at(0, 1), undefined); // F is not in G major
});

test('with a capo, notes are named like the shapes and start at the capo', () => {
  // C shapes with capo 1: the C note sits on the B string at fret 1 + 1 = 2.
  const pos = fretboardPositions({ tonicName: 'C', scaleKey: 'major', capo: 1, lastFret: 15 });
  assert.ok(pos.every((p) => p.fret >= 1));
  assert.equal(pos.find((p) => p.string === 4 && p.fret === 2).name, 'C');
  assert.equal(pos.find((p) => p.string === 4 && p.fret === 1).name, 'B'); // "open" B string at the capo
});

test('renderFretboardSVG', () => {
  const svg = renderFretboardSVG({ tonicName: 'A', scaleKey: 'minorPent', capo: 2, labelMode: 'degree' });
  assert.match(svg, /^<svg [^>]*viewBox=/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(svg.includes('>b3<'));
  assert.ok(svg.includes('var(--fb-capo'));
});
