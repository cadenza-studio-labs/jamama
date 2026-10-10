const spotifyId = /^[A-Za-z0-9]{22}$/;
const appleId = /^\d{1,30}$/;
const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i;
const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const recordingCode = (track) => typeof track?.isrc === 'string' && isrcPattern.test(track.isrc) ? track.isrc.toUpperCase() : null;
const hasDuration = (track) => Number.isFinite(track?.durationMs) && track.durationMs > 0;
const closeDuration = (left, right) => Math.abs(left.durationMs - right.durationMs) <= 3000;

export function sameServiceMatch(provider, source) {
  if (!source || source.provider !== provider || typeof source.id !== 'string' || !source.id.startsWith(`${provider}:`)) return null;
  const sourceId = source.id.slice(provider.length + 1);
  if (provider === 'spotify') {
    const id = source.providerId || sourceId;
    if (typeof id !== 'string' || !spotifyId.test(id) || sourceId !== id) return null;
    return { ...source, id: `spotify:${id}`, providerId: id };
  }
  if (provider === 'apple') {
    const id = source.catalogId || source.providerId || sourceId;
    if (typeof id !== 'string' || !appleId.test(id)) return null;
    if (!source.catalogId && sourceId !== id) return null;
    return { ...source, id: `apple:${id}`, providerId: id, catalogId: id };
  }
  return null;
}

function version(title) {
  const parts = String(title || '').normalize('NFKC').toLowerCase().match(/\([^)]*\)|\[[^\]]*\]|(?:\s[-–—]\s).*/g) || [];
  const markers = /\b(?:live|remaster(?:ed)?|remix(?:ed)?|acoustic|instrumental|karaoke|cover|radio edit|extended|re[- ]?record(?:ed|ing)|sped up|slowed(?: down)?|mono|stereo)\b|现场|現場|混音|重制|重製|伴奏|不插电|不插電|加速|慢速/;
  return parts.filter((part) => markers.test(part)).map(normalize).sort().join('|');
}

export function selectExactMatch(source, candidates) {
  const code = recordingCode(source);
  if (!code || !Array.isArray(candidates)) return null;
  const exact = [...new Map(candidates.filter((track) => recordingCode(track) === code)
    .map((track) => sameServiceMatch(track.provider, track)).filter(Boolean).map((track) => [track.id, track])).values()];
  if (!exact.length) return null;
  const sourceVersion = version(source.title);
  if (exact.some((track) => version(track.title) !== sourceVersion)) return null;
  if (hasDuration(source) && exact.some((track) => hasDuration(track) && !closeDuration(source, track))) return null;
  if (exact.length === 1) return exact[0];
  const reference = exact[0];
  if (!normalize(source.title) || !normalize(source.artist) || !hasDuration(reference)) return null;
  if (exact.some((track) => normalize(track.title) !== normalize(source.title)
    || normalize(track.artist) !== normalize(source.artist)
    || !hasDuration(track) || !closeDuration(reference, track))) return null;
  const durations = exact.map((track) => track.durationMs);
  if (hasDuration(source)) durations.push(source.durationMs);
  if (Math.max(...durations) - Math.min(...durations) > 3000) return null;
  const sourceAlbum = normalize(source.album);
  exact.sort((left, right) => Number(Boolean(sourceAlbum) && normalize(right.album) === sourceAlbum)
    - Number(Boolean(sourceAlbum) && normalize(left.album) === sourceAlbum)
    || left.id.localeCompare(right.id, 'en'));
  return exact[0];
}
