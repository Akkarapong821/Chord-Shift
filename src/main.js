import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { decodeToModelRate, transcribe } from './transcribe.js';
import { extractMelody, extractElectricGuitarMelody } from './melody.js';
import { assignFrets } from './fretting.js';
import { renderTab } from './tab.js';
import { playNotes, stop as stopPlayback } from './player.js';
import { readAudioRange, formatAudioTime, cropAudioSamples, notesInOriginalTime, rangeForSource } from './audio-range.js';
import { checkYouTubeHelper, defaultYouTubeSource, youtubeRequestUrl, youtubePreviewUrl, checkLocalServer } from './youtube-source.js';
import { canRecordTab, startTabRecording } from './tab-recording.js';

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
let sourceOffset = 0;
let isolatedSource = false;
let youtubeAbort = null;
const originalAudio = $('original-audio');
const timeStart = $('time-start');
const timeEnd = $('time-end');
let decodedAudio = null;
let analyzedRange = null;
let previewEnd = null;
let previewFrame = null;
let recording = null;
const recordButton = $('record-tab-btn');
if (!canRecordTab()) {
  recordButton.disabled = true;
  $('record-status').textContent = 'เบราว์เซอร์นี้ยังไม่รองรับการรับเสียงจากแท็บ — เปิดเว็บใน Chrome / Edge บนคอมพิวเตอร์ หรืออัปโหลดไฟล์เสียง';
}
recordButton.addEventListener('click', async () => {
  if (busy) return;
  hideError();
  resultSection.style.display = 'none';
  setBusy(true);
  $('record-status').textContent = 'เลือกแท็บที่เล่นเพลง พร้อมเปิดแชร์เสียงของแท็บ…';
  let clock;
  try {
    recording = await startTabRecording();
    $('stop-record-btn').disabled = false;
    $('cancel-record-btn').disabled = false;
    const started = performance.now();
    const update = () => {
      $('record-status').textContent = `กำลังรับเสียง ${formatAudioTime((performance.now() - started) / 1000)} · เล่นช่วงโซโล่แล้วกดหยุดเพื่อแกะ TAB (หยุดอัตโนมัติที่ 15 นาที)`;
    };
    update(); clock = setInterval(update, 250);
    const blob = await recording.finished;
    clearInterval(clock);
    recording = null;
    $('stop-record-btn').disabled = true;
    $('cancel-record-btn').disabled = true;
    if (!blob) { $('record-status').textContent = 'ยกเลิกแล้ว · เสียงที่รับไม่ได้ถูกนำไปแกะ'; return; }
    timeStart.value = '0:00';
    timeEnd.value = '';
    $('record-status').textContent = 'รับเสียงแล้ว · กำลังแกะ TAB จากเสียงในเบราว์เซอร์';
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    await processFile(new File([blob], `เสียงจากแท็บ-${Date.now()}.${ext}`, { type: blob.type }));
    $('record-status').textContent = raw ? 'รับเสียงเสร็จแล้ว · เวลาในแท็บนับจากเริ่มรับเสียง' : 'รับเสียงแล้ว แต่ยังแกะไม่สำเร็จ · ดูข้อความข้อผิดพลาดด้านล่าง';
  } catch (error) {
    const message = error.name === 'NotAllowedError' || error.name === 'AbortError'
      ? 'ยังไม่ได้อนุญาตแชร์แท็บ — กดรับเสียงแล้วเลือกแท็บที่เล่นเพลงพร้อมแชร์เสียง'
      : error.message;
    $('record-status').textContent = message;
    showError(message);
  } finally {
    clearInterval(clock);
    recording = null;
    $('stop-record-btn').disabled = true;
    $('cancel-record-btn').disabled = true;
    setBusy(false);
  }
});
$('stop-record-btn').addEventListener('click', () => recording?.stop());
$('cancel-record-btn').addEventListener('click', () => recording?.cancel());
window.addEventListener('pagehide', () => recording?.cancel());

function requestedRange() {
  return decodedAudio ? rangeForSource(timeStart.value, timeEnd.value, decodedAudio.duration, sourceOffset)
    : readAudioRange(timeStart.value, timeEnd.value);
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
const ytSource = $('yt-source');
// Old shared links no longer configure a connection; use this computer automatically.
if (new URL(location.href).searchParams.has('home')) {
  const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('home');
  history.replaceState(null, '', cleanUrl);
}
$('cancel-youtube-btn').addEventListener('click', () => youtubeAbort?.abort());
function stopYouTubePreview() {
  $('yt-preview').removeAttribute('src');
  $('yt-preview-section').hidden = true;
  $('yt-preview-stop-btn').disabled = true;
  $('yt-preview-stop-btn').hidden = true;
}
function updateYouTubeRangeSummary() {
  try {
    const range = readAudioRange(timeStart.value, timeEnd.value);
    const end = Number.isFinite(range.end) ? formatAudioTime(range.end) : 'จบเพลง';
    const length = Number.isFinite(range.end) ? ` · แกะ ${Number((range.end - range.start).toFixed(3))} วินาที` : '';
    $('yt-range-summary').textContent = `เริ่ม ${formatAudioTime(range.start)} → หยุด ${end}${length}`;
  } catch (error) { $('yt-range-summary').textContent = error.message; }
}
$('yt-preview-btn').addEventListener('click', () => {
  if (busy) return;
  hideError();
  try {
    const range = readAudioRange(timeStart.value, timeEnd.value);
    const url = youtubePreviewUrl(ytUrl.value.trim(), range);
    originalAudio.pause(); stopPlayback(); setPlaying(false);
    $('yt-preview').src = url;
    $('yt-preview-section').hidden = false;
    $('yt-preview-stop-btn').disabled = false;
    $('yt-preview-stop-btn').hidden = false;
  } catch (error) { showError(error.message); }
});
$('yt-preview-stop-btn').addEventListener('click', stopYouTubePreview);
ytUrl.addEventListener('input', stopYouTubePreview);
updateYouTubeRangeSummary();
ytSource.value = defaultYouTubeSource(location.hostname);
function updateYouTubeSource() {
  const helper = ytSource.value === 'helper';
  $('check-helper-btn').hidden = !helper;
  $('yt-source-help').textContent = ytSource.value === 'home'
    ? 'ดึงเสียงและแยกกีตาร์บนคอมเครื่องนี้อัตโนมัติ ดับเบิลคลิก start-youtube-helper.cmd เพื่อเปิดพร้อมใช้งาน'
    : helper
    ? 'ดับเบิลคลิก start-youtube-helper.cmd แล้วใช้หน้า Melody Tab ที่เปิดขึ้นมาได้เลย'
    : 'ดึงเสียงผ่านเซิร์ฟเวอร์ที่เปิดเว็บนี้ หาก YouTube ขอการยืนยันว่าไม่ใช่บอต ให้เลือกตัวช่วยบนเครื่องนี้';
  $('helper-status').textContent = '';
}
ytSource.addEventListener('change', updateYouTubeSource);
updateYouTubeSource();
$('check-helper-btn').addEventListener('click', async () => {
  $('check-helper-btn').disabled = true;
  $('helper-status').textContent = 'กำลังเชื่อมต่อตัวช่วย…';
  try {
    await checkYouTubeHelper();
    $('helper-status').textContent = 'ตัวช่วยพร้อมใช้งาน · วางลิงก์ YouTube แล้วกดแกะโน้ตได้เลย';
  } catch (error) { $('helper-status').textContent = error.message; }
  finally { $('check-helper-btn').disabled = busy; }
});

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
  'youtube-bot-check': 'YouTube ขอการยืนยันว่าไม่ใช่บอตจากเซิร์ฟเวอร์เว็บ — เปลี่ยนเป็นตัวช่วยบนเครื่องนี้ หรืออัปโหลดไฟล์เสียงแทน',
  'helper-busy': 'ตัวช่วยกำลังดึงเสียงให้แท็บอื่นอยู่ — รอให้เสร็จแล้วลองใหม่',
  'guitar-not-installed': 'เซิร์ฟเวอร์นี้ยังไม่ได้ติดตั้งตัวแยกเสียงกีตาร์ — ใช้เซิร์ฟเวอร์คอมบ้านที่เตรียมไว้ แล้วลองใหม่',
  'guitar-range-invalid': 'กรุณาเลือกเวลาเริ่ม–หยุดสำหรับแยกเสียงกีตาร์ ความยาว 0.1–60 วินาที และไม่เกินจบเพลง',
  'guitar-busy': 'คอมกำลังแยกเสียงกีตาร์ให้อีกแท็บอยู่ — รอให้เสร็จแล้วลองใหม่',
  'guitar-failed': 'แยกเสียงกีตาร์ไม่สำเร็จ — ลองเลือกช่วงสั้นลง หรือปิดการแยกเสียงแล้วแกะตามปกติ',
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
  const isolateGuitar = $('guitar-isolation').checked;
  decodedAudio = null;
  sourceOffset = 0;
  $('source-section').hidden = true;
  setBusy(true);
  hideError();
  resultSection.style.display = 'none';
  progressSection.style.display = 'block';
  ytBtn.disabled = true;
  setProgress(0, isolateGuitar ? 'กำลังดึงและแยกกีตาร์ทั้งเพลงบนคอมบ้าน… เมื่อเสร็จจะแกะ TAB เฉพาะช่วงที่เลือก อาจรอหลายนาที' : 'กำลังดึงเสียงจาก YouTube… (อาจใช้เวลาสักครู่)');
  const aborter = new AbortController();
  youtubeAbort = aborter;
  $('cancel-youtube-btn').hidden = !isolateGuitar;
  const requestTimer = setTimeout(() => aborter.abort(new DOMException('Timed out', 'TimeoutError')), isolateGuitar ? 61 * 60 * 1000 : 75000);

  try {
    if (ytSource.value === 'home') await checkLocalServer();
    if (ytSource.value === 'helper') {
      await checkYouTubeHelper();
      $('helper-status').textContent = 'ตัวช่วยพร้อมใช้งาน · กำลังดึงเสียงผ่านเครื่องนี้';
    }
    let requestUrl = youtubeRequestUrl(url, ytSource.value);
    if (isolateGuitar) requestUrl += '&isolate=guitar&full=1';
    const res = await fetch(requestUrl, { signal: aborter.signal });
    if (!res.ok) {
      const code = (await res.text()).trim();
      if (code === 'youtube-bot-check' && ytSource.value === 'helper') {
        throw new Error('YouTube ขอการยืนยันว่าไม่ใช่บอตจากเครือข่ายเครื่องนี้ด้วย — อัปโหลดไฟล์เสียงจากเครื่องแทน');
      }
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
    const separated = res.headers.get('X-Audio-Isolation') === 'guitar';
    if (isolateGuitar && !separated) throw new Error('เซิร์ฟเวอร์ยังไม่รองรับการแยกกีตาร์ — ปิดแล้วเปิดเซิร์ฟเวอร์คอมบ้านใหม่');
    const offset = separated ? Number(res.headers.get('X-Audio-Start')) : 0;
    if (!Number.isFinite(offset) || offset < 0) throw new Error('เวลาอ้างอิงของเสียงกีตาร์ไม่ถูกต้อง');
    const ext = type.includes('wav') ? 'wav' : type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([new Blob(chunks, { type })], `${title}${separated ? '-guitar' : ''}.${ext}`, { type });
    if (ytSource.value === 'helper') $('helper-status').textContent = 'ดึงเสียงผ่านตัวช่วยสำเร็จ';
    $('cancel-youtube-btn').hidden = true;
    progressSection.style.display = 'none';
    await processFile(file, { offset, separated, fullSong: res.headers.get('X-Audio-Full-Song') === '1' });
  } catch (err) {
    console.error(err);
    progressSection.style.display = 'none';
    if (ytSource.value === 'helper') $('helper-status').textContent = 'ดึงเสียงยังไม่สำเร็จ · ดูข้อความด้านล่าง';
    showError(err.name === 'AbortError' ? 'ยกเลิกการดึงและแยกเสียงแล้ว'
      : err.name === 'TimeoutError'
      ? YT_ERRORS['download-timeout']
      : err instanceof TypeError && ytSource.value === 'helper'
      ? 'การเชื่อมต่อตัวช่วยขาดหาย — เปิดตัวช่วยค้างไว้และอนุญาตการเข้าถึงเครือข่ายในเครื่อง แล้วลองใหม่'
      : err instanceof TypeError
      ? 'การเชื่อมต่อกับเซิร์ฟเวอร์ขาดหายระหว่างดึงเสียง — ตรวจว่าเซิร์ฟเวอร์ยังทำงาน แล้วลองใหม่ หรืออัปโหลดไฟล์เสียงแทน'
      : err.message);
  } finally {
    clearTimeout(requestTimer);
    youtubeAbort = null;
    $('cancel-youtube-btn').hidden = true;
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
  recordButton.disabled = on || !canRecordTab();
  ytBtn.disabled = on;
  ytSource.disabled = on;
  $('yt-preview-btn').disabled = on;
  $('check-helper-btn').disabled = on;
  $('guitar-isolation').disabled = on;
  for (const id of ['time-start', 'time-end', 'full-range-btn']) $(id).disabled = on;
  for (const id of ['analyze-range-btn', 'preview-range-btn', 'use-start-btn', 'use-end-btn']) {
    $(id).disabled = on || !decodedAudio;
    $(id).hidden = !decodedAudio;
  }
  dropzone.setAttribute('aria-busy', String(on));
  if (on) {
    stopYouTubePreview();
    stopPlayback();
    setPlaying(false);
    originalAudio.pause();
    raw = null;
  }
}

async function processFile(file, { offset = 0, separated = false, fullSong = false } = {}) {
  currentFile = file;
  sourceOffset = offset;
  isolatedSource = separated;
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
    $('audio-source-label').textContent = separated ? fullSong ? 'ฟังเฉพาะเสียงกีตาร์ทั้งเพลง' : 'ฟังเฉพาะเสียงกีตาร์ที่แยกได้' : 'ฟังเสียงต้นฉบับเทียบกับแท็บ';
    $('guitar-audio-download').textContent = fullSong ? 'ดาวน์โหลดเสียงกีตาร์ทั้งเพลง .wav' : 'ดาวน์โหลดเสียงกีตาร์ .wav';
    $('guitar-audio-download').hidden = !separated;
    $('guitar-audio-download').href = sourceUrl;
    $('guitar-audio-download').download = file.name;
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
  const requested = requestedRange();
  const selection = cropAudioSamples(decodedAudio, { start: requested.start - sourceOffset, end: requested.end - sourceOffset });
  analyzedRange = { start: selection.start + sourceOffset, end: selection.end + sourceOffset };
  const label = `${formatAudioTime(analyzedRange.start)} – ${formatAudioTime(analyzedRange.end)}`;
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
  updateYouTubeRangeSummary();
  const loaded = decodedAudio ? isolatedSource ? `เสียงกีตาร์ ${formatAudioTime(sourceOffset)} – ${formatAudioTime(sourceOffset + decodedAudio.duration)}` : `ความยาวเพลง ${formatAudioTime(decodedAudio.duration)}` : 'ยังไม่ได้โหลดเพลง';
  try {
    const range = requestedRange();
    const end = Number.isFinite(range.end) ? formatAudioTime(range.end) : 'จบเพลง';
    $('range-status').textContent = `${loaded} · ช่วง ${formatAudioTime(range.start)} – ${end}${decodedAudio && !raw ? ' · กดแกะช่วงที่เลือกเพื่อสร้างแท็บ' : ''}`;
  } catch (error) {
    $('range-status').textContent = `${loaded} · ${error.message}`;
  }
}

function rangeChanged() {
  stopYouTubePreview();
  updateYouTubeRangeSummary();
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
  timeStart.value = formatAudioTime(sourceOffset);
  timeEnd.value = '';
  rangeChanged();
});
for (const [id, field] of [['use-start-btn', timeStart], ['use-end-btn', timeEnd]]) {
  $(id).addEventListener('click', () => {
    field.value = formatAudioTime(sourceOffset + Math.min(originalAudio.currentTime, decodedAudio.duration));
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
    originalAudio.currentTime = range.start - sourceOffset;
    previewEnd = range.end - sourceOffset;
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
    ? isolatedSource
      ? 'กำลังแกะจากเสียงกีตาร์ที่แยกแล้ว โดยคงระดับเสียงเดิมและเลือกแนวโน้ตที่ต่อเนื่อง อาจมีเสียงเครื่องดนตรีอื่นหลงเหลือ'
      : 'โหมดกีตาร์ไฟฟ้าเลือกแนวโน้ตที่ต่อเนื่องและคงระดับเสียงเดิม หากต้องการลดเสียงร้อง เบส และกลอง ให้เปิดแยกเสียงกีตาร์ก่อนแกะ TAB'
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
  const tabHeader = `${electric ? 'Electric Guitar' : 'Melody'} TAB${isolatedSource ? ' · Isolated guitar (Demucs 6 stems)' : ''} · Standard tuning: E A D G B e · Frets: 0–${fretLimit}`;
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
