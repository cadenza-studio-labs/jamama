import { initialApplePlayback, touchRoom } from './room-model.mjs';

const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const clock = (options = {}) => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
const songId = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const copy = (value) => JSON.parse(JSON.stringify(value));
const playbackErrors = {
  unsupported_browser: 'This browser cannot play protected Apple Music audio. Open Jamama in Safari or Chrome.',
  subscription_required: 'The host needs an active Apple Music subscription for playback.',
  preview_only: 'Apple returned a preview instead of full playback. The request stays queued.',
  playback_failed: 'Apple Music could not start this recording. The request stays queued.',
};

function open(room) {
  if (!room || room.endedAt != null) throw error(404, 'room_closed', 'That Jam is no longer open.');
}

function accountIdentity(account) {
  if (!account || typeof account.sessionId !== 'string' || !account.sessionId || account.sessionId.length > 256
    || !((typeof account.connectionGeneration === 'string' && account.connectionGeneration.length > 0 && account.connectionGeneration.length <= 256)
      || (Number.isSafeInteger(account.connectionGeneration) && account.connectionGeneration >= 0))) throw error(401, 'reconnect_required', 'Connect the host’s Apple Music account first.');
  return { sessionId: account.sessionId, connectionGeneration: account.connectionGeneration };
}

function update(room, changes, options) {
  room.playback = { ...room.playback, ...changes }; touchRoom(room, options);
}

function recording(entry) {
  const source = entry?.hostMatch?.status === 'matched' && entry.hostMatch.track?.provider === 'apple' ? entry.hostMatch.track : null;
  if (!source) return null;
  const id = songId(source.providerId) ? source.providerId : songId(source.catalogId) ? source.catalogId : null;
  return id ? { ...copy(source), id: `apple:${id}`, providerId: id } : null;
}

function fail(room, player, message, options) {
  player.pending = null; player.autoAdvance = false; room.playback.autoStartArmed = false;
  update(room, { starting: false, pendingEntryId: null, autoAdvance: false, status: 'error', error: message }, options);
}

function disconnect(room, options) {
  if (!room.applePlayer) return false;
  room.applePlayer = null;
  update(room, { connected: false, available: false, playing: false, autoAdvance: false, autoStartArmed: false, starting: false, pendingEntryId: null, status: 'disconnected', error: null }, options);
  return true;
}

export function refreshApple(room, options = {}) {
  open(room);
  const player = room.applePlayer, now = clock(options);
  if (!player) return false;
  if (player.hostId !== room.hostId || now - player.lastSeen > 30000) return disconnect(room, options);
  if (player.pending?.expiresAt <= now) { fail(room, player, 'Apple Music did not confirm this command. Your request is still queued.', options); return true; }
  return false;
}

function owner(room, account, generation, options) {
  open(room);
  const identity = accountIdentity(account);
  refreshApple(room, options);
  const player = room.applePlayer;
  if (!player) throw error(409, 'player_disconnected', 'Reconnect Apple Music playback in the host browser.');
  if (player.sessionId !== identity.sessionId || player.connectionGeneration !== identity.connectionGeneration || player.hostId !== room.hostId
    || (generation !== undefined && generation !== player.generation)) throw error(403, 'player_session_mismatch', 'Use the Apple Music browser that connected this player.');
  return player;
}

function command(room, player, action, entry, options) {
  const track = entry ? recording(entry) : room.nowPlaying?.hostTrack || null;
  if (action === 'play' && !songId(track?.providerId)) throw error(409, 'recording_required', 'Choose the Apple Music version of the next request before playing it.');
  const result = { id: crypto.randomUUID(), generation: player.generation, action, track: track ? copy(track) : null };
  player.commandId = result.id;
  player.pending = { ...copy(result), entryId: entry?.id || null, expiresAt: clock(options) + 30000 };
  update(room, { starting: true, pendingEntryId: entry?.id || null, error: null }, options);
  return result;
}

export function connectApple(room, account, options = {}) {
  open(room);
  if (room.hostProvider !== 'apple') throw error(409, 'apple_host_required', 'Choose Apple Music as this Jam’s host service.');
  const identity = accountIdentity(account);
  refreshApple(room, options);
  const previous = room.applePlayer;
  if (previous && (previous.sessionId !== identity.sessionId || previous.connectionGeneration !== identity.connectionGeneration)) throw error(403, 'player_session_mismatch', 'Disconnect the previous host player before connecting another browser.');
  if (previous?.pending) throw error(409, 'player_busy', 'Wait for the current Apple Music command before reconnecting.');
  const generation = crypto.randomUUID();
  room.applePlayer = { ...identity, hostId: room.hostId, generation, commandId: null, pending: null,
    expectedId: null, autoAdvance: false, lastSeen: clock(options), lastState: null };
  room.playback = { ...initialApplePlayback(options), available: true, connected: true, mode: 'apple-web', deviceName: 'Apple Music in this browser', status: 'ready', autoStartArmed: true };
  touchRoom(room, options);
  return { player: { generation } };
}

export function beginApple(room, account, input, options = {}) {
  const player = owner(room, account, input?.generation, options);
  if (input?.generation !== player.generation) throw error(403, 'player_session_mismatch', 'Reconnect Apple Music playback.');
  if (!['play', 'pause', 'next'].includes(input.action)) throw error(400, 'invalid_player_action', 'Choose a supported Apple Music playback action.');
  if (player.pending) throw error(409, 'player_busy', 'Apple Music is finishing the previous command.');
  player.lastSeen = clock(options);
  if (input.action === 'pause') { room.playback.autoStartArmed = false; player.autoAdvance = false; return { command: command(room, player, 'pause', null, options) }; }
  room.playback.autoStartArmed = true;
  if (input.action === 'play' && player.expectedId && player.lastState?.trackId === player.expectedId && !player.lastState.playing) return { command: command(room, player, 'play', null, options) };
  if (!room.queue.length) throw error(409, 'queue_empty', 'Add a song to the shared queue first.');
  return { command: command(room, player, 'play', room.queue[0], options) };
}

export function reportApple(room, account, input, options = {}) {
  const player = owner(room, account, input?.generation, options);
  if (input?.generation !== player.generation || typeof input.playing !== 'boolean'
    || (input.trackId != null && !songId(input.trackId)) || (input.completedTrackId != null && !songId(input.completedTrackId))
    || ![input.position, input.duration].every((value) => Number.isFinite(value) && value >= 0 && value <= 86400000)
    || (input.fullPlayback !== undefined && typeof input.fullPlayback !== 'boolean')
    || (input.commandId != null && (typeof input.commandId !== 'string' || input.commandId.length > 128))
    || (input.errorCode != null && (typeof input.errorCode !== 'string' || input.errorCode.length > 64))) throw error(400, 'invalid_player_state', 'Apple Music returned an unreadable playback state.');
  player.lastSeen = clock(options);
  if (player.commandId && input.commandId !== player.commandId) { touchRoom(room, options); return { command: null }; }
  if (input.errorCode) { fail(room, player, playbackErrors[input.errorCode] || playbackErrors.playback_failed, options); return { command: null }; }
  const pending = player.pending;
  if (pending) {
    const confirmed = pending.action === 'pause' ? !input.playing : input.playing && input.trackId === pending.track.providerId;
    if (!confirmed) { touchRoom(room, options); return { command: null }; }
    if (pending.action === 'play' && input.fullPlayback !== true) { fail(room, player, playbackErrors.preview_only, options); return { command: null }; }
    if (pending.entryId) {
      const entry = room.queue.find((value) => value.id === pending.entryId);
      if (!entry || recording(entry)?.providerId !== pending.track.providerId) {
        fail(room, player, 'The queued recording changed before Apple Music confirmed it.', options);
        throw error(409, 'request_changed', 'The queued recording changed before Apple Music confirmed it.');
      }
      room.queue = room.queue.filter((value) => value.id !== entry.id);
      room.nowPlaying = { ...copy(entry), hostTrack: copy(pending.track) }; room.played++;
      player.expectedId = pending.track.providerId;
    }
    player.pending = null; player.autoAdvance = pending.action === 'play';
  }
  if (!pending && !input.playing && (!input.trackId || input.trackId === player.expectedId) && player.autoAdvance
    && player.expectedId && input.completedTrackId === player.expectedId && player.lastState?.trackId === player.expectedId) {
    if (!room.queue.length) {
      player.autoAdvance = false; player.lastState = { trackId: input.trackId ?? null, playing: false };
      update(room, { playing: false, position: input.position, duration: input.duration, sampledAt: clock(options), starting: false, pendingEntryId: null, autoAdvance: false, status: 'finished', error: null }, options);
      return { command: null };
    }
    if (!recording(room.queue[0])) { player.autoAdvance = false; player.lastState = { trackId: input.trackId ?? null, playing: false }; update(room, { playing: false, starting: false, pendingEntryId: null, autoAdvance: false, status: 'waiting_match', error: null }, options); return { command: null }; }
    return { command: command(room, player, 'play', room.queue[0], options) };
  }
  player.lastState = { trackId: input.trackId ?? null, playing: input.playing };
  const changed = Boolean(player.expectedId && input.trackId && input.trackId !== player.expectedId);
  if (changed || (!pending && !input.playing && player.expectedId && room.playback.status === 'playing')) { player.autoAdvance = false; room.playback.autoStartArmed = false; }
  const previousStatus = room.playback.status, stickyError = !pending && previousStatus === 'error';
  update(room, { playing: input.playing, position: input.position, duration: input.duration, sampledAt: clock(options),
    currentTrack: input.trackId === player.expectedId ? room.nowPlaying?.hostTrack || null : null,
    starting: false, pendingEntryId: null, autoAdvance: player.autoAdvance,
    status: !pending && ['finished', 'error', 'waiting_match'].includes(previousStatus) ? previousStatus : changed ? 'changed' : input.playing ? 'playing' : 'paused',
    error: stickyError ? room.playback.error : null }, options);
  return { command: null };
}

export function disconnectApple(room, account, input = {}, options = {}) {
  open(room);
  if (account) {
    const player = owner(room, account, input.generation, options);
    if (input.generation !== player.generation) throw error(403, 'player_session_mismatch', 'Reconnect Apple Music playback.');
  }
  disconnect(room, options); return {};
}
