import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createAppleAuthorization } from '../public/apple-auth.js';
import { clueLengths, clueStart, createRecallGame, listeningPool, playlistPool } from '../public/recall-game.js';
import { readRecallCollection } from '../public/recall-library.js';

const track = { id: 'apple:123', provider: 'apple', providerId: '123', catalogId: '123', title: 'Known song', artist: 'Artist', durationMs: 180000, source: 'selected_playlist' };
function gameFixture() { const game = createRecallGame(); game.load([track]); game.next('middle'); return game; }

test('longer clues play only new audio at one fixed excerpt offset', () => {
  const game = gameFixture(), plans = [];
  for (const target of clueLengths) { const plan = game.clue(); plans.push([plan.startAt, plan.seconds, plan.target]); game.listened(target); }
  assert.deepEqual(plans, [[63, 1, 1], [64, 1, 2], [65, 2, 4], [67, 4, 8], [71, 8, 16]]);
  assert.throws(() => game.clue(), /All clues/);
});

test('wrong guesses unlock one step and Replay never skips unheard audio', () => {
  const game = gameFixture(); game.clue(); game.listened(1); game.guess('wrong');
  const replay = game.clue({ replay: true }); assert.equal(replay.seconds, 1); assert.equal(replay.startAt, 63);
  game.listened(replay.target); assert.equal(game.snapshot().round.listened, false);
  const next = game.clue(); assert.equal(next.startAt, 64); assert.equal(next.seconds, 1); assert.equal(next.target, 2);
  game.listened(2); game.guess('Known song'); assert.equal(game.snapshot().score, 4);
});

test('interrupted or failed extensions retry the same segment without advancement', () => {
  const game = gameFixture(); game.clue(); game.listened(1);
  const interrupted = game.clue(), retry = game.clue();
  assert.equal(retry.startAt, interrupted.startAt); assert.equal(retry.seconds, interrupted.seconds);
  assert.equal(game.snapshot().round.completedThrough, 1); assert.equal(game.snapshot().round.listened, false);
});

test('failed startup preserves the earned guess and score tier', () => {
  const game = gameFixture(); game.clue(); game.listened(1);
  const failed = game.clue(); game.cancelClue(failed);
  assert.equal(game.snapshot().round.step, 0); assert.equal(game.snapshot().round.listened, true);
  game.guess('Known song'); assert.equal(game.snapshot().score, 5);
});

test('heard or stale clue attempts cannot roll back progression', () => {
  const game = gameFixture(); game.clue(); game.listened(1);
  const audible = game.clue(); audible.started = true; game.cancelClue(audible);
  assert.equal(game.snapshot().round.step, 1);
  game.reveal(); game.next(); game.cancelClue(audible); assert.equal(game.snapshot().round.step, 0);
});

test('random excerpts stay within the song and stay fixed throughout a round', () => {
  assert.equal(clueStart(track, 'random', () => 0), 36); assert.equal(clueStart(track, 'random', () => 1), 108);
  assert.equal(clueStart({ ...track, durationMs: 18000 }, 'random', () => 1), 1);
  const game = createRecallGame({ random: () => .5 }); game.load([track]); game.next('random');
  const start = game.snapshot().round.startAt; game.clue(); game.listened(1);
  assert.equal(game.clue().startAt, start + 1); assert.equal(game.clue({ replay: true }).startAt, start);
});

const source = (await readFile(new URL('../public/recall.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
async function interfaceFixture() {
  const elements = new Map(), calls = []; let onPlayback, pending;
  const element = (id) => { if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', classList: { toggle() {} }, setAttribute() {}, querySelector: () => element(id + '-span'), focus() {} }); return elements.get(id); };
  const connections = { csrfToken: 'test-csrf', providers: { apple: { configured: true, connected: true } } };
  const music = { musicUserToken: 'test-token', authorize: async () => 'test-token' };
  const context = vm.createContext({ createAppleAuthorization, clueLengths, createRecallGame, listeningPool, playlistPool, readRecallCollection,
    createRecallPlayer: ({ onState }) => { onPlayback = onState; return { stop: async () => onState({ heard: false, playing: false, busy: false }), pause: async () => onState({ heard: false, playing: false, busy: false }), play: async (track, seconds, options) => { calls.push({ track, seconds, ...options }); if (pending) await pending; } }; },
    document: { getElementById: element, querySelector: () => element('back'), addEventListener() {} }, window: { MusicKit: { configure() {}, getInstance: () => music }, addEventListener() {} }, location: { hostname: '127.0.0.1', port: '4182' }, URL, setTimeout, clearTimeout,
    fetch: async (path) => new Response(JSON.stringify(path.startsWith('/api/connections') ? connections : path.includes('/p1/tracks') ? { items: [track], nextOffset: null } : { items: [{ id: 'p1', name: 'Favorites' }], nextOffset: null })),
  });
  vm.runInContext(source + '\nglobalThis.fixture = {playClue,game,state,render};', context); await settle(); element('load-history').onclick(); await settle();
  return { ...context.fixture, element, calls, playback: (value) => onPlayback(value), hold: (value) => { pending = value; } };
}

test('playing a partial clue does not unlock guesses or longer clips', async () => {
  const f = await interfaceFixture(); await f.playClue();
  f.playback({ playing: true, busy: false, heard: true, position: 63.2 });
  assert.equal(f.game.snapshot().round.listened, false);
  f.playback({ playing: false, busy: false, heard: false, position: 63.2 });
  await f.playClue(); assert.equal(f.calls.at(-1).startAt, 63); assert.equal(f.calls.at(-1).seconds, 1);
  f.playback({ complete: true, playing: false, busy: false, heard: true, position: 64 });
  assert.equal(f.game.snapshot().round.listened, true);
});

test('Hear more continues after a completed clue and a double click starts one request', async () => {
  const f = await interfaceFixture(); await f.playClue(); f.playback({ complete: true, playing: false, busy: false, heard: true, position: 64 });
  let release; f.hold(new Promise((resolve) => { release = resolve; }));
  const first = f.playClue(); await f.playClue(); assert.equal(f.calls.length, 2); assert.equal(f.calls.at(-1).startAt, 64); assert.equal(f.calls.at(-1).seconds, 1);
  release(); await first;
});

test('a completion from the previous round cannot credit the next round', async () => {
  const f = await interfaceFixture(); await f.playClue(); f.game.reveal(); f.game.next();
  f.playback({ complete: true, heard: true, playing: false, busy: false, position: 64 });
  assert.equal(f.game.snapshot().round.listened, false); assert.equal(f.game.snapshot().round.completedThrough, 0);
});

test('center Play starts the first clue, then replays without adding new seconds', async () => {
  const f = await interfaceFixture(); assert.equal(f.element('replay').hidden, false); assert.equal(f.element('replay').disabled, false); assert.equal(f.element('listen').disabled, true);
  f.element('replay').onclick(); await settle(); assert.equal(f.calls.at(-1).startAt,63); assert.equal(f.calls.at(-1).seconds,1);
  f.playback({ complete:true,heard:true,playing:false,busy:false,position:64 });
  assert.equal(f.element('listen').disabled,false);
  f.element('replay').onclick(); await settle(); assert.equal(f.calls.at(-1).startAt,63); assert.equal(f.calls.at(-1).seconds,1);
  assert.equal(f.game.snapshot().round.completedThrough,1);
});

test('right Hear more continues the clue while center Play respects a wrong guess', async () => {
  const f = await interfaceFixture(); await f.playClue(); f.playback({complete:true,heard:true,playing:false,busy:false,position:64});
  f.game.guess('wrong'); f.render(); f.element('replay').onclick(); await settle(); assert.equal(f.calls.at(-1).startAt,63); assert.equal(f.calls.at(-1).seconds,1);
  f.playback({complete:true,heard:true,playing:false,busy:false,position:64});
  f.element('listen').onclick(); await settle(); assert.equal(f.calls.at(-1).startAt,64); assert.equal(f.calls.at(-1).seconds,1);
});

test('the last clue disables Hear more and still permits center replay', async () => {
  const f = await interfaceFixture();
  for(const length of clueLengths){await f.playClue();f.playback({complete:true,heard:true,playing:false,busy:false,position:63+length});}
  assert.equal(f.element('listen').disabled,true); assert.equal(f.element('replay').disabled,false);
  f.element('replay').onclick(); await settle(); assert.equal(f.calls.at(-1).startAt,63); assert.equal(f.calls.at(-1).seconds,16);
});
