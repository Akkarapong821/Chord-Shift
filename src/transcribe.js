import { BasicPitch } from '@spotify/basic-pitch';

const MODEL_SAMPLE_RATE = 22050;

// Decode any browser-supported audio file and resample to 22050 Hz mono.
export async function decodeToModelRate(file, { channels = 1 } = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }

  const length = Math.ceil(decoded.duration * MODEL_SAMPLE_RATE);
  if (channels > 1 && decoded.numberOfChannels !== channels) throw new Error('ไฟล์แยกเสียงไม่มีแทร็กกีตาร์ กลอง และต้นฉบับครบ — อัปเดตตัวช่วยแล้วดึงเพลงใหม่');
  const offline = new OfflineAudioContext(channels, length, MODEL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered;
}

let modelPromise = null;

// Run the basic-pitch model. Returns raw activation matrices so note
// extraction can be re-run cheaply when the user changes settings.
export async function transcribe(audio, onProgress) {
  if (!modelPromise) {
    modelPromise = Promise.resolve(new BasicPitch('model/model.json'));
  }
  const basicPitch = await modelPromise;

  const frames = [];
  const onsets = [];
  const contours = [];
  await basicPitch.evaluateModel(
    audio, // AudioBuffer or a cropped Float32Array at MODEL_SAMPLE_RATE.
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (pct) => onProgress(pct),
  );
  return { frames, onsets, contours };
}
