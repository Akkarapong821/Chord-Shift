// User-facing timestamps accept seconds or minutes:seconds (with decimals).
export function parseAudioTime(value) {
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^\d+:\d{1,2}(?:\.\d+)?$/.test(text)) {
    const [minutes, seconds] = text.split(':').map(Number);
    if (seconds < 60) return minutes * 60 + seconds;
  }
  throw new Error('กรอกเวลาเป็น นาที:วินาที เช่น 1:25 หรือจำนวนวินาที เช่น 85');
}

export function readAudioRange(startText, endText, duration = Infinity) {
  const start = String(startText).trim() ? parseAudioTime(startText) : 0;
  const end = String(endText).trim() ? parseAudioTime(endText) : duration;
  if (!Number.isFinite(start) || start < 0 || start >= duration) {
    throw new Error('เวลาเริ่มต้นต้องอยู่ก่อนจบเพลง');
  }
  if (end <= start) throw new Error('เวลาสิ้นสุดต้องมากกว่าเวลาเริ่มต้น');
  if (end > duration) throw new Error(`เวลาสิ้นสุดเกินความยาวเพลง (${formatAudioTime(duration)})`);
  if (end - start < 0.1) throw new Error('เลือกช่วงเสียงอย่างน้อย 0.1 วินาที');
  if (!Number.isFinite(end) && String(endText).trim()) throw new Error('เวลาสิ้นสุดไม่ถูกต้อง');
  return { start, end };
}

export function formatAudioTime(seconds) {
  // Truncate sub-millisecond precision so a duration copied into a field
  // never becomes longer than the actual decoded audio.
  const millis = Math.floor(seconds * 1000);
  const minutes = Math.floor(millis / 60000);
  const remainder = ((millis % 60000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${minutes}:${Number(remainder) < 10 ? '0' : ''}${remainder}`;
}

export function cropAudioSamples(audio, range) {
  const source = audio.getChannelData(0);
  const start = Math.round(range.start * audio.sampleRate);
  const end = Math.min(source.length, Math.round(range.end * audio.sampleRate));
  if (end <= start || start < 0 || end > source.length) throw new Error('ช่วงเสียงที่เลือกไม่ถูกต้อง');
  return {
    samples: source.slice(start, end),
    start: start / audio.sampleRate,
    end: end / audio.sampleRate,
  };
}

export function notesInOriginalTime(notes, range) {
  return notes.flatMap((note) => {
    const start = Math.max(range.start, range.start + note.startTimeSeconds);
    const end = Math.min(range.end, range.start + note.startTimeSeconds + note.durationSeconds);
    return end > start ? [{ ...note, startTimeSeconds: start, durationSeconds: end - start }] : [];
  });
}
