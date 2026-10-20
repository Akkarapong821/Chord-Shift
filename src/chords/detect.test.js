import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWords, findColumns, groupRows, inkBoxNear, tightenBox, mergeDetections, parseChordText, parseMetaRow, sortReadingOrder,
} from './detect.js';

const w = (text, x0, y0, x1, y1, confidence) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });

// Real Tesseract output for the sample sheet (2x upscale, binarised, sparse
// mode), in original-image pixels. Thai lyric rows come out as garbage.
const SAMPLE = [
  w('Tune', 49, 20, 102, 37, 96), w('down', 113, 19, 173, 37, 96), w('V2', 192, 20, 215, 37, 87),
  w('tone', 223, 20, 274, 37, 93), w('to', 281, 20, 305, 37, 96), w('Eb', 314, 19, 338, 37, 61),
  w('Intro', 50, 83, 106, 100, 93), w('/D/D/G/Gn/', 123, 82, 331, 103, 40),
  w('D', 51, 150, 66, 167, 91), w('G', 458, 149, 473, 167, 90),
  w('tudduiisadasaain', 50, 175, 302, 201, 0), w('fife', 312, 180, 365, 201, 13),
  w('D', 51, 217, 66, 234, 92), w('G', 550, 217, 565, 234, 91),
  w('muaassagniisulitlula', 51, 245, 339, 271, 0),
  w('Bm', 154, 318, 187, 335, 96), w('A', 336, 318, 352, 335, 96), w('G', 569, 318, 585, 335, 90),
  w('Gm', 827, 318, 861, 335, 91),
  w('*', 66, 349, 79, 362, 82), w('faoluatavinla', 91, 346, 258, 370, 0), w('vite', 437, 341, 479, 376, 80),
  w('D', 178, 419, 193, 436, 92), w('Bm', 600, 419, 632, 436, 96),
  w('G', 232, 486, 247, 504, 89), w('A', 543, 486, 559, 503, 96),
  w('D', 104, 553, 119, 570, 92), w('Bm', 473, 553, 505, 570, 96),
  w('a', 523, 591, 535, 606, 90), w('azdaufuundnlvu', 545, 585, 749, 606, 0),
  w('G', 198, 620, 213, 638, 90), w('A', 531, 621, 546, 638, 96),
  w('Instru', 50, 723, 117, 740, 89), w('/D/', 136, 722, 189, 743, 71),
  w('D', 51, 790, 66, 807, 92), w('G', 113, 856, 129, 873, 92),
  w('D', 51, 923, 66, 940, 92), w('G', 483, 923, 498, 940, 90),
  w('(*,**)', 50, 1024, 146, 1047, 67),
  w('Instru', 50, 1089, 117, 1106, 90), w('/D/D/Bm/B/G/G/AJA/', 136, 1089, 513, 1110, 36),
  w('(**)', 50, 1151, 112, 1173, 88),
  w('Outro', 50, 1215, 112, 1233, 93), w('/D/', 130, 1215, 184, 1236, 72),
];

test('parseChordText', () => {
  assert.deepEqual(parseChordText('Gm'), { tokens: [{ type: 'chord', text: 'Gm' }] });
  assert.deepEqual(parseChordText('D/F#').tokens, [{ type: 'chord', text: 'D/F#' }]);
  assert.deepEqual(parseChordText('/D/G/').tokens.map((t) => t.text), ['/', 'D', '/', 'G', '/']);
  assert.deepEqual(parseChordText('|Am|F|').tokens.filter((t) => t.type === 'chord').map((t) => t.text), ['Am', 'F']);
  assert.deepEqual(parseChordText('(G)').tokens.map((t) => t.type), ['sep', 'chord', 'sep']);
  assert.equal(parseChordText('/D/D/G/Gn/'), null);
  assert.equal(parseChordText('Intro'), null);
  assert.equal(parseChordText('(**)'), null);
  assert.equal(parseChordText('/'), null);
  assert.equal(parseChordText('a'), null);
});

test('parseMetaRow reads tuning / capo / key', () => {
  assert.deepEqual(parseMetaRow('Tune down V2 tone to Eb').tuning, { label: 'Tune down ½ tone to Eb', semitones: -1 });
  assert.equal(parseMetaRow('Capo 3').capo, 3);
  assert.equal(parseMetaRow('Key : G').key, 'G');
  assert.equal(parseMetaRow('คาโป้ ช่อง 2').capo, 2);
});

test('groupRows', () => {
  const rows = groupRows(SAMPLE);
  assert.deepEqual(rows[0].map((x) => x.text), ['Tune', 'down', 'V2', 'tone', 'to', 'Eb']);
});

test('classifyWords on the sample sheet', () => {
  const { items, recheck, meta } = classifyWords(SAMPLE);
  assert.deepEqual(meta.tuning, { label: 'Tune down ½ tone to Eb', semitones: -1 });
  // Every chord above the lyrics, in reading order; 'Eb' from the tuning row
  // and the lowercase 'a' / 'vite' lyric fragments are not chords.
  assert.deepEqual(items.map((it) => it.text), [
    'D', 'G', 'D', 'G', 'Bm', 'A', 'G', 'Gm', 'D', 'Bm', 'G', 'A', 'D', 'Bm', 'G', 'A',
    '/D/', 'D', 'G', 'D', 'G', '/D/',
  ]);
  assert.deepEqual(items[0], { x: 51, y: 150, w: 15, h: 17, text: 'D', tokens: [{ type: 'chord', text: 'D' }], confidence: 91 });
  // The misread bar sequences go back for a whitelist re-read.
  assert.deepEqual(recheck.map((r) => r.text), ['/D/D/G/Gn/', '/D/D/Bm/B/G/G/AJA/']);
});

test('a confident chord glued to a garbage word is lyric text', () => {
  const { items } = classifyWords([w('A', 100, 10, 114, 27, 95), w('nuvaskd', 118, 10, 220, 27, 0)]);
  assert.equal(items.length, 0);
});

test('inkBoxNear joins the letters of one chord and ignores the next one', () => {
  const W = 120;
  const H = 40;
  const ink = new Uint8Array(W * H);
  const rect = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * W + x] = 1;
  };
  rect(10, 10, 19, 25); // 'G'
  rect(22, 15, 29, 25); // 'm' — 2px gap, same chord
  rect(70, 10, 79, 25); // a separate chord far right
  assert.deepEqual(inkBoxNear(ink, W, H, 14, 18, 16), { x: 10, y: 10, w: 20, h: 16 });
  assert.deepEqual(inkBoxNear(ink, W, H, 76, 12, 16), { x: 70, y: 10, w: 10, h: 16 });
  assert.equal(inkBoxNear(ink, W, H, 50, 35, 8), null);
  // Taps outside the image are ignored, not a crash.
  assert.equal(inkBoxNear(ink, W, H, 50, 400, 16), null);
  assert.equal(inkBoxNear(ink, W, H, -5, 10, 16), null);
});

test('mergeDetections unions passes and drops duplicates', () => {
  const item = (text, x, y, w, h, confidence) => ({ x, y, w, h, text, tokens: parseChordText(text).tokens, confidence });
  const a = { items: [item('D', 51, 150, 15, 17, 91), item('Gm', 300, 82, 30, 20, 80)], recheck: [], meta: {} };
  const b = {
    items: [item('D', 52, 151, 14, 16, 88), item('G', 458, 149, 15, 18, 90), item('/D/G/Gm/', 120, 82, 211, 21, 70)],
    recheck: [w('Gn', 300, 82, 330, 102, 30), w('/D/D/Bm/', 136, 1089, 513, 1110, 36)],
    meta: { tuning: { label: 'x', semitones: -1 } },
  };
  const { items, recheck, meta } = mergeDetections([a, b]);
  // The bar sequence (more chords) wins over the 'Gm' inside it; D appears once.
  assert.deepEqual(items.map((it) => it.text), ['/D/G/Gm/', 'D', 'G']);
  assert.deepEqual(recheck.map((r) => r.text), ['/D/D/Bm/']);
  assert.equal(meta.tuning.semitones, -1);
});

test('sortReadingOrder keeps row-mates left to right', () => {
  const it = (text, x, y) => ({ x, y, w: 15, h: 17, text, tokens: [], confidence: 90 });
  assert.deepEqual(sortReadingOrder([it('G', 458, 149), it('D', 51, 150), it('A', 10, 300)]).map((i) => i.text), ['D', 'G', 'A']);
});

test('implausible tuning reads are ignored', () => {
  assert.equal(parseMetaRow("Tune down ': tone to Bb").tuning, undefined);
  assert.equal(parseMetaRow('Tune down ½ tone to B').tuning.semitones, -1);
});

test('a bar line split into shaky halves is re-read, not treated as lyrics', () => {
  const split = classifyWords([
    w('Instru', 50, 1089, 117, 1106, 90), w('/D/D/Bm', 136, 1089, 280, 1110, 34), w('/B/G/G/AJA/', 284, 1089, 513, 1110, 34),
  ]);
  assert.deepEqual(split.recheck.map((r) => r.text), ['/D/D/Bm', '/B/G/G/AJA/']);
  const whole = classifyWords([w('Instru', 50, 1089, 117, 1106, 91), w('/D/D/Bm/B/G/G/A/A/', 136, 1089, 513, 1110, 0)]);
  assert.deepEqual(whole.recheck.map((r) => r.text), ['/D/D/Bm/B/G/G/A/A/']);
  // Across passes the whole line is tried first, the halves kept as fallback.
  const merged = mergeDetections([split, whole]);
  assert.deepEqual(merged.recheck.map((r) => r.text), ['/D/D/Bm/B/G/G/A/A/', '/B/G/G/AJA/', '/D/D/Bm']);
});

test('a capital J in a bar line is a misread slash', () => {
  assert.deepEqual(parseChordText('/A/J/A/').tokens.map((t) => t.text), ['/', 'A', '/', 'A', '/']);
  assert.deepEqual(parseChordText('/G/AJA/').tokens.map((t) => t.text), ['/', 'G', '/', 'A', '/', 'A', '/']);
  assert.equal(parseChordText('J'), null);
});

test("a chord another pass found on a tuning row is dropped", () => {
  const tuningRow = classifyWords([w('Tune', 49, 20, 102, 37, 96), w('down', 113, 19, 173, 37, 96), w('to', 281, 20, 305, 37, 96), w('Eb', 314, 19, 338, 37, 90)]);
  const misread = classifyWords([w('Tuna', 49, 20, 102, 37, 30), w('Bb', 314, 19, 338, 37, 90), w('G', 458, 149, 473, 167, 90)]);
  assert.deepEqual(misread.items.map((i) => i.text), ['Bb', 'G']);
  assert.deepEqual(mergeDetections([tuningRow, misread]).items.map((i) => i.text), ['G']);
});

test('OCR slip BMm is read as Bm', () => {
  assert.deepEqual(parseChordText('BMm').tokens, [{ type: 'chord', text: 'Bm' }]);
  assert.deepEqual(parseChordText('/D/BMm/').tokens.map((t) => t.text), ['/', 'D', '/', 'Bm', '/']);
  assert.deepEqual(parseChordText('CmM7').tokens, [{ type: 'chord', text: 'CmM7' }]);
});

test('findColumns splits side-by-side columns and ignores single-column pages', () => {
  const W = 200;
  const H = 60;
  const page = (blocks) => {
    const ink = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of blocks) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * W + x] = 1;
    return ink;
  };
  // Two text columns with words (small gaps) inside each.
  const two = page([[10, 10, 30, 14], [34, 10, 80, 14], [10, 30, 70, 34], [120, 20, 150, 24], [154, 20, 190, 24], [125, 40, 180, 44]]);
  assert.deepEqual(findColumns(two, W, H, { pad: 0 }), [
    { x: 10, y: 10, w: 71, h: 25 },
    { x: 120, y: 20, w: 71, h: 25 },
  ]);
  // One column of lyrics with word gaps narrower than the gutter threshold.
  const one = page([[10, 10, 60, 14], [64, 10, 190, 14], [10, 30, 120, 34]]);
  assert.deepEqual(findColumns(one, W, H), []);
});

test('a chord sitting just above a tall Thai lyric word is still a chord', () => {
  // Dark-mode sheet: the lyric's upper marks reach into the chord row.
  const { items } = classifyWords([w('G#', 763, 305, 782, 316, 84), w('dotAatuunalula', 693, 309, 813, 334, 0)]);
  assert.deepEqual(items.map((i) => i.text), ['G#']);
});

test('tightenBox drops lyric marks caught under a chord', () => {
  const W = 40;
  const H = 40;
  const ink = new Uint8Array(W * H);
  const rect = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * W + x] = 1;
  };
  rect(10, 5, 20, 16); // the chord letter
  rect(4, 22, 7, 24); // a Thai vowel mark from the line below
  assert.deepEqual(tightenBox(ink, W, H, { x: 2, y: 3, w: 25, h: 24 }), { x: 10, y: 5, w: 11, h: 12 });
});
