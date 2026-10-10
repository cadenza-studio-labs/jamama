import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assets } from '../worker/assets.mjs';
import { chooseVisibleMusicService, chooseConnectedMusicService, defaultMusicService, visibleMusicServices } from '../public/service-visibility.js';

const text = (path) => Buffer.from(assets[path].data, 'base64').toString();
const source = text('/app.js');
function functions(names, context) {
  vm.createContext(context);
  for (const name of names) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')), rest = source.slice(start + 1), next = rest.search(/^(?:async )?function \w+\(/m);
    assert.notEqual(start, -1); vm.runInContext(source.slice(start, next === -1 ? undefined : start + next + 1), context);
  }
  return context;
}
test('hidden choices stay out of the built interface while service APIs are retained', () => {
  assert.deepEqual(visibleMusicServices, ['apple', 'spotify']); assert.equal(chooseVisibleMusicService('spotify'), 'spotify');
  assert.doesNotMatch(text('/index.html'), /data-(?:filter|search-provider)="(?:qq|youtube|ytmusic)"/);
  assert.match(source, /<option[^>]*value="spotify"/); assert.match(text('/index.html'), /data-filter="spotify"/); assert.match(text('/index.html'), /data-search-provider="spotify"/);
  assert.match(source, /hostProvider === 'apple'/); assert.match(source, /Connect Spotify playback/);
});
test('a retained Spotify login cannot hide guest browsing or reveal the QQ connection', () => {
  const elements = new Map();
  function element(id) { if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '', innerHTML: '', classList: { toggle() {} }, setAttribute() {}, querySelector: (selector) => element(id + selector) }); return elements.get(id); }
  const context = functions(['renderLibrary'], {
    $: element, document: { querySelector: () => element('tools'), querySelectorAll: () => [] }, renderSidebar() {},
    state: { provider: 'apple', view: 'library', collection: 'playlists', playlists: new Map(), albums: new Map(), loading: new Set(), connections: { providers: { spotify: { connected: true }, qq: { capabilities: { localLibrary: true } } } } },
    order: ['apple'], defaultMusicService, connected: (provider) => provider === 'spotify', canSearch: () => true,
    visibleProviders: () => ['apple'], publicQQSearch: () => false, providerName: () => 'Apple Music', collectionLoadingKey: (value) => value,
    icon: () => '', allPlaylists: () => [], escape: (value) => String(value), clearTimeout() {}, searchTimer: null,
  });
  context.renderLibrary();
  assert.equal(element('browse-guest').hidden, false); assert.equal(element('library-grid-view').hidden, true);
  assert.equal(element('tools').hidden, true); assert.doesNotMatch(element('playlist-grid').innerHTML, /Use your QQ|data-connect="qq"/);
});
test('new Jam hosting defaults to a visible service without changing an existing room', () => {
  const nodes = new Map(), element = (id) => { if (!nodes.has(id)) nodes.set(id, { value: '', showModal() {} }); return nodes.get(id); };
  let invites = 0;
  const context = functions(['openJam'], { state: { provider: 'spotify', room: null }, $: element, chooseConnectedMusicService, connected: (provider) => provider === 'spotify', setEntryMode() {}, showInvite: () => { invites++; } });
  context.openJam('create'); assert.equal(element('room-provider').value, 'spotify');
  context.state.room = { hostProvider: 'spotify' }; context.openJam('join'); assert.equal(context.state.room.hostProvider, 'spotify'); assert.equal(invites, 1);
});

 test('Spotify-only users get Spotify taste defaults, explicit Apple selection stays intact', () => {
 assert.equal(chooseConnectedMusicService(null, provider => provider === 'spotify'), 'spotify');
 assert.equal(chooseConnectedMusicService('apple', provider => provider === 'spotify'), 'apple');
 assert.doesNotMatch(text('/styles.css'), /taste-provider[^}]*display:none/);
 assert.doesNotMatch(source, /<button data-player-mode="mac"/);
 });
