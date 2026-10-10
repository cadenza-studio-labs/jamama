export function targetPosition(playback, serverNow) {
  const position = Math.max(0, Number.isFinite(playback?.position) ? playback.position : 0);
  const elapsed = playback?.playing && Number.isFinite(playback.sampledAt) ? Math.max(0, Math.min(10000, serverNow - playback.sampledAt)) : 0;
  const duration = playback?.duration > 0 ? playback.duration : Infinity;
  return Math.min(duration, position + elapsed);
}

export function hostIsPlaying(room, serverNow) {
  return Boolean(room?.playback?.connected && room.playback.playing && !room.playback.starting
    && !['finished', 'error', 'changed', 'advertisement', 'disconnected'].includes(room.playback.status)
    && Number.isFinite(room.playback.sampledAt) && serverNow - room.playback.sampledAt < 10000);
}
