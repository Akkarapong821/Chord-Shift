import './style.css';
import {
  capoOptions, detectKey, keyName, keyPrefersFlats, mod12, parseKey, shortestShift, transposeChord,
} from './theory.js';
import { parseChordText, tokensText } from './detect.js';
import { getVoicing, renderChordSVG } from './diagrams.js';
import { renderFretboardSVG, SCALES } from './fretboard.js';
import { cancelOcr, detectColumns, loadImage, readChordAt, readChords } from './ocr.js';
import { drawPage, itemAt, sampleColors, transposeTokens } from './render.js';
import { deleteSong, getSong, listSongs, loadPrefs, saveSong, savePrefs } from './storage.js';

const $ = (id) => document.getElementById(id);

const startView = $('start-view');
const progressView = $('progress-view');
const resultView = $('result-view');
const errorBox = $('error-box');
const fileInput = $('file-input');
const cameraInput = $('camera-input');
const dropzone = $('dropzone');
const pagesEl = $('pages');

// --- State ---------------------------------------------------------------------

// song: { id, name, files: Blob[], pages: [{ source: canvas, items, meta, bin? }],
//         origKeyOverride: { tonic, minor } | null, tuningOverride: semitones | null,
//         view: { shift, capo, std, spelling } }
let song = null;
let prefs = {
  highlight: true, diagrams: true, fretboard: true, scaleType: 'full', fbLabel: 'name', splitColumns: true, ...loadPrefs(),
};
let addMode = false;
let showOriginal = false;
let reading = null; // { cancelled } while OCR runs
let nextItemId = 1;
let saveTimer = 0;

const newId = () => `i${nextItemId++}`;

// Tuning / capo / key written on the sheet (first page that mentions each).
function detectedMeta() {
  const out = { tuning: null, capo: 0, key: '' };
  for (const p of song.pages) {
    if (!out.tuning && p.meta.tuning) out.tuning = p.meta.tuning;
    if (!out.capo && p.meta.capo) out.capo = p.meta.capo;
    if (!out.key && p.meta.key) out.key = p.meta.key;
  }
  return out;
}

// ...with the user's correction of the tuning applied.
function meta() {
  const out = detectedMeta();
  if (song.tuningOverride !== null && song.tuningOverride !== undefined) {
    out.tuning = song.tuningOverride ? { label: '', semitones: song.tuningOverride } : null;
  }
  return out;
}

const TUNING_CHOICES = [[0, 'มาตรฐาน (E)'], [-1, 'ลงครึ่งเสียง (Eb)'], [-2, 'ลง 1 เสียง (D)'], [-3, 'ลง 1 เสียงครึ่ง (C#)']];

// Chord names (as written) in reading order across all pages.
function allChords() {
  const out = [];
  for (const p of song.pages) {
    for (const it of p.items) for (const t of it.tokens) if (t.type === 'chord') out.push(t.text);
  }
  return out;
}

function origKey() {
  return song.origKeyOverride || parseKey(meta().key) || detectKey(allChords());
}

// Everything the screen shows, derived from the song + view.
function derive() {
  const m = meta();
  const tuning = m.tuning ? m.tuning.semitones : 0;
  const { shift, capo, std, spelling } = song.view;
  const orig = origKey();
  if (!orig) {
    return { orig: null, tuning, shift, flats: spelling === 'flat', minor: false };
  }
  const target = mod12(orig.tonic + shift);
  const flats = spelling === 'flat' ? true : spelling === 'sharp' ? false : keyPrefersFlats(target, orig.minor);
  const tuningUsed = std ? 0 : tuning;
  const sounding = mod12(target + capo + tuningUsed);
  const origSounding = mod12(orig.tonic + m.capo + tuning);
  return {
    orig, target, flats, tuning, tuningUsed, shift, minor: orig.minor,
    sounding, soundDiff: shortestShift(origSounding, sounding), sheetCapo: m.capo,
  };
}

// --- File input ------------------------------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
$('camera-btn').addEventListener('click', () => cameraInput.click());
for (const input of [fileInput, cameraInput]) {
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles([...input.files]);
    input.value = '';
  });
}

['dragenter', 'dragover'].forEach((ev) =>
  startView.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  }),
);
startView.addEventListener('dragleave', (e) => {
  if (!startView.contains(e.relatedTarget)) dropzone.classList.remove('dragover');
});
startView.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = [...e.dataTransfer.files].filter(isImage);
  if (files.length) handleFiles(files);
  else showError('ไฟล์นี้ไม่ใช่รูปภาพ — ใช้ไฟล์ JPG หรือ PNG');
});
// Dropping a file anywhere else shouldn't navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

document.addEventListener('paste', (e) => {
  if (reading || isTyping(e.target)) return;
  const files = [...(e.clipboardData?.files || [])].filter(isImage);
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});

function isImage(f) {
  return f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name || '');
}

function isTyping(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

// --- Reading ---------------------------------------------------------------------

async function handleFiles(files) {
  if (reading) return;
  hideError();
  closeSheet();
  const job = { cancelled: false };
  reading = job;
  showView('progress');
  const scanImg = $('scan-img');
  if (scanImg.src) URL.revokeObjectURL(scanImg.src);
  scanImg.src = URL.createObjectURL(files[0]);
  setProgress(0, 'กำลังเปิดรูป…');

  try {
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      const prefix = files.length > 1 ? `รูป ${i + 1}/${files.length} · ` : '';
      if (i > 0) {
        URL.revokeObjectURL(scanImg.src);
        scanImg.src = URL.createObjectURL(files[i]);
      }
      const source = await loadImage(files[i]);
      if (job.cancelled) return;
      const { items, meta: pageMeta, bin } = await readChords(source, {
        onStatus: (label, frac) => setProgress((i + frac) / files.length, prefix + label),
      });
      if (job.cancelled) return;
      for (const it of items) {
        it.id = newId();
        it.sourceText = it.text;
      }
      const page = { source, items, meta: pageMeta, bin, columns: detectColumns(source) };
      sampleColors(page);
      pages.push(page);
    }
    setProgress(1, 'เสร็จแล้ว');

    song = {
      id: `s${Date.now().toString(36)}`,
      name: songName(files[0]),
      files,
      pages,
      origKeyOverride: null,
      tuningOverride: null,
      view: { shift: 0, capo: 0, std: false, spelling: 'auto' },
    };
    song.view.capo = meta().capo;
    addMode = false;
    showOriginal = false;
    showView('result');
    renderAll();
    window.scrollTo({ top: 0 });
    const found = allChords().length;
    toast(found ? `เจอคอร์ด ${found} ตำแหน่ง — แตะคีย์ที่ต้องการได้เลย` : 'ไม่เจอคอร์ดในรูปนี้');
    persist(true);
  } catch (err) {
    if (job.cancelled) return;
    console.error(err);
    showView(song ? 'result' : 'start');
    showError(
      err.message === 'unsupported-image'
        ? 'เปิดรูปนี้ไม่ได้ — ใช้ไฟล์ JPG หรือ PNG (รูป HEIC จาก iPhone ให้แคปหน้าจอหรือแปลงไฟล์ก่อน)'
        : `อ่านรูปไม่สำเร็จ: ${err.message || err}`,
    );
  } finally {
    if (reading === job) reading = null;
  }
}

$('cancel-btn').addEventListener('click', async () => {
  if (!reading) return;
  reading.cancelled = true;
  reading = null;
  await cancelOcr();
  showView(song ? 'result' : 'start');
  if (!song) renderRecent();
});

function songName(file) {
  const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
  if (base && !/^(image|img|screenshot|ภาพหน้าจอ|photo|pasted)/i.test(base)) return base;
  const d = new Date();
  return `เพลง ${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}`;
}

function setProgress(frac, label) {
  $('progress-fill').style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
  $('progress-label').textContent = label;
}

function showView(name) {
  startView.hidden = name !== 'start';
  progressView.hidden = name !== 'progress';
  resultView.hidden = name !== 'result';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.hidden = true;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// --- Key controls ------------------------------------------------------------------

function setShift(shift) {
  song.view.shift = shortestShift(0, shift);
  renderAll();
  persist();
}

$('down-btn').addEventListener('click', () => setShift(song.view.shift - 1));
$('up-btn').addEventListener('click', () => setShift(song.view.shift + 1));

document.addEventListener('keydown', (e) => {
  if (!song || resultView.hidden || isTyping(e.target) || !$('sheet').hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '-' || e.key === '_') setShift(song.view.shift - 1);
  else if (e.key === '+' || e.key === '=') setShift(song.view.shift + 1);
});

$('std-toggle').addEventListener('change', (e) => {
  const d = derive();
  song.view.std = e.target.checked;
  // Keep the sound the same: standard tuning is higher, so the shapes go down.
  song.view.shift = shortestShift(0, song.view.shift + (e.target.checked ? d.tuning : -d.tuning));
  renderAll();
  persist();
  toast(e.target.checked ? 'แปลงคอร์ดให้เล่นกับจูนมาตรฐานแล้ว เสียงเท่าเดิม' : 'กลับไปใช้จูนแบบต้นฉบับ');
});

$('capo-select').addEventListener('change', (e) => {
  song.view.capo = Number(e.target.value);
  renderAll();
  persist();
});

$('spelling-select').addEventListener('change', (e) => {
  song.view.spelling = e.target.value;
  renderAll();
  persist();
});

$('orig-select').addEventListener('change', (e) => {
  const v = e.target.value;
  song.origKeyOverride = v === 'auto' ? null : { tonic: Number(v.split(':')[0]), minor: v.endsWith(':m') };
  renderAll();
  persist();
});

$('tuning-select').addEventListener('change', (e) => {
  const before = derive().tuning;
  song.tuningOverride = e.target.value === 'auto' ? null : Number(e.target.value);
  const after = derive().tuning;
  // In standard-tuning mode the chords already compensate for the sheet's
  // tuning; re-compensate for the corrected value so the sound stays put.
  if (song.view.std) song.view.shift = shortestShift(0, song.view.shift + (after - before));
  if (!after) song.view.std = false;
  renderAll();
  persist();
});

$('highlight-toggle').addEventListener('change', (e) => {
  prefs.highlight = e.target.checked;
  savePrefs(prefs);
  drawPages();
});

$('diagram-toggle').addEventListener('click', () => {
  prefs.diagrams = !prefs.diagrams;
  savePrefs(prefs);
  renderDiagrams();
});

$('fretboard-toggle').addEventListener('click', () => {
  prefs.fretboard = !prefs.fretboard;
  savePrefs(prefs);
  renderFretboard();
});

for (const btn of document.querySelectorAll('#fretboard-card [data-scale], #fretboard-card [data-label]')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.scale) prefs.scaleType = btn.dataset.scale;
    if (btn.dataset.label) prefs.fbLabel = btn.dataset.label;
    savePrefs(prefs);
    renderFretboard();
  });
}

$('more').addEventListener('toggle', (e) => {
  prefs.moreOpen = e.target.open;
  savePrefs(prefs);
});

// --- Render ------------------------------------------------------------------------

function renderAll() {
  renderKeybar();
  renderStatus();
  renderOptions();
  renderDiagrams();
  renderFretboard();
  drawPages();
}

// Scale of the key being played, on the neck (named like the chord shapes,
// counted from the capo).
function renderFretboard() {
  const d = derive();
  const card = $('fretboard-card');
  card.hidden = !d.orig;
  if (!d.orig) return;
  const open = prefs.fretboard;
  $('fretboard-toggle').setAttribute('aria-expanded', String(open));
  $('fretboard-body').hidden = !open;

  const pent = prefs.scaleType === 'pent';
  const scaleKey = d.minor ? (pent ? 'minorPent' : 'minor') : pent ? 'majorPent' : 'major';
  const tonicName = keyName(d.target, d.minor).replace(/m$/, '');
  $('fretboard-title').textContent = `· ${tonicName} ${SCALES[scaleKey].name}`;
  for (const btn of document.querySelectorAll('#fretboard-card [data-scale]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.scale === prefs.scaleType));
  }
  for (const btn of document.querySelectorAll('#fretboard-card [data-label]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.label === prefs.fbLabel));
  }
  if (!open) return;
  const capo = song.view.capo;
  $('fretboard').innerHTML = renderFretboardSVG({
    tonicName,
    scaleKey,
    capo,
    lastFret: Math.min(22, capo + 15),
    labelMode: prefs.fbLabel,
  });
}

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

function renderKeybar() {
  const d = derive();
  const chips = $('key-chips');
  chips.textContent = '';
  if (!d.orig) {
    $('key-name').textContent = d.shift === 0 ? 'เดิม' : signed(d.shift);
    $('shift-label').textContent = 'ครึ่งเสียง';
    chips.hidden = true;
    return;
  }
  chips.hidden = false;
  $('key-name').textContent = keyName(d.target, d.minor);
  $('shift-label').textContent = d.shift === 0 ? 'คีย์ต้นฉบับ' : `${signed(d.shift)} ครึ่งเสียง จากคีย์เดิม`;

  for (let pc = 0; pc < 12; pc++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key-chip';
    btn.textContent = keyName(pc, d.minor);
    const active = pc === d.target;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    if (pc === d.orig.tonic) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'เดิม';
      btn.append(tag);
      btn.setAttribute('aria-label', `${keyName(pc, d.minor)} (คีย์เดิม)`);
    }
    btn.addEventListener('click', () => setShift(shortestShift(d.orig.tonic, pc)));
    chips.append(btn);
  }
  // Keep the selected key in view on narrow screens.
  requestAnimationFrame(() => {
    const active = chips.querySelector('.active');
    if (active && chips.scrollWidth > chips.clientWidth) {
      chips.scrollLeft = active.offsetLeft - chips.clientWidth / 2 + active.offsetWidth / 2;
    }
  });
}

function pill(text, cls = '') {
  const span = document.createElement('span');
  span.className = `pill ${cls}`.trim();
  span.textContent = text;
  return span;
}

function renderStatus() {
  const d = derive();
  const line = $('status-line');
  line.textContent = '';
  if (d.orig) line.append(pill(`คีย์เดิม ${keyName(d.orig.tonic, d.minor)}`));
  if (d.tuning && !song.view.std) line.append(pill(tuningText(d.tuning), 'warn'));
  if (d.tuning && song.view.std) line.append(pill('จูนมาตรฐาน'));
  if (song.view.capo) line.append(pill(`คาโป้ ${song.view.capo}`, 'warn'));
  if (d.orig) {
    const same = d.soundDiff === 0;
    const diff = Math.abs(d.soundDiff);
    line.append(
      pill(
        `เสียงจริง ${keyName(d.sounding, d.minor)} · ` +
          (same ? '✓ เท่าต้นฉบับ' : `${d.soundDiff > 0 ? 'สูง' : 'ต่ำ'}กว่าต้นฉบับ ${diff} ครึ่งเสียง`),
        same ? 'good' : '',
      ),
    );
  }

  // Tuning helper
  const tuningCard = $('tuning-card');
  tuningCard.hidden = !d.tuning;
  if (d.tuning) {
    $('std-toggle').checked = song.view.std;
    $('tuning-note').textContent = song.view.std
      ? 'ใช้จูนมาตรฐานอยู่ — คอร์ดถูกแปลงให้เสียงเท่าต้นฉบับแล้ว'
      : `เพลงนี้${tuningText(d.tuning)} เปิดสวิตช์นี้เพื่อเล่นด้วยจูนมาตรฐาน เสียงเท่าเดิม`;
  }

  // Capo helper: same sound, easier shapes.
  const capoCard = $('capo-card');
  const chips = $('capo-chips');
  chips.textContent = '';
  if (!d.orig) {
    capoCard.hidden = true;
    return;
  }
  const options = capoOptions({ soundTonic: d.sounding, minor: d.minor, tuningOffset: d.tuningUsed, maxCapo: 7 });
  const shown = options.filter((o) => o.easy || o.capo === song.view.capo);
  const isCurrent = (o) => o.capo === song.view.capo && o.shapeTonic === d.target;
  // Only worth showing when it offers somewhere else to go.
  capoCard.hidden = !shown.some((o) => !isCurrent(o));
  for (const o of shown) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'capo-chip';
    const current = isCurrent(o);
    btn.classList.toggle('active', current);
    btn.setAttribute('aria-pressed', String(current));
    btn.textContent = `${o.capo ? `คาโป้ ${o.capo}` : 'ไม่ใส่คาโป้'} · ${o.shapeKeyName}${o.easy ? ' ⭐' : ''}`;
    btn.addEventListener('click', () => {
      song.view.capo = o.capo;
      song.view.shift = shortestShift(d.orig.tonic, o.shapeTonic);
      renderAll();
      persist();
      toast(o.capo ? `ใส่คาโป้ช่อง ${o.capo} แล้วจับคอร์ดคีย์ ${o.shapeKeyName}` : `ไม่ใส่คาโป้ จับคอร์ดคีย์ ${o.shapeKeyName}`);
    });
    chips.append(btn);
  }

  // The capo helper sits below the sheet; offer a shortcut to it up here.
  if (!capoCard.hidden) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'pill pill-link';
    jump.textContent = '🎯 ตัวช่วยคาโป้ ↓';
    jump.addEventListener('click', () => capoCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    line.append(jump);
  }
}

function tuningText(semitones) {
  if (semitones === -1) return 'จูนลงครึ่งเสียง (Eb)';
  if (semitones === -2) return 'จูนลง 1 เสียง (D)';
  const n = Math.abs(semitones);
  return `จูน${semitones < 0 ? 'ลง' : 'ขึ้น'} ${n} ครึ่งเสียง`;
}

function renderOptions() {
  const d = derive();
  const capoSelect = $('capo-select');
  if (!capoSelect.options.length) {
    for (let c = 0; c <= 9; c++) capoSelect.add(new Option(c ? `ช่อง ${c}` : 'ไม่ใส่', String(c)));
  }
  capoSelect.value = String(song.view.capo);
  $('spelling-select').value = song.view.spelling;

  const origSelect = $('orig-select');
  origSelect.textContent = '';
  const detected = parseKey(meta().key) || detectKey(allChords());
  origSelect.add(new Option(detected ? `อัตโนมัติ (${keyName(detected.tonic, detected.minor)})` : 'อัตโนมัติ', 'auto'));
  for (const minor of [false, true]) {
    for (let pc = 0; pc < 12; pc++) origSelect.add(new Option(keyName(pc, minor), `${pc}:${minor ? 'm' : 'M'}`));
  }
  origSelect.value = song.origKeyOverride ? `${song.origKeyOverride.tonic}:${song.origKeyOverride.minor ? 'm' : 'M'}` : 'auto';
  origSelect.disabled = !d.orig && !allChords().length;

  const tuningSelect = $('tuning-select');
  tuningSelect.textContent = '';
  const found = detectedMeta().tuning;
  const foundLabel = TUNING_CHOICES.find(([v]) => v === (found ? found.semitones : 0));
  tuningSelect.add(new Option(`อัตโนมัติ (${foundLabel ? foundLabel[1] : tuningText(found.semitones)})`, 'auto'));
  for (const [v, label] of TUNING_CHOICES) tuningSelect.add(new Option(label, String(v)));
  const override = song.tuningOverride;
  tuningSelect.value = override === null || override === undefined ? 'auto' : String(override);

  $('highlight-toggle').checked = prefs.highlight;
  $('more').open = !!prefs.moreOpen;
}

function transposedName(name, d = derive()) {
  return transposeChord(name, d.shift, { flats: d.flats });
}

function renderDiagrams() {
  const card = $('diagram-card');
  const list = $('diagram-list');
  const toggle = $('diagram-toggle');
  const d = derive();
  const names = [...new Set(allChords().map((c) => transposedName(c, d)))];
  card.hidden = names.length === 0;
  toggle.setAttribute('aria-expanded', String(prefs.diagrams));
  list.hidden = !prefs.diagrams;
  list.textContent = '';
  if (!prefs.diagrams) return;
  for (const name of names) {
    const v = getVoicing(name);
    const div = document.createElement('div');
    div.className = 'diagram';
    div.innerHTML = renderChordSVG(name, v, { width: 84 });
    if (v?.approximate || v?.bassIgnored) {
      const mark = document.createElement('span');
      mark.className = 'approx';
      mark.textContent = '≈';
      mark.title = 'ท่าโดยประมาณ (คอร์ดแบบง่าย)';
      div.append(mark);
    }
    list.append(div);
  }
}

// --- Pages -------------------------------------------------------------------------

let selectedId = null;

// Regions of a page shown as separate cards: its columns (stacked so a wide
// multi-column screenshot reads at full width), or the whole page.
function pageViews(page) {
  const split = prefs.splitColumns && page.columns?.length > 1;
  return split ? page.columns : [{ x: 0, y: 0, w: page.source.width, h: page.source.height }];
}

let builtFor = '';
let builtPages = null;

function drawPages() {
  const d = derive();
  // song.pages is a fresh array whenever a song is (re)opened.
  if (song.pages !== builtPages) builtFor = '';
  builtPages = song.pages;
  const signature = `${song.id}|${song.pages.length}|${prefs.splitColumns}`;
  if (signature !== builtFor) buildPages(signature);
  pagesEl.classList.toggle('adding', addMode);
  song.pages.forEach((page) => {
    // Render the full page once, then copy each view's region.
    page.full ??= document.createElement('canvas');
    const pr = page.pixelRatio;
    drawPage(page.full, page, {
      shift: d.shift,
      flats: d.flats,
      highlight: prefs.highlight,
      selectedId,
      original: showOriginal,
      pixelRatio: pr,
    });
    for (const canvas of page.viewCanvases) {
      const r = canvas.region;
      const w = Math.round(r.w * pr);
      const h = Math.round(r.h * pr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.getContext('2d').drawImage(page.full, r.x * pr, r.y * pr, w, h, 0, 0, w, h);
    }
  });
  const splitBtn = $('split-btn');
  splitBtn.hidden = !song.pages.some((p) => p.columns?.length > 1);
  splitBtn.setAttribute('aria-pressed', String(!!prefs.splitColumns));
  const hint = $('sheet-hint');
  hint.classList.toggle('adding', addMode);
  hint.textContent = addMode
    ? 'แตะตรงคอร์ดในรูปที่ยังไม่ถูกเปลี่ยน'
    : showOriginal
      ? 'กำลังดูรูปต้นฉบับ'
      : 'แตะคอร์ดในรูปเพื่อดูวิธีจับหรือแก้ไข';

  const empty = pagesEl.querySelector('.empty-note');
  if (!allChords().length && !empty) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'ไม่เจอคอร์ดในรูปนี้ — แตะ ➕ เพิ่มคอร์ดที่ขาด แล้วแตะตรงคอร์ดในรูป หรือลองรูปที่ชัดกว่านี้';
    pagesEl.prepend(note);
  } else if (allChords().length && empty) {
    empty.remove();
  }
}

function buildPages(signature) {
  builtFor = signature;
  pagesEl.textContent = '';
  pagesEl.classList.toggle('multi', song.pages.some((p) => pageViews(p).length > 1) || song.pages.length > 1);
  song.pages.forEach((page, i) => {
    const views = pageViews(page);
    // Render resolution: enough that the widest view fills ~1000px sharply,
    // within the canvas pixel budget.
    const widest = Math.max(...views.map((v) => v.w));
    const budget = Math.sqrt(16e6 / (page.source.width * page.source.height));
    page.pixelRatio = Math.max(1, Math.min(3, budget, Math.round(1000 / widest) || 1));
    page.viewCanvases = views.map((region, j) => {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      // Never blow a small screenshot up more than 2× on screen.
      wrap.style.maxWidth = `${Math.round(region.w * 2)}px`;
      const canvas = document.createElement('canvas');
      canvas.region = region;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `รูปคอร์ดหน้า ${i + 1}${views.length > 1 ? ` คอลัมน์ ${j + 1}` : ''}`);
      canvas.addEventListener('click', (e) => onPageClick(e, page, canvas));
      wrap.append(canvas);
      const label = [
        song.pages.length > 1 ? `หน้า ${i + 1}/${song.pages.length}` : '',
        views.length > 1 ? `คอลัมน์ ${j + 1}/${views.length}` : '',
      ].filter(Boolean).join(' · ');
      if (label) {
        const badge = document.createElement('span');
        badge.className = 'page-badge';
        badge.textContent = label;
        wrap.append(badge);
      }
      pagesEl.append(wrap);
      return canvas;
    });
  });
}

$('split-btn').addEventListener('click', () => {
  prefs.splitColumns = !prefs.splitColumns;
  savePrefs(prefs);
  drawPages();
});

async function onPageClick(e, page, canvas) {
  if (showOriginal) return;
  const rect = canvas.getBoundingClientRect();
  const x = canvas.region.x + ((e.clientX - rect.left) / rect.width) * canvas.region.w;
  const y = canvas.region.y + ((e.clientY - rect.top) / rect.height) * canvas.region.h;

  if (addMode) {
    toast('กำลังอ่านคอร์ดตรงนี้…');
    try {
      const item = await readChordAt(page, x, y);
      if (!item) {
        toast('ไม่เจอตัวอักษรตรงนี้ — แตะให้ตรงคอร์ดอีกครั้ง');
        return;
      }
      item.id = newId();
      openSheet(page, item, true);
    } catch (err) {
      console.error(err);
      toast('อ่านไม่สำเร็จ ลองใหม่อีกครั้ง');
    }
    return;
  }

  const item = itemAt(page, x, y);
  if (item) openSheet(page, item, false);
}

$('add-btn').addEventListener('click', () => {
  addMode = !addMode;
  showOriginal = false;
  $('add-btn').setAttribute('aria-pressed', String(addMode));
  $('compare-btn').setAttribute('aria-pressed', 'false');
  drawPages();
  if (addMode) toast('แตะตรงคอร์ดที่ระบบหาไม่เจอ');
});

$('compare-btn').addEventListener('click', () => {
  showOriginal = !showOriginal;
  addMode = false;
  $('compare-btn').setAttribute('aria-pressed', String(showOriginal));
  $('compare-btn').textContent = showOriginal ? '↩ กลับไปคีย์ใหม่' : '👁 ดูต้นฉบับ';
  $('add-btn').setAttribute('aria-pressed', 'false');
  drawPages();
});

// --- Chord editor sheet --------------------------------------------------------------

let editing = null; // { page, item, isNew }

function openSheet(page, item, isNew) {
  editing = { page, item, isNew };
  selectedId = item.id;
  drawPages();
  $('sheet-title').textContent = isNew ? 'เพิ่มคอร์ด' : 'คอร์ดนี้';
  $('sheet-input').value = item.text;
  $('sheet-delete').hidden = isNew;
  $('sheet-save').textContent = isNew ? 'เพิ่ม' : 'บันทึก';
  updateSheetPreview();
  $('sheet').hidden = false;
  if (isNew || !item.text) setTimeout(() => $('sheet-input').focus(), 50);
  else $('sheet-save').focus();
}

function closeSheet() {
  if ($('sheet').hidden) return;
  $('sheet').hidden = true;
  editing = null;
  selectedId = null;
  if (song) drawPages();
}

function updateSheetPreview() {
  const value = $('sheet-input').value.trim();
  const parsed = parseChordText(value);
  const d = derive();
  const err = $('sheet-error');
  const play = $('sheet-play');
  const diagram = $('sheet-diagram');
  if (!parsed) {
    play.textContent = '';
    diagram.innerHTML = '';
    err.textContent = value ? 'ชื่อคอร์ดไม่ถูกต้อง เช่น Am, G7, D/F#, /D/G/' : 'พิมพ์ชื่อคอร์ดตามที่เห็นในรูป';
    $('sheet-save').disabled = true;
    return;
  }
  err.textContent = '';
  $('sheet-save').disabled = false;
  const now = transposeTokens(parsed.tokens, d.shift, d.flats);
  play.textContent = '';
  play.append('เล่นเป็น ');
  const b = document.createElement('b');
  b.textContent = now;
  play.append(b);
  const first = parsed.tokens.find((t) => t.type === 'chord');
  const name = transposedName(first.text, d);
  diagram.innerHTML = renderChordSVG(name, getVoicing(name), { width: 110 });
}

$('sheet-input').addEventListener('input', updateSheetPreview);
$('sheet-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('sheet-save').disabled) $('sheet-save').click();
});
$('sheet-close').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

$('sheet-save').addEventListener('click', () => {
  if (!editing) return;
  const parsed = parseChordText($('sheet-input').value.trim());
  if (!parsed) return;
  const { page, item, isNew } = editing;
  item.tokens = parsed.tokens;
  item.text = tokensText(parsed.tokens);
  if (isNew) {
    item.sourceText = item.text;
    page.items.push(item);
    page.items.sort((a, b) => a.y - b.y || a.x - b.x);
    sampleColors(page);
  }
  closeSheet();
  renderAll();
  persist();
  toast(isNew ? 'เพิ่มคอร์ดแล้ว' : 'แก้คอร์ดแล้ว');
});

$('sheet-delete').addEventListener('click', () => {
  if (!editing) return;
  const { page, item } = editing;
  page.items = page.items.filter((it) => it !== item);
  closeSheet();
  renderAll();
  persist();
  toast('ลบแล้ว — รูปส่วนนั้นกลับเป็นต้นฉบับ');
});

// --- Export ------------------------------------------------------------------------

function exportName(i) {
  const d = derive();
  const key = d.orig ? keyName(d.target, d.minor) : signed(d.shift);
  const base = song.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'chords';
  return `${base} - key ${key}${song.pages.length > 1 ? ` (${i + 1})` : ''}.png`;
}

// Whole pages in their original layout (not the split columns).
function pageBlobs() {
  return Promise.all(song.pages.map((p) => new Promise((resolve) => p.full.toBlob(resolve, 'image/png'))));
}

async function withCleanCanvases(fn) {
  // Export without the selection outline or the "original" view.
  const prev = { selectedId, showOriginal };
  selectedId = null;
  showOriginal = false;
  drawPages();
  try {
    return await fn();
  } finally {
    selectedId = prev.selectedId;
    showOriginal = prev.showOriginal;
    drawPages();
  }
}

$('save-btn').addEventListener('click', () =>
  withCleanCanvases(async () => {
    const blobs = await pageBlobs();
    blobs.forEach((blob, i) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = exportName(i);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    toast('บันทึกรูปแล้ว');
  }),
);

const shareBtn = $('share-btn');
shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }));
shareBtn.addEventListener('click', () =>
  withCleanCanvases(async () => {
    const blobs = await pageBlobs();
    const files = blobs.map((b, i) => new File([b], exportName(i), { type: 'image/png' }));
    try {
      await navigator.share({ files, title: song.name });
    } catch (err) {
      if (err.name !== 'AbortError') toast('แชร์ไม่สำเร็จ — ใช้ปุ่มบันทึกรูปแทน');
    }
  }),
);

$('print-btn').addEventListener('click', () => {
  const d = derive();
  const parts = [song.name];
  if (d.orig) parts.push(`คีย์ ${keyName(d.target, d.minor)}`);
  if (song.view.capo) parts.push(`คาโป้ ${song.view.capo}`);
  if (d.tuning) parts.push(song.view.std ? 'จูนมาตรฐาน' : tuningText(d.tuning));
  $('print-head').textContent = parts.join(' · ');
  withCleanCanvases(() => window.print());
});

$('new-btn').addEventListener('click', () => {
  closeSheet();
  hideError();
  showView('start');
  renderRecent();
  window.scrollTo({ top: 0 });
});

// --- Persistence -------------------------------------------------------------------

const STRIP = new Set(['bg', 'ink', 'darkPaper', 'drawnW']);

function persist(now = false) {
  if (!song) return;
  clearTimeout(saveTimer);
  const run = () => {
    const record = {
      id: song.id,
      name: song.name,
      files: song.files,
      origKeyOverride: song.origKeyOverride,
      tuningOverride: song.tuningOverride,
      view: { ...song.view },
      pages: song.pages.map((p) => ({
        meta: p.meta,
        items: p.items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => !STRIP.has(k)))),
      })),
      summary: summary(),
    };
    saveSong(record);
  };
  if (now) run();
  else saveTimer = setTimeout(run, 400);
}

function summary() {
  const d = derive();
  if (!d.orig) return `${song.files.length} รูป`;
  const from = keyName(d.orig.tonic, d.minor);
  const to = keyName(d.target, d.minor);
  return (from === to ? `คีย์ ${from}` : `${from} → ${to}`) + (song.view.capo ? ` · คาโป้ ${song.view.capo}` : '');
}

async function openSaved(id) {
  const rec = await getSong(id);
  if (!rec) {
    toast('เปิดเพลงนี้ไม่ได้แล้ว');
    renderRecent();
    return;
  }
  hideError();
  try {
    const pages = [];
    for (let i = 0; i < rec.files.length; i++) {
      const source = await loadImage(rec.files[i]);
      const items = (rec.pages[i]?.items || []).map((it) => ({ ...it, id: newId() }));
      const page = { source, items, meta: rec.pages[i]?.meta || {}, columns: detectColumns(source) };
      sampleColors(page);
      pages.push(page);
    }
    song = {
      id: rec.id,
      name: rec.name,
      files: rec.files,
      pages,
      origKeyOverride: rec.origKeyOverride || null,
      tuningOverride: rec.tuningOverride ?? null,
      view: rec.view,
    };
    addMode = false;
    showOriginal = false;
    showView('result');
    renderAll();
    window.scrollTo({ top: 0 });
    persist(true);
  } catch (err) {
    console.error(err);
    showError('เปิดเพลงนี้ไม่สำเร็จ');
  }
}

const thumbUrls = [];
async function renderRecent() {
  const songs = await listSongs();
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const list = $('recent-list');
  list.textContent = '';
  $('recent').hidden = songs.length === 0;
  for (const s of songs) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    const img = document.createElement('img');
    img.alt = '';
    if (s.files?.[0]) {
      img.src = URL.createObjectURL(s.files[0]);
      thumbUrls.push(img.src);
    }
    const text = document.createElement('span');
    text.className = 'recent-text';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = s.name;
    const metaEl = document.createElement('span');
    metaEl.className = 'recent-meta';
    metaEl.textContent = s.summary || '';
    text.append(name, metaEl);
    open.append(img, text);
    open.addEventListener('click', () => openSaved(s.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `ลบ ${s.name}`);
    del.addEventListener('click', async () => {
      await deleteSong(s.id);
      renderRecent();
    });
    li.append(open, del);
    list.append(li);
  }
}

renderRecent();
