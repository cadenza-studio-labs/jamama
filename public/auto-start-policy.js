const blocked = (reason) => ({ shouldStart: false, action: null, reason });
const currentTime = (now) => typeof now === 'function' ? now() : now ?? Date.now();

function isHostOnline(room, hostOnline, now) {
  if (typeof hostOnline === 'boolean') return hostOnline;
  const host = room.members?.find((member) => member.id === room.hostId);
  if (typeof host?.online === 'boolean') return host.online;
  const elapsed = currentTime(now) - host?.lastSeenAt;
  return Number.isFinite(host?.lastSeenAt) && elapsed >= 0 && elapsed <= 35000;
}

function matchedHead(room) {
  const match = room.queue[0]?.hostMatch, track = match?.track;
  if (match?.status !== 'matched' || match.provider && match.provider !== room.hostProvider || track?.provider !== room.hostProvider) return false;
  if (room.hostProvider === 'spotify') return /^[A-Za-z0-9]{22}$/.test(track.providerId || '');
  const id = /^\d{1,30}$/.test(track?.providerId || '') ? track.providerId : track?.catalogId;
  return room.hostProvider === 'apple' && /^\d{1,30}$/.test(id || '');
}

export function autoStartDecision({ room, memberId, playerConnected, busy = false, autoStartArmed, hostOnline, now } = {}) {
  if (!room || room.endedAt != null) return blocked('no_room');
  if (typeof memberId !== 'string' || memberId !== room.hostId) return blocked('not_host');
  if (!['apple', 'spotify'].includes(room.hostProvider)) return blocked('unsupported_host');
  if (!isHostOnline(room, hostOnline, now)) return blocked('host_offline');
  if (autoStartArmed !== true) return blocked('not_armed');
  if (playerConnected !== true || room.playback?.connected !== true || room.playback?.available !== true) return blocked('own_player_required');
  if (busy || room.playback.starting || room.playback.pendingEntryId || room.applePlayer?.pending || room.spotifyPlayer?.pending) return blocked('player_busy');
  if (room.hostTransfer) return blocked('handoff_pending');
  if (room.playback.error) return blocked('player_error');
  if (room.playback.playing !== false) return blocked('already_playing');
  const status = room.playback.status;
  const idleApplePause = status === 'paused' && room.hostProvider === 'apple' && !room.nowPlaying;
  if (!['ready', 'finished', 'waiting_match'].includes(status) && !idleApplePause) return blocked('player_not_idle');
  if (room.nowPlaying && !['finished', 'waiting_match'].includes(status)) return blocked('current_request');
  if (!Array.isArray(room.queue) || !room.queue.length) return blocked('queue_empty');
  if (!matchedHead(room)) return blocked('recording_required');
  return { shouldStart: true, action: 'next', reason: 'matched_idle_queue' };
}
