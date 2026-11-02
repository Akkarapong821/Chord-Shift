import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { decodeToModelRate, transcribe } from './transcribe.js';
import { extractMelody, extractElectricGuitarMelody } from './melody.js';
import { assignFrets } from './fretting.js';
import { renderTab } from './tab.js';
import { playNotes, stop as stopPlayback } from './player.js';
import { readAudioRange, formatAudioTime, cropAudioSamples, notesInOriginalTime } from './audio-range.js';

const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('file-input');
const progressSection = $('progress-section');
const progressFill = $('progress-fill');
const progressLabel = $('progress-label');
const resultSection = $('result-section');
const errorBox = $('error-box');
const tabOutput = $('tab-output');
const summary = $('summary');
const playBtn = $('play-btn');

// Raw model output, kept so settings changes re-extract notes instantly
// without re-running the model.
let raw = null;
let currentFile = null;
let currentNotes = [];
let currentTabText = '';
let playing = false;
let busy = false;
let sourceUrl = null;
const originalAudio = $('original-audio');
const timeStart = $('time-start');
const timeEnd = $('time-end');
let decodedAudio = null;
let analyzedRange = null;
let previewEnd = null;
let previewFrame = null;

function requestedRange() {
  return readAudioRange(timeStart.value, timeEnd.value, decodedAudio?.duration ?? Infinity);
}

function validateTimeInputs() {
  try {
    // Before loading a new song, only validate syntax and ordering.
    readAudioRange(timeStart.value, timeEnd.value);
    return true;
  } catch (error) { showError(error.message); return false; }
}

// --- File selection -------------------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// --- YouTube ---------------------------------------------------------------

const ytUrl = $('yt-url');
const ytBtn = $('yt-btn');

ytBtn.addEventListener('click', handleYouTube);
ytUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleYouTube();
});

const YT_ERRORS = {
  'invalid-url': 'ลิงก์ YouTube ไม่ถูกต้อง — ใช้ลิงก์แบบ youtube.com/watch?v=… หรือ youtu.be/…',
  'video-too-long': 'วิดีโอยาวเกิน 15 นาที — ดาวน์โหลดแล้วตัดเฉพาะช่วงที่ต้องการมาอัปโหลดแทน',
  'fetch-failed': 'ดึงเสียงจากวิดีโอนี้ไม่ได้ (อาจติดข้อจำกัดอายุ/ภูมิภาค หรือ YouTube เปลี่ยนระบบ) — ลองวิดีโออื่น',
  'upstream-forbidden': 'YouTube ปฏิเสธการดาวน์โหลดเสียงของวิดีโอนี้ — ลองใหม่ หรืออัปโหลดไฟล์เสียงจากเครื่องแทน',
  'video-unavailable': 'วิดีโอนี้ไม่พร้อมให้ดึงเสียง อาจเป็นวิดีโอส่วนตัวหรือต้องเข้าสู่ระบบ — ใช้ไฟล์เสียงจากเครื่องแทน',
  'download-timeout': 'ดึงเสียงจาก YouTube นานเกินไป — ตรวจการเชื่อมต่อแล้วลองใหม่ หรืออัปโหลดไฟล์เสียงแทน',
  'incomplete-audio': 'ได้รับเสียงจาก YouTube ไม่ครบ — กรุณาลองใหม่ หรืออัปโหลดไฟล์เสียงแทน',
  'invalid-audio': 'YouTube ไม่ได้ส่งไฟล์เสียงที่รองรับกลับมา — ลองใหม่ หรืออัปโหลดไฟล์เสียงแทน',
  'audio-too-large': 'ไฟล์เสียงใหญ่เกิน 32 MB — ตัดเฉพาะช่วงที่ต้องการแล้วอัปโหลดแทน',
  'live-video': 'ยังไม่รองรับไลฟ์สด — ใช้วิดีโอที่จบแล้วหรืออัปโหลดไฟล์เสียงแทน',
  'downloader-missing': 'ยังไม่ได้ติดตั้งตัวดึงเสียง YouTube บนเซิร์ฟเวอร์ — รัน npm run setup:youtube แล้วลองใหม่ หรืออัปโหลดไฟล์เสียงแทน',
};

async function handleYouTube() {
  const url = ytUrl.value.trim();
  if (!url || busy) return;
  if (!validateTimeInputs()) return;
  decodedAudio = null;
  $('source-section').hidden = true;
  setBusy(true);
  hideError();
  resultSection.style.display = 'none';
  progressSection.style.display = 'block';
  ytBtn.disabled = true;
  setProgress(0, 'กำลังดึงเสียงจาก YouTube… (อาจใช้เวลาสักครู่)');

  try {
    const res = await fetch(`/api/youtube?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      const code = (await res.text()).trim();
      throw new Error(YT_ERRORS[code] || `ดึงเสียงไม่สำเร็จ (${res.status})`);
    }
    if (!res.headers.get('Content-Type')?.startsWith('audio/') || !res.body) {
      throw new Error('เซิร์ฟเวอร์นี้ไม่รองรับการดึงเสียงจาก YouTube — เปิดผ่าน npm run dev หรืออัปโหลดไฟล์เสียงแทน');
    }
    const total = Number(res.headers.get('Content-Length')) || 0;
    const title = decodeURIComponent(res.headers.get('X-Video-Title') || 'youtube');

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      setProgress(
        total ? (received / total) * 0.15 : 0.05,
        `กำลังดาวน์โหลดเสียง… ${total ? Math.round((received / total) * 100) + '%' : Math.round(received / 1024) + ' KB'}`,
      );
    }

    if (!received || (total && received !== total)) throw new Error(YT_ERRORS['incomplete-audio']);
    const type = res.headers.get('Content-Type') || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([new Blob(chunks, { type })], `${title}.${ext}`, { type });
    progressSection.style.display = 'none';
    await processFile(file);
  } catch (err) {
    console.error(err);
    progressSection.style.display = 'none';
    showError(err instanceof TypeError
      ? 'การเชื่อมต่อกับเซิร์ฟเวอร์ขาดหายระหว่างดึงเสียง — ตรวจว่าเซิร์ฟเวอร์ยังทำงาน แล้วลองใหม่ หรืออัปโหลดไฟล์เสียงแทน'
      : err.message);
  } finally {
    setBusy(false);
  }
}

async function handleFile(file) {
  if (busy) return;
  setBusy(true);
  try {
    await processFile(file);
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  busy = on;
  fileInput.disabled = on;
  ytBtn.disabled = on;
  for (const id of ['time-start', 'time-end', 'full-range-btn']) $(id).disabled = on;
  for (const id of ['analyze-range-btn', 'preview-range-btn', 'use-start-btn', 'use-end-btn']) {
    $(id).disabled = on || !decodedAudio;
  }
  dropzone.setAttribute('aria-busy', String(on));
  if (on) {
    stopPlayback();
    setPlaying(false);
    originalAudio.pause();
    raw = null;
  }
}

async function processFile(file) {
  currentFile = file;
  raw = null;
  decodedAudio = null;
  analyzedRange = null;
  $('source-section').hidden = true;
  hideError();
  resultSection.style.display = 'none';
  progressSection.style.display = 'block';
  setProgress(0, 'กำลังอ่านไฟล์เสียง…');

  try {
    decodedAudio = await decodeToModelRate(file);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    originalAudio.src = sourceUrl;
    $('source-name').textContent = file.name;
    $('source-section').hidden = false;
    updateRangeStatus();
    await analyzeSelection();
  } catch (err) {
    console.error(err);
    progressSection.style.display = 'none';
    showError(
      err.name === 'EncodingError' || /decod/i.test(String(err.message))
        ? 'อ่านไฟล์นี้ไม่ได้ — ลองแปลงเป็น MP3 หรือ WAV ก่อน'
        : `เกิดข้อผิดพลาด: ${err.message}`,
    );
  }
}

async function analyzeSelection() {
  const selection = cropAudioSamples(decodedAudio, requestedRange());
  analyzedRange = { start: selection.start, end: selection.end };
  const label = `${formatAudioTime(selection.start)} – ${formatAudioTime(selection.end)}`;
  progressSection.style.display = 'block';
  setProgress(0.05, `กำลังแกะช่วง ${label}…`);
  raw = await transcribe(selection.samples, (pct) => {
    setProgress(0.05 + pct * 0.9, `กำลังแกะช่วง ${label}… ${Math.round(pct * 100)}%`);
  });
  setProgress(1, 'เสร็จแล้ว');
  progressSection.style.display = 'none';
  resultSection.style.display = 'block';
  rebuild();
  updateRangeStatus();
}

function updateRangeStatus() {
  const loaded = decodedAudio ? `ความยาวเพลง ${formatAudioTime(decodedAudio.duration)}` : 'ยังไม่ได้โหลดเพลง';
  try {
    const range = requestedRange();
    const end = Number.isFinite(range.end) ? formatAudioTime(range.end) : 'จบเพลง';
    $('range-status').textContent = `${loaded} · ช่วง ${formatAudioTime(range.start)} – ${end}${decodedAudio && !raw ? ' · กดแกะช่วงที่เลือกเพื่อสร้างแท็บ' : ''}`;
  } catch (error) {
    $('range-status').textContent = `${loaded} · ${error.message}`;
  }
}

function rangeChanged() {
  stopPlayback();
  setPlaying(false);
  originalAudio.pause();
  raw = null;
  resultSection.style.display = 'none';
  hideError();
  updateRangeStatus();
}

timeStart.addEventListener('input', rangeChanged);
timeEnd.addEventListener('input', rangeChanged);
$('full-range-btn').addEventListener('click', () => {
  timeStart.value = '0:00';
  timeEnd.value = '';
  rangeChanged();
});
for (const [id, field] of [['use-start-btn', timeStart], ['use-end-btn', timeEnd]]) {
  $(id).addEventListener('click', () => {
    field.value = formatAudioTime(Math.min(originalAudio.currentTime, decodedAudio.duration));
    rangeChanged();
  });
}
$('analyze-range-btn').addEventListener('click', async () => {
  if (busy || !decodedAudio) return;
  hideError();
  try { requestedRange(); } catch (error) { showError(error.message); return; }
  setBusy(true);
  resultSection.style.display = 'none';
  try { await analyzeSelection(); }
  catch (error) { progressSection.style.display = 'none'; showError(error.message); }
  finally { setBusy(false); }
});

$('preview-range-btn').addEventListener('click', async () => {
  if (busy || !decodedAudio) return;
  if (previewEnd !== null) { originalAudio.pause(); return; }
  hideError();
  try {
    const range = requestedRange();
    originalAudio.currentTime = range.start;
    previewEnd = range.end;
    await originalAudio.play();
    $('preview-range-btn').textContent = '■ หยุดฟังช่วงที่เลือก';
  } catch (error) { stopPreview(); showError(error.message); }
});

function watchPreview() {
  if (previewEnd === null || originalAudio.paused) return;
  if (originalAudio.currentTime >= previewEnd) { originalAudio.pause(); return; }
  previewFrame = requestAnimationFrame(watchPreview);
}
function stopPreview() {
  previewEnd = null;
  cancelAnimationFrame(previewFrame);
  $('preview-range-btn').textContent = '▶ ฟังช่วงที่เลือก';
}
originalAudio.addEventListener('pause', stopPreview);
originalAudio.addEventListener('ended', stopPreview);

function setProgress(frac, label) {
  progressFill.style.width = `${Math.round(frac * 100)}%`;
  progressLabel.textContent = label;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
}
function hideError() {
  errorBox.style.display = 'none';
}

// --- Settings → notes → tab ------------------------------------------------

const sensitivity = $('sensitivity');
const minLen = $('min-len');
const melodyOnly = $('melody-only');
const instrument = $('instrument');
const pitchRange = $('pitch-range');
const maxFret = $('max-fret');

const SENSITIVITY_LABELS = { 1: 'ต่ำมาก', 3: 'ต่ำ', 5: 'ปานกลาง', 7: 'สูง', 9: 'สูงมาก' };

sensitivity.addEventListener('input', rebuild);
minLen.addEventListener('input', rebuild);
melodyOnly.addEventListener('change', rebuild);
instrument.addEventListener('change', rebuild);
pitchRange.addEventListener('change', rebuild);
maxFret.addEventListener('change', rebuild);

function rebuild() {
  const electric = instrument.value === 'electric';
  const fretLimit = Number(maxFret.value);
  pitchRange.disabled = !electric;
  $('mode-help').textContent = electric
    ? 'โหมดกีตาร์ไฟฟ้าเลือกแนวโน้ตที่ต่อเนื่องในช่วงเสียงที่กำหนด และคงระดับเสียงเดิม เครื่องมือนี้ยังไม่แยกกีตาร์ออกจากเสียงร้องหรือเครื่องดนตรีอื่นในเพลงเต็ม'
    : 'โหมดเมโลดี้ทั่วไปเลือกโน้ตเด่นในแต่ละช่วง โน้ตนอกช่วงกีตาร์จะถูกเลื่อน octave ให้เล่นได้';

  const sens = Number(sensitivity.value); // 1..9, higher = more notes
  const onsetThresh = 1.0 - sens * 0.09; // 0.91 .. 0.19
  const frameThresh = 0.3;
  const minNoteLen = Number(minLen.value);

  const nearest = [1, 3, 5, 7, 9].reduce((a, b) => (Math.abs(b - sens) < Math.abs(a - sens) ? b : a));
  $('sensitivity-val').textContent = SENSITIVITY_LABELS[nearest];
  $('min-len-val').textContent = `~${Math.round(minNoteLen * 11.6)} ms`;
  if (!raw) return;
  stopPlayback();
  setPlaying(false);

  let notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      raw.contours,
      outputToNotesPoly(raw.frames, raw.onsets, onsetThresh, frameThresh, minNoteLen),
    ),
  );
  notes = notesInOriginalTime(notes, analyzedRange);

  const detectedCount = notes.length;
  if (electric) {
    notes = notes.filter((n) => n.pitchMidi >= Number(pitchRange.value) && n.pitchMidi <= 64 + fretLimit);
  }
  const excludedCount = detectedCount - notes.length;
  if (melodyOnly.checked) {
    notes = electric
      ? extractElectricGuitarMelody(notes, { minPitch: Number(pitchRange.value), maxPitch: 64 + fretLimit })
      : extractMelody(notes);
  } else {
    notes = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  }

  currentNotes = assignFrets(notes, { maxFret: fretLimit, octaveShift: !electric });
  const tabHeader = `${electric ? 'Electric Guitar' : 'Melody'} TAB · Standard tuning: E A D G B e · Frets: 0–${fretLimit}`;
  const rangeLabel = `${formatAudioTime(analyzedRange.start)} – ${formatAudioTime(analyzedRange.end)}`;
  currentTabText = `${tabHeader}\nSource time: ${rangeLabel}\n${electric ? 'Original pitches' : 'Octave adjusted to playable range'} · Sequential notes, not rhythmic notation\n\n${renderTab(currentNotes)}`;

  summary.textContent = currentNotes.length
    ? `ช่วง ${rangeLabel} · พบ ${currentNotes.length} โน้ต · จูนมาตรฐาน (EADGBe) · เฟรต 0–${fretLimit}${electric ? ` · กรองนอกช่วงเสียง ${excludedCount} โน้ต` : ''}`
    : 'ไม่พบโน้ตในช่วงนี้ — ลองเลือกช่วงเสียงรวมริฟฟ์เสียงต่ำ เพิ่มความไว หรือลดความยาวโน้ตขั้นต่ำ';
  for (const id of ['play-btn', 'copy-btn', 'download-btn']) $(id).disabled = !currentNotes.length;

  tabOutput.innerHTML = currentTabText.replace(/\[(\d+:\d+)\]/g, '<span class="time-mark">[$1]</span>');
}

// --- Toolbar ---------------------------------------------------------------

playBtn.addEventListener('click', () => {
  if (playing) {
    stopPlayback();
    setPlaying(false);
    return;
  }
  if (!currentNotes.length) return;
  originalAudio.pause();
  setPlaying(true);
  playNotes(currentNotes, () => setPlaying(false));
});

originalAudio.addEventListener('play', () => {
  stopPlayback();
  setPlaying(false);
  cancelAnimationFrame(previewFrame);
  watchPreview();
});

function setPlaying(on) {
  playing = on;
  playBtn.textContent = on ? '■ หยุด' : '▶ ฟังโน้ตที่ถอดได้';
}

$('copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentTabText);
  flashButton($('copy-btn'), 'คัดลอกแล้ว ✓');
});

$('download-btn').addEventListener('click', () => {
  const base = (currentFile?.name || 'melody').replace(/\.[^.]+$/, '');
  const blob = new Blob([`${base}\nถอดโดย Melody Tab\n\n${currentTabText}`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}-tab.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('new-file-btn').addEventListener('click', () => {
  stopPlayback();
  setPlaying(false);
  fileInput.value = '';
  fileInput.click();
});

function flashButton(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1200);
}
