import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { clueLengths, createRecallGame, listeningPool, playlistPool } from '../public/recall-game.js';
import { readRecallCollection } from '../public/recall-library.js';

const source = (await readFile(new URL('../public/recall.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const qqTrack = (index = 1, extra = {}) => ({ id: `qq:${index}`, provider: 'qq', title: `Song ${index}`, artist: 'Artist', album: 'Album', durationMs: 180000, isrc: null, ...extra });
const appleTrack = (index = 1) => ({ id: `apple:${index}`, provider: 'apple', providerId: String(index), catalogId: String(index), title: `Song ${index}`, artist: 'Artist', album: 'Album', durationMs: 180000 });
const qqExport = (tracks = [qqTrack()], extra = {}) => ({ format: 'jamama-qq-playlists', version: 1, playlists: [{ id: 'qq-list-1', name: 'Favorites', tracks }], ...extra });
const localFile = (value, extra = {}) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return { name: 'qq-playlists.json', size: Buffer.byteLength(text), text: async () => text, ...extra }; };

async function interfaceFixture({ connected = true, resolveBatch } = {}) {
  const elements = new Map(), requests = [], resolverCalls = [], music = { musicUserToken: 'new-apple-token' };
  let authorizations = 0, stops = 0;
  const connections = { csrfToken: 'test-csrf', providers: { apple: { configured: true, connected } } };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: '', files: [], textContent: '', innerHTML: '', classList: { toggle() {} }, setAttribute() {}, querySelector: () => element(`${id}-span`), focus() {} });
    return elements.get(id);
  };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const context = vm.createContext({ clueLengths, createRecallGame, listeningPool, playlistPool, readRecallCollection,
    createAppleAuthorization: () => ({ ready: true, prepare: async () => {}, authorize: async () => { authorizations++; return music.musicUserToken; }, getInstance: () => music, cancel() {} }),
    createRecallPlayer: ({ onState }) => ({ stop: async () => { stops++; onState({ playing: false, busy: false, heard: false }); }, pause: async () => onState({ playing: false, busy: false, heard: false }), play: async () => {} }),
    document: { getElementById: element, querySelector: () => element('document-query'), addEventListener() {} },
    window: { MusicKit: { configure() {}, getInstance: () => music }, addEventListener() {} },
    location: { hostname: '127.0.0.1', port: '4182' }, URL, setTimeout, clearTimeout,
    fetch: async (path, options = {}) => {
      const request = { path, ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) };
      requests.push(request);
      if (path === '/api/recall/qq/resolve') {
        resolverCalls.push(request);
        const result = resolveBatch ? await resolveBatch(request.body.tracks, resolverCalls.length - 1, request) : { items: request.body.tracks.map((track) => appleTrack(Number(track.id.slice(3)))), skipped: 0, ambiguous: 0, total: request.body.tracks.length };
        return result?.responseStatus ? respond(result.body, result.responseStatus) : respond(result);
      }
      if (path === '/api/connections' || path === '/api/connections/apple/connect') return respond(connections);
      if (path.startsWith('/api/library/apple/playlists')) return respond({ items: path.includes('/tracks') ? [appleTrack(999)] : [{ id: 'apple-list', name: 'Apple favorites' }], nextOffset: null });
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  vm.runInContext(source + '\nglobalThis.fixture = {state, game, render, loadHistory, importQQFile, parseQQExport};', context);
  await settle();
  return { ...context.fixture, element, requests, resolverCalls, music, authorizations: () => authorizations, stops: () => stops };
}

function selectQQ(f, id = f.state.qqPlaylists[0]?.id || '') {
  f.state.source = 'qq'; f.state.qqPlaylistId = id;
  f.element('song-source').value = 'qq'; f.element('qq-playlist-choice').value = id; f.render();
}

function existingGame(f) {
  const songs = [appleTrack(999)], poolSource = { kind: 'playlist', id: 'old-list', name: 'Existing game' };
  f.state.songs = songs; f.state.poolSource = poolSource; f.state.playbackToken = 'old-apple-token';
  f.game.load(songs); f.game.next('middle');
  return { songs, poolSource, round: f.game.snapshot().round };
}

test('QQ file import stays local and keeps only playlist song metadata', async () => {
  const f = await interfaceFixture(), before = f.requests.length;
  await f.importQQFile(localFile(qqExport([qqTrack(1, { title: ' Song 1 ', isrc: ' usabc1234567 ', token: 'omit-track-token', cookie: 'omit-track-cookie', externalUrl: 'https://example.com/private' })], { token: 'omit-export-token' })));
  assert.equal(f.requests.length, before); assert.equal(f.authorizations(), 0); assert.equal(f.stops(), 0);
  assert.deepEqual(plain(f.state.qqPlaylists), [{ id: 'qq-list-1', name: 'Favorites', tracks: [{ id: 'qq:1', provider: 'qq', title: 'Song 1', artist: 'Artist', album: 'Album', durationMs: 180000, isrc: 'USABC1234567' }] }]);
  assert.equal(f.state.qqImporting, false); assert.equal(f.state.songs.length, 0); assert.equal(f.game.snapshot().round, null);
});

test('malformed files clear the previous QQ selection without sending requests', async () => {
  const f = await interfaceFixture(); await f.importQQFile(localFile(qqExport()));
  const before = f.requests.length;
  await f.importQQFile(localFile('{broken JSON'));
  assert.equal(f.requests.length, before); assert.equal(f.state.qqPlaylists.length, 0); assert.equal(f.state.qqPlaylistId, '');
  assert.equal(f.state.qqImporting, false); assert.equal(f.element('error').hidden, false);
});

test('files larger than 2 MiB are rejected before reading their contents', async () => {
  const f = await interfaceFixture(), before = f.requests.length; let reads = 0;
  await f.importQQFile(localFile(qqExport(), { size: 2 * 1024 * 1024 + 1, text: async () => { reads++; return JSON.stringify(qqExport()); } }));
  assert.equal(reads, 0); assert.equal(f.requests.length, before); assert.equal(f.state.qqPlaylists.length, 0);
  assert.equal(f.element('error').hidden, false); assert.equal(f.state.qqImporting, false);
});

test('QQ export parser rejects unsupported formats, excessive lists, and excessive songs', async () => {
  const f = await interfaceFixture();
  const invalid = [
    qqExport([], { format: 'other-format' }), qqExport([], { version: 2 }),
    qqExport([], { playlists: Array.from({ length: 201 }, (_, index) => ({ id: String(index), name: 'List', tracks: [] })) }),
    qqExport(Array.from({ length: 10001 }, (_, index) => qqTrack(index + 1))),
    qqExport([], { playlists: null }),
  ];
  for (const value of invalid) assert.throws(() => f.parseQQExport(JSON.stringify(value)));
});

test('QQ parser accepts the playlist and song count limits without dropping songs', async () => {
  const f = await interfaceFixture();
  const playlists = Array.from({ length: 200 }, (_, index) => ({ id: `list-${index}`, name: 'List', tracks: Array.from({ length: 50 }, (_, song) => qqTrack(index * 50 + song + 1)) }));
  const parsed = f.parseQQExport(JSON.stringify(qqExport([], { playlists })));
  assert.equal(parsed.length, 200); assert.equal(parsed.reduce((total, list) => total + list.tracks.length, 0), 10000);
});

test('QQ parser rejects invalid provider IDs and invalid matching metadata', async () => {
  const f = await interfaceFixture();
  const invalid = [
    { id: 'qq:0' }, { id: 'qq:1 OR 1=1' }, { id: `qq:${'1'.repeat(33)}` }, { provider: 'apple' },
    { title: '' }, { title: 'a'.repeat(201) }, { artist: 'a'.repeat(201) }, { album: 'a'.repeat(201) },
    { durationMs: -1 }, { durationMs: '180000' }, { isrc: 'not-an-isrc' },
  ];
  for (const extra of invalid) assert.throws(() => f.parseQQExport(JSON.stringify(qqExport([qqTrack(1, extra)]))));
  for (const extra of [{ id: 'a'.repeat(129) }, { name: 'a'.repeat(201) }]) {
    assert.throws(() => f.parseQQExport(JSON.stringify(qqExport([], { playlists: [{ id: 'list', name: 'List', tracks: [], ...extra }] }))));
  }
  const parsed = f.parseQQExport(JSON.stringify(qqExport([{ id: 'qq:1', provider: 'qq', title: 'Song', artist: 'Artist' }])));
  assert.deepEqual(plain(parsed[0].tracks[0]), { id: 'qq:1', provider: 'qq', title: 'Song', artist: 'Artist', album: '', durationMs: null, isrc: null });
});

test('empty or missing QQ playlists cannot start a quiz', async () => {
  const f = await interfaceFixture(); await f.importQQFile(localFile(qqExport([]))); selectQQ(f);
  assert.equal(f.element('load-history').disabled, true); assert.equal(f.element('switch-pool').disabled, true);
  const before = f.requests.length; await f.loadHistory(); assert.equal(f.requests.length, before); assert.equal(f.authorizations(), 0);
  await f.importQQFile(localFile(qqExport())); selectQQ(f, 'missing-list');
  assert.equal(f.element('load-history').disabled, true); await f.loadHistory();
  assert.equal(f.requests.length, before); assert.equal(f.authorizations(), 0);
});

test('QQ quizzes require prepared playback and a connected Apple Music account', async () => {
  const f = await interfaceFixture({ connected: false }); await f.importQQFile(localFile(qqExport())); selectQQ(f);
  assert.equal(f.element('load-history').disabled, true);
  const before = f.requests.length; await f.loadHistory(); assert.equal(f.requests.length, before); assert.equal(f.authorizations(), 0);
  f.state.connections.providers.apple.connected = true; f.state.prepared = false; f.render();
  assert.equal(f.element('load-history').disabled, true);
});

test('Start matches only the first 100 selected songs in batches of 20', async () => {
  const f = await interfaceFixture();
  const tracks = Array.from({ length: 105 }, (_, index) => qqTrack(index + 1, { secret: 'omit-secret', cookie: 'omit-cookie', artist: ' Artist ' }));
  await f.importQQFile(localFile(qqExport(tracks, { playlists: [{ id: 'qq-list-1', name: 'Favorites', tracks }, { id: 'unselected-list', name: 'Other', tracks: [qqTrack(1000)] }] }))); selectQQ(f);
  await f.loadHistory();
  assert.equal(f.authorizations(), 1); assert.equal(f.resolverCalls.length, 5);
  assert.deepEqual(f.resolverCalls.map((call) => call.body.tracks.length), [20, 20, 20, 20, 20]);
  const sent = f.resolverCalls.flatMap((call) => call.body.tracks);
  assert.deepEqual(sent.map((track) => track.id), Array.from({ length: 100 }, (_, index) => `qq:${index + 1}`));
  for (const call of f.resolverCalls) {
    assert.equal(call.method, 'POST'); assert.deepEqual(Object.keys(call.body), ['tracks']); assert.equal(call.headers['X-CSRF-Token'], 'test-csrf');
  }
  for (const track of sent) {
    assert.deepEqual(Object.keys(track).sort(), ['album', 'artist', 'durationMs', 'id', 'isrc', 'provider', 'title']);
    assert.equal(track.artist, 'Artist');
  }
  assert.equal(f.state.songs.length, 100); assert.equal(f.game.snapshot().poolSize, 100);
  assert.equal(f.state.poolSource.kind, 'qq'); assert.equal(f.state.poolSource.id, 'qq-list-1'); assert.equal(f.state.playbackToken, 'new-apple-token');
  assert.equal(f.state.loading, false); assert.equal(f.state.matchingProgress, null);
});

test('matching progress advances per batch and commits the new game only after all batches', async () => {
  const first = deferred(), second = deferred();
  const f = await interfaceFixture({ resolveBatch: async (tracks, index) => { await (index === 0 ? first.promise : second.promise); return { items: tracks.map((track) => appleTrack(Number(track.id.slice(3)))), skipped: 0, ambiguous: 0, total: tracks.length }; } });
  const old = existingGame(f); await f.importQQFile(localFile(qqExport(Array.from({ length: 21 }, (_, index) => qqTrack(index + 1))))); selectQQ(f);
  const loading = f.loadHistory(); await settle();
  assert.deepEqual(plain(f.state.matchingProgress), { done: 0, total: 21 }); assert.equal(f.resolverCalls.length, 1);
  assert.equal(f.state.songs, old.songs); assert.equal(f.state.playbackToken, 'old-apple-token'); assert.equal(f.game.snapshot().round, old.round);
  first.resolve(); await settle();
  assert.deepEqual(plain(f.state.matchingProgress), { done: 20, total: 21 }); assert.equal(f.resolverCalls.length, 2);
  assert.equal(f.state.songs, old.songs); assert.equal(f.state.poolSource, old.poolSource); assert.equal(f.state.playbackToken, 'old-apple-token');
  second.resolve(); await loading;
  assert.equal(f.state.songs.length, 21); assert.notEqual(f.game.snapshot().round, old.round); assert.equal(f.state.playbackToken, 'new-apple-token');
  assert.equal(f.state.matchingProgress, null); assert.equal(f.state.loading, false);
});

test('a failed later matching batch preserves the previous pool and playback token', async () => {
  const f = await interfaceFixture({ resolveBatch: async (tracks, index) => index === 1 ? { responseStatus: 503, body: { error: 'Matching temporarily failed.' } } : { items: tracks.map((track) => appleTrack(Number(track.id.slice(3)))), skipped: 0, ambiguous: 0, total: tracks.length } });
  const old = existingGame(f); await f.importQQFile(localFile(qqExport(Array.from({ length: 40 }, (_, index) => qqTrack(index + 1))))); selectQQ(f);
  await f.loadHistory();
  assert.equal(f.resolverCalls.length, 2); assert.equal(f.state.songs, old.songs); assert.equal(f.state.poolSource, old.poolSource);
  assert.equal(f.state.playbackToken, 'old-apple-token'); assert.equal(f.game.snapshot().round, old.round);
  assert.equal(f.state.loading, false); assert.equal(f.state.matchingProgress, null); assert.equal(f.element('error').hidden, false);
  assert.match(f.element('error').textContent, /Matching temporarily failed/);
});

test('unmatched QQ songs cannot replace an existing playable game', async () => {
  const f = await interfaceFixture({ resolveBatch: async (tracks) => ({ items: [], skipped: tracks.length, ambiguous: 0, total: tracks.length }) });
  const old = existingGame(f); await f.importQQFile(localFile(qqExport())); selectQQ(f); await f.loadHistory();
  assert.equal(f.state.songs, old.songs); assert.equal(f.state.poolSource, old.poolSource); assert.equal(f.state.playbackToken, 'old-apple-token');
  assert.equal(f.game.snapshot().round, old.round); assert.equal(f.element('error').hidden, false);
});

test('an expired matching attempt stops before another batch and cannot commit', async () => {
  const pending = deferred();
  const f = await interfaceFixture({ resolveBatch: async (tracks) => { await pending.promise; return { items: tracks.map((track) => appleTrack(Number(track.id.slice(3)))), skipped: 0, ambiguous: 0, total: tracks.length }; } });
  const old = existingGame(f); await f.importQQFile(localFile(qqExport(Array.from({ length: 21 }, (_, index) => qqTrack(index + 1))))); selectQQ(f);
  const loading = f.loadHistory(); await settle(); assert.equal(f.resolverCalls.length, 1);
  f.state.version++; pending.resolve(); await loading;
  assert.equal(f.resolverCalls.length, 1); assert.equal(f.state.songs, old.songs); assert.equal(f.state.poolSource, old.poolSource);
  assert.equal(f.state.playbackToken, 'old-apple-token'); assert.equal(f.game.snapshot().round, old.round);
  assert.equal(f.state.loading, false); assert.equal(f.state.matchingProgress, null);
});

test('two rapid Start attempts share one authorization and one matching run', async () => {
  const pending = deferred();
  const f = await interfaceFixture({ resolveBatch: async (tracks) => { await pending.promise; return { items: [appleTrack(1)], skipped: 0, ambiguous: 0, total: tracks.length }; } });
  await f.importQQFile(localFile(qqExport())); selectQQ(f);
  const first = f.loadHistory(); await f.loadHistory(); await settle();
  assert.equal(f.authorizations(), 1); assert.equal(f.resolverCalls.length, 1);
  pending.resolve(); await first; assert.equal(f.state.songs.length, 1);
});

test('QQ playlist labels are escaped before they enter the dropdown', async () => {
  const f = await interfaceFixture();
  await f.importQQFile(localFile(qqExport([], { playlists: [{ id: 'qq-list-1', name: '<img src=x onerror=alert(1)>', tracks: [qqTrack()] }] }))); selectQQ(f);
  assert.doesNotMatch(f.element('qq-playlist-choice').innerHTML, /<img/);
  assert.match(f.element('qq-playlist-choice').innerHTML, /&lt;img/);
});

test('a slow local file read cannot overwrite a newer QQ import', async () => {
  const pending = deferred(), f = await interfaceFixture(), before = f.requests.length;
  const first = f.importQQFile(localFile(qqExport(), { text: () => pending.promise }));
  await settle(); assert.equal(f.state.qqImporting, true);
  const newer = qqExport([], { playlists: [{ id: 'newer-list', name: 'Newer list', tracks: [qqTrack(2)] }] });
  await f.importQQFile(localFile(newer)); const version = f.state.qqImportVersion;
  pending.resolve(JSON.stringify(qqExport())); await first;
  assert.equal(f.state.qqPlaylistId, 'newer-list'); assert.equal(f.state.qqPlaylists[0].tracks[0].id, 'qq:2');
  assert.equal(f.state.qqImportVersion, version); assert.equal(f.state.qqImporting, false); assert.equal(f.requests.length, before);
  assert.match(f.element('qq-playlist-choice').innerHTML, /Newer list/);
});

test('malformed matching responses cannot commit a replacement game or token', async () => {
  const invalid = [{ items: null }, { items: [appleTrack(1), appleTrack(2)] }, { total: 2 }, { skipped: -1 }, { skipped: 0.5 }, { ambiguous: '0' }];
  for (const extra of invalid) {
    const f = await interfaceFixture({ resolveBatch: async () => ({ items: [appleTrack(1)], skipped: 0, ambiguous: 0, total: 1, ...extra }) });
    const old = existingGame(f); await f.importQQFile(localFile(qqExport())); selectQQ(f); await f.loadHistory();
    assert.equal(f.resolverCalls.length, 1); assert.equal(f.state.songs, old.songs); assert.equal(f.state.poolSource, old.poolSource);
    assert.equal(f.state.playbackToken, 'old-apple-token'); assert.equal(f.game.snapshot().round, old.round);
    assert.equal(f.state.loading, false); assert.equal(f.state.matchingProgress, null); assert.equal(f.element('error').hidden, false);
  }
});
