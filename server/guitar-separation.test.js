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
