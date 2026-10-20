// Draw a chord sheet page with its chords replaced by the transposed ones.
//
// The lyrics stay as the original pixels (so Thai text is never mis-read);
// each chord box is painted over with the paper colour sampled around it and
// the new chord name is drawn in its place, sized to the original lettering.

import { transposeChord } from './theory.js';

const FONT = 'Arial, Helvetica, "Noto Sans Thai", sans-serif';

// --- Colour sampling ---------------------------------------------------------

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 255;
}

// Paper colour (median of a ring just outside the box) and ink colour (mean of
// the darkest third inside it) for every item. Needs the page's pixels once.
export function sampleColors(page) {
  const { source } = page;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  for (const it of page.items) {
    if (it.bg) continue;
    const pad = Math.max(2, Math.round(it.h * 0.25));
    const x0 = Math.max(0, Math.floor(it.x - pad));
    const y0 = Math.max(0, Math.floor(it.y - pad));
    const x1 = Math.min(source.width, Math.ceil(it.x + it.w + pad));
    const y1 = Math.min(source.height, Math.ceil(it.y + it.h + pad));
    if (x1 <= x0 || y1 <= y0) continue;
    const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const W = x1 - x0;
    const ring = [[], [], []];
    const inside = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = ((y - y0) * W + (x - x0)) * 4;
        const rgb = [data[o], data[o + 1], data[o + 2]];
        const inBox = x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h;
        if (inBox) inside.push(rgb);
        else if (x < x0 + 2 || x >= x1 - 2 || y < y0 + 2 || y >= y1 - 2) rgb.forEach((v, c) => ring[c].push(v));
      }
    }
    const bg = ring.map(median);
    const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    const bgLum = lum(bg);
    inside.sort((a, b) => Math.abs(lum(b) - bgLum) - Math.abs(lum(a) - bgLum));
    const dark = inside.slice(0, Math.max(1, Math.floor(inside.length / 3)));
    const ink = [0, 1, 2].map((c) => Math.round(dark.reduce((s, p) => s + p[c], 0) / dark.length));
    it.bg = `rgb(${bg.join(',')})`;
    it.ink = `rgb(${ink.join(',')})`;
    it.darkPaper = bgLum < 110;
  }
}

// --- Text --------------------------------------------------------------------

export function transposeTokens(tokens, shift, flats) {
  return tokens.map((t) => (t.type === 'chord' ? transposeChord(t.text, shift, { flats }) : t.text)).join('');
}

// Font size that makes `refText` fill a box `h` tall, and its descent at
// that size (to sit the baseline on the box's bottom edge).
function fitFont(ctx, refText, h) {
  ctx.font = `700 100px ${FONT}`;
  const m = ctx.measureText(refText || 'G');
  const asc = m.actualBoundingBoxAscent || 72;
  const desc = Math.max(0, m.actualBoundingBoxDescent || 0);
  const k = h / (asc + desc);
  return { size: 100 * k, descentPerPx: desc / 100 };
}

// OCR boxes sometimes include a stray mark above a chord; all chords on a
// sheet share one font, so cap each size near the page's median.
function fontSizes(ctx, page) {
  const fits = page.items.map((it) => fitFont(ctx, it.sourceText || it.text, it.h));
  const sorted = fits.map((f) => f.size).sort((a, b) => a - b);
  const cap = (sorted[sorted.length >> 1] || 20) * 1.15;
  return fits.map((f) => ({ size: Math.min(f.size, cap), descentPerPx: f.descentPerPx }));
}

// --- Page ----------------------------------------------------------------------

// Draw page onto canvas. opts: { shift, flats, highlight, selectedId, original,
// pixelRatio }. The canvas is sized to the page × pixelRatio (item coordinates
// stay in page pixels); a ratio > 1 keeps the new chord names sharp when a
// small screenshot is shown enlarged.
export function drawPage(canvas, page, {
  shift = 0, flats = false, highlight = true, selectedId = null, original = false, pixelRatio = 1,
} = {}) {
  const { source } = page;
  const W = Math.round(source.width * pixelRatio);
  const H = Math.round(source.height * pixelRatio);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  if (original) return;

  const sizes = fontSizes(ctx, page);
  page.items.forEach((it, i) => {
    const text = transposeTokens(it.tokens, shift, flats);
    const changed = text !== it.sourceText;
    if (changed || highlight) {
      const { size, descentPerPx } = sizes[i];
      ctx.font = `700 ${size}px ${FONT}`;
      const width = ctx.measureText(text).width;
      const pad = Math.max(2, Math.round(it.h * 0.2));
      ctx.fillStyle = it.bg || '#fff';
      ctx.fillRect(it.x - pad, it.y - pad, Math.max(it.w, width) + pad * 2, it.h + pad * 2);
      // Green on dark pages: dark-mode sheets often already use blue/yellow chords.
      ctx.fillStyle = highlight ? (it.darkPaper ? '#4ee38a' : '#0b57d0') : it.ink || '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, it.x, it.y + it.h - descentPerPx * size);
      it.drawnW = Math.max(it.w, width);
    } else {
      it.drawnW = it.w;
    }

    if (it.id === selectedId) {
      const pad = Math.max(3, Math.round(it.h * 0.3));
      ctx.save();
      ctx.strokeStyle = '#e8a33d';
      ctx.lineWidth = Math.max(2, it.h * 0.12);
      ctx.setLineDash([it.h * 0.35, it.h * 0.2]);
      ctx.strokeRect(it.x - pad, it.y - pad, it.drawnW + pad * 2, it.h + pad * 2);
      ctx.restore();
    }
  });
}

// Item under a point (page pixels), with a forgiving margin for fingers.
export function itemAt(page, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const it of page.items) {
    const m = Math.max(6, it.h * 0.6);
    const w = it.drawnW || it.w;
    if (x < it.x - m || x > it.x + w + m || y < it.y - m || y > it.y + it.h + m) continue;
    const d = Math.hypot(Math.max(it.x - x, 0, x - (it.x + w)), Math.max(it.y - y, 0, y - (it.y + it.h)));
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}
