// Reduce a polyphonic note list to a single melody line.
//
// Notes whose onsets fall within ONSET_GROUP_SEC of each other are treated as
// one "moment" (a strummed chord, doubled octaves, accompaniment hits) and only
// the most prominent note survives: highest amplitude wins, higher pitch breaks
// ties. Long accompaniment notes that started earlier don't suppress new
// melody onsets — each onset group stands on its own.

const ONSET_GROUP_SEC = 0.08;

export function extractMelody(notes) {
  if (notes.length === 0) return [];
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  const melody = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const note = sorted[i];
    if (note.startTimeSeconds - group[0].startTimeSeconds <= ONSET_GROUP_SEC) {
      group.push(note);
    } else {
      melody.push(pickProminent(group));
      group = [note];
    }
  }
  melody.push(pickProminent(group));

  // Clip overlaps so the line is strictly monophonic.
  for (let i = 0; i < melody.length - 1; i++) {
    const end = melody[i].startTimeSeconds + melody[i].durationSeconds;
    const nextStart = melody[i + 1].startTimeSeconds;
    if (end > nextStart) {
      melody[i] = { ...melody[i], durationSeconds: nextStart - melody[i].startTimeSeconds };
    }
  }
  return melody;
}

function pickProminent(group) {
  return group.reduce((best, n) => {
    if (n.amplitude > best.amplitude * 1.05) return n;
    if (best.amplitude > n.amplitude * 1.05) return best;
    return n.pitchMidi > best.pitchMidi ? n : best;
  });
}

// A guitar lead is usually a continuous line, not necessarily the loudest
// note of every chord. This is a note-selection heuristic, not stem separation.
export function extractElectricGuitarMelody(notes, { minPitch = 52, maxPitch = 88 } = {}) {
  const sorted = notes.filter((n) =>
    Number.isFinite(n.pitchMidi) && Number.isFinite(n.startTimeSeconds) &&
    n.durationSeconds > 0 && n.pitchMidi >= minPitch && n.pitchMidi <= maxPitch,
  ).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  if (!sorted.length) return [];

  const groups = [];
  for (const note of sorted) {
    const last = groups.at(-1);
    // Keep fast solo runs separate; only near-simultaneous attacks compete.
    if (last && note.startTimeSeconds - last[0].startTimeSeconds <= 0.035) last.push(note);
    else groups.push([note]);
  }

  const strength = (n) => Math.log(Math.max(0.01, Math.min(1, n.amplitude || 0))) +
    Math.min(n.durationSeconds, 0.3) * 0.4;
  let scores = groups[0].map(strength);
  const back = [];
  for (let i = 1; i < groups.length; i++) {
    const pointers = [];
    const nextScores = groups[i].map((note, j) => {
      let best = -Infinity;
      for (let k = 0; k < groups[i - 1].length; k++) {
        const prev = groups[i - 1][k];
        const gap = note.startTimeSeconds - (prev.startTimeSeconds + prev.durationSeconds);
        const movement = gap > 0.7 ? 0 : Math.min(Math.abs(note.pitchMidi - prev.pitchMidi), 19) * 0.055;
        const score = scores[k] + strength(note) - movement;
        if (score > best) { best = score; pointers[j] = k; }
      }
      return best;
    });
    back.push(pointers);
    scores = nextScores;
  }

  let pick = scores.reduce((best, score, i) => score > scores[best] ? i : best, 0);
  const melody = new Array(groups.length);
  for (let i = groups.length - 1; i >= 0; i--) {
    melody[i] = { ...groups[i][pick] };
    if (i > 0) pick = back[i - 1][pick];
  }
  for (let i = 0; i < melody.length - 1; i++) {
    melody[i].durationSeconds = Math.min(melody[i].durationSeconds,
      melody[i + 1].startTimeSeconds - melody[i].startTimeSeconds);
  }
  return melody;
}
