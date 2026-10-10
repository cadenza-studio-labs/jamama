import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createCloudApp } from '../worker/index.js';
import { Store } from '../worker/store.mjs';

const origin = 'https://jamama.test';
const appleSong = (id = '123') => ({ id, type: 'songs', attributes: { name: 'Shared recording', artistName: 'Artist', albumName: 'Album', durationInMillis: 180000, isrc: 'USAAA1234567', artwork: { url: 'https://example.com/{w}x{h}.png' } } });
const spotifySong = { type: 'track', id: 'abcdefghijklmnopqrstuv', name: 'Shared recording', artists: [{ name: 'Artist' }], album: { name: 'Album', images: [] }, duration_ms: 180000, external_ids: { isrc: 'USAAA1234567' } };
async function fixture(t, hooks = {}) {
  const runtime = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'cloud-test' } });
  t.after(() => runtime.dispose()); const DB = await runtime.getD1Database('DB');
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter((file) => file.endsWith('.sql'))) for (const statement of (await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await DB.exec(statement.trim().replaceAll('\n', ' '));
  const calls = [];
  const handle = createCloudApp({ fetchImpl: async (input, options = {}) => {
    const url = new URL(input); calls.push({ path: url.pathname, token: options.headers?.['Music-User-Token'], method: options.method || 'GET' });
    const override = await hooks.fetch?.(url, options); if (override !== undefined) return override;
    if (url.hostname === 'accounts.spotify.com') return new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: 'playlist-read-private playlist-read-collaborative user-library-read' }));
    if (url.pathname === '/v1/me/storefront') return new Response(JSON.stringify({ data: [{ id: 'us' }] }));
    if (url.pathname === '/v1/me/library/playlists') return new Response(JSON.stringify({ data: [{ id: 'p1', type: 'library-playlists', attributes: { name: 'My Favorites' } }] }));
    if (url.pathname === '/v1/me/library/playlists/p1/tracks' || url.pathname === '/v1/me/recent/played/tracks') return new Response(JSON.stringify({ data: [appleSong()] }));
    if (url.pathname === '/v1/catalog/us/songs') return new Response(JSON.stringify({ data: [appleSong()] }));
    if (url.pathname === '/v1/catalog/us/search') return new Response(JSON.stringify({ results: { songs: { data: [appleSong()] } } }));
    if (url.pathname === '/v1/me/tracks') return new Response(JSON.stringify({ items: [{ track: spotifySong }], total: 1, next: null }));
    if (url.pathname === '/v1/me/playlists') return new Response(JSON.stringify({ items: [], total: 0, next: null }));
    if (url.pathname === '/v1/search') return new Response(JSON.stringify({ tracks: { items: [spotifySong], total: 1, next: null } }));
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  } });
  const env = { DB, PUBLIC_URL: origin, SESSION_ENCRYPTION_KEY: '1'.repeat(64), SPOTIFY_CLIENT_ID: 'test-client', APPLE_MUSIC_DEVELOPER_TOKEN: 'test-developer' };
  let clientCounter = 0;
  async function client() {
    const client = { cookie: '', csrf: '', ip: `192.0.2.${++clientCounter}` };
    client.request = async (path, method = 'GET', input, token, extras = {}) => {
      const headers = { Cookie: client.cookie, 'CF-Connecting-IP': client.ip, ...extras };
      if (method !== 'GET') Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': client.csrf });
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await handle(new Request(origin + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) }), env);
      const cookie = response.headers.get('Set-Cookie'); if (cookie) client.cookie = cookie.split(';')[0];
      return response;
    };
    const response = await client.request('/api/connections'); client.csrf = (await response.json()).csrfToken;
    return client;
  }
  return { handle, env, DB, calls, client };
}
function gate() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function connectApple(client) { const response = await client.request('/api/connections/apple/connect', 'POST', { musicUserToken: 'private-apple-token' }); assert.equal(response.status, 200); }
async function connectSpotify(client) {
  const start = await client.request('/auth/spotify/start'); assert.equal(start.status, 302);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const callback = await client.request('/auth/spotify/callback?state=' + state + '&code=test-code'); assert.equal(callback.status, 302);
}

test('cloud pages and authenticated sessions expose no account secrets and enforce origins', async (t) => {
  const f = await fixture(t), c = await f.client();
  const home = await c.request('/'); assert.equal(home.status, 200); assert.match(await home.text(), /href="\/recall"/); assert.match(home.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await c.request('/api/library/spotify/tracks')).status, 401);
  const bad = await f.handle(new Request(origin + '/api/rooms', { method: 'POST', headers: { Cookie: c.cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf }, body: '{}' }), f.env); assert.equal(bad.status, 403);
  const csrf = await f.handle(new Request(origin + '/api/rooms', { method: 'POST', headers: { Cookie: c.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }), f.env); assert.equal(csrf.status, 403);
  await connectApple(c); const text = await (await c.request('/api/connections')).text(); assert.doesNotMatch(text, /private-apple-token/);
  const stored = await f.DB.prepare('SELECT payload FROM sessions').all(); assert.doesNotMatch(JSON.stringify(stored), /private-apple-token|csrfToken/);
  const status = await c.request('/api/connections'); assert.match(status.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
});

test('OAuth verifies browser state and account libraries remain private across sessions', async (t) => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  assert.equal((await b.request('/auth/spotify/callback?state=wrong&code=x')).status, 400);
  await connectSpotify(a); assert.equal((await a.request('/api/library/spotify/tracks')).status, 200); assert.equal((await b.request('/api/library/spotify/tracks')).status, 401);
  assert.doesNotMatch(await (await a.request('/api/connections')).text(), /test-access|test-refresh/);
});

test('durable Jam handles concurrent requests, safe invitations, permissions and cross-service matching', async (t) => {
  const f = await fixture(t), host = await f.client(), guest = await f.client(); await connectApple(host); await connectSpotify(guest);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json();
  const room = started.room, code = room.code, inviteToken = new URL(room.inviteUrl).searchParams.get('invite');
  assert.equal((await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Guest', provider: 'spotify' })).status, 403);
  const joined = await (await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Guest', provider: 'spotify', inviteToken })).json();
  await guest.request('/api/library/spotify/tracks');
  const additions = await Promise.all(['one', 'two'].map((requestId) => guest.request(`/api/rooms/${code}/queue`, 'POST', { trackId: 'spotify:abcdefghijklmnopqrstuv', provider: 'spotify', requestId }, joined.token)));
  assert.ok(additions.every((response) => response.status === 201));
  const saved = await (await host.request(`/api/rooms/${code}`, 'GET', undefined, started.token)).json(); assert.equal(saved.queue.length, 2);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(joined.token));
  const repeated = await (await guest.request(`/api/rooms/${code}/queue`, 'POST', { trackId: 'spotify:abcdefghijklmnopqrstuv', provider: 'spotify', requestId: 'one' }, joined.token)).json(); assert.equal(repeated.room.queue.length, 2);
  assert.equal((await guest.request(`/api/rooms/${code}/access`, 'POST', { locked: true }, joined.token)).status, 403);
  const matched = await (await host.request(`/api/rooms/${code}/queue/match/search`, 'POST', { entryId: saved.queue[0].id }, started.token)).json(); assert.equal(matched.queue[0].hostMatch.status, 'matched');
  const replacement = createCloudApp();
  const cold = await replacement(new Request(origin + `/api/rooms/${code}`, { headers: { Cookie: host.cookie, Authorization: 'Bearer ' + started.token } }), f.env); assert.equal((await cold.json()).queue.length, 2);
});

test('cloud taste compares real service responses and withdrawing removes the overlap', async (t) => {
  const f = await fixture(t), host = await f.client(), guest = await f.client(); await connectApple(host); await connectSpotify(guest);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = started.room.code;
  const joined = await (await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Guest', provider: 'spotify', inviteToken: new URL(started.room.inviteUrl).searchParams.get('invite') })).json();
  assert.equal((await host.request(`/api/rooms/${code}/taste`, 'POST', { provider: 'apple', playlistId: 'p1' }, started.token)).status, 200);
  const sharedResponse = await guest.request(`/api/rooms/${code}/taste`, 'POST', { provider: 'spotify' }, joined.token); assert.equal(sharedResponse.status, 200); const shared = await sharedResponse.json();
  assert.equal(shared.taste.pairs[0].shared, 1); assert.equal(shared.taste.songs.length, 1);
  const withdrawn = await (await guest.request(`/api/rooms/${code}/taste`, 'DELETE', {}, joined.token)).json(); assert.equal(withdrawn.taste.songs.length, 0);
});

test('Apple queue acknowledges full playback before consuming a request and rejects guests', async (t) => {
  const f = await fixture(t), host = await f.client(); await connectApple(host);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = started.room.code;
  await host.request('/api/library/apple/search?q=known');
  const added = await (await host.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'apple', trackId: 'apple:123', requestId: 'first' }, started.token)).json();
  await host.request(`/api/rooms/${code}/queue/match/search`, 'POST', { entryId: added.entryId }, started.token);
  const connectedResponse = await host.request(`/api/rooms/${code}/player/connect`, 'POST', { mode: 'apple-web' }, started.token); assert.equal(connectedResponse.status, 200); const connected = await connectedResponse.json();
  const startResponse = await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { generation: connected.player.generation, action: 'play' }, started.token); assert.equal(startResponse.status, 200); const command = (await startResponse.json()).command;
  const playingResponse = await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation: connected.player.generation, commandId: command.id, trackId: '123', playing: true, fullPlayback: true, position: 1000, duration: 180000 }, started.token); assert.equal(playingResponse.status, 200); const playing = await playingResponse.json();
  assert.equal(playing.room.queue.length, 0); assert.equal(playing.room.nowPlaying.hostTrack.providerId, '123');
});

test('simultaneous library reads merge metadata without replacing account permissions', async (t) => {
  const f = await fixture(t), c = await f.client(); await connectSpotify(c);
  const results = await Promise.all([c.request('/api/library/spotify/tracks'), c.request('/api/library/spotify/search?q=shared')]); assert.ok(results.every((response) => response.status === 200));
  const store = new Store(f.env); const session = await store.session(new Request(origin, { headers: { Cookie: c.cookie } })); assert.ok(session.data.tracks['spotify:abcdefghijklmnopqrstuv']); assert.ok(session.data.providers.spotify);
});

test('catalog search accepts the interface term parameter for guests and connected users', async (t) => {
  const f = await fixture(t), c = await f.client();
  const apple = await c.request('/api/library/apple/search?term=Shared%20recording'); assert.equal(apple.status, 200); assert.equal((await apple.json()).items.length, 1);
  await connectSpotify(c); const spotify = await c.request('/api/library/spotify/search?term=Shared%20recording'); assert.equal(spotify.status, 200); assert.equal((await spotify.json()).items.length, 1);
});

test('connection status exposes the OAuth and player links used by the retained Spotify integration', async (t) => {
  const f = await fixture(t), c = await f.client();
  const before = await (await c.request('/api/connections')).json(); assert.equal(before.providers.spotify.connectUrl, '/auth/spotify/start'); assert.equal(before.providers.spotify.player.webAuthorized, false);
  await connectSpotify(c); const store = new Store(f.env), session = await store.session(new Request(origin, { headers: { Cookie: c.cookie } }));
  session.data.providers.spotify.scope += ' user-read-playback-state user-modify-playback-state'; await store.saveSession(session);
  const after = await (await c.request('/api/connections')).json(); assert.equal(after.providers.spotify.player.webAuthorized, true); assert.equal(after.providers.spotify.player.webConnectUrl, '/auth/spotify/start?playback=web');
});

test('unchanged old library tokens cannot replace a refreshed connection', async (t) => {
  const f = await fixture(t), c = await f.client(); await connectSpotify(c);
  const store = new Store(f.env), request = new Request(origin, { headers: { Cookie: c.cookie } });
  const oldRead = await store.session(request), refreshed = await store.session(request), previousProvider = { ...refreshed.data.providers.spotify };
  const next = { ...previousProvider, accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: previousProvider.expiresAt + 1000 };
  await store.mergeLibrary(refreshed, 'spotify', next, [], { previousProvider });
  await store.mergeLibrary(oldRead, 'spotify', oldRead.data.providers.spotify, []);
  const saved = await store.session(request); assert.equal(saved.data.providers.spotify.accessToken, 'fresh-access'); assert.equal(saved.data.providers.spotify.refreshToken, 'fresh-refresh');
});

test('a disconnected account cannot commit a pending taste publication', async (t) => {
  const f = await fixture(t), c = await f.client(); await connectApple(c);
  const created = await (await c.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json();
  const store = new Store(f.env), request = new Request(origin, { headers: { Cookie: c.cookie } }), session = await store.session(request), entered = gate(), release = gate();
  const update = store.mutateRoom(created.room.code, async (room) => { entered.resolve(); await release.promise; room.taste = { unpublished: true }; }, { connection: { sessionId: session.id, provider: 'apple', generation: session.data.providers.apple.generation } });
  const rejected = assert.rejects(update, { code: 'connection_changed' });
  await entered.promise; await store.dropProvider(await store.session(request), 'apple'); release.resolve(); await rejected;
  assert.equal((await store.room(created.room.code)).state.taste, null);
});

test('refreshing the same Apple authorization keeps an existing player connection valid', async (t) => {
  const f = await fixture(t), c = await f.client(); await connectApple(c);
  const store = new Store(f.env), request = new Request(origin, { headers: { Cookie: c.cookie } }); const before = (await store.session(request)).data.providers.apple.generation;
  await connectApple(c); const after = (await store.session(request)).data.providers.apple.generation; assert.equal(after, before);
});

test('a delayed version search cannot overwrite the host’s chosen recording', async (t) => {
  let blocked = false; const entered = gate(), release = gate();
  const f = await fixture(t, { fetch: async (url) => { if (url.pathname !== '/v1/catalog/us/songs') return; if (blocked) { entered.resolve(); await release.promise; } return new Response(JSON.stringify({ data: [appleSong('123'), { ...appleSong('456'), attributes: { ...appleSong('456').attributes, name: 'Shared recording (Live)' } }] })); } });
  const host = await f.client(), guest = await f.client(); await connectApple(host); await connectSpotify(guest);
  const created = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = created.room.code;
  const joined = await (await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Guest', provider: 'spotify', inviteToken: new URL(created.room.inviteUrl).searchParams.get('invite') })).json(); await guest.request('/api/library/spotify/tracks');
  const added = await (await guest.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'spotify', trackId: 'spotify:abcdefghijklmnopqrstuv', requestId: 'request' }, joined.token)).json();
  const first = await host.request(`/api/rooms/${code}/queue/match/search`, 'POST', { entryId: added.entryId }, created.token); assert.equal((await first.json()).queue[0].hostMatch.status, 'choice_required');
  blocked = true; const pending = host.request(`/api/rooms/${code}/queue/match/search`, 'POST', { entryId: added.entryId }, created.token); await entered.promise;
  const selected = await host.request(`/api/rooms/${code}/queue/match/select`, 'POST', { entryId: added.entryId, trackId: 'apple:456' }, created.token); assert.equal(selected.status, 200); release.resolve();
  assert.equal((await pending).status, 409);
  const final = await (await host.request(`/api/rooms/${code}`, 'GET', undefined, created.token)).json(); assert.equal(final.queue[0].hostMatch.track.id, 'apple:456'); assert.equal(final.queue[0].hostMatch.status, 'matched');
});

test('same-service requests arrive matched without a search or a host confirmation click', async (t) => {
  const f = await fixture(t), host = await f.client(), guest = await f.client(); await connectSpotify(host); await connectSpotify(guest);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'spotify' })).json(), code = started.room.code;
  const joined = await (await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Friend', provider: 'spotify', inviteToken: new URL(started.room.inviteUrl).searchParams.get('invite') })).json();
  await guest.request('/api/library/spotify/tracks'); const before = f.calls.length;
  const added = await (await guest.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'spotify', trackId: 'spotify:abcdefghijklmnopqrstuv', requestId: 'direct' }, joined.token)).json();
  assert.equal(added.room.queue[0].hostMatch.status, 'matched'); assert.equal(added.room.queue[0].hostMatch.track.providerId, spotifySong.id); assert.equal(f.calls.length, before);
});

test('equivalent albums sharing the same recording match automatically across services', async (t) => {
  const f = await fixture(t, { fetch: async (url) => { if (url.pathname === '/v1/catalog/us/songs') return new Response(JSON.stringify({ data: [appleSong('123'), { ...appleSong('456'), attributes: { ...appleSong('456').attributes, albumName: 'Compilation' } }] })); } });
  const host = await f.client(), guest = await f.client(); await connectApple(host); await connectSpotify(guest);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = started.room.code;
  const joined = await (await guest.request(`/api/rooms/${code}/join`, 'POST', { name: 'Friend', provider: 'spotify', inviteToken: new URL(started.room.inviteUrl).searchParams.get('invite') })).json(); await guest.request('/api/library/spotify/tracks');
  const added = await (await guest.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'spotify', trackId: 'spotify:abcdefghijklmnopqrstuv', requestId: 'cross' }, joined.token)).json();
  const matched = await (await host.request(`/api/rooms/${code}/queue/match/search`, 'POST', { entryId: added.entryId }, started.token)).json();
  assert.equal(matched.queue[0].hostMatch.status, 'matched'); assert.equal(matched.queue[0].hostMatch.track.id, 'apple:123');
});

test('automatic Apple playback survives an idle heartbeat, preserves requests and respects manual pause', async (t) => {
  const f = await fixture(t), host = await f.client(); await connectApple(host);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = started.room.code;
  const player = await (await host.request(`/api/rooms/${code}/player/connect`, 'POST', {}, started.token)).json(), generation = player.player.generation;
  const idle = await (await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation, playing: false, position: 0, duration: 0 }, started.token)).json(); assert.equal(idle.room.playback.status, 'paused'); assert.equal(idle.room.playback.autoStartArmed, true);
  await host.request('/api/library/apple/search?term=known');
  const added = await (await host.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'apple', trackId: 'apple:123', requestId: 'first-auto' }, started.token)).json();
  const request = { generation, action: 'next', automatic: true, entryId: added.entryId };
  const wrong = await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { ...request, entryId: 'outdated-head' }, started.token); assert.equal(wrong.status, 409);
  const start = await (await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', request, started.token)).json(); assert.equal(start.room.queue.length, 1);
  const playing = await (await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation, commandId: start.command.id, trackId: '123', playing: true, fullPlayback: true, position: 1000, duration: 180000 }, started.token)).json(); assert.equal(playing.room.queue.length, 0);
  const paused = await (await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { generation, action: 'pause' }, started.token)).json();
  await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation, commandId: paused.command.id, trackId: '123', playing: false, position: 1000, duration: 180000 }, started.token);
  const second = await (await host.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'apple', trackId: 'apple:123', requestId: 'second-auto' }, started.token)).json();
  const rejected = await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { ...request, entryId: second.entryId }, started.token); assert.equal(rejected.status, 409); assert.equal(second.room.playback.autoStartArmed, false); assert.equal(second.room.queue.length, 1);
});

test('cloud host handoff waits for Apple pause, preserves the queue and revokes old host controls', async (t) => {
  const f = await fixture(t), host = await f.client(), friend = await f.client(), other = await f.client(); await connectApple(host); await connectSpotify(friend);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'apple' })).json(), code = started.room.code;
  const input = { provider: 'spotify', inviteToken: new URL(started.room.inviteUrl).searchParams.get('invite') };
  const joined = await (await friend.request(`/api/rooms/${code}/join`, 'POST', { ...input, name: 'Friend' })).json();
  const outsider = await (await other.request(`/api/rooms/${code}/join`, 'POST', { ...input, name: 'Other' })).json();
  await host.request('/api/library/apple/search?term=known');
  const added = await (await host.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'apple', trackId: 'apple:123', requestId: 'handoff-song' }, started.token)).json();
  const player = await (await host.request(`/api/rooms/${code}/player/connect`, 'POST', {}, started.token)).json(), generation = player.player.generation;
  const play = await (await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { generation, action: 'next' }, started.token)).json();
  await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation, commandId: play.command.id, trackId: '123', playing: true, fullPlayback: true, position: 5000, duration: 180000 }, started.token);
  const offeredResponse = await host.request(`/api/rooms/${code}/host/offer`, 'POST', { memberId: joined.memberId, generation }, started.token); assert.equal(offeredResponse.status, 200);
  const offered = await offeredResponse.json(), transferId = offered.room.hostTransfer.id; assert.equal(offered.command.action, 'pause'); assert.equal(offered.room.hostTransfer.phase, 'pausing');
  assert.equal((await friend.request(`/api/rooms/${code}/host/accept`, 'POST', { transferId, provider: 'spotify' }, joined.token)).status, 409);
  assert.equal((await other.request(`/api/rooms/${code}/host/cancel`, 'POST', { transferId }, outsider.token)).status, 403);
  await host.request(`/api/rooms/${code}/player/apple/state`, 'POST', { generation, commandId: offered.command.id, trackId: '123', playing: false, position: 5000, duration: 180000 }, started.token);
  const acceptedResponse = await friend.request(`/api/rooms/${code}/host/accept`, 'POST', { transferId, provider: 'spotify' }, joined.token); assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json(); assert.equal(accepted.hostId, joined.memberId); assert.equal(accepted.hostProvider, 'spotify'); assert.equal(accepted.queue[0].id, added.entryId); assert.equal(accepted.queue[0].hostMatch, undefined); assert.equal(accepted.inviteUrl, started.room.inviteUrl); assert.equal(accepted.members.length, 3); assert.equal(accepted.playback.connected, false); assert.equal(accepted.hostTransfer, null);
  assert.equal((await host.request(`/api/rooms/${code}/player/apple/command`, 'POST', { generation, action: 'play' }, started.token)).status, 403);
});

test('Spotify auto-start sends one confirmed play and host handoff sends only one confirmed pause', async (t) => {
  let current = null, playing = false, failPause = false; const commands = [];
  const f = await fixture(t, { fetch: async (url, options) => {
    if (url.pathname === '/v1/me/player/devices') return new Response(JSON.stringify({ devices: [{ id: 'test-device', name: 'Test output', is_active: true, is_restricted: false }] }));
    if (url.pathname === '/v1/me/player/play' || url.pathname === '/v1/me/player/pause') { commands.push(url.pathname); if (failPause && url.pathname.endsWith('/pause')) return new Response(JSON.stringify({ error: { message: 'Temporary service failure' } }), { status: 500 }); playing = url.pathname.endsWith('/play'); if (options.body) current = JSON.parse(options.body).uris?.[0]?.split(':').pop() || current; return new Response(null, { status: 204 }); }
    if (url.pathname === '/v1/me/player') return new Response(JSON.stringify({ device: { id: 'test-device', name: 'Test output', is_restricted: false }, is_playing: playing, progress_ms: 1000, currently_playing_type: current ? 'track' : null, item: current ? spotifySong : null }));
  } });
  const host = await f.client(), friend = await f.client(); await connectSpotify(host); await connectApple(friend);
  const store = new Store(f.env), hostSession = await store.session(new Request(origin, { headers: { Cookie: host.cookie } })); hostSession.data.providers.spotify.scope += ' user-read-playback-state user-modify-playback-state'; await store.saveSession(hostSession);
  const started = await (await host.request('/api/rooms', 'POST', { name: 'Host', provider: 'spotify' })).json(), code = started.room.code;
  const joined = await (await friend.request(`/api/rooms/${code}/join`, 'POST', { name: 'Friend', provider: 'apple', inviteToken: new URL(started.room.inviteUrl).searchParams.get('invite') })).json();
  await host.request('/api/library/spotify/tracks');
  const added = await (await host.request(`/api/rooms/${code}/queue`, 'POST', { provider: 'spotify', trackId: 'spotify:abcdefghijklmnopqrstuv', requestId: 'spotify-auto' }, started.token)).json();
  const connectedResponse = await host.request(`/api/rooms/${code}/player/connect`, 'POST', { deviceId: 'test-device' }, started.token); assert.equal(connectedResponse.status, 200); const connectedRoom = await connectedResponse.json();
  const automatic = { action: 'next', automatic: true, entryId: added.entryId, generation: connectedRoom.playback.connectionId };
  const playResponse = await host.request(`/api/rooms/${code}/playback`, 'POST', automatic, started.token); assert.equal(playResponse.status, 200); const result = await playResponse.json(); assert.equal(result.queue.length, 0); assert.equal(result.playback.playing, true);
  assert.equal((await host.request(`/api/rooms/${code}/playback`, 'POST', automatic, started.token)).status, 409); assert.equal(commands.length, 1);
  failPause = true; const failedOffer = await host.request(`/api/rooms/${code}/host/offer`, 'POST', { memberId: joined.memberId }, started.token); assert.equal(failedOffer.status, 502); const failedRoom = await (await host.request(`/api/rooms/${code}`, 'GET', undefined, started.token)).json(); assert.equal(failedRoom.hostTransfer, null); assert.equal(playing, true); failPause = false; commands.pop();
  const offeredResponse = await host.request(`/api/rooms/${code}/host/offer`, 'POST', { memberId: joined.memberId }, started.token); assert.equal(offeredResponse.status, 200); const offered = await offeredResponse.json(); assert.equal(offered.room.hostTransfer.phase, 'ready'); assert.equal(commands.length, 2); assert.match(commands[1], /pause$/);
  const accepted = await friend.request(`/api/rooms/${code}/host/accept`, 'POST', { transferId: offered.room.hostTransfer.id, provider: 'apple' }, joined.token); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).hostId, joined.memberId); assert.equal(commands.length, 2);
});
