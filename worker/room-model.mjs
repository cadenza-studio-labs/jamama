import { sameServiceMatch } from './recording-match.mjs';
import { refreshHostTransfer } from './host-transfer.mjs';
const services = new Set(['spotify', 'apple', 'qq', 'youtube', 'ytmusic']);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const clock = (options = {}) => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
const copy = (value) => JSON.parse(JSON.stringify(value));
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
const uuid = () => crypto.randomUUID();
const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function open(room) {
  if (!room || room.endedAt != null) throw error(404, "That room isn't open. Check the invitation or start a new room.");
}

function currentMember(room, member) {
  open(room);
  const found = room.members.find((value) => value.id === member?.id);
  if (!found) throw error(401, 'Your room session expired. Please join again.');
  return found;
}

function host(room, member) {
  const found = currentMember(room, member);
  if (found.id !== room.hostId) throw error(403, 'Only the host can manage this Jam.');
  return found;
}

function equal(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function service(value, guest = false) {
  if (!services.has(value) && !(guest && value === 'guest')) throw error(400, 'Choose a music service.');
  return value;
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 32 || /[\x00-\x1f\x7f]/.test(value)) throw error(400, 'Use a name between 1 and 32 characters.');
  return value.trim();
}

function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function verifiedTrack(value) {
  if (!value || typeof value.id !== 'string' || value.id.length > 256 || !value.id.startsWith(`${service(value.provider)}:`)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
    || typeof value.artist !== 'string' || !value.artist.trim() || value.artist.length > 500) throw error(400, 'Choose a song returned by the music service.');
  const track = { id: value.id, provider: value.provider, providerId: String(value.providerId || value.id.slice(value.provider.length + 1)),
    title: value.title, artist: value.artist, album: String(value.album || '').slice(0, 500),
    duration: typeof value.duration === 'string' ? value.duration.slice(0, 20) : '—', isDemo: false,
    durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 86400000 ? value.durationMs : null,
    artworkUrl: httpsUrl(value.artworkUrl), externalUrl: httpsUrl(value.externalUrl) };
  if (typeof value.catalogId === 'string' && /^\d{1,30}$/.test(value.catalogId)) track.catalogId = value.catalogId;
  if (typeof value.isrc === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value.isrc)) track.isrc = value.isrc.toUpperCase();
  if (value.source === 'recently_played' || value.source === 'selected_playlist') track.source = value.source;
  if (value.artistIsUploader === true) track.artistIsUploader = true;
  return track;
}

function invitation(room, options) {
  const baseUrl = options.baseUrl || room.baseUrl;
  const url = new URL('/', baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw error(500, 'Configure Jamama with its HTTPS website address.');
  url.searchParams.set('room', room.code); url.searchParams.set('invite', room.inviteToken);
  return url.href;
}

export function initialApplePlayback(options = {}) {
  return { available: false, connected: false, mode: null, deviceName: null, playing: false, currentTrack: null,
    position: 0, duration: 0, sampledAt: clock(options), startedAt: null, starting: false, pendingEntryId: null,
    autoAdvance: false, autoStartArmed: false, status: 'disconnected', error: null };
}

export function touchRoom(room, options = {}) {
  open(room); room.version++; room.updatedAt = clock(options); return room;
}

export function roomSnapshot(room, options = {}) {
  open(room);
  const transfer = refreshHostTransfer(room, options);
  const now = clock(options), taste = room.taste?.public;
  return copy({ code: room.code, version: room.version, title: room.title, discoverable: room.discoverable,
    hostId: room.hostId, hostProvider: room.hostProvider, listeningMode: room.listeningMode || 'speaker',
    speaker: room.speaker || null, serverTime: now, hostTransfer: transfer, listeningAutomatic: false, output: room.output || null,
    members: room.members.map(({ id, name, provider, lastSeenAt, listener }) => ({ id, name, provider,
      online: Number.isFinite(lastSeenAt) && now - lastSeenAt <= 35000, ...(listener ? { listener } : {}) })),
    queue: room.queue, nowPlaying: room.nowPlaying, played: room.played, playback: room.playback,
    taste: taste ? { ...taste, songs: taste.songs.slice(0, 100), totalSongs: taste.songs.length } : { revision: null, participants: [], pairs: [], songs: [], totalSongs: 0 },
    inviteUrl: invitation(room, options), locked: Boolean(room.locked), inviteRequired: true });
}

export function createRoom(input, options = {}) {
  const now = clock(options), provider = service(input?.provider);
  const code = options.code || [...crypto.getRandomValues(new Uint8Array(6))].map((value) => alphabet[value % alphabet.length]).join('');
  if (!/^[A-Z2-9]{6}$/.test(code)) throw error(400, 'Use a valid six-character Jam code.');
  const member = { id: uuid(), token: randomHex(24), name: name(input?.name), provider, lastSeenAt: now, requests: [] };
  const state = { code, version: 1, title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 100) : 'Jamama session',
    discoverable: input.discoverable === true, hostId: member.id, hostProvider: provider, listeningMode: 'speaker',
    speaker: null, listeningAutomatic: false, output: null, members: [member], queue: [], nowPlaying: null, played: 0,
    playback: initialApplePlayback({ now }), applePlayer: null, taste: null, updatedAt: now, createdAt: now,
    baseUrl: options.baseUrl, inviteToken: randomHex(32), locked: false, endedAt: null };
  return { state, token: member.token, memberId: member.id, room: roomSnapshot(state, options) };
}

export function addMember(room, input, options = {}) {
  open(room);
  if (room.locked) throw error(403, 'The host has locked this Jam to new joins.');
  if (typeof input?.inviteToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.inviteToken) || !equal(input.inviteToken, room.inviteToken)) throw error(403, 'Use the full invitation link from the host.');
  if (room.members.length >= 20) throw error(409, 'This room has reached its 20-person limit.');
  const member = { id: uuid(), token: randomHex(24), name: name(input.name), provider: service(input.provider, true), lastSeenAt: clock(options), requests: [] };
  room.members.push(member); touchRoom(room, options);
  return { token: member.token, memberId: member.id, room: roomSnapshot(room, options) };
}

export function memberFor(room, token) {
  open(room);
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw error(401, 'Join this room first.');
  const member = room.members.find((value) => equal(value.token, token));
  if (!member) throw error(401, 'Your room session expired. Please join again.');
  return member;
}

export function touchMember(room, member, options = {}) {
  currentMember(room, member).lastSeenAt = clock(options);
}

export function enqueue(room, member, value, requestId, options = {}) {
  const owner = currentMember(room, member);
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 64 || /[\x00-\x1f\x7f]/.test(requestId)) throw error(400, 'A request ID is required.');
  const previous = owner.requests.find((request) => request.requestId === requestId);
  if (previous) return { entryId: previous.entryId, room: roomSnapshot(room, options) };
  if (room.queue.length >= 100) throw error(409, 'The queue is full. Let a few songs play first.');
  const track = verifiedTrack(value), entry = { id: uuid(), trackId: track.id, track,
    addedBy: owner.id, name: owner.name, provider: track.provider, addedAt: clock(options) };
  const direct = sameServiceMatch(room.hostProvider, track);
  if (direct) entry.hostMatch = { provider: room.hostProvider, status: 'matched', track: direct };
  room.queue.push(entry); owner.requests.push({ requestId, entryId: entry.id });
  if (owner.requests.length > 200) owner.requests.shift();
  touchRoom(room, options); return { entryId: entry.id, room: roomSnapshot(room, options) };
}

export function removeEntry(room, member, entryId, options = {}) {
  const owner = currentMember(room, member), entry = room.queue.find((value) => value.id === entryId);
  if (!entry) throw error(404, 'That song is no longer queued.');
  if (owner.id !== room.hostId && entry.addedBy !== owner.id) throw error(403, 'You can remove your own requests. The host can manage the whole queue.');
  if (room.playback.pendingEntryId === entry.id) throw error(409, 'This request is starting. Wait for confirmation before removing it.');
  room.queue = room.queue.filter((value) => value.id !== entry.id); touchRoom(room, options); return roomSnapshot(room, options);
}

export function setAccess(room, member, locked, options = {}) {
  host(room, member);
  if (typeof locked !== 'boolean') throw error(400, 'Choose whether this Jam accepts new joins.');
  room.locked = locked; touchRoom(room, options); return roomSnapshot(room, options);
}

export function endRoom(room, member, options = {}) {
  host(room, member);
  room.version++; room.endedAt = clock(options); room.updatedAt = room.endedAt;
  room.members = []; room.queue = []; room.nowPlaying = null; room.taste = null; room.applePlayer = null;
  room.playback = initialApplePlayback(options); delete room.hostPlaybackSessionId;
  return { ended: true, room: null, left: true };
}

export async function leaveRoom(room, member, options = {}) {
  const owner = currentMember(room, member);
  if (owner.id === room.hostId) return endRoom(room, owner, options);
  room.members = room.members.filter((value) => value.id !== owner.id);
  refreshHostTransfer(room, options);
  if (room.taste) await refreshTaste(room);
  touchRoom(room, options); return { ended: false, left: true, room: roomSnapshot(room, options) };
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

const recordingCode = (track) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(track.isrc || '') ? track.isrc.toUpperCase() : null;
const metadata = (track) => `${normalize(track.title)}\0${normalize(track.artist)}`;
const comparable = (left, right) => metadata(left) === metadata(right) && left.title && left.artist
  && Number.isFinite(left.durationMs) && Number.isFinite(right.durationMs) && Math.abs(left.durationMs - right.durationMs) <= 3000;
const trackIdentity = (member, track) => {
  if (track.provider !== 'apple') return track.id;
  const id = track.catalogId || track.providerId || track.id.slice(6);
  return /^\d+$/.test(id) ? `apple:${id}` : `${member.id}:${track.id}`;
};

export async function refreshTaste(room) {
  open(room);
  const participants = room.members.filter((member) => member.taste), groups = new Map(), byMetadata = new Map(), byTrack = new Map();
  const entries = participants.flatMap((member) => member.taste.tracks.map((track) => ({ member, track })));
  entries.sort((a, b) => Number(Boolean(recordingCode(b.track))) - Number(Boolean(recordingCode(a.track))) || a.track.id.localeCompare(b.track.id));
  for (const { member, track } of entries) {
    const code = recordingCode(track), meta = metadata(track), identity = trackIdentity(member, track);
    let group = byTrack.get(identity) || (code ? groups.get(`isrc:${code}`) : null);
    if (!group && !code) {
      const candidates = (byMetadata.get(meta) || []).filter((value) => value.tracks.every((other) => comparable(track, other)));
      if (candidates.length === 1) group = candidates[0];
    }
    if (!group) {
      const key = code ? `isrc:${code}` : identity;
      group = { key, tracks: [], identities: new Set(), members: new Set() }; groups.set(key, group);
    }
    if (!group.identities.has(identity)) { group.tracks.push(track); group.identities.add(identity); }
    if (!byMetadata.has(meta)) byMetadata.set(meta, []);
    if (!byMetadata.get(meta).includes(group)) byMetadata.get(meta).push(group);
    group.members.add(member.id); byTrack.set(identity, group);
  }
  const all = [...groups.values()];
  await Promise.all(all.map(async (group) => { group.id = await digest(group.key); }));
  const shared = all.filter((group) => group.members.size >= 2).sort((a, b) => b.members.size - a.members.size || a.tracks[0].title.localeCompare(b.tracks[0].title));
  const sets = new Map(participants.map((member) => [member.id, new Set(all.filter((group) => group.members.has(member.id)).map((group) => group.id))]));
  const pairs = [];
  participants.forEach((left, index) => participants.slice(index + 1).forEach((right) => {
    const a = sets.get(left.id), b = sets.get(right.id), count = [...a].filter((id) => b.has(id)).length, combined = a.size + b.size - count;
    pairs.push({ memberIds: [left.id, right.id], shared: count, combined, percentage: combined ? Math.round(100 * count / combined) : null });
  }));
  room.taste = { public: { revision: uuid(), participants: participants.map((member) => ({ memberId: member.id, provider: member.taste.provider,
    source: member.taste.source, count: sets.get(member.id).size, updatedAt: member.taste.updatedAt })), pairs,
    songs: shared.map((group) => ({ id: group.id, track: group.tracks[0], likedBy: [...group.members], providers: [...new Set(group.tracks.map((track) => track.provider))] })) },
    songs: shared.map((group) => ({ id: group.id, tracks: group.tracks })) };
  return room.taste;
}

export async function setTaste(room, member, input, options = {}) {
  const owner = currentMember(room, member), provider = service(input?.provider);
  if (!['apple', 'spotify'].includes(provider) || !Array.isArray(input.tracks) || input.tracks.length > 10000
    || typeof input.source?.name !== 'string' || !input.source.name.trim() || input.source.name.length > 500) throw error(400, 'Choose a complete music-library selection.');
  const tracks = input.tracks.map(verifiedTrack);
  if (tracks.some((track) => track.provider !== provider)) throw error(400, 'Choose songs from the selected music service.');
  owner.taste = { provider, source: { name: input.source.name, ...(typeof input.source.id === 'string' ? { id: input.source.id.slice(0, 256) } : {}) }, tracks, updatedAt: clock(options) };
  owner.tasteRevision = (owner.tasteRevision || 0) + 1;
  await refreshTaste(room); touchRoom(room, options); return roomSnapshot(room, options);
}

export async function withdrawTaste(room, member, options = {}) {
  const owner = currentMember(room, member);
  delete owner.taste; owner.tasteRevision = (owner.tasteRevision || 0) + 1;
  await refreshTaste(room); touchRoom(room, options); return roomSnapshot(room, options);
}

export function tasteSnapshot(room, { offset = 0, pair = '' } = {}) {
  open(room);
  if (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0 || Number(offset) > 999999 || typeof pair !== 'string') throw error(400, 'Choose a valid shared-song page.');
  const members = pair ? pair.split(':') : [];
  if (members.length && (members.length !== 2 || members[0] === members[1] || members.some((id) => !room.members.some((member) => member.id === id)))) throw error(400, 'Choose two people in this Jam.');
  const songs = (room.taste?.public.songs || []).filter((song) => members.every((id) => song.likedBy.includes(id))), start = Number(offset);
  return copy({ items: songs.slice(start, start + 100), totalSongs: songs.length,
    nextOffset: start + 100 < songs.length ? start + 100 : null, revision: room.taste?.public.revision || null });
}

export function tasteTrack(room, member, songId) {
  const owner = currentMember(room, member), tracks = room.taste?.songs.find((song) => song.id === songId)?.tracks;
  if (!tracks?.length) throw error(404, 'That shared song is no longer in the comparison.');
  return copy(tracks.find((track) => track.provider === owner.taste?.provider) || tracks.find((track) => track.provider === owner.provider) || tracks[0]);
}
