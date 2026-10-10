import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecallPlayer } from '../public/recall-player.js';
import { createRecallGame } from '../public/recall-game.js';

const song = (id) => ({ provider: 'apple', catalogId: String(id), title: `Song ${id}`, artist: 'Artist', durationMs: 180000 });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(onState = () => {}, options = {}) {
  let time = 0, sequence = 0;
  const callbacks = new Map(), states = [], errors = [], calls = [], queues = [];
  const music = {
    isAuthorized: true, musicUserToken: 'test-account', autoplayEnabled: true, playbackState: 0, currentPlaybackTime: 0,
    hasMusicSubscription: async () => true,
    pause: async () => { calls.push('pause'); music.playbackState = 0; },
    setQueue: async (descriptor, options) => { const { song: id } = descriptor; queues.push({ descriptor, options }); calls.push(`queue:${id}`); music.nowPlayingItem = { id, playbackType: 1 }; },
    seekToTime: async (position) => { calls.push(`seek:${position}`); music.currentPlaybackTime = position; },
    play: async () => { calls.push('play'); music.playbackState = 1; },
  };
  const SDK = { getInstance: () => music, PlaybackStates: { playing: 1, ended: 3, completed: 4 }, PlaybackType: { encryptedFull: 1, unencryptedFull: 2 } };
  const player = createRecallPlayer({ getSDK: () => SDK, now: () => time,
    onState: (state) => { states.push(state); onState(state); }, onError: (error) => errors.push(error.message),
    setIntervalFn: (callback) => { callbacks.set(++sequence, callback); return sequence; }, clearIntervalFn: (id) => callbacks.delete(id),
    ...options,
  });
  return { player, music, states, errors, calls, queues, tick: async (position, milliseconds = 0) => {
    time += milliseconds; music.currentPlaybackTime = position;
    for (const callback of [...callbacks.values()]) callback();
    await flush();
  } };
}

test('wrong guesses and More do not inherit the previous clue’s listening credit', async () => {
  const game = createRecallGame(); game.load([song(123)]); game.next('intro');
  const f = fixture((state) => { if (state.heard) game.listened(); });
  await f.player.play(song(123), 1); await f.tick(1.01);
  assert.ok(f.states.some((state) => state.complete && state.heard));
  game.guess('Wrong'); await f.player.pause();
  assert.equal(game.snapshot().round.listened, false);
  await f.player.play(song(123), 2); await f.tick(2.01);
  game.more(); await f.player.pause();
  assert.equal(game.snapshot().round.listened, false);
  await f.player.play(song(123), 4); await f.tick(.5);
  await f.player.stop();
  assert.equal(f.states.at(-1).heard, false);
});

test('Pause cancels pending subscription preparation without waiting for Apple', async () => {
  const f = fixture(), subscription = deferred();
  f.music.hasMusicSubscription = () => subscription.promise;
  const play = f.player.play(song(123), 1); await flush();
  await f.player.pause(); await play;
  assert.equal(f.states.at(-1).busy, false);
  subscription.resolve(true); await flush();
  assert.deepEqual(f.calls, ['pause']); assert.deepEqual(f.errors, []);
});

test('a cancelled queue request drains before a replacement clue is queued', async () => {
  const f = fixture(), queued = deferred(), setQueue = f.music.setQueue;
  f.music.setQueue = ({ song: id }) => {
    f.calls.push(`pending-queue:${id}`);
    return queued.promise.then(() => { f.music.nowPlayingItem = { id, playbackType: 1 }; });
  };
  const old = f.player.play(song(123), 1); await flush();
  await f.player.stop(); await old;
  f.music.setQueue = setQueue;
  const replacement = f.player.play(song(456), 2, { startAt: 60 }); await flush();
  assert.equal(f.calls.some((call) => call === 'queue:456'), false);
  queued.resolve(); await replacement;
  assert.equal(f.music.nowPlayingItem.id, '456'); assert.equal(f.music.currentPlaybackTime, 60);
  assert.equal(f.calls.filter((call) => call === 'play').length, 1);
  await f.player.stop();
});

test('a cancelled seek rejection cannot report errors or change the replacement attempt', async () => {
  const f = fixture(), seek = deferred(), seekToTime = f.music.seekToTime;
  f.music.seekToTime = () => seek.promise;
  const old = f.player.play(song(123), 1); await flush();
  await f.player.pause(); await old;
  f.music.seekToTime = seekToTime;
  const replacement = f.player.play(song(456), 2, { startAt: 60 }); await flush();
  assert.equal(f.states.at(-1).busy, true);
  seek.reject(new Error('Old seek failed')); await replacement;
  assert.equal(f.states.at(-1).busy, false); assert.equal(f.player.playing, true);
  assert.deepEqual(f.errors, []); await f.player.stop();
});

test('a delayed cancelled play is paused before replacement playback begins', async () => {
  const f = fixture(), started = deferred(), playMusic = f.music.play;
  f.music.play = () => started.promise.then(() => { f.calls.push('late-play'); f.music.playbackState = 1; });
  const old = f.player.play(song(123), 1); await flush();
  await f.player.pause(); await old;
  assert.equal(f.states.at(-1).busy, false);
  f.music.play = playMusic;
  const replacement = f.player.play(song(456), 2); await flush();
  assert.equal(f.calls.includes('queue:456'), false);
  started.resolve(); await replacement;
  const late = f.calls.indexOf('late-play'), next = f.calls.indexOf('queue:456');
  assert.ok(f.calls.slice(late + 1, next).includes('pause'));
  assert.equal(f.player.playing, true); assert.equal(f.music.nowPlayingItem.id, '456');
  assert.deepEqual(f.errors, []); await f.player.stop();
});

test('late audio is paused even while a cancelled play promise remains pending', async () => {
  const f = fixture(), started = deferred();
  f.music.play = () => started.promise;
  const old = f.player.play(song(123), 1); await flush();
  await f.player.stop(); await old;
  f.music.playbackState = 1; await f.tick(.2);
  assert.equal(f.player.playing, false); assert.equal(f.states.at(-1).heard, false);
  started.resolve(); await flush(); assert.deepEqual(f.errors, []);
});

for (const stage of ['subscription', 'pause', 'queue', 'seek', 'play']) {
  test(`startup timeout cancels a pending ${stage} request and releases controls`, async () => {
    const f = fixture(), pending = deferred();
    const method = { subscription: 'hasMusicSubscription', pause: 'pause', queue: 'setQueue', seek: 'seekToTime', play: 'play' }[stage];
    const original = f.music[method]; let requested = false;
    f.music[method] = (...args) => {
      if (requested) return original(...args);
      requested = true; return pending.promise;
    };
    const play = f.player.play(song(123), 1); await flush();
    await f.tick(0, 20001); await play;
    assert.equal(f.states.at(-1).busy, false);
    assert.deepEqual(f.errors, ['Apple Music took too long to start. Retry the clue.']);
    pending.resolve(stage === 'subscription' ? true : undefined); await flush();
    assert.equal(f.player.playing, false); assert.equal(f.states.at(-1).heard, false);
  });
}

test('sixteen seconds of loading does not shorten a one-second middle clue', async () => {
  const f = fixture();
  await f.player.play(song(123), 1, { startAt: 60 });
  f.music.playbackState = 2; await f.tick(60, 16000);
  assert.equal(f.states.at(-1).heard, false);
  f.music.playbackState = 1; await f.tick(60.1, 100);
  await f.tick(60.9, 800);
  assert.equal(f.player.playing, true); assert.deepEqual(f.errors, []);
  await f.tick(61.01, 110); assert.equal(f.player.playing, false);
  assert.ok(f.states.some((state) => state.complete && state.heard));
});

test('only unchanged media progress triggers the stall timeout', async () => {
  const f = fixture(); await f.player.play(song(123), 16);
  await f.tick(.5, 100);
  await f.tick(.5, 15001);
  assert.equal(f.player.playing, false); assert.equal(f.states.at(-1).busy, false);
  assert.deepEqual(f.errors, ['Playback timing stopped updating. The recording was paused.']);
  const progressing = fixture(); await progressing.player.play(song(456));
  await progressing.tick(10, 10000); await progressing.tick(30, 20000); await progressing.tick(50, 20000);
  assert.equal(progressing.player.playing, true); assert.deepEqual(progressing.errors, []);
  await progressing.player.stop();
});

test('previews still cannot earn listening credit', async () => {
  const f = fixture(); await f.player.play(song(123), 1);
  f.music.nowPlayingItem.playbackType = 3; await f.tick(.2);
  assert.equal(f.player.playing, false);
  assert.equal(f.states.some((state) => state.heard), false);
  assert.match(f.errors[0], /Full Apple Music playback/);
});

test('a full song ending naturally does not produce a stalled-playback error', async () => {
  const f = fixture(); await f.player.play(song(123)); await f.tick(179, 179000);
  f.music.playbackState = 3; await f.tick(180, 1000); await f.tick(180, 20000);
  assert.equal(f.player.playing, false); assert.deepEqual(f.errors, []);
});

test('unavailable media timing does not earn listening credit or prevent later progress', async () => {
  const f = fixture(); await f.player.play(song(123), 1, { startAt: 60 });
  await f.tick(NaN, 1000);
  assert.equal(f.states.some((state) => state.heard), false);
  await f.tick(60.5, 1000); await f.tick(61.01, 500);
  assert.ok(f.states.some((state) => state.complete && state.heard));
  assert.deepEqual(f.errors, []);
});

test('subscription eligibility is checked again when the SDK account token changes', async () => {
  const f = fixture(); await f.player.prepare();
  f.music.musicUserToken = 'different-test-account'; f.music.hasMusicSubscription = async () => false;
  await assert.rejects(f.player.play(song(123), 1));
  assert.equal(f.calls.includes('play'), false); assert.equal(f.states.at(-1).busy, false);
});

test('a new middle clue supplies its fixed start time while setting the queue', async () => {
  const f = fixture(); await f.player.play(song(123), 2, { startAt: 60 });
  assert.deepEqual(f.queues, [{ descriptor: { song: '123', startTime: 60 }, options: undefined }]);
  await f.player.stop();
});

test('full-song playback replaces a previous middle clue’s queue start time', async () => {
  const f = fixture(); await f.player.play(song(123), 1, { startAt: 60 }); await f.tick(61.01);
  await f.player.play(song(123));
  assert.deepEqual(f.queues.map(({ descriptor }) => descriptor.startTime), [60, 0]);
  assert.equal(f.music.currentPlaybackTime, 0); await f.player.stop();
});

test('a silently ignored seek stops intro playback without crediting a middle clue', async () => {
  const f = fixture(); f.music.seekToTime = async () => {};
  await f.player.play(song(123), 1, { startAt: 60 });
  await f.tick(0); assert.equal(f.states.some((state) => state.heard), false);
  await f.tick(.2);
  assert.equal(f.player.playing, false); assert.equal(f.states.some((state) => state.heard), false);
  assert.match(f.errors[0], /starting point/);
});

test('a playing state without advancing media time does not unlock guessing', async () => {
  const f = fixture(); await f.player.play(song(123), 1); await f.tick(0, 1000);
  assert.equal(f.states.some((state) => state.heard), false);
  await f.tick(.1, 100); assert.equal(f.states.at(-1).heard, true);
  await f.player.stop();
});

test('rejected clue pause falls back to stopping the recording', async () => {
  const f = fixture(); await f.player.play(song(123), 1);
  f.music.pause = async () => { throw new Error('Pause unavailable'); };
  f.music.stop = async () => { f.calls.push('stop'); f.music.playbackState = 0; };
  await f.tick(1.01);
  assert.equal(f.player.playing, false); assert.ok(f.calls.includes('stop'));
  assert.ok(f.states.some((state) => state.complete && state.heard)); assert.deepEqual(f.errors, []);
});

test('unavailable stop fallback reports a pause failure without awarding completion', async () => {
  const f = fixture(); await f.player.play(song(123), 1);
  f.music.pause = async () => { throw new Error('Pause unavailable'); };
  f.music.stop = async () => { throw new Error('Stop unavailable'); };
  await f.tick(1.01);
  assert.equal(f.states.some((state) => state.complete), false); assert.equal(f.errors.length, 1);
  f.music.pause = async () => { f.music.playbackState = 0; }; await f.player.stop();
});

test('clue playback rejects missing or invalid duration metadata before asking Apple', async () => {
  for (const durationMs of [undefined, NaN, Infinity, '180000']) {
    const f = fixture(); await assert.rejects(f.player.play({ ...song(123), durationMs }, 1), /within this recording/);
    assert.deepEqual(f.calls, []);
  }
});

test('completed clues publish paused state when Apple’s playback state lags its pause', async () => {
  const f = fixture(); await f.player.play(song(123), 1, { startAt: 60 });
  f.music.pause = async () => {};
  await f.tick(60.2); await f.tick(61.01);
  assert.equal(f.music.playbackState, 1);
  assert.equal(f.player.playing, false);
  assert.equal(f.states.at(-1).playing, false);
  assert.equal(f.states.at(-1).busy, false);
  assert.equal(f.states.at(-1).heard, true);
  assert.equal(f.states.at(-1).complete, true);
});

test('cancelling an unheard clue releases controls without credit despite stale Apple state', async () => {
  const f = fixture(); await f.player.play(song(123), 1);
  f.music.pause = async () => {};
  await f.player.pause();
  assert.equal(f.music.playbackState, 1);
  assert.equal(f.player.playing, false);
  assert.equal(f.states.at(-1).playing, false);
  assert.equal(f.states.at(-1).busy, false);
  assert.equal(f.states.some((state) => state.heard || state.complete), false);
});

for (const [startAt, seconds] of [[0, 1], [87, 1], [87, 2]]) {
  test(`${seconds}-second clue at ${startAt} uses real media progress despite rounded SDK timing`, async () => {
    let mediaTime = startAt;
    const f = fixture(undefined, { getPlaybackPosition: () => mediaTime });
    await f.player.play(song(123), seconds, { startAt });
    mediaTime = startAt + seconds - .49;
    await f.tick(Math.round(mediaTime), (seconds - .49) * 1000);
    assert.equal(f.music.currentPlaybackTime, startAt + seconds);
    assert.equal(f.player.playing, true);
    assert.equal(f.states.at(-1).position, mediaTime);
    assert.equal(f.states.some((state) => state.complete), false);
    mediaTime = startAt + seconds + .01;
    await f.tick(Math.round(mediaTime), 500);
    assert.equal(f.player.playing, false);
    assert.ok(f.states.some((state) => state.complete && state.heard && state.position === mediaTime));
    assert.deepEqual(f.errors, []);
  });
}

test('missing real media position cannot fall back to rounded SDK time for a clue', async () => {
  let mediaTime = NaN;
  const f = fixture(undefined, { getPlaybackPosition: () => mediaTime });
  await f.player.play(song(123), 1);
  await f.tick(1, 500);
  assert.equal(f.states.some((state) => state.heard || state.complete), false);
  assert.equal(f.player.playing, true);
  mediaTime = .6; await f.tick(1, 100);
  assert.equal(f.states.at(-1).position, .6); assert.equal(f.player.playing, true);
  await f.player.stop();
});

test('stall detection follows actual media time even if SDK timing advances', async () => {
  const f = fixture(undefined, { getPlaybackPosition: () => .2 });
  await f.player.play(song(123), 16); await f.tick(1, 100);
  await f.tick(2, 15001);
  assert.equal(f.player.playing, false);
  assert.deepEqual(f.errors, ['Playback timing stopped updating. The recording was paused.']);
});
