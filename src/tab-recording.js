export function canRecordTab(scope = globalThis) {
  return Boolean(scope.navigator?.mediaDevices?.getDisplayMedia && scope.MediaRecorder && scope.MediaStream);
}

// Record only the audio track. The display track remains live for the lifetime
// of the share, but is never passed to MediaRecorder or saved in the file.
export async function startTabRecording({
  getDisplayMedia = (options) => navigator.mediaDevices.getDisplayMedia(options),
  Recorder = globalThis.MediaRecorder,
  Stream = globalThis.MediaStream,
  maxDurationMs = 15 * 60 * 1000,
  maxBytes = 32 * 1024 * 1024,
} = {}) {
  const shared = await getDisplayMedia({
    video: { displaySurface: 'browser' }, audio: true,
    systemAudio: 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
  });
  const cleanup = () => shared.getTracks().forEach(track => track.stop());
  try {
    const surface = shared.getVideoTracks()[0]?.getSettings?.().displaySurface;
    if (surface && surface !== 'browser') throw new Error('เลือกแชร์แท็บเบราว์เซอร์ที่เล่นเพลง พร้อมเปิดแชร์เสียงของแท็บ');
    if (!shared.getAudioTracks().length) throw new Error('ไม่ได้รับเสียง — เลือกแท็บที่เล่นเพลงและติ๊ก “แชร์เสียงของแท็บ” แล้วลองใหม่');
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => Recorder.isTypeSupported(type));
    const recorder = new Recorder(new Stream(shared.getAudioTracks()), mimeType ? { mimeType } : {});
    const chunks = [];
    let bytes = 0;
    let cancelled = false;
    let failure;
    let timer;
    let settled = false;
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    const ended = () => stop();
    const finished = new Promise((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        shared.getTracks().forEach(track => track.removeEventListener('ended', ended));
        cleanup();
        if (cancelled) resolve(null);
        else if (failure) reject(failure);
        else if (!bytes) reject(new Error('ไม่ได้รับข้อมูลเสียง — ลองแชร์เสียงของแท็บใหม่'));
        else resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
      };
      recorder.addEventListener('dataavailable', event => {
        if (!event.data.size || failure) return;
        bytes += event.data.size;
        if (bytes > maxBytes) { failure = new Error('เสียงที่รับมีขนาดเกิน 32 MB — ลองรับเฉพาะช่วงโซโล่สั้นลง'); stop(); }
        else chunks.push(event.data);
      });
      recorder.addEventListener('error', () => {
        failure = new Error('เบราว์เซอร์บันทึกเสียงไม่สำเร็จ — ลองใหม่หรืออัปโหลดไฟล์เสียง');
        if (recorder.state === 'inactive') finish();
        else stop();
      });
      recorder.addEventListener('stop', finish);
    });
    shared.getTracks().forEach(track => track.addEventListener('ended', ended, { once: true }));
    recorder.start(1000);
    timer = setTimeout(stop, maxDurationMs);
    return { finished, stop, cancel() { cancelled = true; stop(); } };
  } catch (error) { cleanup(); throw error; }
}
