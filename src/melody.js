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
