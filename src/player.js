// Play back the transcribed notes so the user can verify the transcription
// by ear. Acoustic guitar model in two parts:
//   1. String: Karplus-Strong synthesis — a noise burst circulating through a
//      delay line, comb-filtered by pick position so the attack has the
//      hollow character of a real pluck.
//   2. Body: a ConvolverNode with a synthetic impulse response carrying the
//      air-cavity resonance (~100 Hz) and wood-top modes of a dreadnought,
//      which gives the notes the boxy warmth of an acoustic.

let ctx = null;
let stopFlag = { stopped: false };

// Exported for testing.
export function pluckBuffer(sampleRate, freq, durSeconds, brightness = 0.5) {
  const ringSeconds = durSeconds + 0.4; // let the string ring past the note
  const len = Math.ceil(sampleRate * ringSeconds);
  const data = new Float32Array(len);

  const N = Math.max(2, Math.round(sampleRate / freq));
  const delay = new Float32Array(N);

  // Excitation: lowpass-filtered noise burst (soft pick)...
  let last = 0;
  for (let i = 0; i < N; i++) {
    const white = Math.random() * 2 - 1;
    last = brightness * white + (1 - brightness) * last;
    delay[i] = last;
  }
  // ...comb-filtered by pick position (~1/8 along the string, near the
  // soundhole). Cancelling those harmonics is what makes it sound "plucked".
  const pick = Math.max(1, Math.round(N * 0.12));
  const excitation = delay.slice();
  for (let i = 0; i < N; i++) {
    delay[i] = excitation[i] - 0.9 * excitation[(i - pick + N) % N];
  }

  // Damping is applied once per trip around the loop (freq times/second), so
  // low strings naturally ring longer than high ones — like a real guitar.
  const damping = 0.996;
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const cur = delay[idx];
    const next = delay[(idx + 1) % N];
    data[i] = cur;
    delay[idx] = damping * 0.5 * (cur + next);
    idx = (idx + 1) % N;
  }

  // Normalize so every pluck starts at a consistent level.
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) {
    for (let i = 0; i < len; i++) data[i] /= peak;
  }
  return data;
}

// Synthetic body impulse response: a handful of decaying resonant modes.
// Frequencies/decays loosely follow measured dreadnought responses — the
// ~100 Hz Helmholtz air mode dominates, wood modes above it fade faster.
export function bodyImpulseResponse(sampleRate) {
  const dur = 0.28;
  const len = Math.ceil(sampleRate * dur);
  const data = new Float32Array(len);
  const modes = [
    // [freq Hz, amplitude, decay per second]
    [98, 1.0, 22],
    [195, 0.55, 30],
    [285, 0.35, 40],
    [420, 0.25, 55],
    [650, 0.15, 70],
    [1100, 0.08, 90],
  ];
  for (const [freq, amp, decay] of modes) {
    const phase = Math.random() * 2 * Math.PI;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      data[i] += amp * Math.sin(2 * Math.PI * freq * t + phase) * Math.exp(-decay * t);
    }
  }
  // A whisper of broadband "knock" so the attack sounds like wood.
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    data[i] += (Math.random() * 2 - 1) * 0.06 * Math.exp(-120 * t);
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  for (let i = 0; i < len; i++) data[i] = (data[i] / peak) * 0.5;
  return data;
}

const bufferCache = new Map();

function getPluckBuffer(audioCtx, freq, durSeconds) {
  const key = `${Math.round(freq * 10)}_${Math.round(durSeconds * 10)}`;
  let buf = bufferCache.get(key);
  if (!buf) {
    const data = pluckBuffer(audioCtx.sampleRate, freq, durSeconds);
    buf = audioCtx.createBuffer(1, data.length, audioCtx.sampleRate);
    buf.copyToChannel(data, 0);
    bufferCache.set(key, buf);
  }
  return buf;
}

export function playNotes(notes, onDone) {
  stop();
  if (notes.length === 0) return;
  ctx = new AudioContext();
  stopFlag = { stopped: false };
  const flag = stopFlag;

  // Gentle compression keeps overlapping ringing strings from clipping.
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -18;
  master.ratio.value = 6;
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.9;
  master.connect(masterGain).connect(ctx.destination);

  // All strings feed one bus, split into direct string sound and the
  // body-resonance convolution.
  const stringBus = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 0.55;
  const convolver = ctx.createConvolver();
  const irData = bodyImpulseResponse(ctx.sampleRate);
  const irBuf = ctx.createBuffer(1, irData.length, ctx.sampleRate);
  irBuf.copyToChannel(irData, 0);
  convolver.buffer = irBuf;
  const wet = ctx.createGain();
  wet.gain.value = 1.4;
  stringBus.connect(dry).connect(master);
  stringBus.connect(convolver).connect(wet).connect(master);

  const t0 = ctx.currentTime + 0.1;
  const firstStart = notes[0].startTimeSeconds;
  let lastEnd = 0;

  for (const note of notes) {
    const start = t0 + (note.startTimeSeconds - firstStart);
    const dur = Math.max(0.15, Math.min(note.durationSeconds, 2.0));
    lastEnd = Math.max(lastEnd, start + dur + 0.6);

    const freq = 440 * Math.pow(2, (note.pitchMidi - 69) / 12);
    const source = ctx.createBufferSource();
    source.buffer = getPluckBuffer(ctx, freq, dur);

    // Hold through the note, then release so the melody's rhythm stays clear.
    const gain = ctx.createGain();
    const vol = 0.3 + 0.4 * Math.min(1, note.amplitude);
    gain.gain.setValueAtTime(vol, start);
    gain.gain.setValueAtTime(vol, start + dur);
    gain.gain.linearRampToValueAtTime(0, start + dur + 0.35);

    source.connect(gain).connect(stringBus);
    source.start(start);
  }

  const totalMs = (lastEnd - ctx.currentTime) * 1000 + 200;
  setTimeout(() => {
    if (!flag.stopped) {
      stop();
      onDone?.();
    }
  }, totalMs);
}

export function stop() {
  stopFlag.stopped = true;
  if (ctx) {
    ctx.close();
    ctx = null;
  }
}
