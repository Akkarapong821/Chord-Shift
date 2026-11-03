// The transport WAV contains guitar on channel 0 and drums on channel 1.
// Listening/export mixes are mono; transcription continues to read channel 0.
export function mixStemSamples(audio, { guitar, drums }) {
  if (!guitar && !drums) return null;
  if (audio.numberOfChannels !== 2) throw new Error('ต้องมีเสียงกีตาร์และกลองครบสองแทร็ก');
  const first = audio.getChannelData(0);
  const second = audio.getChannelData(1);
  const samples = new Float32Array(first.length);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (guitar ? first[i] : 0) + (drums ? second[i] : 0);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  // Preserve the balance, applying one master gain only when the sum would clip.
  if (peak > 0.98) for (let i = 0; i < samples.length; i++) samples[i] *= 0.98 / peak;
  return samples;
}

export function encodeMonoWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const data = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); data.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
  data.setUint16(22, 1, true); data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, 'data'); data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export class StemPlayer {
  constructor(audio, { urls = URL, onError = () => {} } = {}) {
    this.audio = audio;
    this.urls = urls;
    this.onError = onError;
    this.outputs = new Map();
  }

  load(buffer) {
    this.clear();
    this.buffer = buffer;
    this.restore = { position: 0, playing: false };
  }

  clear() {
    this.audio.pause();
    this.detachMetadata();
    for (const url of this.outputs.values()) this.urls.revokeObjectURL(url);
    this.outputs.clear();
    this.buffer = null;
    this.restore = null;
  }

  detachMetadata() {
    if (this.metadataListener) this.audio.removeEventListener('loadedmetadata', this.metadataListener);
    this.metadataListener = null;
  }

  select(selection) {
    if (!this.buffer) throw new Error('ยังไม่ได้โหลดแทร็กกีตาร์และกลอง');
    const key = `${+selection.guitar}${+selection.drums}`;
    const position = this.restore?.position ?? this.audio.currentTime;
    const playing = this.restore?.playing ?? (!this.audio.paused && !this.audio.ended);
    this.detachMetadata();
    this.audio.pause();
    this.restore = { position, playing: key === '00' ? false : playing };
    if (key === '00') return null;
    if (!this.outputs.has(key)) {
      const samples = mixStemSamples(this.buffer, selection);
      this.outputs.set(key, this.urls.createObjectURL(new Blob([encodeMonoWav(samples, this.buffer.sampleRate)], { type: 'audio/wav' })));
    }
    const url = this.outputs.get(key);
    const restore = () => {
      this.detachMetadata();
      const state = this.restore;
      this.restore = null;
      if (!state) return;
      this.audio.currentTime = Math.min(state.position, this.audio.duration || this.buffer.duration);
      if (state.playing) this.audio.play().catch(this.onError);
    };
    if (this.audio.src === url && this.audio.readyState >= 1) restore();
    else {
      this.metadataListener = restore;
      this.audio.addEventListener('loadedmetadata', restore);
      this.audio.src = url;
    }
    return { url };
  }
}
