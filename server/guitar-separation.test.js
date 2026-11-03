import test from 'node:test';
import assert from 'node:assert/strict';
import { guitarRange } from './guitar-separation.js';

test('separation accepts finite clip boundaries up to 60 seconds within 15 minutes', () => {
  assert.deepEqual(guitarRange(new URLSearchParams('start=85&end=90')), { start: 85, end: 90 });
  assert.deepEqual(guitarRange(new URLSearchParams('start=840&end=900')), { start: 840, end: 900 });
  for (const query of ['start=Infinity&end=900', 'start=0&end=Infinity', 'start=0&end=0.01', 'start=0&end=61', 'start=895&end=901']) {
    assert.throws(() => guitarRange(new URLSearchParams(query)), { code: 'guitar-range-invalid' });
  }
});

test('guitar and drums transport is explicit and invalid stem choices are rejected', () => {
  assert.deepEqual(guitarRange(new URLSearchParams('full=1&stems=guitar,drums')), {
    start: 0, end: null, full: true, stems: ['guitar', 'drums'],
  });
  for (const stems of ['drums', 'vocals', 'guitar,drums,vocals', '']) {
    assert.throws(() => guitarRange(new URLSearchParams({ full: '1', stems })), { code: 'guitar-stems-invalid' });
  }
});
