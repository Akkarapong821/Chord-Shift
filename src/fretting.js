// Map a monophonic note sequence to guitar string/fret positions.
//
// Standard tuning, frets 0..MAX_FRET. Notes outside the guitar's range are
// shifted by octaves until playable (vocal melodies often sit above or below).
// Position choice is a Viterbi pass minimizing hand movement: fret distance
// and string jumps cost, open strings and low positions are slightly favored.

export const TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4, string 0 = low E
export const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
const MAX_FRET = 15;
const MIN_PITCH = TUNING[0];
const MAX_PITCH = TUNING[5] + MAX_FRET;

function candidatesFor(pitch) {
  const out = [];
  for (let s = 0; s < 6; s++) {
    const fret = pitch - TUNING[s];
    if (fret >= 0 && fret <= MAX_FRET) out.push({ string: s, fret });
  }
  return out;
}

function intoRange(pitch) {
  let p = Math.round(pitch);
  while (p < MIN_PITCH) p += 12;
  while (p > MAX_PITCH) p -= 12;
  return p;
}

function positionCost(pos) {
  if (pos.fret === 0) return 0.2;
  return pos.fret * 0.06;
}

function transitionCost(prev, cur) {
  if (prev.fret === 0 || cur.fret === 0) return Math.abs(prev.string - cur.string) * 0.15;
  return Math.abs(prev.fret - cur.fret) * 1.0 + Math.abs(prev.string - cur.string) * 0.3;
}

export function assignFrets(notes) {
  if (notes.length === 0) return [];

  const candidates = notes.map((n) => candidatesFor(intoRange(n.pitchMidi)));

  // Viterbi: cost[i][j] = min total cost ending at candidate j of note i.
  let costs = candidates[0].map(positionCost);
  const backptr = [];
  for (let i = 1; i < candidates.length; i++) {
    const prevCands = candidates[i - 1];
    const curCands = candidates[i];
    const newCosts = new Array(curCands.length).fill(Infinity);
    const ptrs = new Array(curCands.length).fill(0);
    for (let j = 0; j < curCands.length; j++) {
      for (let k = 0; k < prevCands.length; k++) {
        const c = costs[k] + transitionCost(prevCands[k], curCands[j]) + positionCost(curCands[j]);
        if (c < newCosts[j]) {
          newCosts[j] = c;
          ptrs[j] = k;
        }
      }
    }
    costs = newCosts;
    backptr.push(ptrs);
  }

  // Trace back the cheapest path.
  const picks = new Array(notes.length);
  let best = 0;
  for (let j = 1; j < costs.length; j++) if (costs[j] < costs[best]) best = j;
  picks[notes.length - 1] = best;
  for (let i = notes.length - 2; i >= 0; i--) {
    picks[i] = backptr[i][picks[i + 1]];
  }

  return notes.map((n, i) => ({
    ...n,
    pitchMidi: intoRange(n.pitchMidi),
    ...candidates[i][picks[i]],
  }));
}
