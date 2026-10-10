export const clueLengths = [1, 2, 4, 8, 16];

export function clueStart(track, mode, random = Math.random) {
  if (!['intro', 'middle', 'random'].includes(mode)) throw new Error('Choose a supported clue mode.');
  if (mode === 'intro') return 0;
  const fraction = mode === 'random' ? .2 + Math.min(1, Math.max(0, random())) * .4 : .35;
  return Math.max(0, Math.floor(Math.min(track.durationMs / 1000 * fraction, track.durationMs / 1000 - 17) + .000001));
}

export function answerKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function eligiblePool(tracks, source) {
  const songs = new Map();
  let unavailable = 0;
  for (const track of tracks) {
    const id = track.catalogId || (/^\d+$/.test(track.providerId || '') ? track.providerId : null);
    if (track.provider !== 'apple' || track.source !== source || !id || !/^\d+$/.test(id) || !track.title || !track.artist || !Number.isFinite(track.durationMs) || track.durationMs < 17000) { unavailable++; continue; }
    const key = track.isrc || id;
    if (!songs.has(key)) songs.set(key, { ...track, catalogId: id });
  }
  return { songs: [...songs.values()], unavailable, duplicates: tracks.length - songs.size - unavailable };
}

export const listeningPool = (tracks) => eligiblePool(tracks, 'recently_played');
export const playlistPool = (tracks) => eligiblePool(tracks, 'selected_playlist');

export function createRecallGame({ random = Math.random } = {}) {
  let pool = [], remaining = [], round = null, total = 0, wins = 0, score = 0, streak = 0, guessCount = 0;
  function snapshot() {
    return { round, total, wins, score, streak, poolSize: pool.length, guessed: guessCount };
  }
  return {
    snapshot,
    load(songs) { pool = [...songs]; remaining = []; round = null; total = 0; wins = 0; score = 0; streak = 0; guessCount = 0; return snapshot(); },
    next(mode = 'middle') {
      if (!pool.length) throw new Error('Listen to some songs in Apple Music, then refresh your recent listening.');
      if (round && !round.finished) throw new Error('Finish or reveal this song before starting another.');
      if (!remaining.length) {
        remaining = [...pool];
        for (let i = remaining.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [remaining[i], remaining[j]] = [remaining[j], remaining[i]]; }
        if (remaining.length > 1 && remaining[remaining.length - 1].catalogId === round?.track.catalogId) [remaining[0], remaining[remaining.length - 1]] = [remaining[remaining.length - 1], remaining[0]];
      }
      const track = remaining.pop();
      round = { number: ++total, track, startAt: clueStart(track, mode, random), mode, step: 0, completedThrough: 0, listened: false, finished: false, correct: false, guesses: [], points: 0 };
      return snapshot();
    },
    listened(seconds = round ? clueLengths[round.step] : 0) {
      if (round && !round.finished && Number.isFinite(seconds)) {
        round.completedThrough = Math.max(round.completedThrough, Math.max(0, Math.min(clueLengths[round.step], seconds)));
        round.listened = round.completedThrough >= clueLengths[round.step];
      }
      return snapshot();
    },
    clue({ replay = false } = {}) {
      if (!round || round.finished) throw new Error('Start a new song first.');
      const previousStep = round.step, previousListened = round.listened;
      if (replay) {
        if (!round.completedThrough) throw new Error('Hear a clue before replaying it.');
        return { round, track: round.track, startAt: round.startAt, seconds: round.completedThrough, target: round.completedThrough };
      }
      if (round.listened) {
        if (round.step === clueLengths.length - 1) throw new Error('All clues are unlocked. Guess or reveal the song.');
        round.step++; round.listened = false;
      }
      const target = clueLengths[round.step];
      return { round, track: round.track, startAt: round.startAt + round.completedThrough, seconds: target - round.completedThrough, target, previousStep, previousListened };
    },
    cancelClue(plan) {
      if (plan?.round === round && !round.finished && !plan.started && plan.previousStep != null && round.completedThrough < plan.target) {
        round.step = plan.previousStep; round.listened = plan.previousListened;
      }
      return snapshot();
    },
    guess(value) {
      if (!round || round.finished) throw new Error('Start a new song first.');
      if (!round.listened) throw new Error('Listen to the clue before guessing.');
      const input = answerKey(value);
      if (!input || input.length > 200) throw new Error('Enter a song title.');
      if (round.guesses.some((guess) => answerKey(guess.title) === input)) throw new Error('You already tried that title.');
      const correct = input === answerKey(round.track.title);
      round.guesses.push({ title: value.trim(), correct }); guessCount++;
      if (correct) {
        round.finished = true; round.correct = true; round.points = 5 - round.step;
        wins++; streak++; score += round.points;
      } else if (round.step === clueLengths.length - 1) { round.finished = true; streak = 0; }
      else { round.step++; round.listened = false; }
      return snapshot();
    },
    more() {
      if (!round || round.finished) throw new Error('Start a new song first.');
      if (!round.listened) throw new Error('Listen to the clue before asking for more.');
      if (round.step < clueLengths.length - 1) { round.step++; round.listened = false; }
      else { round.finished = true; streak = 0; }
      return snapshot();
    },
    reveal() { if (round && !round.finished) { round.finished = true; streak = 0; } return snapshot(); },
  };
}
