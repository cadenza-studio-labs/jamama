import { assets } from './assets.mjs';
import { Store, fail, equal } from './store.mjs';
import { createSpotify, createApple } from './music-api.mjs';
import * as model from './room-model.mjs';
import * as applePlayer from './apple-playback.mjs';
import * as spotifyPlayer from './spotify-playback.mjs';
import * as handoff from './host-transfer.mjs';
import { sameServiceMatch, selectExactMatch } from './recording-match.mjs';
import { autoStartDecision } from '../public/auto-start-policy.js';
import { resolveQQRecall } from './qq-recall.mjs';
import QRCode from 'qrcode';

const labels = { spotify: 'Spotify', apple: 'Apple Music' };
const allowedServices = new Set(Object.keys(labels));
const copy = (value) => JSON.parse(JSON.stringify(value));
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.apple.com https://*.mzstatic.com; frame-src https://*.apple.com; media-src 'self' blob: https://*.apple.com https://*.mzstatic.com; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.apple.com https://accounts.spotify.com",
};
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function redirect(location) { return new Response(null, { status: 302, headers: { ...securityHeaders, Location: location, 'Cache-Control': 'no-store' } }); }
function requireService(provider) { if (!allowedServices.has(provider)) throw fail(400, 'unsupported_service', 'Choose Spotify or Apple Music.'); }
async function body(request, maxBytes = 32768) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw fail(415, 'invalid_content_type', 'Use Jamama to make this change.');
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw fail(413, 'body_too_large', 'That request is too large.');
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw fail(413, 'body_too_large', 'That request is too large.'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw fail(400, 'invalid_body', 'The request could not be read.'); }
}
function trackId(value, provider) { if (typeof value !== 'string' || value.length > 256 || !value.startsWith(`${provider}:`)) throw fail(400, 'invalid_track', 'Choose a song fetched from the music service.'); }
function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

export function createCloudApp({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  return async function handle(request, env, context = {}) {
    const url = new URL(request.url), method = request.method;
    const baseUrl = new URL(env.PUBLIC_URL || url.origin).origin;
    const store = new Store(env, now);
    let session;
    const options = { baseUrl, now };
    const clients = { spotify: createSpotify({ clientId: env.SPOTIFY_CLIENT_ID || '', redirectUri: `${baseUrl}/auth/spotify/callback`, fetchImpl, now }), apple: createApple({ developerToken: env.APPLE_MUSIC_DEVELOPER_TOKEN || '', fetchImpl }) };
    const configured = (provider) => provider === 'spotify' ? Boolean(env.SPOTIFY_CLIENT_ID) : Boolean(env.APPLE_MUSIC_DEVELOPER_TOKEN);
    const connection = (provider, optional = false) => { requireService(provider); const item = session?.data.providers[provider]; if (!item && !optional) throw fail(401, 'connect_required', `Connect ${labels[provider]} to read your library.`); return item; };
    const account = (provider) => { const item = connection(provider); return { sessionId: session.id, connectionGeneration: item.generation }; };
    const requireWrite = () => { if (!session || !equal(request.headers.get('X-CSRF-Token'), session.data.csrfToken)) throw fail(403, 'csrf_failed', 'Refresh Jamama before making this change.'); };
    async function clearShared(provider) {
      const rows = await store.db.prepare('SELECT code FROM rooms WHERE payload LIKE ? AND expires_at > ?').bind(`%"tasteSessionId":"${session.id}"%`, now()).all();
      for (const row of rows.results) try {
        await store.mutateRoom(row.code, async (value) => { for (const own of value.members) if (own.tasteSessionId === session.id && own.taste?.provider === provider) await model.withdrawTaste(value, own, options); });
      } catch (error) { if (error.code !== 'room_closed') throw error; }
    }
    function status() {
      return { rememberConnection: session?.data.remember !== false, csrfToken: session?.data.csrfToken,
        providers: Object.fromEntries(Object.entries(labels).map(([id, name]) => [id, { configured: configured(id), connected: Boolean(session?.data.providers[id]), connectAvailable: configured(id), status: !configured(id) ? 'setup_required' : session?.data.providers[id] ? 'connected' : 'disconnected',
          message: session?.data.providers[id] ? `Your ${name} library is connected.` : `Connect ${name} to browse your library.`,
          ...(id === 'spotify' ? { connectUrl: configured(id) ? '/auth/spotify/start' : null, player: { authorized: Boolean(session?.data.providers.spotify?.scope?.includes('user-read-playback-state')), webAuthorized: Boolean(session?.data.providers.spotify?.scope?.includes('user-modify-playback-state')), webConnectUrl: '/auth/spotify/start?playback=web', listenConnectUrl: '/auth/spotify/start?playback=listen' } } : {}),
          capabilities: { library: configured(id), albums: configured(id), search: configured(id), publicCatalog: id === 'apple' && configured(id), playback: id === 'apple' || Boolean(session?.data.providers.spotify?.scope?.includes('user-read-playback-state')) },
          setup: id === 'spotify' ? { redirectUri: `${baseUrl}/auth/spotify/callback`, message: 'Spotify development accounts must be approved in the app dashboard.' } : { requiredOrigin: baseUrl } }])), publicBeta: true };
    }
    async function call(provider, name, ...args) {
      if (!configured(provider)) throw fail(503, 'setup_required', `${labels[provider]} is not configured yet.`);
      const item = connection(provider, provider === 'apple' && name === 'search');
      const previousProvider = item ? { ...item } : null;
      const generation = item?.generation;
      let result;
      try { result = await clients[provider][name](item || { storefront: 'us' }, ...args); }
      catch (error) { if (item && error.code === 'reconnect_required' && await store.dropProvider(session, provider, item.generation)) await clearShared(provider); throw error; }
      if (item) await store.currentProvider(session, provider, generation);
      await store.mergeLibrary(session, provider, item, result?.items, { previousProvider }); return result;
    }
    async function match(provider, source) {
      const direct = sameServiceMatch(provider, source);
      if (direct) return { provider, status: 'matched', track: direct };
      connection(provider);
      const isrc = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(source.isrc || '') ? source.isrc.toUpperCase() : null;
      let result;
      if (isrc) result = await call(provider, provider === 'apple' ? 'byIsrc' : 'search', provider === 'apple' ? isrc : `isrc:${isrc}`, 0);
      if (!result?.items?.length) result = await call(provider, 'search', `${source.title} ${source.artist}`.slice(0, 200), 0);
      const candidates = [...new Map(result.items.map((track) => [track.id, track])).values()];
      const exact = result.nextOffset == null ? selectExactMatch(source, candidates) : null;
      if (exact) return { provider, status: 'matched', track: exact, message: 'The recording ID matches.' };
      const rank = (track) => (isrc && track.isrc?.toUpperCase() === isrc ? 8 : 0) + (normalize(track.title) === normalize(source.title) ? 4 : 0) + (normalize(track.artist) === normalize(source.artist) ? 2 : 0) + (track.durationMs && source.durationMs && Math.abs(track.durationMs - source.durationMs) < 3000 ? 1 : 0);
      candidates.sort((a, b) => rank(b) - rank(a));
      return candidates.length ? { provider, status: 'choice_required', candidates: candidates.slice(0, 5) } : { provider, status: 'not_found' };
    }
    const roomToken = () => request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    const readRoom = async (code) => { const { state } = await store.room(code); model.memberFor(state, roomToken()); return state; };
    const roomUpdate = (code, mutation, guard) => store.mutateRoom(code, async (room) => { const member = model.memberFor(room, roomToken()); return mutation(room, member); }, guard);
    const confirmHandoffPause = (room, generation, commandId) => { const offer = room.hostTransfer; if (offer && offer.pauseCommandId === commandId && offer.playerGeneration === generation && room.playback.status === 'paused' && !room.playback.playing && !room.playback.starting && !room.applePlayer?.pending && !room.spotifyPlayer?.pending) { offer.pauseConfirmed = true; model.touchRoom(room, options); } };
    const requireAutomaticStart = (room, member, input) => { if (!input.automatic) return; if (room.hostProvider === 'spotify' && input.generation !== room.spotifyPlayer?.generation || input.entryId !== room.queue[0]?.id || !autoStartDecision({ room, memberId: member.id, playerConnected: true, autoStartArmed: room.playback.autoStartArmed, hostOnline: true, now }).shouldStart) throw fail(409, 'request_changed', 'The queue or player changed before automatic playback.'); };
    const requireStableHost = (room) => { if (handoff.refreshHostTransfer(room, options)) throw fail(409, 'handoff_pending', 'Finish or cancel the host change first.'); };
    const requireHost = (room, member) => { if (member.id !== room.hostId) throw fail(403, 'host_required', 'Only the host can control playback and matching.'); };
    async function spotifyWork(code, operation = null, generation = null) {
      let next = operation;
      for (let step = 0; step < 3; step++) {
        const live = await readRoom(code); requireHost(live, model.memberFor(live, roomToken()));
        const player = live.spotifyPlayer;
        if (!player || player.sessionId !== session.id || player.connectionGeneration !== connection('spotify').generation || generation && player.generation !== generation || next && player.pending?.commandId !== next.commandId) return;
        try {
          if (next) await call('spotify', 'playerCommand', next.action, next.deviceId, next.trackId || undefined);
          const observed = await call('spotify', 'playerState');
          const result = await roomUpdate(code, (value, own) => {
            requireHost(value, own); const active = value.spotifyPlayer;
            if (!active || active.connectionGeneration !== connection('spotify').generation) throw fail(409, 'player_disconnected', 'Reconnect Spotify playback.');
            const pendingCommandId = active.pending?.commandId;
            const result = spotifyPlayer.observeSpotify(value, account('spotify'), observed, { ...options, generation: player.generation, ...(next ? { commandId: next.commandId } : {}) });
            if (!result.ignored) confirmHandoffPause(value, active.generation, pendingCommandId);
            active.pollUntil = 0; model.touchRoom(value, options); return result;
          });
          next = result.operation; generation = player.generation; if (!next) return;
        } catch (error) {
          await roomUpdate(code, (value, own) => { requireHost(value, own); if (!value.spotifyPlayer) return; spotifyPlayer.failSpotify(value, account('spotify'), error, { ...options, generation: player.generation, ...(next ? { commandId: next.commandId } : {}) }); value.spotifyPlayer.pollUntil = 0; model.touchRoom(value, options); });
          if (operation) throw error; return;
        }
      }
    }
    try {
      if (!['GET', 'HEAD', 'POST', 'DELETE', 'PATCH'].includes(method)) throw fail(405, 'method_not_allowed', 'Use the supported action.');
      if (!['GET', 'HEAD'].includes(method) && request.headers.get('Origin') && request.headers.get('Origin') !== baseUrl) throw fail(403, 'invalid_origin', 'Use Jamama to make this change.');
      const assetPath = url.pathname === '/' ? '/index.html' : url.pathname === '/recall' ? '/recall.html' : url.pathname;
      if (assets[assetPath] && ['GET', 'HEAD'].includes(method)) {
        const asset = assets[assetPath], bytes = Uint8Array.from(atob(asset.data), (x) => x.charCodeAt(0));
        return new Response(method === 'HEAD' ? null : bytes, { headers: { ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' } });
      }
      if (url.pathname === '/api/catalog') return json({ publicBeta: true, providers: { spotify: { name: 'Spotify', short: 'Spotify', logoUrl: '/brands/spotify-icon-black.svg' }, apple: { name: 'Apple Music', short: 'Apple Music', logoUrl: '/brands/apple-music-icon-color.svg' } }, tracks: [] });
      if (url.pathname === '/api/host-capabilities') return json({ audioOutput: false });
      if (url.pathname === '/api/clock') return json({ serverTime: now() });
      if (url.pathname === '/api/nearby') return json({ enabled: false, rooms: [], scope: 'same_server', message: 'Join a Jam using its invitation link.' });
      if (!env.DB) throw fail(503, 'setup_required', 'Jamama’s cloud storage is preparing.');
      if (Math.random() < .02) context.waitUntil?.(store.cleanup());
      session = await store.session(request, url.pathname === '/api/connections' || url.pathname === '/auth/spotify/start' || url.pathname === '/api/connections/apple/config' || url.pathname.startsWith('/api/library/apple/search'));
      let response;
      if (url.pathname === '/api/connections' && method === 'GET') response = json(status());
      else if (url.pathname === '/api/connections/apple/config' && method === 'GET') {
        if (!configured('apple')) throw fail(503, 'setup_required', 'Apple Music is not configured yet.');
        response = json({ developerToken: env.APPLE_MUSIC_DEVELOPER_TOKEN, app: { name: 'Jamama', build: '1.0.0' } });
      } else if (url.pathname === '/auth/spotify/start' && method === 'GET') {
        if (!configured('spotify')) throw fail(503, 'setup_required', 'Spotify sign-in is not configured yet.');
        await store.limit(request, 'spotify-login', 20);
        const authorization = await clients.spotify.authorization(url.searchParams.get('playback') || '');
        session.data.authorization = { ...authorization, startedAt: now(), generation: crypto.randomUUID() };
        await store.saveSession(session); response = redirect(authorization.url);
      } else if (url.pathname === '/auth/spotify/callback' && method === 'GET') {
        const authorization = session?.data.authorization;
        if (!authorization || now() - authorization.startedAt > 600000 || !equal(authorization.state, url.searchParams.get('state'))) throw fail(400, 'invalid_oauth_state', 'Spotify sign-in could not be verified. Start it again from Jamama.');
        const generation = authorization.generation;
        delete session.data.authorization; await store.saveSession(session);
        if (url.searchParams.has('error')) response = redirect('/?connection=spotify&status=cancelled');
        else {
          const code = url.searchParams.get('code'); if (!code || code.length > 4096) throw fail(400, 'invalid_authorization', 'Spotify did not return a sign-in code.');
          const provider = await clients.spotify.exchange(code, authorization.verifier, `${baseUrl}/auth/spotify/callback`);
          provider.scope ||= authorization.requestedScope; provider.generation = generation;
          session.data.providers.spotify = provider; await store.saveSession(session);
          await clearShared('spotify');
          response = redirect(`/?connection=spotify&status=connected${authorization.playbackMode ? '&view=player&player=web' : ''}`);
        }
      } else if (url.pathname === '/api/connections/preferences' && method === 'POST') {
        requireWrite(); const input = await body(request); if (typeof input.remember !== 'boolean') throw fail(400, 'invalid_preference', 'Choose whether to keep signed in.');
        session.data.remember = input.remember; await store.saveSession(session); response = json(status());
      } else if (/^\/api\/connections\/(apple|spotify)\/(connect|disconnect)$/.test(url.pathname) && method === 'POST') {
        requireWrite(); await store.limit(request, 'connection', 30);
        const [, provider, action] = url.pathname.match(/^\/api\/connections\/(apple|spotify)\/(connect|disconnect)$/);
        if (action === 'disconnect') { await store.dropProvider(session, provider); await clearShared(provider); }
        else {
          if (provider !== 'apple') throw fail(400, 'oauth_required', 'Sign in directly with Spotify.');
          const input = await body(request); if (typeof input.musicUserToken !== 'string' || input.musicUserToken.length > 16384 || !input.musicUserToken.trim()) throw fail(400, 'invalid_token', 'Apple Music did not return access.');
          const verified = await clients.apple.connect(input.musicUserToken);
          const changed = session.data.providers.apple?.musicUserToken !== input.musicUserToken;
          session.data.providers.apple = { musicUserToken: input.musicUserToken, storefront: verified.storefront, generation: changed ? crypto.randomUUID() : session.data.providers.apple.generation };
          if (changed) await clearShared('apple');
        }
        await store.saveSession(session); response = json(status());
      } else if (url.pathname === '/api/recall/qq/resolve' && method === 'POST') {
        requireWrite(); connection('apple'); await store.limit(request, 'qq-quiz', 12);
        const input = await body(request, 65536), own = connection('apple'), generation = own.generation;
        let result;
        try {
          result = await resolveQQRecall(input, { search: (term, offset = 0) => clients.apple.search(own, term, offset), byIsrc: (isrc) => clients.apple.byIsrc(own, isrc) });
        } catch (error) {
          if (error.code === 'reconnect_required' && await store.dropProvider(session, 'apple', generation)) await clearShared('apple');
          throw error;
        }
        await store.currentProvider(session, 'apple', generation);
        response = json(result);
      } else if (url.pathname.startsWith('/api/library/') && method === 'GET') {
        await store.limit(request, 'library', 120);
        const route = url.pathname.match(/^\/api\/library\/(apple|spotify)\/(playlists|albums|tracks|search|recent)(?:\/([^/]+)\/tracks)?$/);
        if (!route) throw fail(404, 'not_found', 'This library is unavailable.');
        const [, provider, collection, encodedId] = route; requireService(provider);
        if (!session) throw fail(401, 'connect_required', `Connect ${labels[provider]} to see your library.`);
        const offsetString = url.searchParams.get('offset') || '0';
        if (collection === 'recent') {
          if (provider !== 'apple' || offsetString.length > 512 || /[\s\x00-\x1f]/.test(offsetString)) throw fail(400, 'invalid_offset', 'Choose a valid recent-song page.');
          response = json(await call('apple', 'recentTracks', offsetString === '0' ? '' : offsetString));
        } else {
          if (!/^\d{1,7}$/.test(offsetString)) throw fail(400, 'invalid_offset', 'Choose a valid page.');
          const offset = Number(offsetString), id = encodedId ? decodeURIComponent(encodedId) : null;
          if (id && !/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw fail(400, 'invalid_playlist', 'Choose a valid playlist.');
          let result;
          if (collection === 'search') { const term = (url.searchParams.get('term') ?? url.searchParams.get('q'))?.trim(); if (!term || term.length > 200) throw fail(400, 'invalid_search', 'Enter a song, artist or album.'); result = await call(provider, 'search', term, offset); }
          else if (collection === 'playlists') result = id ? await call(provider, 'tracks', id, offset) : await call(provider, 'playlists', offset);
          else if (collection === 'albums') result = id ? await call(provider, 'albumTracks', id, offset) : await call(provider, 'albums', offset);
          else result = await call(provider, 'tracks', null, offset);
          response = json(result);
        }
      } else if (url.pathname === '/api/rooms' && method === 'POST') {
        requireWrite(); await store.limit(request, 'create-room', 12);
        const input = await body(request); requireService(input.provider);
        const result = model.createRoom(input, options); await store.insertRoom(result.state); response = json({ token: result.token, memberId: result.memberId, room: result.room }, 201);
      } else if (/^\/api\/rooms\/[A-Z2-9]{6}(?:\/.*)?$/.test(url.pathname)) {
        const [, code, action = ''] = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(.*))?$/);
        if (action === 'socket') throw fail(426, 'use_polling', 'Use Jamama’s live room connection.');
        if (action === 'join' && method === 'POST') {
          requireWrite(); await store.limit(request, 'join-room', 30); const input = await body(request);
          response = json(await store.mutateRoom(code, (room) => model.addMember(room, input, options)));
        } else {
          const room = await readRoom(code), member = model.memberFor(room, roomToken());
          if (method !== 'GET') requireWrite();
          if (!action && method === 'GET') {
            if (room.hostTransfer) await roomUpdate(code, (value) => { handoff.refreshHostTransfer(value, options); });
            if (now() - member.lastSeenAt > 15000) await roomUpdate(code, (value, own) => { model.touchMember(value, own, options); });
            if (room.applePlayer && (now() - room.applePlayer.lastSeen > 30000 || room.applePlayer.pending?.expiresAt <= now())) await roomUpdate(code, (value) => { applePlayer.refreshApple(value, options); });
            if (member.id === room.hostId && room.spotifyPlayer && (room.spotifyPlayer.pending || room.spotifyPlayer.autoAdvance || room.playback.autoStartArmed) && now() - (room.playback.sampledAt || 0) > 1500) {
              const generation = await roomUpdate(code, (value, own) => { requireHost(value, own); const active = value.spotifyPlayer; if (!active || active.pollUntil > now() || now() - (value.playback.sampledAt || 0) < 1500) return null; active.pollUntil = now() + 15000; return active.generation; });
              if (generation) await spotifyWork(code, null, generation);
            }
            const current = (await store.room(code)).state; response = json(model.roomSnapshot(current, options));
          } else if (action === 'qr' && method === 'GET') response = new Response(await QRCode.toString(model.roomSnapshot(room, options).inviteUrl, { type: 'svg', margin: 1, width: 256 }), { headers: { ...securityHeaders, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
          else if (action === 'access' && method === 'POST') { const input = await body(request); response = json(await roomUpdate(code, (value, own) => model.setAccess(value, own, input.locked, options))); }
          else if (action === 'leave' && method === 'POST') response = json(await roomUpdate(code, (value, own) => model.leaveRoom(value, own, options)));
          else if (action === 'member' && method === 'PATCH') { const input = await body(request); requireService(input.provider); response = json(await roomUpdate(code, (value, own) => { own.provider = input.provider; model.touchRoom(value, options); return model.roomSnapshot(value, options); })); }
          else if (action === 'queue' && method === 'POST') {
            const input = await body(request); trackId(input.trackId, input.provider);
            const track = session.data.tracks[input.trackId]; if (!track || track.provider !== input.provider) throw fail(404, 'track_not_loaded', 'Open this song from your library or search again.');
            response = json(await roomUpdate(code, (value, own) => model.enqueue(value, own, track, input.requestId, options)), 201);
          } else if (action === 'queue' && method === 'DELETE') { const input = await body(request); response = json(await roomUpdate(code, (value, own) => model.removeEntry(value, own, input.entryId, options))); }
          else if (action === 'queue/match/search' && method === 'POST') {
            requireHost(room, member); requireStableHost(room); const input = await body(request), entry = room.queue.find((item) => item.id === input.entryId);
            if (!entry) throw fail(404, 'request_missing', 'That request is no longer queued.');
            if (room.playback.pendingEntryId === entry.id) throw fail(409, 'player_busy', 'Wait for this recording to finish starting.');
            const previousMatch = JSON.stringify(entry.hostMatch || null);
            let found; try { found = await match(room.hostProvider, entry.track); } catch (error) { if (error.code === 'connect_required') found = { provider: room.hostProvider, status: 'connection_required' }; else throw error; }
            response = json(await roomUpdate(code, (value, own) => { requireHost(value, own); requireStableHost(value); if (value.hostId !== room.hostId || value.hostProvider !== room.hostProvider) throw fail(409, 'host_changed', 'The host changed. Match this request again.'); const current = value.queue.find((item) => item.id === input.entryId); if (!current || value.playback.pendingEntryId === current.id || JSON.stringify(current.hostMatch || null) !== previousMatch) throw fail(409, 'request_changed', 'That request changed.'); current.hostMatch = found; model.touchRoom(value, options); return model.roomSnapshot(value, options); }));
          } else if (action === 'queue/match/select' && method === 'POST') {
            const input = await body(request); response = json(await roomUpdate(code, (value, own) => { requireHost(value, own); requireStableHost(value); const entry = value.queue.find((item) => item.id === input.entryId), track = entry?.hostMatch?.status === 'choice_required' && entry.hostMatch.candidates.find((item) => item.id === input.trackId);
              if (!track) throw fail(400, 'invalid_match', 'Choose a version found on the host’s service.'); if (value.playback.pendingEntryId === entry.id) throw fail(409, 'player_busy', 'Wait for this recording to finish starting.'); entry.hostMatch = { provider: value.hostProvider, status: 'matched', track }; model.touchRoom(value, options); return model.roomSnapshot(value, options); }));
          } else if (action === 'taste' && method === 'GET') response = json(model.tasteSnapshot(room, { offset: Number(url.searchParams.get('offset') || 0), pair: url.searchParams.get('pair') || '' }));
          else if (action === 'taste' && method === 'DELETE') response = json(await roomUpdate(code, (value, own) => model.withdrawTaste(value, own, options)));
          else if (action === 'taste' && method === 'POST') {
            const input = await body(request); requireService(input.provider); connection(input.provider);
            let sourceName = 'Liked Songs';
            if (input.provider === 'apple') {
              if (typeof input.playlistId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(input.playlistId)) throw fail(400, 'invalid_playlist', 'Choose one of your Apple Music playlists.');
              let offset = 0, selected;
              for (let page = 0; page < 20; page++) { const lists = await call('apple', 'playlists', offset); selected = lists.items.find((list) => list.id === input.playlistId); if (selected || lists.nextOffset == null) break; offset = lists.nextOffset; }
              if (!selected) throw fail(409, 'playlist_changed', 'This playlist changed. Refresh your library and choose it again.');
              sourceName = selected.name;
            }
            if (member.taste?.updatedAt > now() - 30000) throw fail(429, 'refresh_too_soon', 'Wait a moment before refreshing your taste.');
            const revision = member.tasteRevision || 0, generation = connection(input.provider).generation;
            let items = [], offset = 0; const seen = new Set();
            for (let page = 0; page < 200; page++) { if (seen.has(offset)) throw fail(502, 'invalid_page', 'The music service repeated a page.'); seen.add(offset);
              const result = input.provider === 'spotify' ? await call('spotify', 'tracks', null, offset) : await call('apple', 'tracks', input.playlistId, offset);
              items.push(...result.items); if (items.length > 10000) throw fail(413, 'taste_limit', 'Choose up to 10,000 songs for this comparison.'); if (result.nextOffset == null) break; offset = result.nextOffset; if (page === 199) throw fail(413, 'taste_limit', 'Choose a smaller playlist.'); }
            await store.currentProvider(session, input.provider, generation);
            response = json(await roomUpdate(code, (value, own) => { if ((own.tasteRevision || 0) !== revision) throw fail(409, 'taste_changed', 'You stopped sharing this selection.'); own.tasteSessionId = session.id; return model.setTaste(value, own, { provider: input.provider, source: { kind: input.provider === 'spotify' ? 'liked' : 'playlist', id: input.playlistId || null, name: sourceName }, tracks: items, updatedAt: now() }, options); }, { connection: { sessionId: session.id, provider: input.provider, generation } }));
          } else if (action === 'taste/queue' && method === 'POST') { const input = await body(request); response = json(await roomUpdate(code, (value, own) => model.enqueue(value, own, model.tasteTrack(value, own, input.songId), input.requestId, options)), 201); }
          else if (action === 'host/offer' && method === 'POST') {
            const input = await body(request);
            const offered = await roomUpdate(code, (value, own) => {
              requireHost(value, own);
              handoff.offerHost(value, own, input, options);
              value.playback.autoStartArmed = false;
              let command = null, operation = null;
              if (value.playback.connected) {
                if (value.hostProvider === 'apple') command = applePlayer.beginApple(value, account('apple'), { action: 'pause', generation: input.generation }, options).command;
                else { if (value.spotifyPlayer?.connectionGeneration !== connection('spotify').generation) throw fail(409, 'player_disconnected', 'Reconnect your Spotify host player before changing hosts.'); operation = spotifyPlayer.beginSpotify(value, account('spotify'), { action: 'pause' }, options).operation; }
              }
              if (value.hostTransfer.pauseRequired) { value.hostTransfer.pauseCommandId = command?.id || operation?.commandId; value.hostTransfer.playerGeneration = command?.generation || operation?.generation; }
              return { command, operation, transferId: value.hostTransfer.id };
            });
            if (offered.operation) { try { await spotifyWork(code, offered.operation, offered.operation.generation); } catch (error) { await roomUpdate(code, value => { if (value.hostTransfer?.id === offered.transferId) { delete value.hostTransfer; model.touchRoom(value, options); } }); throw error; } }
            response = json({ command: offered.command, room: model.roomSnapshot((await store.room(code)).state, options) });
          } else if (action === 'host/accept' && method === 'POST') {
            const input = await body(request); requireService(input.provider);
            const ownConnection = connection(input.provider);
            const generation = ownConnection.generation;
            response = json(await roomUpdate(code, (value, own) => {
              handoff.acceptHost(value, own, input, { ...options, accountReady: true });
              return model.roomSnapshot(value, options);
            }, { connection: { sessionId: session.id, provider: input.provider, generation } }));
          } else if (action === 'host/cancel' && method === 'POST') {
            const input = await body(request);
            response = json(await roomUpdate(code, (value, own) => { handoff.cancelHost(value, own, input, options); return model.roomSnapshot(value, options); }));
          } else if (action === 'player/connect' && method === 'POST') {
            requireHost(room, member); requireStableHost(room); const input = await body(request);
            const occupied = await store.db.prepare("SELECT code FROM rooms WHERE code != ? AND expires_at > ? AND json_extract(payload, '$.hostPlaybackSessionId') = ? AND json_extract(payload, '$.playback.connected') = 1 LIMIT 1").bind(code, now(), session.id).first();
            if (occupied) throw fail(409, 'player_in_use', 'This browser already controls another Jam. Disconnect that player first.');
            if (room.hostProvider === 'apple') response = json(await roomUpdate(code, (value, own) => { requireHost(value, own); requireStableHost(value); const result = applePlayer.connectApple(value, account('apple'), options); return { ...result, room: model.roomSnapshot(value, options) }; }));
            else {
              const own = connection('spotify'), scopes = new Set(own.scope?.split(' ') || []);
              if (!scopes.has('user-read-playback-state') || !scopes.has('user-modify-playback-state')) throw fail(409, 'player_authorization_required', 'Authorize Spotify playback before connecting the host player.');
              const devices = await call('spotify', 'playerDevices'), device = devices.find((item) => item.id === input.deviceId && !item.restricted); if (!device) throw fail(409, 'device_inactive', 'Open Spotify on your selected device first.');
              const observed = await call('spotify', 'playerState');
              response = json(await roomUpdate(code, (value, ownMember) => { requireHost(value, ownMember); requireStableHost(value); spotifyPlayer.connectSpotify(value, account('spotify'), device, { ...options, state: observed }); value.spotifyPlayer.connectionGeneration = own.generation; model.touchRoom(value, options); return model.roomSnapshot(value, options); }));
            }
          } else if (action === 'player/devices' && method === 'GET') { requireHost(room, member); response = json({ devices: await call('spotify', 'playerDevices') }); }
          else if (action.startsWith('player/apple/') && method === 'POST') {
            requireHost(room, member); const input = await body(request);
            response = json(await roomUpdate(code, (value, own) => { requireHost(value, own); if (action.endsWith('/command')) { if (input.action !== 'pause') requireStableHost(value); requireAutomaticStart(value, own, input); } const result = action.endsWith('/command') ? applePlayer.beginApple(value, account('apple'), input, options) : action.endsWith('/state') ? applePlayer.reportApple(value, account('apple'), input, options) : applePlayer.disconnectApple(value, account('apple'), input, options); if (action.endsWith('/state')) confirmHandoffPause(value, input.generation, input.commandId); return { ...result, room: model.roomSnapshot(value, options) }; }));
          } else if (action === 'playback' && method === 'POST') {
            requireHost(room, member); const input = await body(request), player = room.spotifyPlayer;
            if (!player || player.sessionId !== session.id || player.connectionGeneration !== connection('spotify').generation) throw fail(409, 'player_disconnected', 'Reconnect the Spotify host player.');
            if (input.automatic) {
              const observed = await call('spotify', 'playerState');
              await roomUpdate(code, (value, own) => { requireHost(value, own); const active = value.spotifyPlayer; if (!active || active.generation !== player.generation || active.connectionGeneration !== connection('spotify').generation) throw fail(409, 'player_disconnected', 'The host player changed.');
                if (observed.playing || observed.device?.id !== active.deviceId || observed.track?.providerId !== active.lastState?.track?.providerId && observed.track?.providerId !== active.expectedId) { value.playback.autoStartArmed = false; value.playback.status = 'changed'; value.playback.playing = observed.playing; value.playback.currentTrack = observed.track; model.touchRoom(value, options); }
              });
            }
            const result = await roomUpdate(code, (value, own) => { requireHost(value, own); if (value.spotifyPlayer?.connectionGeneration !== connection('spotify').generation) throw fail(409, 'player_disconnected', 'Reconnect your Spotify host player.'); if (input.action !== 'pause') requireStableHost(value); requireAutomaticStart(value, own, input); const result = spotifyPlayer.beginSpotify(value, account('spotify'), input, options); model.touchRoom(value, options); return result; });
            if (result.operation) await spotifyWork(code, result.operation, result.operation.generation);
            response = json(model.roomSnapshot((await store.room(code)).state, options));
          } else throw fail(405, 'unsupported_action', 'This action is not supported in the cloud version.');
        }
      } else throw fail(404, 'not_found', 'This page was not found.');
      if (session) response.headers.set('Set-Cookie', store.cookie(session));
      return response;
    } catch (error) {
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
      return json({ error: known ? error.message : 'Jamama could not finish this request. Please try again.', code: known ? error.code || 'request_failed' : 'server_error' }, known ? error.status : 500);
    }
  };
}
const handle = createCloudApp();
export default { fetch: (request, env, context) => handle(request, env, context), async scheduled(event, env, context) { const now = Date.now(); await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now), env.DB.prepare('DELETE FROM rooms WHERE expires_at < ?').bind(now), env.DB.prepare('DELETE FROM limits WHERE expires_at < ?').bind(now)]); } };
