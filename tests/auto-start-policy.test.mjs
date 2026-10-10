import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { autoStartDecision } from '../public/auto-start-policy.js';

function fixture(provider = 'apple', status = 'ready') {
  const track = provider === 'apple' ? { provider, providerId: '12345' } : { provider, providerId: 'A'.repeat(22) };
  return { memberId: 'host', playerConnected: true, autoStartArmed: true, now: 1000,
    room: { hostId: 'host', hostProvider: provider, members: [{ id: 'host', online: true }], queue: [{ id: 'request', hostMatch: { status: 'matched', provider, track } }],
      nowPlaying: null, playback: { available: true, connected: true, playing: false, starting: false, pendingEntryId: null, status, error: null } } };
}

test('auto-start policy is a portable pure browser module', async () => {
  const source = await readFile(new URL('../public/auto-start-policy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:|\bBuffer\b|process\.|fetch\(|document\.|window\./);
  const input = fixture(), before = JSON.stringify(input);
  autoStartDecision(input); assert.equal(JSON.stringify(input), before);
});

test('an armed connected ready or finished host starts the verified queue head', () => {
  for (const provider of ['apple', 'spotify']) for (const status of ['ready', 'finished']) {
    const input = fixture(provider, status);
    if (status === 'finished') input.room.nowPlaying = { id: 'completed-request' };
    assert.deepEqual(autoStartDecision(input), { shouldStart: true, action: 'next', reason: 'matched_idle_queue' });
  }
});

test('the first idle Apple paused heartbeat starts only while explicitly armed', () => {
  const input = fixture('apple', 'paused');
  assert.equal(autoStartDecision(input).shouldStart, true);
  input.autoStartArmed = false; assert.equal(autoStartDecision(input).reason, 'not_armed');
  delete input.autoStartArmed; assert.equal(autoStartDecision(input).shouldStart, false);
  input.autoStartArmed = true; input.room.nowPlaying = { id: 'paused-current' };
  assert.equal(autoStartDecision(input).reason, 'player_not_idle');
  assert.equal(autoStartDecision(fixture('spotify', 'paused')).shouldStart, false);
});

test('manual pause and a current unfinished request never trigger the next song', () => {
  for (const status of ['ready', 'paused']) {
    const input = fixture('apple', status); input.room.nowPlaying = { id: 'current' };
    assert.equal(autoStartDecision(input).shouldStart, false);
  }
  const input = fixture(); input.autoStartArmed = false;
  assert.equal(autoStartDecision(input).reason, 'not_armed');
});

test('missing own player, disconnected or unavailable playback never starts', () => {
  for (const change of [
    (input) => { input.playerConnected = false; },
    (input) => { delete input.playerConnected; },
    (input) => { input.room.playback.connected = false; },
    (input) => { input.room.playback.available = false; },
  ]) {
    const input = fixture(); change(input); assert.equal(autoStartDecision(input).reason, 'own_player_required');
  }
});

test('starting, pending, busy, handoff and actual playing states block duplicate commands', () => {
  for (const change of [
    (input) => { input.busy = true; },
    (input) => { input.room.playback.starting = true; },
    (input) => { input.room.playback.pendingEntryId = 'request'; },
    (input) => { input.room.applePlayer = { pending: { action: 'pause' } }; },
    (input) => { input.room.spotifyPlayer = { pending: { action: 'play' } }; },
    (input) => { input.room.hostTransfer = { id: 'offer' }; },
    (input) => { input.room.playback.playing = true; },
  ]) {
    const input = fixture(); change(input); assert.equal(autoStartDecision(input).shouldStart, false);
  }
});

test('errors, changes, advertisement, connection setup and unknown statuses do not start', () => {
  for (const status of ['error', 'changed', 'advertisement', 'connecting', 'starting', 'disconnected', 'unknown', undefined]) {
    const input = fixture(); input.room.playback.status = status;
    assert.equal(autoStartDecision(input).shouldStart, false);
  }
  const input = fixture(); input.room.playback.error = 'Music service failed';
  assert.equal(autoStartDecision(input).reason, 'player_error');
});

test('guests, absent rooms, ended rooms and unsupported hosts cannot auto-start', () => {
  const input = fixture(); input.memberId = 'guest'; assert.equal(autoStartDecision(input).reason, 'not_host');
  assert.equal(autoStartDecision().reason, 'no_room');
  const ended = fixture(); ended.room.endedAt = 1000; assert.equal(autoStartDecision(ended).reason, 'no_room');
  const unsupported = fixture(); unsupported.room.hostProvider = 'qq'; assert.equal(autoStartDecision(unsupported).reason, 'unsupported_host');
});

test('offline or stale hosts cannot auto-start and live public presence is respected', () => {
  const input = fixture(); input.hostOnline = false; assert.equal(autoStartDecision(input).reason, 'host_offline');
  delete input.hostOnline; input.room.members[0].online = false; assert.equal(autoStartDecision(input).shouldStart, false);
  delete input.room.members[0].online; input.room.members[0].lastSeenAt = 500;
  assert.equal(autoStartDecision(input).shouldStart, true);
  input.now = 40000; assert.equal(autoStartDecision(input).shouldStart, false);
  input.now = 0; assert.equal(autoStartDecision(input).shouldStart, false);
});

test('an empty queue or unverified head never skips forward to a later matched request', () => {
  const input = fixture(); input.room.queue = []; assert.equal(autoStartDecision(input).reason, 'queue_empty');
  input.room.queue = [{ id: 'unknown', hostMatch: { status: 'choice_required' } }, ...fixture().room.queue];
  assert.equal(autoStartDecision(input).reason, 'recording_required');
  input.room.queue[0] = { id: 'same-service-without-confirmed-match', track: { provider: 'apple', providerId: '12345' } };
  assert.equal(autoStartDecision(input).shouldStart, false);
});

test('invalid recording IDs or a wrong host service require a choice', () => {
  for (const change of [
    (input) => { input.room.queue[0].hostMatch.track.providerId = 'i.private'; },
    (input) => { input.room.queue[0].hostMatch.track.provider = 'spotify'; },
    (input) => { input.room.queue[0].hostMatch.provider = 'spotify'; },
    (input) => { input.room.queue[0].hostMatch.status = 'connection_required'; },
  ]) {
    const input = fixture(); change(input); assert.equal(autoStartDecision(input).reason, 'recording_required');
  }
  const input = fixture(); input.room.queue[0].hostMatch.track = { provider: 'apple', providerId: 'i.private', catalogId: '12345' };
  assert.equal(autoStartDecision(input).shouldStart, true);
});

test('a completed song waiting for its next match can resume when the exact recording arrives', () => {
  const input = fixture('apple', 'waiting_match'); input.room.nowPlaying = { id: 'completed-request' };
  assert.equal(autoStartDecision(input).shouldStart, true); input.autoStartArmed = false; assert.equal(autoStartDecision(input).shouldStart, false);
});
