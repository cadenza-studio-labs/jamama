import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { offerHost, acceptHost, cancelHost, refreshHostTransfer } from '../worker/host-transfer.mjs';

function fixture() {
  const now = 1000, host = { id: 'host', name: 'Host', provider: 'apple', lastSeenAt: now },
    friend = { id: 'friend', name: 'Friend', provider: 'guest', lastSeenAt: now }, other = { id: 'other', lastSeenAt: now };
  const track = { id: 'spotify:original', provider: 'spotify', title: 'Original request' };
  const room = { code: 'ABC234', hostId: host.id, hostProvider: 'apple', hostRevision: 0, version: 1, updatedAt: now, members: [host, friend, other],
    queue: [{ id: 'queued', track, addedBy: host.id, hostMatch: { provider: 'apple', status: 'matched', track: { id: 'apple:123', provider: 'apple', providerId: '123' } } }],
    nowPlaying: { id: 'current', track, addedBy: friend.id, hostTrack: { id: 'apple:456', provider: 'apple', providerId: '456' } },
    taste: { public: { songs: [{ id: 'shared' }] } }, played: 4, inviteToken: 'unchanged-invite', baseUrl: 'https://jamama.example', locked: false,
    playback: { connected: true, playing: false, starting: false, pendingEntryId: null, status: 'paused', position: 30000 },
    applePlayer: { sessionId: 'private-session', generation: 'private-generation', pending: null },
    hostPlaybackSessionId: 'private-session', output: { kind: 'airplay' } };
  return { room, host, friend, other, options: { now, accountReady: true } };
}
const offer = (f) => { offerHost(f.room, f.host, { memberId: f.friend.id }, f.options); if (!f.room.playback.playing && ['paused', 'finished', 'waiting_match'].includes(f.room.playback.status)) f.room.hostTransfer.pauseConfirmed = true; return refreshHostTransfer(f.room, f.options); };
const accept = (f, provider = 'spotify', options = f.options) => acceptHost(f.room, f.friend, { transferId: f.room.hostTransfer.id, provider }, options);

test('handoff module is portable and public offers disclose no private connection details', async () => {
  assert.doesNotMatch(await readFile(new URL('../worker/host-transfer.mjs', import.meta.url), 'utf8'), /node:|Buffer|process\.|fetch\(/);
  const f = fixture(), snapshot = offer(f);
  assert.deepEqual(Object.keys(snapshot).sort(), ['expiresAt', 'fromId', 'id', 'phase', 'toId']);
  assert.equal(snapshot.phase, 'ready'); assert.equal(snapshot.expiresAt, 121000);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-session|private-generation/);
});

test('JSON-restored acceptance preserves requests, taste, members and invitation', () => {
  const f = fixture(); offer(f); f.room = JSON.parse(JSON.stringify(f.room));
  const originalTaste = structuredClone(f.room.taste), originalMembers = f.room.members.map((member) => member.id);
  accept(f);
  assert.equal(f.room.hostId, f.friend.id); assert.equal(f.room.hostProvider, 'spotify'); assert.equal(f.room.hostRevision, 1);
  assert.deepEqual(f.room.queue.map((entry) => entry.id), ['current', 'queued']);
  assert.equal(f.room.queue[0].track.provider, 'spotify'); assert.equal(f.room.queue[1].addedBy, f.host.id);
  assert.deepEqual(f.room.taste, originalTaste); assert.deepEqual(f.room.members.map((member) => member.id), originalMembers);
  assert.equal(f.room.inviteToken, 'unchanged-invite'); assert.equal(f.room.played, 4); assert.equal(f.room.baseUrl, 'https://jamama.example');
  assert.equal(f.room.nowPlaying, null); assert.ok(f.room.queue.every((entry) => !entry.hostMatch && !entry.hostTrack));
  assert.equal(f.room.applePlayer, undefined); assert.equal(f.room.hostPlaybackSessionId, undefined); assert.equal(f.room.hostTransfer, undefined);
  assert.equal(f.room.playback.connected, false); assert.equal(f.room.playback.playing, false); assert.equal(f.room.playback.status, 'disconnected');
});

test('same-service handoff retains selected recordings and reconstructs the current exact match', () => {
  const f = fixture(), match = f.room.queue[0].hostMatch; offer(f); accept(f, 'apple');
  assert.equal(f.room.queue[1].hostMatch, match);
  assert.equal(f.room.queue[0].hostMatch.status, 'matched'); assert.equal(f.room.queue[0].hostMatch.track.providerId, '456');
  assert.equal(f.room.queue[0].hostTrack, undefined);
});

test('only the host can offer to another online member', () => {
  const f = fixture();
  assert.throws(() => offerHost(f.room, f.friend, { memberId: f.host.id }, f.options), { code: 'host_required' });
  assert.throws(() => offerHost(f.room, f.host, { memberId: f.host.id }, f.options), { code: 'handoff_member_required' });
  assert.throws(() => offerHost(f.room, f.host, { memberId: 'missing' }, f.options), { code: 'handoff_member_required' });
  f.friend.lastSeenAt = -40000; assert.throws(() => offer(f), { code: 'handoff_offline' });
  f.friend.lastSeenAt = 5000; assert.throws(() => offer(f), { code: 'handoff_offline' });
});

test('only the invited member with a connected Apple or Spotify account can accept', () => {
  const f = fixture(); offer(f); const transferId = f.room.hostTransfer.id;
  assert.throws(() => acceptHost(f.room, f.other, { transferId, provider: 'spotify' }, f.options), { code: 'handoff_recipient_required' });
  assert.throws(() => accept(f, 'guest'), { code: 'host_service_required' });
  assert.throws(() => accept(f, 'qq'), { code: 'host_service_required' });
  assert.throws(() => accept(f, 'apple', { now: 1000, accountReady: false }), { code: 'connect_required' });
  f.friend.lastSeenAt = -40000; assert.throws(() => accept(f), { code: 'handoff_offline' });
  assert.equal(f.room.hostId, f.host.id); assert.equal(f.room.queue.length, 1);
});

test('offers can wait for pause but acceptance requires the real paused state', () => {
  const f = fixture(); f.room.playback.playing = true;
  assert.equal(offer(f).phase, 'pausing');
  assert.throws(() => accept(f), { code: 'handoff_pause_required' });
  f.room.playback.playing = false; f.room.hostTransfer.pauseConfirmed = true; accept(f); assert.equal(f.room.hostId, f.friend.id);
});

test('starting songs and pending pause commands block transfers without changing the queue', () => {
  for (const setBusy of [
    (room) => { room.playback.starting = true; },
    (room) => { room.playback.pendingEntryId = 'queued'; },
    (room) => { room.applePlayer.pending = { action: 'pause' }; },
    (room) => { room.spotifyPlayer = { pending: { action: 'play' } }; },
  ]) {
    const f = fixture(); setBusy(f.room); assert.throws(() => offer(f), { code: 'player_busy' });
    const g = fixture(); offer(g); setBusy(g.room); assert.throws(() => accept(g), { code: 'handoff_pause_required' });
    assert.equal(g.room.queue.length, 1); assert.equal(g.room.hostId, g.host.id);
  }
});

test('host and recipient can cancel but a third participant cannot', () => {
  for (const role of ['host', 'friend']) {
    const f = fixture(), offered = offer(f);
    assert.throws(() => cancelHost(f.room, f.other, { transferId: offered.id }, f.options), { code: 'handoff_participant_required' });
    cancelHost(f.room, f[role], { transferId: offered.id }, f.options);
    assert.equal(f.room.hostTransfer, undefined); assert.equal(f.room.hostId, f.host.id); assert.equal(f.room.queue.length, 1);
    assert.throws(() => acceptHost(f.room, f.friend, { transferId: offered.id, provider: 'apple' }, f.options), { code: 'handoff_expired' });
  }
});

test('expired, cancelled and obsolete offers cannot transfer ownership', () => {
  const f = fixture(), offered = offer(f);
  assert.equal(refreshHostTransfer(f.room, { now: offered.expiresAt }), null); assert.equal(f.room.hostTransfer, undefined);
  assert.throws(() => acceptHost(f.room, f.friend, { transferId: offered.id, provider: 'apple' }, { now: offered.expiresAt, accountReady: true }), { code: 'handoff_expired' });
  const g = fixture(); offer(g); g.room.hostId = g.other.id;
  assert.equal(refreshHostTransfer(g.room, g.options), null); assert.equal(g.room.hostId, g.other.id);
  const h = fixture(); offer(h); h.room.hostRevision++;
  assert.throws(() => accept(h), { code: 'handoff_expired' });
  const i = fixture(); offer(i); i.room.hostProvider = 'spotify';
  assert.equal(refreshHostTransfer(i.room, i.options), null);
});

test('an unfinished recording is requeued once and an already finished one is not replayed', () => {
  const f = fixture(); f.room.queue.push(structuredClone(f.room.nowPlaying)); offer(f); accept(f);
  assert.deepEqual(f.room.queue.map((entry) => entry.id), ['current', 'queued']);
  const g = fixture(); g.room.playback.status = 'finished'; offer(g); accept(g);
  assert.deepEqual(g.room.queue.map((entry) => entry.id), ['queued']);
});

test('a full queue cannot lose the unfinished request during a handoff', () => {
  const f = fixture(); f.room.queue = Array.from({ length: 100 }, (_, index) => ({ id: String(index), track: { provider: 'spotify' } })); offer(f);
  const before = JSON.stringify(f.room.queue);
  assert.throws(() => accept(f), { code: 'handoff_queue_full' });
  assert.equal(JSON.stringify(f.room.queue), before); assert.equal(f.room.hostId, f.host.id); assert.ok(f.room.applePlayer); assert.ok(f.room.hostTransfer);
  f.room.queue[50] = structuredClone(f.room.nowPlaying); accept(f);
  assert.equal(f.room.queue.length, 100); assert.equal(f.room.queue[0].id, 'current');
});

test('replacing an offer requires cancellation and accepting invalidates all playback bindings', () => {
  const f = fixture(); f.room.spotifyPlayer = { pending: null, sessionId: 'old' }; f.friend.listener = { connected: true };
  offer(f); assert.throws(() => offer(f), { code: 'handoff_pending' }); accept(f);
  assert.equal(f.room.spotifyPlayer, undefined); assert.equal(f.friend.listener, undefined);
  assert.equal(f.room.playback.pendingEntryId, null); assert.equal(f.room.playback.autoAdvance, false);
});

test('failure or timeout cannot count as a confirmed host pause', () => {
  const f = fixture(); f.room.playback.playing = true; offer(f);
  f.room.playback.playing = false; f.room.playback.status = 'error'; f.room.applePlayer.pending = null;
  assert.equal(refreshHostTransfer(f.room, f.options).phase, 'pausing');
  assert.throws(() => accept(f), { code: 'handoff_pause_required' });
  f.room.playback.connected = false; f.room.playback.status = 'disconnected';
  assert.throws(() => accept(f), { code: 'handoff_pause_required' });
});

test('completion is preserved when the handoff pause changes finished status to paused', () => {
  for (const status of ['finished', 'waiting_match']) {
    const f = fixture(); f.room.playback.status = status; offer(f);
    f.room.playback.status = 'paused'; f.room.hostTransfer.pauseConfirmed = true;
    accept(f); assert.equal(f.room.queue.length, 1); assert.equal(f.room.queue[0].id, 'queued');
  }
});
