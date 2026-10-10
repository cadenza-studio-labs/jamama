import { providerError } from './music-api.mjs';

const clock = (options) => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
const recording = (entry) => entry?.hostMatch?.status === 'matched' && entry.hostMatch.track?.provider === 'spotify'
  ? entry.hostMatch.track : entry?.provider === 'spotify' ? entry.track : null;
const validRecording = (track) => track?.provider === 'spotify' && /^[A-Za-z0-9]{22}$/.test(track.providerId || '');
const nearEnd = (state) => state?.duration > 0 && state.position >= state.duration - 4000;
const messages = {
  premium_required: 'Spotify web playback requires Premium on the host account.',
  reconnect_required: 'Connect Spotify playback again to restore host controls.',
  device_changed: 'Spotify moved to another device. Reconnect playback to continue.',
  device_inactive: 'Open Spotify on the selected device, then try again.',
  rate_limited: 'Spotify needs a short pause before another request.',
  recording_required: 'Choose the Spotify version of the next queued request, then press Play.',
  request_changed: 'The request changed while Spotify was starting it. Your queue is preserved.',
  playback_unconfirmed: 'Spotify did not confirm playback. Your queued requests are preserved.',
};

function playerFor(room, account) {
  const player = room.spotifyPlayer;
  if (!player || room.hostProvider !== 'spotify' || player.hostId !== room.hostId) throw providerError(409, 'playback_unavailable', 'Connect the host’s Spotify player before starting the queue.');
  if (!account?.sessionId || account.sessionId !== player.sessionId || room.hostPlaybackSessionId !== account.sessionId) {
    throw providerError(403, 'player_session_mismatch', 'Use the host browser that connected this Spotify player.');
  }
  return player;
}

function report(room, player, state, options, changes = {}) {
  room.playback = { ...room.playback, available: true, connected: true, mode: 'web', connectionId: player.generation, playing: state.playing === true,
    position: Math.max(0, Number.isFinite(state.position) ? state.position : 0), duration: Math.max(0, Number.isFinite(state.duration) ? state.duration : 0),
    sampledAt: clock(options), currentTrack: state.track || null, intermission: state.type === 'ad', autoAdvance: player.autoAdvance,
    starting: Boolean(player.pending), pendingEntryId: player.pending?.entryId || null,
    status: player.pending ? 'starting' : state.type === 'ad' ? 'advertisement' : state.playing ? 'playing' : 'paused', error: null, ...changes };
}

function failure(room, player, code) {
  player.pending = null; player.autoAdvance = false; player.afterAd = false; room.playback.autoStartArmed = false;
  player.disabled = ['reconnect_required', 'device_changed'].includes(code);
  room.playback = { ...room.playback, playing: false, starting: false, pendingEntryId: null, autoAdvance: false, status: 'error',
    error: messages[code] || 'The Spotify player could not be reached. Reconnect playback and try again.' };
  return { operation: null };
}

function pendingOperation(room, player, action, options, { entry = null, resume = false, stopReason = null } = {}) {
  const track = entry ? recording(entry) : null;
  if (entry && !validRecording(track)) throw providerError(409, 'recording_required', messages.recording_required);
  if (entry && !room.queue.some((candidate) => candidate.id === entry.id)) throw providerError(409, 'request_changed', messages.request_changed);
  const commandId = crypto.randomUUID();
  player.pending = { commandId, action, entryId: entry?.id || null, trackId: track?.providerId || null,
    expectedId: track?.providerId || (resume ? player.expectedId : null), expiresAt: clock(options) + 30000, stopReason };
  player.autoAdvance = false;
  room.playback = { ...room.playback, starting: true, pendingEntryId: entry?.id || null, autoAdvance: false, status: 'starting', error: null };
  return { operation: { action, deviceId: player.deviceId, trackId: player.pending.trackId,
    entryId: player.pending.entryId, commandId, generation: player.generation } };
}

export function connectSpotify(room, account, device, options = {}) {
  if (room.hostProvider !== 'spotify') throw providerError(409, 'spotify_host_required', 'Choose Spotify as the host service.');
  if (typeof account?.sessionId !== 'string' || !account.sessionId) throw providerError(403, 'player_session_mismatch', 'Connect playback from your own host browser.');
  if (!device?.id || device.restricted) throw providerError(409, 'device_unavailable', 'Open Spotify on the chosen device and refresh the device list.');
  if (room.spotifyPlayer?.pending && room.spotifyPlayer.pending.expiresAt > clock(options)) throw providerError(409, 'player_busy', 'Wait for the current playback command to finish before reconnecting.');
  const player = room.spotifyPlayer = { sessionId: account.sessionId, hostId: room.hostId, generation: options.generation || crypto.randomUUID(),
    deviceId: device.id, expectedId: null, currentEntryId: null, autoAdvance: false, afterAd: false, disabled: false, pending: null,
    lastState: options.state || null, lastObservedAt: options.state ? clock(options) : null };
  room.hostPlaybackSessionId = account.sessionId;
  report(room, player, options.state || { playing: false, position: 0, duration: 0, track: null, type: 'none' }, options,
    { status: options.state?.playing ? 'playing' : 'ready', autoStartArmed: options.state?.playing !== true, deviceName: device.name || 'Spotify device' });
  return { generation: player.generation, operation: null };
}

export function beginSpotify(room, account, input = {}, options = {}) {
  const player = playerFor(room, account), action = input.action;
  if (input.generation && input.generation !== player.generation) throw providerError(409, 'player_generation_mismatch', 'This Spotify playback connection changed. Refresh the host page.');
  if (!['play', 'pause', 'next', 'disconnect'].includes(action)) throw providerError(400, 'invalid_player_action', 'Choose a supported playback action.');
  if (action === 'disconnect') {
    delete room.spotifyPlayer; delete room.hostPlaybackSessionId;
    room.playback = { ...room.playback, connected: false, available: false, playing: false, autoAdvance: false, autoStartArmed: false, starting: false, pendingEntryId: null, status: 'disconnected' };
    return { operation: null };
  }
  if (player.pending && player.pending.expiresAt > clock(options)) throw providerError(409, 'player_busy', 'Spotify is finishing the previous command. Try again in a moment.');
  if (player.pending) failure(room, player, 'playback_unconfirmed');
  player.disabled = false;
  if (player.lastState?.device?.id && player.lastState.device.id !== player.deviceId) throw providerError(409, 'device_changed', messages.device_changed);
  if (action === 'pause') { room.playback.autoStartArmed = false; return pendingOperation(room, player, 'pause', options); }
  if (player.lastState?.type === 'ad') throw providerError(409, 'spotify_advertisement', 'Spotify is playing an advertisement. Your requests stay queued until it finishes.');
  room.playback.autoStartArmed = true;
  if (action === 'play' && player.expectedId && player.lastState?.track?.providerId === player.expectedId) {
    if (player.lastState.playing) { player.autoAdvance = true; report(room, player, player.lastState, options); return { operation: null }; }
    return pendingOperation(room, player, 'play', options, { resume: true });
  }
  if (!room.queue.length) throw providerError(409, 'queue_empty', 'Add a song to your shared queue first.');
  return pendingOperation(room, player, 'play', options, { entry: room.queue[0] });
}

export function failSpotify(room, account, error, options = {}) {
  const player = playerFor(room, account);
  if (options.generation && options.generation !== player.generation || options.commandId && options.commandId !== player.pending?.commandId) return { operation: null, ignored: true };
  return failure(room, player, error?.code);
}

export function observeSpotify(room, account, state, options = {}) {
  const player = playerFor(room, account);
  if (options.generation && options.generation !== player.generation || options.commandId && options.commandId !== player.pending?.commandId) return { operation: null, ignored: true };
  if (!state || typeof state !== 'object') return failure(room, player, 'service_unavailable');
  if (state.device?.id !== player.deviceId) return failure(room, player, 'device_changed');
  const pending = player.pending;
  if (pending) {
    if (pending.expiresAt <= clock(options)) return failure(room, player, 'playback_unconfirmed');
    if (pending.action === 'pause' && state.playing === false) {
      player.pending = null; player.autoAdvance = false; player.lastState = state; player.lastObservedAt = clock(options); player.afterAd = false;
      if (pending.stopReason === 'finished') { player.expectedId = null; report(room, player, state, options, { status: 'finished' }); }
      else if (pending.stopReason === 'recording_required') { report(room, player, state, options, { status: 'waiting_match', error: null }); }
      else report(room, player, state, options);
      return { operation: null };
    }
    if (pending.action === 'play' && state.playing === true && state.type === 'track' && state.duration > 0
      && validRecording(state.track) && state.track.providerId === pending.expectedId) {
      if (pending.entryId) {
        const entry = room.queue.find((candidate) => candidate.id === pending.entryId), track = recording(entry);
        if (!entry || !validRecording(track) || track.providerId !== pending.expectedId) return failure(room, player, 'request_changed');
        room.queue = room.queue.filter((candidate) => candidate.id !== entry.id);
        room.nowPlaying = { ...entry, hostTrack: track }; room.played = (room.played || 0) + 1;
        player.expectedId = track.providerId; player.currentEntryId = entry.id;
      }
      player.pending = null; player.autoAdvance = true; player.afterAd = false; player.lastState = state; player.lastObservedAt = clock(options);
      report(room, player, state, options, { startedAt: clock(options) });
      return { operation: null };
    }
    report(room, player, state, options); return { operation: null };
  }
  if (player.disabled) { report(room, player, state, options, { status: 'error', error: room.playback.error, autoAdvance: false }); return { operation: null }; }
  if (state.type === 'ad') {
    if (player.autoAdvance && player.expectedId) player.afterAd = true;
    report(room, player, state, options); return { operation: null };
  }
  if (room.playback.autoStartArmed && !player.expectedId && (state.playing || state.track?.providerId !== player.lastState?.track?.providerId)) { room.playback.autoStartArmed = false; player.autoAdvance = false; report(room, player, state, options, { status: 'changed', autoAdvance: false }); player.lastState = state; player.lastObservedAt = clock(options); return { operation: null }; }
  const same = validRecording(state.track) && state.track.providerId === player.expectedId;
  const elapsed = clock(options) - player.lastObservedAt;
  const fresh = Number.isFinite(player.lastObservedAt) && elapsed >= 0 && elapsed <= 15000;
  const ended = fresh && state.playing === true && player.lastState?.playing && nearEnd(player.lastState) && (!same || state.position + 4000 < player.lastState.position)
    || same && state.playing === false && state.duration > 0 && state.position >= state.duration - 100;
  if (player.autoAdvance && player.expectedId && ended) {
    player.lastState = state; player.lastObservedAt = clock(options); player.afterAd = false;
    if (!room.queue.length) return pendingOperation(room, player, 'pause', options, { stopReason: 'finished' });
    if (!validRecording(recording(room.queue[0]))) return pendingOperation(room, player, 'pause', options, { stopReason: 'recording_required' });
    return pendingOperation(room, player, 'play', options, { entry: room.queue[0] });
  }
  player.afterAd = false;
  if (player.expectedId && !same && !['finished', 'waiting_match'].includes(room.playback.status)) { room.playback.autoStartArmed = false; player.autoAdvance = false; report(room, player, state, options, { status: 'changed', autoAdvance: false }); }
  else if (state.playing === false) { if (player.expectedId && !['finished', 'waiting_match'].includes(room.playback.status)) room.playback.autoStartArmed = false; player.autoAdvance = false; report(room, player, state, options, ['ready', 'finished', 'waiting_match', 'error'].includes(room.playback.status) ? { status: room.playback.status, error: room.playback.error } : {}); }
  else report(room, player, state, options, ['finished', 'error'].includes(room.playback.status) ? { status: room.playback.status, error: room.playback.error } : {});
  player.lastState = state; player.lastObservedAt = clock(options);
  return { operation: null };
}
