const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const clock = (options) => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
const copy = (value) => JSON.parse(JSON.stringify(value));
const touch = (room, options) => { room.version = (room.version || 0) + 1; room.updatedAt = clock(options); };

function memberFor(room, member) {
  if (!room || room.endedAt != null) throw fail(404, 'room_closed', 'This Jam is no longer open.');
  const found = room.members?.find((value) => value.id === member?.id);
  if (!found) throw fail(401, 'member_required', 'Join this Jam before changing the host.');
  return found;
}

function online(member, options) {
  const elapsed = clock(options) - member.lastSeenAt;
  return Number.isFinite(member.lastSeenAt) && elapsed >= 0 && elapsed <= 35000;
}

function pending(room) {
  return room.playback?.starting || room.playback?.pendingEntryId || room.applePlayer?.pending || room.spotifyPlayer?.pending;
}

function transferSnapshot(room) {
  const offer = room.hostTransfer;
  return offer ? { id: offer.id, fromId: offer.fromId, toId: offer.toId, expiresAt: offer.expiresAt,
    phase: room.playback?.playing || pending(room) || offer.pauseRequired && !offer.pauseConfirmed ? 'pausing' : 'ready' } : null;
}

export function refreshHostTransfer(room, options = {}) {
  if (!room?.hostTransfer) return null;
  const offer = room.hostTransfer;
  if (room.endedAt != null || offer.expiresAt <= clock(options) || offer.fromId !== room.hostId || offer.fromProvider !== room.hostProvider
    || offer.hostRevision !== (room.hostRevision || 0)
    || !room.members?.some((member) => member.id === offer.toId)) {
    delete room.hostTransfer; touch(room, options);
  }
  return transferSnapshot(room);
}

export function offerHost(room, member, input = {}, options = {}) {
  const owner = memberFor(room, member);
  if (owner.id !== room.hostId) throw fail(403, 'host_required', 'Only the host can offer a handoff.');
  if (refreshHostTransfer(room, options)) throw fail(409, 'handoff_pending', 'Cancel the current handoff before offering another.');
  const target = room.members.find((value) => value.id === input.memberId);
  if (!target || target.id === owner.id) throw fail(400, 'handoff_member_required', 'Choose another person in this Jam.');
  if (!online(target, options)) throw fail(409, 'handoff_offline', 'That person is offline. Wait for them to reconnect.');
  if (pending(room)) throw fail(409, 'player_busy', 'Wait for the current playback command to finish.');
  room.hostTransfer = { id: crypto.randomUUID(), fromId: owner.id, fromProvider: room.hostProvider, toId: target.id,
    hostRevision: room.hostRevision || 0, pauseRequired: room.playback?.connected === true, pauseConfirmed: room.playback?.connected !== true, wasFinished: ['finished', 'waiting_match'].includes(room.playback?.status), expiresAt: clock(options) + 120000 };
  touch(room, options);
  return transferSnapshot(room);
}

export function acceptHost(room, member, input = {}, options = {}) {
  const recipient = memberFor(room, member);
  refreshHostTransfer(room, options);
  const offer = room.hostTransfer;
  if (!offer || offer.id !== input.transferId) throw fail(409, 'handoff_expired', 'This handoff expired or was cancelled.');
  if (offer.toId !== recipient.id || offer.fromId !== room.hostId || offer.hostRevision !== (room.hostRevision || 0)) {
    throw fail(403, 'handoff_recipient_required', 'Only the invited person can accept this handoff.');
  }
  if (!online(recipient, options)) throw fail(409, 'handoff_offline', 'Reconnect to the Jam before accepting.');
  if (!['apple', 'spotify'].includes(input.provider)) throw fail(400, 'host_service_required', 'Choose Spotify or Apple Music for host playback.');
  if (options.accountReady !== true) throw fail(401, 'connect_required', 'Connect your own music account before accepting the handoff.');
  if (room.playback?.playing !== false || pending(room) || offer.pauseRequired && !offer.pauseConfirmed) throw fail(409, 'handoff_pause_required', 'The current host’s player must confirm it is paused first.');
  const unfinished = room.nowPlaying && !offer.wasFinished && !['finished', 'waiting_match'].includes(room.playback.status) ? room.nowPlaying : null;
  const queued = unfinished ? room.queue.filter((entry) => entry.id !== unfinished.id) : room.queue;
  if (unfinished && queued.length >= 100) throw fail(409, 'handoff_queue_full', 'Let a queued request finish or remove one before handing off this song.');
  const sameProvider = room.hostProvider === input.provider;
  if (unfinished) {
    const entry = copy(unfinished);
    delete entry.hostTrack;
    if (sameProvider && unfinished.hostTrack?.provider === input.provider) {
      entry.hostMatch = { provider: input.provider, status: 'matched', track: copy(unfinished.hostTrack) };
    }
    room.queue = [entry, ...queued];
  }
  if (!sameProvider) for (const entry of room.queue) delete entry.hostMatch;
  room.hostId = recipient.id; room.hostProvider = input.provider; recipient.provider = input.provider;
  room.hostRevision = (room.hostRevision || 0) + 1;
  delete room.applePlayer; delete room.spotifyPlayer; delete room.hostPlaybackSessionId; delete room.hostTransfer;
  for (const value of room.members) delete value.listener;
  room.nowPlaying = null; room.output = null; room.speaker = null;
  room.listeningMode = 'speaker'; room.listeningAutomatic = false;
  room.playback = { available: false, connected: false, mode: null, deviceName: null, playing: false, currentTrack: null,
    position: 0, duration: 0, sampledAt: clock(options), startedAt: null, starting: false, pendingEntryId: null,
    autoAdvance: false, autoStartArmed: false, status: 'disconnected', error: null };
  touch(room, options);
  return { hostId: room.hostId, hostProvider: room.hostProvider, hostRevision: room.hostRevision, hostTransfer: null };
}

export function cancelHost(room, member, input = {}, options = {}) {
  const owner = memberFor(room, member);
  refreshHostTransfer(room, options);
  const offer = room.hostTransfer;
  if (!offer || offer.id !== input.transferId) throw fail(409, 'handoff_expired', 'This handoff expired or was cancelled.');
  if (![offer.fromId, offer.toId].includes(owner.id)) throw fail(403, 'handoff_participant_required', 'Only the host or invited person can cancel this handoff.');
  delete room.hostTransfer; touch(room, options);
  return { hostTransfer: null };
}
