import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { decodeToModelRate, transcribe } from './transcribe.js';
import { extractMelody } from './melody.js';
import { assignFrets } from './fretting.js';
import { renderTab } from './tab.js';
import { playNotes, stop as stopPlayback } from './player.js';

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
};

async function handleYouTube() {
  const url = ytUrl.value.trim();
  if (!url) return;
  hideError();
  resultSection.style.display = 'none';
  progressSection.style.display = 'block';
  ytBtn.disabled = true;
  setProgress(0, 'กำลังเชื่อมต่อ YouTube…');

  try {
    const res = await fetch(`/api/youtube?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      const code = (await res.text()).trim();
      throw new Error(YT_ERRORS[code] || `ดึงเสียงไม่สำเร็จ (${res.status})`);
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

    const type = res.headers.get('Content-Type') || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([new Blob(chunks, { type })], `${title}.${ext}`, { type });
    progressSection.style.display = 'none';
    ytBtn.disabled = false;
    await handleFile(file);
  } catch (err) {
    console.error(err);
    progressSection.style.display = 'none';
    ytBtn.disabled = false;
    showError(err.message);
  }
}

async function handleFile(file) {
  currentFile = file;
  raw = null;
  hideError();
  resultSection.style.display = 'none';
  progressSection.style.display = 'block';
  setProgress(0, 'กำลังอ่านไฟล์เสียง…');

  try {
    const audio = await decodeToModelRate(file);
    setProgress(0.05, 'กำลังถอดโน้ตด้วย AI… (เพลงยาวอาจใช้เวลาสักครู่)');
    raw = await transcribe(audio, (pct) => {
      setProgress(0.05 + pct * 0.9, `กำลังถอดโน้ตด้วย AI… ${Math.round(pct * 100)}%`);
    });
    setProgress(1, 'เสร็จแล้ว');
    progressSection.style.display = 'none';
    resultSection.style.display = 'block';
    rebuild();
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

const SENSITIVITY_LABELS = { 1: 'ต่ำมาก', 3: 'ต่ำ', 5: 'ปานกลาง', 7: 'สูง', 9: 'สูงมาก' };

sensitivity.addEventListener('input', rebuild);
minLen.addEventListener('input', rebuild);
melodyOnly.addEventListener('change', rebuild);

function rebuild() {
  if (!raw) return;

  const sens = Number(sensitivity.value); // 1..9, higher = more notes
  const onsetThresh = 1.0 - sens * 0.09; // 0.91 .. 0.19
  const frameThresh = 0.3;
  const minNoteLen = Number(minLen.value);

  const nearest = [1, 3, 5, 7, 9].reduce((a, b) => (Math.abs(b - sens) < Math.abs(a - sens) ? b : a));
  $('sensitivity-val').textContent = SENSITIVITY_LABELS[nearest];
  $('min-len-val').textContent = `~${Math.round(minNoteLen * 11.6)} ms`;

  let notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      raw.contours,
      outputToNotesPoly(raw.frames, raw.onsets, onsetThresh, frameThresh, minNoteLen),
    ),
  );

  if (melodyOnly.checked) {
    notes = extractMelody(notes);
  } else {
    notes = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  }

  currentNotes = assignFrets(notes);
  currentTabText = renderTab(currentNotes);

  const dur = currentNotes.length
    ? currentNotes[currentNotes.length - 1].startTimeSeconds + currentNotes[currentNotes.length - 1].durationSeconds
    : 0;
  summary.textContent = currentNotes.length
    ? `พบ ${currentNotes.length} โน้ต · ความยาว ${Math.round(dur)} วินาที · จูนมาตรฐาน (EADGBe)`
    : 'ไม่พบโน้ตด้วยการตั้งค่านี้';

  tabOutput.innerHTML = currentTabText.replace(/\[(\d+:\d+)\]/g, '<span class="time-mark">[$1]</span>');
}

// --- Toolbar ---------------------------------------------------------------

playBtn.addEventListener('click', () => {
  if (playing) {
    stopPlayback();
    setPlaying(false);
    return;
  }
  setPlaying(true);
  playNotes(currentNotes, () => setPlaying(false));
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
