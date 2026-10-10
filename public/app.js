import { autoStartDecision } from './auto-start-policy.js';
import { refreshLoadedPages } from './library-sync.js';
import { createAppleAuthorization, observeAppleAuthorization } from './apple-auth.js';
import { createAppleBrowserPlayer } from './apple-player.js';
import { createLiveRoom } from './live-room.js';
import { createAppleListener } from './apple-listener.js';
import { hostIsPlaying } from './playback-clock.js';
import { visibleMusicServices, defaultMusicService, chooseVisibleMusicService, chooseConnectedMusicService } from './service-visibility.js';

const $ = (id) => document.getElementById(id);
const state = { catalog: null, connections: { providers: {} }, session: null, room: null, online: false, events: null, provider: 'all', view: 'library', playlist: null, collection: 'playlists', playlists: new Map(), albums: new Map(), matching: new Set(), matchAttempts: new Set(), matchErrors: new Map(), songs: new Map(), tracks: new Map(), pending: new Set(), mode: 'create', busy: false, deferredTrack: null, loading: new Set(), nearbyTimer: null, qqSearch: null, refreshingLibrary: false, lastLibraryRefresh: 0, refreshBlockedUntil: 0 };
const recentlyQueued = new Map();
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const names = { spotify: 'Spotify', apple: 'Apple Music', qq: 'QQ Music', youtube: 'YouTube Music', ytmusic: 'YouTube Music companion', guest: 'Guest' };
const order = visibleMusicServices;
const providerName = (id) => names[id] || 'Music';
const connected = (id) => Boolean(state.connections.providers[id]?.connected);
const host = () => Boolean(state.room && state.room.hostId === state.session?.memberId);
let inviteCode = null, invitationToken = null, invitationImageUrl = null;
const tasteUI = { provider: null, playlistId: '', pair: '', busy: false, error: '', pending: new Set() };
const tastePages = { revision: null, pair: '', items: [], nextOffset: null, totalSongs: 0, loading: false };
let tasteRenderKey;
const automaticStarts = new Map();
const listeningUI = { provider: null, busy: false, preparing: false, active: false, generation: null, match: null, devices: [], deviceId: '', error: '', key: '', version: 0, clockOffset: 0, status: null };
let listeningRenderKey;
const handoffUI = { busy: false, provider: '', error: '' };
let handoffRenderKey, outputCheckBusy = false;
let outputDetectionAvailable = false;
const appleListener = createAppleListener({ getSDK: () => window.MusicKit,
  resolveTrack: async (code, provider) => (await api(`/api/rooms/${code}/listener/resolve`, { method: 'POST', body: { provider } })).match,
  reportState: (code, body) => api(`/api/rooms/${code}/listener/state`, { method: 'POST', body }),
  onStatus: (status) => { listeningUI.status = status; if (['error', 'choose_recording', 'stopped'].includes(status.status) && !appleListener.enabled) { listeningUI.active = false; listeningUI.error = status.error || 'Listening stopped.'; } renderListening(); },
});
const paths = {
  library: '<path d="M4 4v16M8 4v16M13 4l5 16M3 6h6M3 17h6M12 7l5-1"/>',
  accounts: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  taste: '<circle cx="8" cy="12" r="6"/><circle cx="16" cy="12" r="6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  back: '<path d="M20 12H5m5-5-5 5 5 5"/>',
  queue: '<path d="M4 5h16M4 10h16M4 15h9M4 20h7m7-6v7m-3-3h6"/>',
  link: '<path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1) scale(.9)"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  speaker: '<rect x="6" y="3" width="12" height="18" rx="3"/><circle cx="12" cy="15" r="3"/><circle cx="12" cy="7" r=".6"/>',
  play: '<path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zm6 0h4v16h-4z" fill="currentColor" stroke="none"/>',
  previous: '<path d="m19 5-10 7 10 7Z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  next: '<path d="m5 5 10 7-10 7Z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.library}</svg>`; }
function icons(root = document) { root.querySelectorAll('[data-icon]').forEach((node) => node.innerHTML = icon(node.dataset.icon)); }
function badge(id) { const url = id === 'spotify' ? '/brands/spotify-icon-black.svg' : state.catalog?.providers?.[id]?.logoUrl; return url ? `<span class="provider-icon official-mark ${escape(id)}"><img src="${escape(url)}" alt="" width="24" height="24"></span>` : `<span class="provider-icon no-logo" aria-hidden="true"></span>`; }
function safeUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
function art(item, extra = '') { const url = safeUrl(item?.artworkUrl); return `<div class="art ${extra}">${url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}<span class="art-placeholder" aria-hidden="true">${item?.saved ? '♥' : '♫'}</span></div>`; }
function trackFor(id) { return state.tracks.get(id); }
function entryTrack(entry) { return entry?.track || trackFor(entry?.trackId) || { title: 'Song unavailable', artist: 'Reconnect the music account to view this song', duration: '—' }; }
let toastTimer, searchTimer, catalogSearchTimer, queueRenderKey, jamStatusKey, jamActionsKey, membersRenderKey;
const songSearch = { provider: defaultMusicService, qqSource: 'auto', term: '', pages: new Map(), version: 0, controller: null };
const playerSetup = { mode: location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'mac' : 'web', devices: [], loaded: false, loading: false, busy: false, version: 0 };
const companionSetup = { checking: false };
let appleConnectionError = '';
let appleMusicPreparing = false;
const appleAuthorization = createAppleAuthorization({ getConfiguration: () => api('/api/connections/apple/config'), loadSDK: () => loadMusicKit() });
const appleBrowserPlayer = createAppleBrowserPlayer({ getSDK: () => window.MusicKit,
  sendState: (code, body) => api(`/api/rooms/${code}/player/apple/state`, { method: 'POST', body }),
  onRoom: (room) => { if (room?.code === state.session?.code) acceptRoom(room); },
  onError: (error) => { toast(error.message || 'Apple Music playback disconnected.', 'error'); renderPlayer(); },
});
function toast(message, tone = 'info') { $('toast').dataset.tone = tone; $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3800); }
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(state.session ? { Authorization: `Bearer ${state.session.token}` } : {}), ...(state.connections.csrfToken ? { 'X-CSRF-Token': state.connections.csrfToken } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let data; try { data = await response.json(); } catch { throw new Error('Jamama could not read the server response. Please try again.'); }
  if (!response.ok) {
    const error = new Error(data.error || 'Please try again.'); error.status = response.status; error.code = data.code;
    error.retryAfter = Number(response.headers.get('retry-after'));
    if (error.code === 'reconnect_required') {
      const provider = path.match(/^\/api\/(?:library|connections)\/(spotify|apple|qq|youtube|ytmusic)\//)?.[1];
      if (provider) {
        resetCatalogSearch();
        state.playlists.delete(provider); state.albums.delete(provider);
        for (const key of state.songs.keys()) if (key.startsWith(`${provider}/`)) state.songs.delete(key);
        for (const [id, track] of state.tracks) if (track.provider === provider) state.tracks.delete(id);
        if (state.playlist?.provider === provider) state.playlist = null;
      }
      try { const status = await fetch('/api/connections'); if (status.ok) state.connections = await status.json(); } catch {}
      renderAccounts(); renderLibrary(); renderSongSearch();
    }
    throw error;
  }
  return data;
}
function remember(tracks) { for (const track of tracks) state.tracks.set(track.id, track); }
function songRow(track, index, provider = track.provider) {
  const pending = state.pending.has(track.id), queued = (recentlyQueued.get(track.id) || 0) > Date.now();
  return `<div class="song-row" role="row" draggable="true" data-track-row="${escape(track.id)}"><span class="song-number" role="cell">${index + 1}</span><div class="song-name" role="cell">${art(track)}<div class="track-info"><strong>${escape(track.title)}</strong><p>${track.artistIsUploader ? 'Channel: ' : ''}${escape(track.artist)}</p></div></div><span class="album-column" role="cell">${escape(track.album)}</span><span class="duration-column" role="cell">${escape(track.duration || '—')}</span><span class="song-action" role="cell"><button class="add-button ${queued ? 'just-queued' : ''}" data-track="${escape(track.id)}" data-track-provider="${escape(provider)}" aria-label="${queued ? 'Queued' : 'Add'} ${escape(track.title)}${queued ? ' · add again' : ' to shared queue'}" title="${queued ? 'Added to queue' : 'Add to queue'}" ${pending ? 'disabled' : ''}>${pending ? '…' : queued ? '✓' : '+'}</button></span></div>`;
}
function searchProviders() { return songSearch.provider === 'all' ? order : [songSearch.provider]; }
function qqSearchSource() { return songSearch.qqSource === 'auto' ? connected('qq') ? 'library' : 'catalog' : songSearch.qqSource; }
function canSearch(provider) { return Boolean(state.connections.providers[provider]?.capabilities?.search && (provider === 'qq' && qqSearchSource() === 'catalog' || provider === 'apple' && state.connections.providers.apple.capabilities.publicCatalog || connected(provider))); }
function resetCatalogSearch() {
  clearTimeout(catalogSearchTimer); songSearch.controller?.abort(); songSearch.version += 1;
  songSearch.pages.clear(); songSearch.term = '';
}
function renderSongSearch() {
  document.querySelectorAll('[data-search-provider]').forEach((button) => {
    const active = button.dataset.searchProvider === songSearch.provider;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  const pages = searchProviders().map((provider) => songSearch.pages.get(provider));
  const loading = pages.some((page) => page?.loading), count = pages.reduce((sum, page) => sum + (page?.items.length || 0), 0);
  $('catalog-search-results').setAttribute('aria-busy', String(loading));
  $('catalog-search-status').textContent = !searchProviders().some(canSearch)
    ? `Connect ${providerName(songSearch.provider)} to search its catalog.` : songSearch.term
    ? `${loading ? 'Searching… ' : ''}${count} ${count === 1 ? 'result' : 'results'} loaded for “${songSearch.term}”.`
    : !connected('apple') && songSearch.provider === 'apple' && canSearch('apple') ? 'Search Apple Music’s catalog without signing in. Add a song to the shared queue.' : 'Search the full catalog of a connected service. Your playlists stay unchanged.';
  $('catalog-search-results').innerHTML = searchProviders().map((provider) => {
    const page = songSearch.pages.get(provider), details = state.connections.providers[provider];
    let body;
    if (!canSearch(provider)) {
      const setup = !details?.configured || details.connectAvailable === false;
      body = `<div class="catalog-search-empty"><p>${setup ? escape(details?.message || `${providerName(provider)} needs app setup.`) : `Sign in to search ${providerName(provider)} for any song.`}</p><button class="button secondary" ${setup ? `data-connection-detail="${provider}"` : 'data-view="accounts"'}>${setup ? `Set up ${providerName(provider)}` : `Connect ${providerName(provider)}`}</button></div>`;
      if (provider === 'qq' && qqSearchSource() === 'library' && !details?.capabilities?.localLibrary) body = '<div class="catalog-search-empty"><p>Your private QQ Music library can only be connected from its own Mac. Phone account sign-in is not connected yet.</p><button class="button secondary" data-connection-detail="qq">QQ Music connection details</button></div>';
    } else if (!songSearch.term) body = '<p class="empty-caption">Enter a song, artist, or album above.</p>';
    else {
      const rows = (page?.items || []).map((track, index) => songRow(track, index)).join('');
      body = rows ? `<div class="song-table" role="table" aria-label="${providerName(provider)} search results"><div class="song-table-header" role="row"><span role="columnheader">#</span><span role="columnheader">Title</span><span class="album-column" role="columnheader">Album</span><span class="duration-column" role="columnheader">Time</span><span role="columnheader" aria-label="Add to queue"></span></div><div role="rowgroup">${rows}</div></div>` : '';
      if (page?.error) {
        body += `<p class="inline-error" role="alert">${escape(page.error)}</p><button class="text-button" data-search-retry="${provider}">Try ${providerName(provider)} again</button>`;
        if (provider === 'qq' && details?.capabilities?.localLibrary) body += `<div class="catalog-search-empty"><p>Your real QQ Music playlists on this Mac are still available.</p><button class="button secondary" ${connected('qq') ? 'data-filter="qq"' : 'data-connect="qq"'}>Browse cached QQ Music library</button></div>`;
      }
      else if (!rows) body += `<p class="empty-caption">${page?.loading ? 'Searching for songs…' : 'No songs found. Try another title or artist.'}</p>`;
      if (page?.nextOffset != null) body += `<div class="load-more"><button class="button secondary" data-more-search="${provider}" ${page.loading ? 'disabled' : ''}>${page.loading ? 'Loading…' : 'Load more songs'}</button></div>`;
    }
    const localQQ = provider === 'qq' && qqSearchSource() === 'library';
    const sources = provider === 'qq' ? `<div class="collection-switch qq-search-sources" role="group" aria-label="QQ Music search source"><button data-qq-source="library" aria-pressed="${localQQ}">My QQ library</button><button data-qq-source="catalog" aria-pressed="${!localQQ}">Public catalog</button></div><p class="field-help">${localQQ ? 'Searches every cached playlist on this Mac. The original library stays unchanged.' : 'Experimental public search. QQ account sign-in is not connected.'}</p>` : '';
    const youtubeNote = provider === 'youtube' ? '<p class="field-help youtube-catalog-note">Searches music videos on YouTube. Channel names identify uploaders; the host reviews matching song versions.</p>' : '';
    const companionNote = provider === 'ytmusic' ? '<p class="field-help youtube-catalog-note">Searches playlists already synced by your companion. Open another playlist on YouTube Music to include it.</p>' : '';
    return `<section class="catalog-search-service" aria-label="${providerName(provider)} catalog"><div class="catalog-search-service-heading">${badge(provider)}<h2>${localQQ ? 'My QQ library' : providerName(provider)}</h2>${provider === 'qq' && !localQQ ? '<span class="muted">Experimental</span>' : ''}</div>${sources}${youtubeNote}${companionNote}${body}</section>`;
  }).join('');
}
async function loadSearchPage(provider, more = false) {
  if (!canSearch(provider) || !songSearch.term) return;
  const previous = songSearch.pages.get(provider);
  if (previous?.loading || (more && previous?.nextOffset == null)) return;
  const version = songSearch.version, offset = more ? previous.nextOffset : 0;
  const page = { items: more ? previous.items : [], nextOffset: more ? previous.nextOffset : null, loading: true };
  songSearch.pages.set(provider, page); renderSongSearch();
  try {
    const params = new URLSearchParams({ term: songSearch.term, offset: String(offset) });
    if (provider === 'qq') params.set('source', qqSearchSource());
    const data = await api(`/api/library/${provider}/search?${params}`, { signal: songSearch.controller.signal });
    if (version !== songSearch.version || !canSearch(provider)) return;
    const tracks = Array.isArray(data.items) ? data.items : []; remember(tracks);
    const items = [...new Map([...page.items, ...tracks].map((track) => [track.id, track])).values()];
    const nextOffset = Number.isInteger(data.nextOffset) && data.nextOffset > offset && (provider !== 'spotify' || data.nextOffset <= 1000) ? data.nextOffset : null;
    songSearch.pages.set(provider, { ...data, items, nextOffset, loading: false });
  } catch (error) {
    if (version !== songSearch.version || error.name === 'AbortError') return;
    songSearch.pages.set(provider, { ...page, loading: false, error: error.message });
  } finally { if (version === songSearch.version) renderSongSearch(); }
}
async function searchSongs() {
  resetCatalogSearch(); songSearch.term = $('catalog-search-input').value.trim();
  songSearch.controller = new AbortController(); renderSongSearch();
  if (songSearch.term) await Promise.all(searchProviders().filter(canSearch).map((provider) => loadSearchPage(provider)));
}
async function refreshConnectionsAfterMatch() {
  const connections = await api('/api/connections');
  for (const provider of order) {
    if (!connected(provider) || connections.providers[provider]?.connected) continue;
    resetCatalogSearch();
    state.playlists.delete(provider); state.albums.delete(provider);
    for (const key of state.songs.keys()) if (key.startsWith(`${provider}/`)) state.songs.delete(key);
    for (const [id, track] of state.tracks) if (track.provider === provider) state.tracks.delete(id);
    if (state.playlist?.provider === provider) state.playlist = null;
  }
  state.connections = connections;
  renderAccounts(); renderLibrary(); renderSongSearch();
}
function visibleProviders() { return state.provider === 'all' ? order : [state.provider]; }
function getPlaylists(provider) {
  if (provider === 'qq' && connected(provider)) return (state.playlists.get(provider)?.items || []).map((item) => ({ ...item, provider }));
  if (connected(provider)) return [...(state.connections.providers[provider]?.capabilities?.savedTracks === false ? [] : [{ id: '__saved', provider, name: provider === 'spotify' ? 'Liked Songs' : 'Songs', subtitle: 'Your saved songs', saved: true }]), ...(state.playlists.get(provider)?.items || []).map((item) => ({ ...item, provider }))];
  return [];
}
function getAlbums(provider) { return connected(provider) && state.connections.providers[provider]?.capabilities?.albums !== false ? (state.albums.get(provider)?.items || []).map((item) => ({ ...item, provider, kind: 'album' })) : []; }
function allPlaylists() { return visibleProviders().flatMap(state.collection === 'albums' ? getAlbums : getPlaylists); }
function collectionLoadingKey(provider) { return state.collection === 'albums' ? `albums:${provider}` : provider; }
function publicQQSearch() { return !connected('qq') && state.collection === 'playlists' && state.provider === 'qq' && state.connections.providers.qq?.capabilities?.search && (!state.playlist || state.playlist.isSearch); }
function playlistKey(list) { return `${list.provider}/${list.kind === 'album' ? 'album/' : ''}${list.id}`; }
function renderSidebar() {
  const lists = order.flatMap(getPlaylists).slice(0, 7);
  $('sidebar-playlists').innerHTML = lists.map((list) => `<button class="sidebar-playlist" data-playlist-key="${escape(playlistKey(list))}" title="${escape(list.name)}">${art(list, list.saved ? 'saved-art' : '')}<span>${escape(list.name)}</span></button>`).join('') || '<p class="sidebar-empty">Connect an account to see your playlists.</p>';
  document.querySelectorAll('.main-nav [data-view]').forEach((button) => { const active = !$('app-shell').classList.contains('queue-active') && button.dataset.view === state.view; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
}
function renderLibrary() {
  renderSidebar();
  $('beta-label').hidden = !state.connections.publicBeta;
  $('browse-guest').hidden = !canSearch(defaultMusicService) || order.some(connected);
  $('library-view').classList.toggle('has-playlist', Boolean(state.playlist));
  const qq = state.provider === 'qq' && state.connections.providers.qq?.capabilities?.search;
  $('library-heading').textContent = state.provider === 'all' ? 'Your Library' : providerName(state.provider);
  $('library-subtitle').textContent = 'Browse your music and add songs to the shared queue.';
  if (state.provider === 'youtube') $('library-subtitle').textContent = 'Playlists you own on YouTube and YouTube Music, connected through Google.';
  if (state.provider === 'ytmusic') $('library-subtitle').textContent = 'Real playlists synced by your desktop companion.';
  $('breadcrumb').textContent = { search: 'Search', taste: 'Shared taste', accounts: 'Music accounts' }[state.view] || state.playlist?.name || 'Your library';
  const publicSearch = publicQQSearch();
  $('search-input').placeholder = publicSearch ? 'Search QQ Music songs' : state.playlist ? state.playlist.kind === 'album' ? 'Search this album' : 'Search this playlist' : state.collection === 'albums' ? 'Search loaded albums' : 'Search your library';
  $('search-input').setAttribute('aria-label', publicSearch ? 'Search public QQ Music songs' : state.playlist ? state.playlist.kind === 'album' ? 'Search loaded album songs' : 'Search loaded playlist songs' : state.collection === 'albums' ? 'Search loaded albums' : 'Search displayed library');
  const hasConnection = visibleProviders().some(connected);
  document.querySelector('.library-tools').hidden = !hasConnection && !publicSearch;
  $('refresh-library').hidden = !hasConnection || Boolean(state.playlist?.isSearch);
  $('refresh-library').disabled = state.refreshingLibrary || state.loading.size > 0;
  $('refresh-library').innerHTML = `${icon('refresh')}${state.refreshingLibrary ? 'Refreshing…' : 'Refresh'}`;
  $('connect-banner').hidden = Boolean(state.playlist) || hasConnection;
  $('connect-banner').querySelector('strong').textContent = qq ? 'Search QQ Music' : 'Connect your library';
  $('connect-banner').querySelector('p').textContent = qq ? 'Public songs only. Private playlists are not connected.' : 'Connect Spotify or Apple Music to browse your playlists, or search as a guest.';
  $('connect-main').innerHTML = qq ? `Search songs${icon('search')}` : `Connect music${icon('arrow')}`;
  $('library-tabs').hidden = Boolean(state.playlist) || order.length === 1;
  document.querySelectorAll('#library-tabs [data-filter]').forEach((button) => { const active = button.dataset.filter === state.provider; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('library-grid-view').hidden = Boolean(state.playlist) || (!hasConnection && !publicSearch);
  $('playlist-detail').hidden = !state.playlist;
  if (state.playlist) { renderTracks(); return; }
  const query = $('search-input').value.trim().toLowerCase();
  const lists = allPlaylists().filter((list) => `${list.name} ${list.subtitle}`.toLowerCase().includes(query));
  $('playlist-grid').classList.toggle('library-list', lists.length > 0 && lists.every((list) => list.source === 'local_library'));
  const collectionLabel = state.collection === 'albums' ? 'album' : 'playlist';
  $('grid-heading').textContent = state.collection === 'albums' ? 'Your albums' : 'Your playlists';
  document.querySelectorAll('[data-collection]').forEach((button) => { const active = button.dataset.collection === state.collection; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); button.hidden = button.dataset.collection === 'albums' && ['youtube', 'ytmusic'].includes(state.provider); });
  $('grid-count').textContent = lists.length ? `${lists.length} ${collectionLabel}${lists.length === 1 ? '' : 's'}` : '';
  if (state.collection === 'albums' && !query) {
    const pages = visibleProviders().filter(connected).map((provider) => state.albums.get(provider));
    if (pages.length && pages.every((page) => Number.isFinite(page?.total))) {
      const total = pages.reduce((sum, page) => sum + page.total, 0);
      if (total > lists.length) $('grid-count').textContent = `${lists.length} of ${total.toLocaleString()} albums`;
    }
  }
  $('library-note').hidden = !visibleProviders().includes('qq') || state.connections.providers.qq?.mode !== 'local_library';
  $('library-note').textContent = state.collection === 'albums' ? 'QQ Music albums contain songs from your cached playlists and may be incomplete.' : 'QQ Music playlists saved on this Mac.';
  if (state.provider === 'ytmusic' && connected('ytmusic')) { $('library-note').hidden = false; $('library-note').textContent = 'Browse the real YouTube Music page with Jamama’s sidebar. Sync an open playlist, then request songs here or in the sidebar. Unloaded, unavailable, or non-song entries may be missing.'; }
  const loadingLibrary = visibleProviders().some((id) => state.loading.has(collectionLoadingKey(id)));
  const canUseMacLibrary = visibleProviders().includes('qq') && !connected('qq') && state.connections.providers.qq?.capabilities?.localLibrary;
  $('playlist-grid').innerHTML = lists.map((list) => `<button class="playlist-card" data-playlist-key="${escape(playlistKey(list))}"><div class="playlist-cover">${art(list, list.saved ? 'saved-art' : '')}</div><div class="playlist-copy"><h3>${escape(list.name)}</h3><p>${list.trackCount == null ? '' : `${list.trackCount} ${list.kind === 'album' && list.source === 'local_library' ? 'cached ' : ''}${list.trackCount === 1 ? 'song' : 'songs'} · `}${escape(providerName(list.provider))}</p></div></button>`).join('') || (loadingLibrary ? '' : `<div class="real-library-empty"><h3>${hasConnection ? `No ${state.collection} found` : canUseMacLibrary ? 'Use your QQ Music library' : qq ? 'Search for a real song' : 'Your music belongs here'}</h3><p>${hasConnection ? state.collection === 'albums' && visibleProviders().some((provider) => state.albums.get(provider)?.nextOffset != null) ? 'This search covers the albums loaded so far. Load more albums below to include more of your library.' : 'Try another search or refresh your music connection.' : canUseMacLibrary ? 'Your QQ Music playlists are available on this Mac. Load their song lists here without importing or moving them.' : qq ? 'Use the search field above to browse QQ Music’s public catalog. Account playlists are not connected.' : 'Connect Spotify or Apple Music to load your own library. QQ Music search is available now.'}</p>${canUseMacLibrary ? '<button class="button primary" data-connect="qq">Use QQ Music on this Mac</button>' : !hasConnection && !qq ? '<button class="button primary" data-filter="qq">Search QQ Music</button>' : ''}</div>`);
  $('library-grid-view').setAttribute('aria-busy', String(loadingLibrary)); $('library-loading').hidden = !loadingLibrary;
  $('playlist-more').innerHTML = visibleProviders().filter((id) => (state.collection === 'albums' ? state.albums : state.playlists).get(id)?.nextOffset != null).map((id) => `<button class="button secondary" data-more-playlists="${id}">Load more ${providerName(id)} ${state.collection}</button>`).join('');
}
function renderTracks() {
  const list = state.playlist; if (!list) return;
  $('refresh-library').disabled = state.refreshingLibrary || state.loading.size > 0;
  $('back-library').innerHTML = `${icon('back')}All ${list.kind === 'album' ? 'albums' : 'playlists'}`;
  $('playlist-detail').querySelector('.song-table').setAttribute('aria-label', list.kind === 'album' ? 'Album songs' : 'Playlist songs');
  const key = playlistKey(list), data = state.songs.get(key) || { items: [] };
  const query = list.isSearch ? '' : $('search-input').value.trim().toLowerCase();
  const songs = data.items.filter((track) => track && `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query));
  $('playlist-hero').innerHTML = `${art(list, list.saved ? 'saved-art' : '')}<div><span class="eyebrow">${list.isSearch ? 'PUBLIC CATALOG' : list.saved ? 'YOUR LIBRARY' : list.kind === 'album' ? 'ALBUM' : 'PLAYLIST'}</span><h1>${escape(list.name)}</h1><p class="playlist-description">${escape(list.subtitle || '')}</p><div class="playlist-meta">${badge(list.provider)}${providerName(list.provider)}<span>· ${data.total == null ? `${data.items.length} songs loaded` : `${data.total} ${list.kind === 'album' && list.source === 'local_library' ? 'cached ' : ''}${data.total === 1 ? 'song' : 'songs'}`}</span></div></div>`;
  $('track-count').textContent = songs.length;
  if (list.source === 'browser_companion') $('playlist-hero').insertAdjacentHTML('beforeend', `<p class="companion-capture-note">${data.captureComplete ? `All ${data.total} listed entries captured.` : `${data.total || data.items.length}${data.expectedCount ? ` of ${data.expectedCount}` : ''} entries captured. Others may be unloaded or unavailable.`}</p>`);
  $('track-list').innerHTML = songs.map((track, index) => songRow(track, index, list.provider)).join('');
  $('no-results').hidden = songs.length > 0;
  $('no-results').textContent = state.loading.has(key) ? 'Loading songs…' : data.error || (list.isSearch ? 'No songs found. Try another title or artist.' : 'No songs match your search.');
  $('tracks-more').innerHTML = data.nextOffset != null ? '<button class="button secondary" id="load-more-tracks">Load more songs</button>' : '';
}
async function loadPlaylists(provider, more = false) {
  if (state.loading.has(provider) || !connected(provider)) return;
  state.loading.add(provider); $('library-error').hidden = true; renderLibrary();
  try { const previous = state.playlists.get(provider); const data = await api(`/api/library/${provider}/playlists?offset=${more ? previous?.nextOffset || 0 : 0}`); state.playlists.set(provider, { ...data, items: more ? [...previous.items, ...data.items] : data.items }); }
  catch (error) { $('library-error').textContent = error.message; $('library-error').hidden = false; }
  finally { state.loading.delete(provider); renderLibrary(); }
}
async function loadAlbums(provider, more = false) {
  const key = `albums:${provider}`;
  if (state.connections.providers[provider]?.capabilities?.albums === false) return;
  if (state.loading.has(key) || !connected(provider)) return;
  state.loading.add(key); $('library-error').hidden = true; renderLibrary();
  try {
    const previous = state.albums.get(provider);
    const data = await api(`/api/library/${provider}/albums?offset=${more ? previous?.nextOffset || 0 : 0}`);
    state.albums.set(provider, { ...data, items: more ? [...previous.items, ...data.items] : data.items });
  } catch (error) { $('library-error').textContent = error.message; $('library-error').hidden = false; }
  finally { state.loading.delete(key); renderLibrary(); }
}
async function loadCollection(provider, more = false) {
  const albums = state.collection === 'albums';
  if (!more && (albums ? state.albums : state.playlists).has(provider)) return;
  await (albums ? loadAlbums(provider, more) : loadPlaylists(provider, more));
}
function songsPath(list, offset) {
  return list.isSearch ? `search?term=${encodeURIComponent(list.term)}&offset=${offset}` : list.saved ? `tracks?offset=${offset}` : `${list.kind === 'album' ? 'albums' : 'playlists'}/${encodeURIComponent(list.id)}/tracks?offset=${offset}`;
}
async function refreshLibrary({ automatic = false } = {}) {
  const providers = visibleProviders().filter(connected);
  if (!providers.length || state.refreshingLibrary || state.playlist?.isSearch || state.loading.size) return;
  if (Date.now() < state.refreshBlockedUntil) {
    if (!automatic) toast('The music service needs a short pause. Please try again shortly.', 'warning');
    return;
  }
  const collection = state.collection, cache = collection === 'albums' ? state.albums : state.playlists;
  const selection = state.playlist;
  state.refreshingLibrary = true; $('library-error').hidden = true; renderLibrary();
  try {
    const results = await Promise.allSettled(providers.map(async (provider) => {
      const previous = cache.get(provider);
      const data = await refreshLoadedPages((offset) => api(`/api/library/${provider}/${collection}?offset=${offset}`), previous?.items.length || 0);
      if (connected(provider)) cache.set(provider, data);
    }));
    if (selection && connected(selection.provider)) {
      const key = playlistKey(selection), previous = state.songs.get(key);
      const data = await refreshLoadedPages((offset) => api(`/api/library/${selection.provider}/${songsPath(selection, offset)}`), previous?.items.length || 0);
      if (connected(selection.provider)) { remember(data.items); state.songs.set(key, data); }
      if (state.playlist === selection) {
        const updated = allPlaylists().find((item) => playlistKey(item) === key);
        if (updated) state.playlist = updated;
      }
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    state.lastLibraryRefresh = Date.now();
    if (!automatic) toast('Your library has been refreshed.', 'success');
  } catch (error) {
    const pause = error.status === 429 && Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter * 1000 : 120000;
    state.refreshBlockedUntil = Date.now() + Math.min(900000, Math.max(120000, pause));
    $('library-error').textContent = `Library refresh could not finish. ${error.message}`; $('library-error').hidden = false;
    if (!automatic) toast(error.message, 'error');
  } finally { state.refreshingLibrary = false; renderLibrary(); }
}
function refreshActiveLibrary() {
  if (document.visibilityState === 'visible' && state.view === 'library' && !document.querySelector('dialog[open]') && Date.now() - state.lastLibraryRefresh >= 120000) void refreshLibrary({ automatic: true });
}
async function selectCollection(collection) {
  if (!['albums', 'playlists'].includes(collection)) return;
  clearTimeout(searchTimer);
  state.collection = collection; state.playlist = null; $('search-input').value = '';
  setView('library'); renderLibrary();
  await Promise.all(visibleProviders().filter(connected).map((provider) => loadCollection(provider)));
}
async function loadTracks(list, more = false) {
  const key = playlistKey(list); if (state.loading.has(key)) return;
  state.loading.add(key); renderTracks();
  try {
    const previous = state.songs.get(key), offset = more ? previous?.nextOffset || 0 : 0;
    const path = songsPath(list, offset);
    const data = await api(`/api/library/${list.provider}/${path}`); remember(data.items);
    state.songs.set(key, { ...data, items: more ? [...previous.items, ...data.items] : data.items });
  } catch (error) { const previous = state.songs.get(key); state.songs.set(key, { ...(previous || { items: [] }), error: error.message }); toast(error.message, 'error'); }
  finally { state.loading.delete(key); if (state.playlist && playlistKey(state.playlist) === key) renderTracks(); }
}
async function openPlaylist(key) {
  const list = order.flatMap((id) => [...getPlaylists(id), ...getAlbums(id)]).find((item) => playlistKey(item) === key); if (!list) return;
  state.playlist = list; state.collection = list.kind === 'album' ? 'albums' : 'playlists'; state.provider = list.provider; $('search-input').value = ''; setView('library'); renderLibrary(); $('content-scroll').scrollTop = 0;
  if (!state.songs.has(key)) await loadTracks(list);
}
function setView(view) {
  document.querySelectorAll('.main-nav [data-mobile="queue"]').forEach(button => { button.classList.remove('active'); button.setAttribute('aria-current', 'false'); });
  $('app-shell').classList.remove('queue-active');
  state.view = view; $('library-view').hidden = view !== 'library'; $('search-view').hidden = view !== 'search'; $('accounts-view').hidden = view !== 'accounts'; $('taste-view').hidden = view !== 'taste';
  document.querySelectorAll('[data-mobile]').forEach((button) => { const active = button.dataset.mobile === view; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
  $('breadcrumb').textContent = { search: 'Search', taste: 'Shared taste', accounts: 'Music accounts' }[view] || state.playlist?.name || 'Your library';
  renderSidebar(); if (view === 'accounts') { renderAccounts(); if (state.connections.providers.apple?.configured && !appleAuthorization.ready && !appleMusicPreparing) void prepareAppleMusic(); } if (view === 'search') { renderSongSearch(); $('catalog-search-input').focus(); }
  if (view === 'taste') {
    tasteUI.provider = chooseConnectedMusicService(tasteUI.provider, connected);
    renderTaste();
    if (tasteUI.provider === 'apple' && connected('apple') && !state.playlists.has('apple')) void loadPlaylists('apple').then(renderTaste);
  }
  $('content-scroll').scrollTop = 0;
}
async function selectProvider(provider) {
  clearTimeout(searchTimer);
  if (['youtube', 'ytmusic'].includes(provider)) state.collection = 'playlists';
  state.provider = provider; state.playlist = null; $('search-input').value = ''; setView('library'); renderLibrary();
  try { localStorage.setItem('jamama-provider', provider); } catch {}
  await Promise.all(visibleProviders().filter(connected).map((id) => loadCollection(id)));
}
function showQueue() { $('app-shell').classList.add('queue-active'); renderSidebar(); $('queue-panel').focus({ preventScroll: true }); document.querySelectorAll('[data-mobile]').forEach((button) => { const active = button.dataset.mobile === 'queue'; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }); }
function renderAccounts() {
  $('remember-connection').checked = state.connections.rememberConnection !== false;
  $('account-list').innerHTML = order.map((id) => {
    const status = state.connections.providers[id] || { status: 'unavailable', message: 'Connection status is temporarily unavailable.' };
    const publicCatalog = id === 'qq' && status.capabilities?.search;
    const local = status.mode === 'local_library', canReadLocal = id === 'qq' && status.capabilities?.localLibrary;
    const label = status.connected ? local ? 'Local library connected' : 'Connected' : id === 'ytmusic' && status.connectAvailable !== false ? 'Optional desktop companion' : local ? 'Local library connected' : canReadLocal ? 'Available on this Mac' : publicCatalog ? 'Public song search available' : status.status === 'approval_required' ? 'Official integration needed' : status.status === 'host_only' ? 'Connect on this Mac' : status.configured ? 'Ready to connect' : 'Setup needed';
    const message = status.connected ? local ? 'Browse the real playlists saved by QQ Music on this Mac.' : id === 'ytmusic' ? 'Real playlists captured by your desktop companion are ready to browse and queue.' : id === 'youtube' ? 'Your owned YouTube playlists are available. YouTube Music library features may be missing.' : 'Your playlists and saved songs are available in your library.' : canReadLocal ? 'Use the playlist information already saved by QQ Music on this Mac. No QQ password is needed.' : status.status === 'setup_required' ? 'Sign-in needs a one-time setup for this app.' : status.message;
    const action = status.connected ? `data-filter="${id}"` : canReadLocal ? 'data-connect="qq"' : publicCatalog ? 'data-filter="qq"' : `data-connect="${id}"`;
    const needsSetup = !status.connected && !canReadLocal && !publicCatalog && !status.configured;
    const statusTone = status.connected ? 'connected' : needsSetup ? 'needs-setup' : 'available';
    const serviceSignIn = ['spotify', 'apple', 'youtube', 'ytmusic'].includes(id);
    const signInReady = status.configured && status.connectAvailable !== false;
    const actionLabel = status.connected ? 'Open library' : id === 'apple' && appleMusicPreparing ? 'Preparing Apple Music…' : canReadLocal ? 'Use Mac library' : publicCatalog ? 'Search QQ Music' : id === 'ytmusic' ? 'Connect companion' : id === 'youtube' ? 'Sign in with Google' : `Sign in with ${providerName(id)}`;
    const unavailable = serviceSignIn && !status.connected && !signInReady;
    const preparing = id === 'apple' && appleMusicPreparing && !status.connected;
    return `<article class="account-card ${id}">${badge(id)}<div class="account-card-copy"><h2>${providerName(id)}</h2><p>${escape(message)}</p><span class="account-status ${statusTone}">${label}</span>${id === 'apple' && appleConnectionError ? `<p class="inline-error" role="alert">${escape(appleConnectionError)}</p>` : ''}</div><div class="account-actions${unavailable ? ' needs-app-setup' : ''}"><button class="button ${status.connected ? 'secondary' : 'primary'}" ${action} ${preparing ? 'disabled' : unavailable ? 'disabled aria-describedby="setup-note-' + id + '"' : ''}>${actionLabel}</button>${unavailable ? `<span class="signin-note" id="setup-note-${id}">${status.status === 'host_only' ? 'Phone sign-in needs HTTPS.' : 'One-time app setup required.'}</span><button class="text-button" data-connection-detail="${id}">${status.status === 'host_only' ? 'Sign-in details' : `Set up ${providerName(id)}`}</button>` : status.connected ? `<button class="text-button" data-disconnect="${id}">Disconnect</button>` : publicCatalog ? '<button class="text-button" data-connection-detail="qq">Connection details</button>' : ''}</div></article>`;
  }).join('');
}
function signInSetupGuide(provider, details) {
  if (provider === 'spotify') {
    const callback = details.setup?.redirectUri || 'http://127.0.0.1:4177/auth/spotify/callback';
    if (details.status === 'host_only') return '<div class="setup-guide"><p>Spotify is configured for the Mac. To let guests sign in on their phones, the Jamama owner must give this app an HTTPS address and register its return address in the existing Spotify app.</p><a class="button secondary" href="https://developer.spotify.com/documentation/web-api/concepts/redirect_uri" target="_blank" rel="noopener noreferrer">Spotify return-address requirements ↗</a></div>';
    const firstStep = details.setup?.clientIdConfigured ? 'Open the settings for your existing Spotify development app.' : 'Create a Spotify development app using a Premium account.';
    return `<div class="setup-guide"><p>This setup belongs to the Jamama owner. Guests will use the sign-in button.</p><ol><li>${firstStep}</li><li>Add the Spotify users who will join your Jam to the app’s user list.</li><li>Register this return address: <code>${escape(callback)}</code></li><li>Add the app’s Client ID and return address to Jamama’s local configuration, then restart Jamama.</li></ol><a class="button secondary" href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">Open Spotify developer dashboard ↗</a><p class="field-help">Development mode supports five approved Spotify accounts across Jamama, not per room. Phone sign-in needs HTTPS. Public access requires Spotify approval; its current eligibility includes an established organization and 250,000 monthly active users.</p></div>`;
  }
  if (provider === 'apple') {
    return `<div class="setup-guide"><p>This setup belongs to the Jamama owner. Each guest then authorizes their own Apple Music account.</p><ol><li>Use your Apple Developer Program account to register a Media ID. Set its description to <strong>Jamama</strong> and enable MusicKit.</li><li>Create a Media Services key with MusicKit enabled and associate it with Jamama.</li><li>Download the key to your computer. Keep its Key ID and your account’s Team ID handy.</li><li>Jamama’s local setup helper will create the sign-in token. Then each person can connect their own Apple Music account.</li></ol><a class="button secondary" href="https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key" target="_blank" rel="noopener noreferrer">Create Apple Music credentials ↗</a><p class="field-help">An Apple Music subscription and an Apple Developer membership are separate. Your private signing key stays off the website.</p></div>`;
  }
  if (provider === 'qq') return '<div class="setup-guide"><p>Use Mac library to browse the playlists QQ Music has saved on this Mac. Tap + to request a song; the host plays its Spotify or Apple Music version.</p><p>This does not change your QQ playlists. Choose your QQ songs on this Mac; QQ phone sign-in is unavailable. A song must exist on the host’s service to play.</p></div>';
  if (provider === 'youtube') return `<div class="setup-guide"><p>Connect your owned YouTube playlists through Google. Google says YouTube Music playlists also appear in YouTube, but this connection does not expose the entire YouTube Music library.</p><ol><li>Create a Google Cloud project for Jamama and enable <strong>YouTube Data API v3</strong>.</li><li>Set up Google Auth Platform, choose an External audience, and add your account under Test users.</li><li>Create an OAuth client with application type <strong>Web application</strong>.</li><li>Register this return address: <code>${escape(details.setup?.redirectUri || 'http://127.0.0.1:4177/auth/youtube/callback')}</code></li><li>Download the client’s JSON file to your Mac. Jamama’s local setup helper keeps its secret on the server.</li></ol><a class="button secondary" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">Open YouTube API setup ↗</a><p class="field-help">Phone sign-in needs a reachable HTTPS address. Public Google account access requires Google’s verification process. YouTube playback is not connected.</p></div>`;
  if (provider === 'ytmusic') return '<div class="setup-guide"><p>Keep the real YouTube Music interface. Jamama’s Chrome sidebar adds a shared queue beside it. Google sign-in stays on YouTube Music.</p><ol><li>Install the Jamama Music Companion in Chrome.</li><li>Leave this pairing dialog open, click Jamama’s extension icon, and choose <strong>Connect to open Jamama</strong>. No code copying is needed.</li><li>Open a playlist on YouTube Music, click the extension icon, and choose <strong>Sync playlist</strong>.</li><li>Join a Jam in the sidebar and use <strong>+</strong> to request songs.</li></ol><p>Desktop prototype. Only loaded playlist information and artwork links are shared. Phone support, full-library background sync, and YouTube host playback are not included.</p><a class="button secondary" href="/jamama-companion.zip" download>Download companion</a><button class="button primary full" data-connect="ytmusic">Pair companion</button></div>';
  return '';
}
function showConnectionDetail(provider) {
  const details = state.connections.providers[provider]; if (!details) return toast('Connection status is unavailable. Refresh and try again.', 'warning');
  const documentation = safeUrl(details.setup?.documentationUrl);
  $('connection-detail').innerHTML = `<div class="detail-provider">${badge(provider)}</div><h2>${providerName(provider)}</h2><p class="dialog-caption">${escape(details.message)}</p>${signInSetupGuide(provider, details)}${details.setup ? `<details class="connection-details"><summary>Technical configuration</summary><p>${escape(details.setup.message || '')}</p>${details.setup.requiredEnv?.length ? `<p>Server settings: <code>${details.setup.requiredEnv.map(escape).join(', ')}</code></p>` : ''}${details.setup.redirectUri ? `<p>Return address: <code>${escape(details.setup.redirectUri)}</code></p>` : ''}${documentation ? `<a href="${escape(documentation)}" target="_blank" rel="noopener noreferrer">Official setup documentation ↗</a>` : ''}</details>` : ''}${provider === 'qq' && details.capabilities?.search ? '<button class="button primary full" data-filter="qq">Search QQ Music</button>' : '<p class="field-help">Your account will be shown as connected only after the music service authorizes it.</p>'}`;
  $('connection-dialog').showModal();
}
let musicKitPromise;
async function pairMusicCompanion() {
  $('companion-code').textContent = 'Getting a code…'; $('companion-status').textContent = 'Waiting for your companion.';
  if (!$('companion-dialog').open) $('companion-dialog').showModal();
  try {
    const result = await api('/api/connections/ytmusic/pair', { method: 'POST', body: {} });
    $('companion-code').textContent = result.code;
    $('companion-status').textContent = 'This code works once and expires in 10 minutes.';
  } catch (error) { $('companion-code').textContent = 'Code unavailable'; $('companion-status').textContent = error.message; }
}
async function refreshMusicCompanion() {
  if (companionSetup.checking || document.visibilityState !== 'visible' || (!$('companion-dialog').open && !connected('ytmusic'))) return;
  companionSetup.checking = true;
  try {
    const status = await api('/api/connections'), previous = state.connections.providers.ytmusic, current = status.providers.ytmusic;
    state.connections = status;
    if (previous?.connected && !current?.connected) {
      state.playlists.delete('ytmusic');
      for (const key of state.songs.keys()) if (key.startsWith('ytmusic/')) state.songs.delete(key);
      for (const [id, track] of state.tracks) if (track.provider === 'ytmusic') state.tracks.delete(id);
      if (state.playlist?.provider === 'ytmusic') state.playlist = null;
      renderAccounts(); renderLibrary(); renderSongSearch();
    }
    if ($('companion-dialog').open && current?.companion?.paired) $('companion-status').textContent = current.connected ? 'A real playlist is connected. Your library is ready.' : 'Companion paired. Open a playlist on YouTube Music and choose Sync open playlist.';
    if (current?.connected && (!previous?.connected || current.companion.revision !== previous.companion?.revision)) {
      state.playlists.delete('ytmusic');
      for (const key of state.songs.keys()) if (key.startsWith('ytmusic/')) state.songs.delete(key);
      resetCatalogSearch(); renderAccounts(); renderSongSearch();
      await loadPlaylists('ytmusic');
      if (state.playlist?.provider === 'ytmusic') await loadTracks(state.playlist);
      if ($('companion-dialog').open) { $('companion-dialog').close(); await selectProvider('ytmusic'); toast('YouTube Music playlist connected.', 'success'); }
    }
  } catch (error) { if ($('companion-dialog').open) $('companion-status').textContent = error.message; }
  finally { companionSetup.checking = false; }
}
async function loadMusicKit() {
  if (window.MusicKit) return window.MusicKit;
  if (!musicKitPromise) musicKitPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'; script.async = true;
    const timer = setTimeout(() => { musicKitPromise = null; reject(new Error('Apple sign-in took too long to load. Try again.')); }, 15000);
    const ready = () => { if (!window.MusicKit) return; clearTimeout(timer); resolve(window.MusicKit); };
    document.addEventListener('musickitloaded', ready, { once: true }); script.onload = ready;
    script.onerror = () => { clearTimeout(timer); musicKitPromise = null; reject(new Error('Apple sign-in could not load. Check your connection and try again.')); };
    document.head.append(script);
  });
  return musicKitPromise;
}
async function prepareAppleMusic() {
  appleMusicPreparing = true; renderAccounts();
  try { await appleAuthorization.prepare(); return true; }
  catch (error) { appleConnectionError = error.message || 'Apple Music could not prepare sign-in. Please try again.'; return false; }
  finally { appleMusicPreparing = false; renderAccounts(); }
}
async function connectProvider(provider, button) {
  const details = state.connections.providers[provider];
  if (provider === 'ytmusic') { if (details?.connectAvailable === false) return showConnectionDetail(provider); $('connection-dialog').close(); return pairMusicCompanion(); }
  if (provider === 'qq' && details?.capabilities?.localLibrary) {
    if (button) button.disabled = true;
    try { state.connections = await api('/api/connections/qq/connect', { method: 'POST', body: {} }); renderAccounts(); await selectProvider('qq'); toast('Your QQ Music library is connected on this Mac.', 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { if (button?.isConnected) button.disabled = false; }
    return;
  }
  if (!details?.configured || details.connectAvailable === false) return showConnectionDetail(provider);
  if (['spotify', 'youtube'].includes(provider) && details.connectUrl) { location.assign(details.connectUrl); return; }
  if (provider !== 'apple') return showConnectionDetail(provider);
  if (!appleAuthorization.ready) {
    if (await prepareAppleMusic()) toast('Apple Music is ready. Select Sign in with Apple Music to continue.');
    return;
  }
  if (button) button.disabled = true;
  appleConnectionError = '';
  document.querySelector('.account-card.apple .inline-error')?.remove();
  let stage = 'authorization';
  const observer = observeAppleAuthorization(window);
  try {
    const musicUserToken = await appleAuthorization.authorize();
    stage = 'library-validation';
    state.connections = await api('/api/connections/apple/connect', { method: 'POST', body: { musicUserToken } });
    renderAccounts(); await selectProvider('apple'); toast('Apple Music is connected. Your library is loading.', 'success');
  } catch (error) {
    console.warn('Apple Music connection failed', { stage, ...observer.finish(), status: Number.isInteger(error.status) ? error.status : null });
    appleConnectionError = stage === 'authorization'
      ? 'Apple’s sign-in window did not return library access. Your account is not connected yet. Please keep the Apple window open until it confirms permission.'
      : error.message || 'Apple Music could not connect. Please try again.';
    renderAccounts(); toast(appleConnectionError, 'error');
  }
  finally { observer.finish(); if (button?.isConnected) button.disabled = false; }
}
async function disconnectProvider(provider) {
  if (listeningUI.active && listeningUI.provider === provider) await stopListening(true);
  if (provider === 'apple' && appleBrowserPlayer.connected) await controlPlayer('disconnect');
  resetCatalogSearch(); renderSongSearch();
  try { state.connections = await api(`/api/connections/${provider}/disconnect`, { method: 'POST', body: {} }); state.playlists.delete(provider); state.albums.delete(provider); for (const key of state.songs.keys()) if (key.startsWith(`${provider}/`)) state.songs.delete(key); for (const [id, track] of state.tracks) if (track.provider === provider) state.tracks.delete(id); if (state.playlist?.provider === provider) state.playlist = null; renderAccounts(); renderLibrary(); toast(`${providerName(provider)} disconnected`); }
  catch (error) { toast(error.message, 'error'); }
  finally { if (provider === 'apple' && !connected('apple') && appleAuthorization.ready) await appleAuthorization.getInstance().unauthorize().catch(() => {}); renderSongSearch(); }
}
function setOnline(online) { state.online = online; renderRoom(); }
function acceptRoom(room) {
  if (!state.session || room.code !== state.session.code) return;
  if (state.room && room.code === state.room.code && room.version < state.room.version) return;
  const previousHost = state.room?.hostId, wasHost = host();
  state.room = room;
  if (previousHost && previousHost !== room.hostId) {
    automaticStarts.clear(); state.matchAttempts.clear(); state.matchErrors.clear(); state.matching.clear(); playerSetup.renderKey = '';
    if (wasHost && appleBrowserPlayer.connected) void appleBrowserPlayer.stop();
    if (host()) { if (listeningUI.active || appleListener.enabled) void stopListening(true); handoffUI.error = ''; toast('You’re the host now. Connect your player to start the shared queue.', 'success'); }
    else if (wasHost) toast('Host transferred. Your queue is still here.', 'success');
  }
  if (wasHost && !room.playback.connected && appleBrowserPlayer.connected) void appleBrowserPlayer.stop();
  if (!host()) appleListener.observe(room);
  renderRoom(); void matchQueuedTracks(); void startMatchedQueue();
}
function openEvents() {
  state.events?.close();
  const url = new URL(`/api/rooms/${state.session.code}/socket`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const events = createLiveRoom({ url: url.href, token: state.session.token,
    onRoom: (room) => { if (room.code !== state.session?.code) return; state.online = true; acceptRoom(room); },
    onEnded: () => { resetSession(); toast('The host ended this Jam.'); },
    onOffline: async () => { if (state.events !== events || !state.session) return; const session = state.session; setOnline(false); try { await api(`/api/rooms/${session.code}`); } catch (error) { if (state.events === events && state.session === session && [401, 404].includes(error.status)) { resetSession(); toast(error.message, 'error'); } } },
  });
  state.events = events;
}
function enterRoom(result) {
  inviteCode = null; invitationToken = null;
  state.session = { token: result.token, memberId: result.memberId, code: result.room.code }; state.online = true;
  try { sessionStorage.setItem('jamama-session', JSON.stringify(state.session)); localStorage.setItem('jamama-name', $('name-input').value.trim()); } catch {}
  $('jam-dialog').close(); history.replaceState(null, '', '/'); acceptRoom(result.room); openEvents();
  if (host()) void checkHostOutput();
  const deferred = state.deferredTrack; state.deferredTrack = null;
  if (deferred) void addTrack(deferred.id, deferred.provider); else toast(host() ? 'Your Jam is ready. Invite your people.' : 'You joined the Jam. Add your first song.');
  if (!host() && !order.some(connected) && canSearch(defaultMusicService)) { songSearch.provider = defaultMusicService; setView('search'); }
}
function resetSession() { void stopListening(true); if (appleBrowserPlayer.connected) void appleBrowserPlayer.stop(); state.events?.close(); state.events = null; state.session = null; state.room = null; state.online = false; try { sessionStorage.removeItem('jamama-session'); } catch {} renderRoom(); }
function matchKey(entryId) { return `${state.session?.code}/${state.room?.hostId}/${entryId}`; }
function renderHostMatch(entry) {
  if (!state.room?.hostProvider) return '';
  const match = entry.hostMatch, provider = providerName(match?.provider || state.room.hostProvider);
  const key = matchKey(entry.id), pending = state.matching.has(key), error = state.matchErrors.get(key);
  if (pending) return `<div class="host-match"><span class="match-status" role="status">Finding the host’s version on ${escape(provider)}…</span></div>`;
  if (match?.status === 'matched') {
    const url = safeUrl(match.track?.externalUrl);
    const sameVersion = match.track?.id === entryTrack(entry).id;
    return `<div class="host-match" data-state="matched"><span class="match-status success">Matched on ${escape(provider)}</span>${!sameVersion && match.track ? `<span class="match-status">Host version: ${escape([match.track.title, match.track.album].filter(Boolean).join(' · '))}</span>` : ''}${url && !sameVersion ? `<a class="service-track-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">View host’s version ↗</a>` : ''}</div>`;
  }
  if (match?.status === 'choice_required' && !error) {
    const candidates = (match.candidates || []).map((track) => `<button class="match-button" data-match-entry="${escape(entry.id)}" data-match-track="${escape(track.id)}" aria-label="Use ${escape(track.title)} by ${escape(track.artist)} from ${escape(track.album)} on ${escape(provider)}">${art(track)}<span><strong>${escape(track.title)}</strong><small>${escape(track.artist)} · ${escape(track.album)}${track.duration && track.duration !== '—' ? ` · ${escape(track.duration)}` : ''}</small></span></button>`).join('');
    return `<div class="host-match" data-state="choice"><span class="match-status choice">${host() ? 'Choose a version' : 'The host is choosing a version'} on ${escape(provider)}</span>${host() ? `<details class="match-options"><summary>Review matches</summary><div class="match-candidates">${candidates}</div></details>` : ''}</div>`;
  }
  const messages = { not_found: `No match found on ${provider}.`, connection_required: `Connect the host’s ${provider} account.`, error: `Could not search ${provider}.` };
  const message = error || match?.message || messages[match?.status] || (host() ? `Find this recording on ${provider}.` : `Waiting for the host to find this recording on ${provider}.`);
  const action = match?.status === 'connection_required' ? `<button class="match-button" data-view="accounts">Music accounts</button><button class="match-button" data-match-search="${escape(entry.id)}">Try matching again</button>` : `<button class="match-button" data-match-search="${escape(entry.id)}">${match || error ? 'Try matching again' : `Find on ${escape(provider)}`}</button>`;
  return `<div class="host-match"><span class="match-status ${match || error ? 'warning' : ''}">${escape(message)}</span>${host() ? action : ''}</div>`;
}
async function startMatchedQueue() {
  const room = state.room;
  const decision = autoStartDecision({ room, memberId: state.session?.memberId, playerConnected: room?.hostProvider === 'apple' ? appleBrowserPlayer.connected : room?.playback.connected, busy: playerSetup.busy, autoStartArmed: room?.playback.autoStartArmed, hostOnline: state.online });
  if (!decision.shouldStart) return;
  const key = `${room.code}/${room.hostId}/${room.queue[0].id}`;
  if ((automaticStarts.get(key) || 0) > Date.now()) return;
  if (automaticStarts.size > 200) automaticStarts.clear();
  automaticStarts.set(key, Date.now() + 3000);
  await controlPlayer(decision.action, { automatic: true, entryId: room.queue[0].id });
}
async function matchQueuedTracks() {
  if (!host() || !state.online || !state.room.hostProvider || state.room.hostTransfer || state.matching.size) return;
  const entry = state.room.queue.find((item) => !item.hostMatch && !state.matchAttempts.has(matchKey(item.id)));
  if (entry) await resolveHostMatch(entry.id);
}
async function resolveHostMatch(entryId) {
  if (!host() || !state.online || state.room.hostTransfer) return;
  const key = matchKey(entryId), session = state.session;
  if (state.matching.has(key)) return;
  state.matching.add(key); state.matchAttempts.add(key); state.matchErrors.delete(key); renderRoom();
  try {
    const room = await api(`/api/rooms/${session.code}/queue/match/search`, { method: 'POST', body: { entryId } });
    if (state.session === session) {
      acceptRoom(room);
      if (room.queue.find((entry) => entry.id === entryId)?.hostMatch?.status === 'connection_required') await refreshConnectionsAfterMatch();
    }
  }
  catch (error) { if (state.session === session) state.matchErrors.set(key, error.message); }
  finally { state.matching.delete(key); if (state.session === session) renderRoom(); void matchQueuedTracks(); }
}
async function selectHostMatch(entryId, trackId) {
  if (!host() || !state.online || state.room.hostTransfer) return;
  const key = matchKey(entryId), session = state.session;
  if (state.matching.has(key)) return;
  state.matching.add(key); state.matchErrors.delete(key); renderRoom();
  try { const room = await api(`/api/rooms/${session.code}/queue/match/select`, { method: 'POST', body: { entryId, trackId } }); if (state.session === session) { acceptRoom(room); toast('The host’s version is selected.', 'success'); } }
  catch (error) { if (state.session === session) state.matchErrors.set(key, error.message); }
  finally { state.matching.delete(key); if (state.session === session) renderRoom(); void matchQueuedTracks(); }
}
function renderTaste() {
  const room = state.room, comparison = room?.taste || { participants: [], pairs: [], songs: [] };
  if (tastePages.revision !== comparison.revision) { tastePages.revision = comparison.revision; tastePages.pair = ''; tastePages.items = []; tastePages.nextOffset = null; }
  const provider = chooseConnectedMusicService(tasteUI.provider, connected);
  const playlists = state.playlists.get('apple');
  const own = comparison.participants.find((person) => person.memberId === state.session?.memberId);
  const key = JSON.stringify({ room: room?.code, members: room?.members, comparison, pages: tastePages, own: state.session?.memberId, provider, playlistId: tasteUI.playlistId, pair: tasteUI.pair, busy: tasteUI.busy, error: tasteUI.error, pending: [...tasteUI.pending], playlists, connected: [connected('apple'), connected('spotify')], loading: state.loading.has('apple') });
  if (tasteRenderKey === key) return;
  tasteRenderKey = key;
  if (!room) { $('taste-content').innerHTML = '<div class="taste-empty"><h2>Good taste is better together.</h2><p>Start or join a Jam to compare your favorites with friends.</p><button class="button primary" data-action="start-taste-jam">Start a Jam</button><button class="button secondary" data-action="join-taste-jam">Join a Jam</button></div>'; return; }
  const memberName = (id) => room.members.find((member) => member.id === id)?.name || 'Friend';
  const lists = playlists?.items || [];
  const selectedPlaylist = lists.some((list) => list.id === tasteUI.playlistId) ? tasteUI.playlistId : lists.find((list) => /^(favorite songs|favourite songs|收藏歌曲|喜愛的歌曲)$/i.test(list.name))?.id || '';
  tasteUI.playlistId = selectedPlaylist;
  const options = lists.map((list) => `<option value="${escape(list.id)}" ${list.id === selectedPlaylist ? 'selected' : ''}>${escape(list.name)}</option>`).join('');
  const sourceControl = `<label for="taste-provider">Your music service</label><select id="taste-provider" ${tasteUI.busy ? 'disabled' : ''}><option value="spotify" ${provider === 'spotify' ? 'selected' : ''}>Spotify · Liked Songs</option><option value="apple" ${provider === 'apple' ? 'selected' : ''}>Apple Music · Choose a playlist</option></select>${provider === 'apple' && connected('apple') ? `<label for="taste-playlist">Favorite Songs, or another playlist</label><select id="taste-playlist" ${tasteUI.busy || state.loading.has('apple') ? 'disabled' : ''}><option value="">${state.loading.has('apple') ? 'Loading playlists…' : 'Choose a playlist'}</option>${options}</select>${playlists?.nextOffset != null ? '<button class="text-button" data-taste-more>Load more playlists</button>' : ''}` : ''}`;
  const shareButton = connected(provider) ? `<button class="button primary" data-taste-share ${tasteUI.busy || (provider === 'apple' && (state.loading.has('apple') || !selectedPlaylist)) ? 'disabled' : ''}>${tasteUI.busy ? 'Reading your songs…' : own ? 'Refresh my taste' : 'Share my taste'}</button>` : `<button class="button primary" data-view="accounts">Connect ${providerName(provider)}</button>`;
  const people = comparison.participants.map((person) => `<div class="taste-person">${badge(person.provider)}<div><strong>${escape(memberName(person.memberId))}${person.memberId === state.session.memberId ? ' · you' : ''}</strong><span>${escape(person.source.name)} · ${person.count} ${person.count === 1 ? 'song' : 'songs'}</span></div></div>`).join('');
  const pairs = comparison.pairs.map((pair) => `<button class="taste-pair ${tasteUI.pair === pair.memberIds.join(':') ? 'active' : ''}" data-taste-pair="${pair.memberIds.join(':')}" aria-pressed="${tasteUI.pair === pair.memberIds.join(':')}"><span>${pair.memberIds.map((id) => escape(memberName(id))).join(' + ')}</span><strong>${pair.shared} shared ${pair.shared === 1 ? 'song' : 'songs'}</strong><small>${pair.percentage == null ? 'No songs to compare yet' : `${pair.percentage}% of your combined songs`}</small></button>`).join('');
  if (tasteUI.pair && !comparison.pairs.some((pair) => pair.memberIds.join(':') === tasteUI.pair)) tasteUI.pair = '';
  const selectedMembers = tasteUI.pair ? tasteUI.pair.split(':') : [];
  const songs = (tastePages.items.length && tastePages.pair === tasteUI.pair ? tastePages.items : comparison.songs).filter((song) => selectedMembers.every((id) => song.likedBy.includes(id)));
  const totalSongs = tasteUI.pair ? comparison.pairs.find((pair) => pair.memberIds.join(':') === tasteUI.pair)?.shared || 0 : comparison.totalSongs || 0;
  const songRows = songs.map((song) => `<li class="taste-song">${art(song.track)}<div class="track-info"><strong>${escape(song.track.title)}</strong><p>${escape(song.track.artist)}</p><span class="taste-liked-by">Shared by ${song.likedBy.map((id) => escape(memberName(id))).join(', ')}</span></div><button class="add-button" data-taste-song="${song.id}" aria-label="Add shared song ${escape(song.track.title)} to queue" ${tasteUI.pending.has(song.id) ? 'disabled' : ''}>+</button></li>`).join('');
  const empty = comparison.participants.length < 2 ? 'Each friend taps Share my taste. Your overlaps will appear here.' : songs.length ? '' : totalSongs ? 'Loading your shared songs…' : 'No overlapping songs in these selections yet. Try another playlist or refresh after adding favorites.';
  $('taste-content').innerHTML = `<section class="taste-share" aria-label="Your taste sharing"><div><h2>${own ? 'Your taste is shared with this Jam.' : 'Bring your favorites.'}</h2><p>Share a selection to find songs in common.</p></div><div class="taste-source">${sourceControl}<div class="taste-share-actions">${shareButton}${own ? `<button class="text-button" data-taste-stop ${tasteUI.busy ? 'disabled' : ''}>Stop sharing</button>` : ''}</div></div>${tasteUI.error ? `<p class="inline-error" role="alert">${escape(tasteUI.error)}</p>` : ''}${tasteUI.busy ? '<p class="field-help" role="status">Reading every page so the comparison includes all your songs.</p>' : own ? '<p class="field-help">Refresh reads your latest songs. You can refresh every 30 seconds.</p>' : ''}</section><div class="taste-people">${people || '<p class="section-note">Nobody has shared their taste yet.</p>'}</div>${pairs ? `<section class="taste-pairs" aria-label="Song overlap between friends">${pairs}</section><details class="taste-explanation"><summary>How the comparison works</summary><p>Shared songs ÷ unique songs across both selections. Recording IDs match first; otherwise, title, artist and duration must agree.</p></details>` : ''}<div class="section-title taste-results-heading"><h2>Songs in common <span class="muted">${totalSongs}</span></h2>${tasteUI.pair ? '<button class="text-button" data-taste-pair="">Show everyone</button>' : ''}</div>${empty ? `<p class="taste-empty-note" role="status">${empty}</p>` : `<ul class="taste-songs" aria-label="Songs in common">${songRows}</ul>`}`;
  if (totalSongs > songs.length) $('taste-content').insertAdjacentHTML('beforeend', `<div class="load-more"><button class="button secondary" data-taste-more-songs ${tastePages.loading ? 'disabled' : ''}>${tastePages.loading ? 'Loading shared songs…' : `Show more shared songs (${songs.length} of ${totalSongs})`}</button></div>`);
  icons($('taste-content'));
}
async function loadTasteSongs(more = false) {
  if (!state.session || tastePages.loading) return;
  const code = state.session.code, revision = state.room.taste?.revision, pair = tasteUI.pair;
  const loaded = tastePages.pair === pair && tastePages.items.length ? tastePages.items : (pair ? [] : state.room.taste.songs);
  const offset = more ? (tastePages.items.length && tastePages.pair === pair ? tastePages.nextOffset : loaded.length) : 0;
  if (more && offset == null) return;
  tastePages.loading = true; renderTaste();
  try {
    const page = await api(`/api/rooms/${code}/taste?offset=${offset}&pair=${encodeURIComponent(pair)}`);
    if (state.session?.code === code && state.room.taste?.revision === revision && page.revision === revision && tasteUI.pair === pair) Object.assign(tastePages, { revision, pair, items: more ? [...loaded, ...page.items] : page.items, nextOffset: page.nextOffset, totalSongs: page.totalSongs });
  } catch (error) { toast(error.message, 'error'); }
  finally {
    tastePages.loading = false; renderTaste();
    if (state.session?.code === code && (tasteUI.pair !== pair || state.room.taste?.revision !== revision)) void loadTasteSongs();
  }
}
async function shareTaste() {
  if (!state.session || tasteUI.busy) return;
  const code = state.session.code, provider = $('taste-provider').value;
  const playlistId = provider === 'apple' ? $('taste-playlist')?.value : undefined;
  tasteUI.provider = provider; tasteUI.playlistId = playlistId || ''; tasteUI.busy = true; tasteUI.error = ''; renderTaste();
  try {
    const room = await api(`/api/rooms/${code}/taste`, { method: 'POST', body: { provider, playlistId } });
    if (state.session?.code === code) { acceptRoom(room); toast('Your taste is shared with this Jam.', 'success'); }
  } catch (error) { if (state.session?.code === code) tasteUI.error = error.message; }
  finally { tasteUI.busy = false; renderTaste(); }
}
async function stopSharingTaste() {
  if (!state.session || tasteUI.busy) return;
  const code = state.session.code; tasteUI.error = ''; tasteUI.busy = true; renderTaste();
  try { const room = await api(`/api/rooms/${code}/taste`, { method: 'DELETE', body: {} }); if (state.session?.code === code) acceptRoom(room); }
  catch (error) { tasteUI.error = error.message; }
  finally { tasteUI.busy = false; renderTaste(); }
}
async function queueTasteSong(songId) {
  if (!state.session || tasteUI.pending.has(songId)) return;
  const code = state.session.code; tasteUI.pending.add(songId); renderTaste();
  try { const result = await api(`/api/rooms/${code}/taste/queue`, { method: 'POST', body: { songId, requestId: crypto.randomUUID() } }); if (state.session?.code === code) { acceptRoom(result.room); toast('Shared favorite added to the queue.', 'success'); } }
  catch (error) { toast(error.message, 'error'); }
  finally { tasteUI.pending.delete(songId); renderTaste(); }
}
function renderListening() {
  const room = state.room, own = room?.members.find((member) => member.id === state.session?.memberId);
  const panel = $('listening-panel'); panel.hidden = !room;
  if (!room) return;
  const everyone = room.listeningMode === 'everyone';
  if (!everyone && listeningUI.active) void stopListening(true);
  const provider = listeningUI.provider || (connected('apple') ? 'apple' : connected('spotify') ? 'spotify' : 'apple');
  const status = own?.listener || listeningUI.status;
  const key = JSON.stringify({ code: room.code, everyone, automatic: room.listeningAutomatic, output: room.output?.kind, detection: outputDetectionAvailable, handoff: room.hostTransfer, host: host(), provider, ui: { ...listeningUI, clockOffset: undefined }, status, playing: room.playback.playing, starting: room.playback.starting, source: room.nowPlaying?.id, accounts: [connected('apple'), connected('spotify')], spotify: state.connections.providers.spotify?.player, online: state.online });
  if (key === listeningRenderKey) return;
  listeningRenderKey = key;
  let body = `<div class="listening-switch" role="group" aria-label="Jam listening mode"><button data-listening-mode="speaker" aria-pressed="${!everyone}" ${!host() || room.hostTransfer || listeningUI.busy ? 'disabled' : ''}>One speaker</button><button data-listening-mode="everyone" aria-pressed="${everyone}" ${!host() || room.hostTransfer || listeningUI.busy ? 'disabled' : ''}>Every device</button></div><p class="listening-caption">${everyone ? 'Apart? Each person listens with their own music account.' : 'Together? Audio plays on the host. Everyone can queue as a guest.'}</p>`;
  if (host()) body += outputDetectionAvailable ? `<label class="automatic-output"><input id="automatic-output" type="checkbox" ${room.listeningAutomatic !== false ? 'checked' : ''} ${room.hostTransfer || listeningUI.busy ? 'disabled' : ''}>Use one speaker for Bluetooth / AirPlay</label><p class="listening-note">${room.output?.sharedOutput ? `${room.output.kind === 'airplay' ? 'AirPlay' : 'Bluetooth'} is the active Mac output.${everyone ? ' Remote listening is your manual override.' : ' Audio stays on the host.'}` : room.output?.kind === 'built-in' ? 'Using the Mac’s built-in audio. Bluetooth headphones also count as Bluetooth output.' : room.output?.kind === 'spotify-connect' ? 'Spotify Connect chooses its own output. Use the listening toggle for that device.' : 'Checks this Mac’s selected audio output, not who is nearby.'}</p>` : '<p class="listening-note">Choose the mode here. This browser can’t detect its Bluetooth audio output.</p>';
  if (everyone && host()) body += '<p class="listening-note">Your host player supplies your audio. Friends tap Listen on their devices. Each listener needs their own subscription.</p>';
  if (everyone && !host()) {
    if (listeningUI.active) {
      const label = status?.status === 'playing' ? Math.abs(status.drift || 0) > 1500 ? 'Adjusting timing…' : 'Listening in sync' : status?.status === 'paused' ? 'Waiting for the host' : status?.status === 'stopped' ? 'Stopped in your music app' : status?.status === 'error' ? 'Listening needs attention' : 'Syncing your player…';
      body += `<div class="listener-status" role="status"><strong>${label}</strong><span>${providerName(provider)}${status?.error ? ` · ${escape(status.error)}` : ''}</span></div><button class="button secondary full" data-listening-stop>Stop listening here</button>`;
    } else {
      body += `<label class="field-label" for="listener-provider">Listen with</label><select id="listener-provider" ${listeningUI.busy ? 'disabled' : ''}><option value="apple" ${provider === 'apple' ? 'selected' : ''}>Apple Music · This tab</option><option value="spotify" ${provider === 'spotify' ? 'selected' : ''}>Spotify · My Spotify app</option></select>`;
      if (!connected(provider)) body += `<button class="button primary full" data-view="accounts">Connect ${providerName(provider)}</button><p class="listening-note">Connecting is optional for queueing. Listening remotely needs your own subscription.</p>`;
      else if (provider === 'spotify' && !state.connections.providers.spotify.player.webAuthorized) {
        const url = state.connections.providers.spotify.player.listenConnectUrl;
        body += url ? `<a class="button primary full" href="${escape(url)}">Enable Spotify listening</a><p class="listening-note">Authorize control of your Spotify playback. Spotify Premium and an approved beta account are required.</p>` : '<p class="listening-note">Spotify sign-in at this beta address still needs the owner’s setup. Apple Music and guest queueing are available.</p>';
      } else {
        if (provider === 'spotify') body += `<label class="field-label" for="listener-device">Your Spotify device</label><select id="listener-device" ${listeningUI.busy ? 'disabled' : ''}><option value="">Choose your device</option>${listeningUI.devices.map((device) => `<option value="${escape(device.id)}" ${device.id === listeningUI.deviceId ? 'selected' : ''}>${escape(device.name)}${device.active ? ' · active' : ''}</option>`).join('')}</select><button class="text-button" data-listening-devices>Refresh devices</button><p class="listening-note">Open Spotify on your device first. Listening here moves this account’s playback to your selected device.</p>`;
        const match = listeningUI.match;
        if (match?.status === 'choice_required') body += `<div class="match-candidates">${match.candidates.map((track) => `<button class="match-button" data-listener-track="${escape(track.id)}">${art(track)}<span><strong>${escape(track.title)}</strong><small>${escape(track.album)} · ${escape(track.duration)}</small></span></button>`).join('')}</div>`;
        const ready = match?.status === 'matched' && !listeningUI.preparing && !listeningUI.busy && !listeningUI.error && hostIsPlaying(room, Date.now() + listeningUI.clockOffset) && (provider === 'spotify' ? listeningUI.deviceId : appleListener.prepared);
        body += `<button class="button primary full" data-listening-start ${ready ? '' : 'disabled'}>${listeningUI.preparing ? 'Preparing your player…' : 'Listen on this device'}</button>`;
        if (!room.playback.playing) body += '<p class="listening-note">The host must start a song before you tap Listen.</p>';
        if (match?.status === 'not_found') body += `<p class="listening-note">${escape(match.message)}</p>`;
      }
    }
    if (listeningUI.error) body += `<p class="inline-error" role="alert">${escape(listeningUI.error)}</p><button class="text-button" data-listening-retry>Try again</button>`;
  }
  panel.innerHTML = body;
  if (everyone && !host() && connected(provider) && !listeningUI.active && !listeningUI.preparing && !listeningUI.busy && (provider !== 'spotify' || state.connections.providers.spotify.player.webAuthorized)) void prepareListening();
}
async function setListeningMode(mode, automatic) {
  if (!host() || listeningUI.busy) return;
  listeningUI.busy = true; renderListening();
  const overridesOutput = mode === 'everyone' && state.room.output?.sharedOutput;
  try { acceptRoom(await api(`/api/rooms/${state.session.code}/listening-mode`, { method: 'POST', body: { mode, automatic: automatic ?? (overridesOutput ? false : state.room.listeningAutomatic !== false) } })); if (automatic === true) void checkHostOutput(); }
  catch (error) { toast(error.message, 'error'); }
  finally { listeningUI.busy = false; renderListening(); }
}
async function prepareListening(trackId) {
  if (!state.session || host() || state.room.listeningMode !== 'everyone' || listeningUI.active || listeningUI.preparing) return;
  const provider = listeningUI.provider || (connected('apple') ? 'apple' : 'spotify');
  const key = `${state.session.code}/${provider}/${state.room.nowPlaying?.id || ''}`;
  if (!trackId && listeningUI.key === key) return;
  const version = ++listeningUI.version, code = state.session.code;
  listeningUI.key = key; listeningUI.provider = provider; listeningUI.preparing = true; listeningUI.error = ''; renderListening();
  try {
    let best;
    for (let i = 0; i < 3; i++) { const start = Date.now(), clock = await api('/api/clock'), end = Date.now(); if (!best || end - start < best.rtt) best = { rtt: end - start, offset: clock.serverTime - (start + end) / 2 }; }
    const result = await api(`/api/rooms/${code}/listener/resolve`, { method: 'POST', body: { provider, trackId } });
    if (version !== listeningUI.version || state.session?.code !== code || state.room.listeningMode !== 'everyone') return;
    listeningUI.clockOffset = best.offset; listeningUI.match = result.match;
    if (provider === 'apple' && result.match.status === 'matched') {
      if (!appleAuthorization.ready && !await prepareAppleMusic()) throw new Error('Apple Music could not prepare listening.');
      await appleListener.prepare(state.room, result.match);
    }
    if (provider === 'spotify' && !listeningUI.devices.length) await loadListeningDevices();
  } catch (error) { if (version === listeningUI.version) listeningUI.error = error.message; }
  finally { listeningUI.preparing = false; renderListening(); }
}
async function loadListeningDevices() {
  if (!state.session) return;
  try { const result = await api(`/api/rooms/${state.session.code}/listener/devices`); listeningUI.devices = result.devices.filter((device) => !device.restricted); listeningUI.deviceId ||= listeningUI.devices.find((device) => device.active)?.id || listeningUI.devices[0]?.id || ''; }
  catch (error) { listeningUI.error = error.message; }
  renderListening();
}
async function startListening() {
  if (!state.session || listeningUI.busy || listeningUI.active || !listeningUI.match?.track) return;
  const code = state.session.code, provider = listeningUI.provider;
  let playPromise;
  if (provider === 'apple') { try { playPromise = appleListener.unlock(); playPromise.catch(() => {}); } catch (error) { listeningUI.error = error.message; renderListening(); return; } }
  listeningUI.busy = true; listeningUI.error = ''; renderListening();
  try {
    const result = await api(`/api/rooms/${code}/listener/connect`, { method: 'POST', body: { provider, deviceId: listeningUI.deviceId, sourceKey: listeningUI.match.sourceKey, trackId: listeningUI.match.track.id } });
    if (state.session?.code !== code || state.room.listeningMode !== 'everyone') throw new Error('The Jam changed before listening connected.');
    listeningUI.active = true; listeningUI.generation = result.listener.generation; acceptRoom(result.room);
    if (provider === 'apple') await appleListener.start({ code, generation: result.listener.generation, memberId: state.session.memberId }, playPromise, listeningUI.clockOffset);
  } catch (error) { await appleListener.stop(); listeningUI.active = false; listeningUI.error = error.message; }
  finally { listeningUI.busy = false; renderListening(); renderPlayer(); }
}
async function stopListening(quiet = false) {
  const code = state.session?.code, generation = listeningUI.generation;
  listeningUI.active = false; listeningUI.generation = null; listeningUI.version++; listeningUI.key = ''; listeningUI.status = null;
  await appleListener.stop();
  if (code && generation) { try { const room = await api(`/api/rooms/${code}/listener/disconnect`, { method: 'POST', body: { generation } }); if (state.session?.code === code) acceptRoom(room); } catch (error) { if (!quiet) toast(error.message, 'error'); } }
  renderListening(); renderPlayer();
}
function renderHandoff() {
  const room = state.room, transfer = room?.hostTransfer;
  const key = JSON.stringify({ room: room?.code, transfer, host: host(), members: room?.members, accounts: [connected('spotify'), connected('apple')], ui: handoffUI });
  if (key === handoffRenderKey) return; handoffRenderKey = key;
  const panel = $('handoff-panel'); panel.hidden = !transfer;
  if (!transfer) return;
  const target = room.members.find((member) => member.id === transfer.toId)?.name || 'Friend';
  const isTarget = transfer.toId === state.session?.memberId, ready = transfer.phase === 'ready';
  let body = transfer.phase === 'switching' ? '<strong>Transferring host…</strong><p>Keeping your queue. Waiting for the old player to stop.</p>' : isTarget ? '<strong>You’ve been invited to host.</strong><p>Choose your own music service. You’ll connect playback after accepting.</p>' : `<strong>Handoff to ${escape(target)}</strong><p>${ready ? 'Waiting for them to accept.' : 'Waiting for the old player to confirm it is paused.'}</p>`;
  if (isTarget && transfer.phase !== 'switching') {
    handoffUI.provider = chooseConnectedMusicService(handoffUI.provider, connected);
    body += `<label class="field-label" for="handoff-service">Your music service</label><select id="handoff-service"><option value="apple" ${handoffUI.provider === 'apple' ? 'selected' : ''}>Apple Music</option><option value="spotify" ${handoffUI.provider === 'spotify' ? 'selected' : ''}>Spotify</option></select>`;
    body += connected(handoffUI.provider) ? `<button class="button primary full" data-host-accept ${!ready || handoffUI.busy ? 'disabled' : ''}>Accept host role</button>` : `<button class="button primary full" data-view="accounts">Connect ${providerName(handoffUI.provider)}</button>`;
  }
  if ((host() || isTarget) && transfer.phase !== 'switching') body += `<button class="text-button" data-host-cancel ${handoffUI.busy ? 'disabled' : ''}>${isTarget ? 'Decline' : 'Cancel handoff'}</button>`;
  if (handoffUI.error) body += `<p class="inline-error" role="alert">${escape(handoffUI.error)}</p>`;
  panel.innerHTML = body;
}
function showHandoff() {
  if (!host() || state.room.hostTransfer) return;
  const people = state.room.members.filter((member) => member.id !== state.room.hostId && member.online);
  $('handoff-person').innerHTML = people.map((member) => `<option value="${escape(member.id)}">${escape(member.name)}</option>`).join('');
  $('handoff-error').hidden = true; $('handoff-offer').disabled = !people.length;
  if (!people.length) { $('handoff-error').textContent = 'A friend must be online in this Jam first.'; $('handoff-error').hidden = false; }
  $('handoff-dialog').showModal();
}
async function offerHandoff() {
  if (!host() || handoffUI.busy) return;
  const code = state.session.code;
  handoffUI.busy = true; $('handoff-offer').disabled = true; $('handoff-error').hidden = true;
  try {
    const result = await api(`/api/rooms/${code}/host/offer`, { method: 'POST', body: { memberId: $('handoff-person').value, generation: appleBrowserPlayer.generation } });
    if (state.session?.code !== code) return;
    acceptRoom(result.room);
    if (result.command) await appleBrowserPlayer.execute(result.command);
    $('handoff-dialog').close(); toast('Handoff offered. Your friend can accept now.');
  } catch (error) { $('handoff-error').textContent = error.message; $('handoff-error').hidden = false; }
  finally { handoffUI.busy = false; $('handoff-offer').disabled = false; renderHandoff(); }
}
async function respondHandoff(action) {
  if (!state.room?.hostTransfer || handoffUI.busy) return;
  const code = state.session.code, transferId = state.room.hostTransfer.id;
  handoffUI.busy = true; handoffUI.error = ''; renderHandoff();
  try {
    if (action === 'accept' && listeningUI.active) await stopListening(true);
    const room = await api(`/api/rooms/${code}/host/${action}`, { method: 'POST', body: { transferId, provider: handoffUI.provider } });
    if (state.session?.code === code) acceptRoom(room);
  } catch (error) { handoffUI.error = error.message; }
  finally { handoffUI.busy = false; renderHandoff(); }
}
async function checkHostOutput() {
  if (!host() || !outputDetectionAvailable || state.room.hostTransfer || outputCheckBusy) return;
  const code = state.session.code; outputCheckBusy = true;
  try { const room = await api(`/api/rooms/${code}/host/output`, { method: 'POST', body: {} }); if (state.session?.code === code && host()) acceptRoom(room); }
  catch (error) { if (error.code === 'local_output_only') outputDetectionAvailable = false; }
  finally { outputCheckBusy = false; }
}
function renderRoom() {
  renderHandoff();
  renderListening();
  renderTaste();
  const room = state.room;
  $('jam-status').classList.toggle('reconnecting', Boolean(room && !state.online));
  $('queue-count').textContent = room?.queue.length || 0; $('mobile-queue-count').textContent = room?.queue.length || 0;
  $('room-members').hidden = !room; $('queue-empty').hidden = Boolean(room?.queue.length); $('start-button').hidden = Boolean(room); $('join-button').innerHTML = room ? `${icon('radio')}Invite friends` : `${icon('radio')}Join a Jam`;
  const statusKey = JSON.stringify({ code: room?.code, title: room?.title, online: state.online, count: room?.members.length, host: host(), provider: room?.hostProvider });
  if (statusKey !== jamStatusKey) {
    jamStatusKey = statusKey;
    $('jam-status').innerHTML = room ? `<span class="status-dot ${state.online ? 'live' : ''}"></span><div><strong>${escape(room.title || 'Your Jam')}</strong><small>${state.online ? `${host() ? 'You’re hosting' : `${escape(room.members.find(person => person.id === room.hostId)?.name || 'Host')} hosts`} · ${escape(providerName(room.hostProvider))}` : 'Reconnecting…'}</small></div><button data-action="leave">${host() ? 'End' : 'Leave'}</button>` : '<span class="status-dot"></span>No active Jam yet.';
  }
  const actionKey = JSON.stringify({ code: room?.code, host: host(), connected: room?.playback.connected, transfer: Boolean(room?.hostTransfer), online: state.online });
  if (actionKey !== jamActionsKey) {
    jamActionsKey = actionKey;
    $('jam-actions').hidden = !room;
    $('jam-actions').innerHTML = room ? `${host() ? `<button class="button ${room.playback.connected ? 'secondary' : 'primary'} compact" data-player-settings ${!state.online || room.hostTransfer ? 'disabled' : ''}>${room.playback.connected ? 'Playback settings' : 'Enable playback'}</button><button class="button secondary compact" data-host-offer ${!state.online || room.hostTransfer ? 'disabled' : ''}>Change host</button>` : ''}<button class="button secondary compact" data-action="invite">Invite friends</button>` : '';
  }
  $('queue-empty').querySelector('h3').textContent = room ? 'What should play next?' : 'Start something together.';
  $('queue-empty').querySelector('p').innerHTML = room ? 'Open Library or Search, then tap <b>+</b> to add a song.' : 'Start a Jam to play from your account.<br>Join a friend’s Jam to choose songs together.';
  $('queue-start').textContent = room ? 'Browse your library' : 'Start a Jam'; $('queue-join').textContent = room ? 'Invite friends' : 'Join a Jam'; $('queue-join').hidden = Boolean(room);
  const queueKey = JSON.stringify({ code: room?.code, queue: room?.queue || [], host: host(), member: state.session?.memberId, matching: [...state.matching], errors: [...state.matchErrors], macControl: state.connections.providers.qq?.capabilities?.localControl, starting: room?.playback.pendingEntryId });
  if (queueKey !== queueRenderKey) {
  queueRenderKey = queueKey;
  $('queue-list').innerHTML = (room?.queue || []).map((entry, index) => {
    const track = entryTrack(entry), canRemove = host() || entry.addedBy === state.session.memberId;
    const qqOpen = host() && (!room.hostProvider || room.hostProvider === 'qq') && track.provider === 'qq' && track.isDemo === false && state.connections.providers.qq?.capabilities?.localControl;
    return `<li class="queue-entry"><span class="queue-number">${index + 1}</span>${art(track)}<div class="track-info"><strong>${escape(track.title)}</strong><p>${escape(track.artist)}</p><span class="queued-by">${badge(entry.provider)}${escape(entry.name)}${entry.addedBy === state.session.memberId ? ' · you' : ''}</span>${renderHostMatch(entry)}${qqOpen ? `<button class="qq-open-button" data-qq-open="${escape(entry.id)}" title="Experimental: sends a request to QQ Music on this Mac. Automatic song selection has not passed testing.">Try Mac handoff · experimental</button>` : ''}${safeUrl(track.externalUrl) ? `<a class="service-track-link" href="${escape(safeUrl(track.externalUrl))}" target="_blank" rel="noopener noreferrer">View in ${providerName(entry.provider)} ↗</a>` : ''}</div>${canRemove ? `<button class="remove-button" data-remove="${escape(entry.id)}" aria-label="Remove ${escape(track.title)} from queue">×</button>` : ''}</li>`;
  }).join('');
  }
  if (room) {
    $('member-count').textContent = `${room.members.length}`;
    const membersKey = JSON.stringify(room.members);
    if (membersKey !== membersRenderKey) { membersRenderKey = membersKey; $('member-list').innerHTML = room.members.map((member) => `<span class="member-chip ${member.online ? '' : 'offline'}">${badge(member.provider)}${escape(member.name)}${member.id === room.hostId ? ' · host' : member.id === state.session.memberId ? ' · you' : ''}${member.online ? '' : ' · offline'}</span>`).join(''); }
    const own = room.members.find((member) => member.id === state.session.memberId); if (own) $('profile-button').textContent = own.name.slice(0, 1).toUpperCase();
  }
  renderPlayer();
}
function updateAddButtons(trackId) {
  const pending = state.pending.has(trackId), queued = (recentlyQueued.get(trackId) || 0) > Date.now();
  const title = trackFor(trackId)?.title || 'Song';
  document.querySelectorAll('[data-track]').forEach((button) => {
    if (button.dataset.track !== trackId) return;
    button.disabled = pending; button.textContent = pending ? '…' : queued ? '✓' : '+';
    button.classList.toggle('just-queued', queued);
    button.setAttribute('aria-label', queued ? `${title} queued · add again` : `Add ${title} to shared queue`);
    button.setAttribute('aria-busy', String(pending)); button.title = queued ? 'Added to queue' : 'Add to queue';
  });
}
async function addTrack(trackId, provider) {
  if (!state.room) { state.deferredTrack = { id: trackId, provider }; openJam('create'); return; }
  if (!state.online) return toast('Reconnecting to your Jam. Try again in a moment.', 'warning');
  if (state.pending.has(trackId)) return;
  const session = state.session;
  state.pending.add(trackId); updateAddButtons(trackId);
  try {
    const result = await api(`/api/rooms/${session.code}/queue`, { method: 'POST', body: { trackId, provider: provider || trackFor(trackId)?.provider || chooseVisibleMusicService(state.provider), requestId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` } });
    if (state.session !== session) return;
    acceptRoom(result.room);
    const expires = Date.now() + 2400; recentlyQueued.set(trackId, expires);
    setTimeout(() => { if (recentlyQueued.get(trackId) === expires) { recentlyQueued.delete(trackId); updateAddButtons(trackId); } }, 2400);
    toast(`${trackFor(trackId)?.title || 'Song'} added to the queue`, 'success');
  } catch (error) { if (state.session === session) toast(error.message, 'error'); }
  finally { state.pending.delete(trackId); updateAddButtons(trackId); }
}
async function removeEntry(entryId) { try { acceptRoom(await api(`/api/rooms/${state.session.code}/queue`, { method: 'DELETE', body: { entryId } })); } catch (error) { toast(error.message, 'error'); } }
async function openQQ(entryId, button) { if (button) button.disabled = true; try { const result = await api(`/api/rooms/${state.session.code}/qq/open`, { method: 'POST', body: { entryId } }); toast(result.message || 'Sent to QQ Music on this Mac. Use QQ Music to control playback.', 'warning'); } catch (error) { toast(error.message, 'error'); } finally { if (button?.isConnected) button.disabled = false; } }
function setEntryMode(mode) {
  const invited = mode === 'join' && inviteCode;
  state.mode = mode; $('create-tab').classList.toggle('active', mode === 'create'); $('join-tab').classList.toggle('active', mode === 'join'); $('create-tab').setAttribute('aria-pressed', String(mode === 'create')); $('join-tab').setAttribute('aria-pressed', String(mode === 'join'));
  $('jam-dialog-title').textContent = mode === 'create' ? 'Start a Jam' : invited ? 'Join this Jam' : 'Join your people.'; $('jam-dialog-caption').textContent = mode === 'create' ? 'Your friends bring the songs. You share one queue.' : invited ? 'Choose your name. You can request songs without signing in.' : 'Find an available Jam and jump into the queue.';
  $('nearby-section').hidden = mode !== 'join' || Boolean(invited); $('create-provider-field').hidden = mode !== 'create'; $('enter-button').textContent = mode === 'create' ? 'Start a Jam' : invited ? 'Join Jam' : 'Join with code'; $('enter-button').hidden = mode === 'join' && !invited && !$('code-fallback').open; $('entry-error').hidden = true;
  clearInterval(state.nearbyTimer); state.nearbyTimer = null;
  if (mode === 'join' && !invited) { void loadNearby(); state.nearbyTimer = setInterval(loadNearby, 5000); }
}
function openJam(mode) { if (state.room) return showInvite(); $('room-provider').value = chooseConnectedMusicService(connected(state.provider) ? state.provider : null, connected); setEntryMode(mode); $('jam-dialog').showModal(); }
async function loadNearby() {
  if (state.mode !== 'join') return;
  try {
    const result = await api('/api/nearby'); if (state.mode !== 'join') return;
    $('nearby-list').innerHTML = result.rooms?.length ? result.rooms.map((room) => `<button class="nearby-room" type="button" data-nearby="${escape(room.code)}">${badge(room.hostProvider)}<div><strong>${escape(room.hostName)}’s Jam</strong><small>${escape(room.title)} · ${room.memberCount} ${room.memberCount === 1 ? 'person' : 'people'}</small></div><span>Join →</span></button>`).join('') : `<p class="nearby-empty">${result.enabled === false ? escape(result.message || 'Jam discovery is not enabled on this server. Use a room code below.') : 'No Jams are open yet. Ask a friend to start one on this Jamama server.'}</p>`;
    const notice = $('nearby-section').querySelector('.field-help'); notice.textContent = result.rooms?.some((room) => room.localOnly === false) ? result.message : 'On this Jamama server';
  } catch { $('nearby-list').innerHTML = '<p class="nearby-empty">Use a room code below to join a friend’s Jam.</p>'; }
}
async function submitRoom(code) {
  if (state.busy || !$('name-input').reportValidity()) return;
  const joining = state.mode === 'join'; const roomCode = code || $('code-input').value.trim().toUpperCase();
  if (joining && !/^[A-Z2-9]{6}$/.test(roomCode)) { $('entry-error').textContent = 'Enter the six-character room code or choose an available Jam.'; $('entry-error').hidden = false; return; }
  state.busy = true; $('enter-button').disabled = true; $('entry-error').hidden = true;
  const provider = joining ? order.find(connected) || 'guest' : $('room-provider').value;
  try { enterRoom(await api(joining ? `/api/rooms/${roomCode}/join` : '/api/rooms', { method: 'POST', body: { name: $('name-input').value, provider, ...(joining ? { inviteToken: invitationToken } : {}) } })); }
  catch (error) { $('entry-error').textContent = error.message; $('entry-error').hidden = false; }
  finally { state.busy = false; $('enter-button').disabled = false; }
}
async function showInvite() {
  if (!state.room) return; $('invite-code').textContent = state.room.code; $('invite-url').textContent = state.room.inviteUrl;
  $('invite-lock').hidden = !host(); $('invite-lock').textContent = state.room.locked ? 'Allow new joins' : 'Lock new joins';
  const code = state.session.code, token = state.session.token;
  $('qr-box').textContent = 'Preparing invitation…'; $('invite-dialog').showModal();
  try {
    const response = await fetch(`/api/rooms/${code}/qr`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('The invitation could not be loaded. Try again.');
    const blob = await response.blob();
    if (!$('invite-dialog').open || state.session?.code !== code) return;
    if (invitationImageUrl) URL.revokeObjectURL(invitationImageUrl);
    invitationImageUrl = URL.createObjectURL(blob);
    const image = new Image(); image.alt = 'Scan to join this Jam'; image.src = invitationImageUrl; $('qr-box').replaceChildren(image);
  } catch (error) { $('qr-box').textContent = error.message; }
}
async function leaveRoom() {
  if (host()) { $('end-jam-dialog').showModal(); return; }
  await finishLeavingRoom();
}
async function finishLeavingRoom() {
  const code = state.session?.code;
  if (!code) return;
  try { await api(`/api/rooms/${code}/leave`, { method: 'POST', body: {} }); if (state.session?.code === code) resetSession(); toast('You left the Jam.'); }
  catch (error) { toast(error.message, 'error'); }
}
function playerTime(value) { const seconds = Math.floor(Math.max(0, value || 0) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function renderPlayer() {
  $('app-shell').classList.toggle('music-playing', Boolean(state.room?.playback.playing));
  const service = state.room?.hostProvider === 'apple' ? 'Apple Music' : 'Spotify';
  $('player-progress').setAttribute('aria-label', `${service} playback progress`);
  const playback = state.room?.playback, track = playback?.currentTrack || (playback?.connected ? state.room?.nowPlaying?.hostTrack : null);
  const linked = Boolean(playback?.connected), canControl = linked && host() && !state.room.hostTransfer && state.online && !playerSetup.busy && !playback.starting && (state.room.hostProvider !== 'apple' || appleBrowserPlayer.connected);
  const remote = state.room?.listeningMode === 'everyone' && !host();
  $('now-art').innerHTML = track ? art(track) : icon('speaker');
  $('now-title').textContent = playback?.intermission ? 'Spotify advertisement' : track?.title || (linked ? `${service} connected` : 'Playback not linked');
  $('now-artist').textContent = playback?.error || (linked ? `${track?.artist ? `${track.artist} · ` : ''}${playback.status === 'changed' ? `Changed in ${service} · Queue paused` : playback.status === 'waiting_match' ? 'Finding the next recording…' : playback.status === 'finished' ? 'Waiting for the next request' : playback.autoStartArmed && !track ? 'Ready · requests play automatically' : playback.status === 'paused' && !playback.autoStartArmed ? 'Paused · press Play to continue' : playback.starting ? `Waiting for ${service}` : playback.autoAdvance ? 'Shared queue playing' : playback.playing ? `Playing in ${service}` : 'Paused'}` : state.room?.queue.length ? `${state.room.queue.length} requests in your shared queue` : 'Connect the host player to listen');
  $('player-center').hidden = !linked;
  $('player-output-name').textContent = remote ? listeningUI.active ? `Your ${providerName(listeningUI.provider)}` : 'Listen on this device' : linked && !host() ? 'Host’s player' : linked ? playback.deviceName : 'Connect player';
  $('play-button').disabled = !canControl || (!playback.playing && !state.room?.nowPlaying && !state.room?.queue.length);
  $('play-button').setAttribute('aria-label', playback?.playing ? `Pause ${service} playback` : 'Play shared queue');
  $('play-button').innerHTML = icon(playback?.playing ? 'pause' : 'play');
  $('skip-button').disabled = !canControl || !state.room?.queue.length || playback?.intermission;
  $('player-position').textContent = playerTime(playback?.position);
  $('player-duration').textContent = playerTime(playback?.duration);
  $('player-progress').max = Math.max(1, playback?.duration || 1); $('player-progress').value = playback?.position || 0;
  if ($('playback-dialog').open) renderPlayerSetup();
}
function renderPlayerSetup() {
  const room = state.room, playback = room?.playback, spotify = state.connections.providers.spotify;
  const key = JSON.stringify({ code: room?.code, host: host(), provider: room?.hostProvider, spotify, connected: playback?.connected, appleBrowserConnected: appleBrowserPlayer.connected, mode: playback?.mode, device: playback?.deviceName, setupMode: playerSetup.mode, devices: playerSetup.devices, loaded: playerSetup.loaded, loading: playerSetup.loading, busy: playerSetup.busy });
  if (key === playerSetup.renderKey) return;
  playerSetup.renderKey = key;
  $('player-caption').textContent = playback?.connected ? `Connected to ${playback.deviceName}. The host controls playback; everyone can request songs.` : 'Connect the host’s Spotify player. Friends keep using their own libraries.';
  if (!room) { $('player-setup').innerHTML = '<p class="field-help">Start a Jam and choose the host’s music service first.</p><button class="button primary full" data-player-start>Start a Jam</button>'; return; }
  if (!host()) { $('player-setup').innerHTML = '<p class="field-help">Your host connects the speaker and controls playback. Add songs from Search or your library.</p>'; return; }
  if (room.hostProvider === 'apple') {
    $('player-caption').textContent = 'Apple Music plays in the host browser. Friends contribute requests from their libraries or the catalog.';
    document.querySelector('.homepod-guide').hidden = true;
    $('player-setup').innerHTML = playback?.connected && appleBrowserPlayer.connected
      ? '<p class="field-help">Apple Music is connected in the host browser. Keep this tab open. Audio comes directly from Apple.</p><button class="button secondary full" data-player-action="disconnect">Disconnect player</button>'
      : !connected('apple') ? '<p class="field-help">Connect the host’s Apple Music account first.</p><button class="button primary full" data-view="accounts" data-player-accounts>Connect Apple Music</button>'
        : `<p class="field-help">Use Safari or Chrome with an active Apple Music subscription. Enable playback once. Matched requests then play automatically.</p><button class="button primary full" data-player-apple-connect ${playerSetup.busy ? 'disabled' : ''}>${playerSetup.busy ? 'Connecting Apple Music…' : playback?.connected ? 'Reconnect this host browser' : 'Connect Apple Music player'}</button>`;
    return;
  }
  document.querySelector('.homepod-guide').hidden = false;
  if (room.hostProvider !== 'spotify') { $('player-setup').innerHTML = `<p class="field-help">${providerName(room.hostProvider)} host playback is not connected yet. Spotify can already match requests from QQ Music and Apple Music.</p>`; return; }
  if (playback?.connected) {
    $('player-setup').innerHTML = `<div class="player-connection"><strong>${escape(playback.deviceName)}</strong><span class="account-status connected">Connected</span></div><p class="field-help">${playback.mode === 'mac' ? 'Spotify runs on this Mac. Free-account playback and advertisements follow Spotify’s rules.' : 'Spotify controls this device through the host’s Premium account.'}</p><button class="button secondary full" data-player-action="disconnect" ${playerSetup.busy ? 'disabled' : ''}>Disconnect player</button>`; return;
  }
  const authorized = playerSetup.mode === 'web' ? spotify?.player?.webAuthorized : spotify?.connected;
  const loginUrl = playerSetup.mode === 'web' ? '/auth/spotify/start?playback=web' : '/auth/spotify/start?playback=mac';
  let body = `<div class="entry-tabs player-modes" role="group" aria-label="Host playback connection"><button data-player-mode="mac" aria-pressed="${playerSetup.mode === 'mac'}">Spotify on this Mac</button><button data-player-mode="web" aria-pressed="${playerSetup.mode === 'web'}">Spotify Connect</button></div><p class="field-help">${playerSetup.mode === 'mac' ? 'Uses the installed Spotify app directly. Leave other Spotify Jams and choose This computer in Spotify’s device picker first. macOS will ask before allowing control.' : 'Control a Spotify Connect device. The host account needs Premium.'}</p>`;
  if (!spotify?.configured) body += '<button class="button secondary full" data-connection-detail="spotify">Set up Spotify</button>';
  else if (!authorized) body += `<p class="field-help">Authorize playback access separately from your music library.</p><a class="button primary full" href="${loginUrl}">Connect Spotify playback</a>`;
  else {
    body += `${playerSetup.mode === 'mac' ? `<button class="button secondary full" data-player-check ${playerSetup.busy ? 'disabled' : ''}>Check Mac connection</button><p class="field-help">Reads Spotify’s playback status without starting music. macOS may ask for Automation permission.</p>` : ''}<button class="button secondary full" data-player-refresh ${playerSetup.loading ? 'disabled' : ''}>${playerSetup.loading ? 'Finding Spotify devices…' : 'Refresh Spotify devices'}</button>`;
    if (playerSetup.loaded) body += playerSetup.devices.length ? `<label class="field-label" for="player-device">Playback device</label><select id="player-device">${playerSetup.devices.map((device) => `<option value="${escape(device.id)}">${escape(device.name)}${device.active ? ' · active' : ''}</option>`).join('')}</select>${playerSetup.mode === 'mac' ? '<label class="local-output-confirm"><input type="checkbox" id="local-output-confirm">I’ve left other Spotify Jams and selected This computer.</label>' : ''}<button class="button primary full" data-player-connect ${playerSetup.busy ? 'disabled' : ''}>Connect player</button>` : '<p class="field-help">No controllable device found. Open Spotify, select this Mac, and refresh.</p>';
  }
  $('player-setup').innerHTML = body;
}
function showPlaybackInfo() {
  $('player-error').hidden = true; renderPlayerSetup(); $('playback-dialog').showModal();
  const spotify = state.connections.providers.spotify;
  if (host() && state.room?.hostProvider === 'spotify' && !state.room.playback.connected && (playerSetup.mode === 'web' ? spotify?.player?.webAuthorized : spotify?.connected)) void refreshPlayerDevices();
}
async function refreshPlayerDevices() {
  if (!host() || playerSetup.loading) return;
  const version = ++playerSetup.version, code = state.session.code;
  playerSetup.loading = true; $('player-error').hidden = true; renderPlayerSetup();
  try {
    const result = await api(`/api/rooms/${code}/player/devices?mode=${playerSetup.mode}`);
    if (version !== playerSetup.version || code !== state.session?.code) return;
    playerSetup.devices = result.devices.filter((device) => playerSetup.mode === 'web' ? !device.restricted : device.type === 'computer'); playerSetup.loaded = true;
    if (playerSetup.mode === 'mac' && !result.macAvailable) throw new Error('The Mac player must be connected from this Mac with Spotify installed.');
  } catch (error) { if (version === playerSetup.version) { $('player-error').textContent = error.message; $('player-error').hidden = false; } }
  finally { if (version === playerSetup.version) { playerSetup.loading = false; renderPlayerSetup(); } }
}
async function connectPlayer() {
  const deviceId = $('player-device')?.value; if (!deviceId || !host() || playerSetup.busy) return;
  const localOutputConfirmed = $('local-output-confirm')?.checked === true;
  if (playerSetup.mode === 'mac' && !localOutputConfirmed) { $('player-error').textContent = 'Leave other Spotify Jams and select This computer in Spotify. Then check the box above.'; $('player-error').hidden = false; return; }
  playerSetup.busy = true; $('player-error').hidden = true; renderPlayerSetup();
  try { automaticStarts.clear(); acceptRoom(await api(`/api/rooms/${state.session.code}/player/connect`, { method: 'POST', body: { mode: playerSetup.mode, deviceId, localOutputConfirmed } })); $('playback-dialog').close(); toast('Spotify connected. Matched songs will play automatically.', 'success'); }
  catch (error) { $('player-error').textContent = error.message; $('player-error').hidden = false; }
  finally { playerSetup.busy = false; renderPlayer(); void startMatchedQueue(); }
}
async function checkMacPlayer() {
  if (!host() || playerSetup.busy) return;
  playerSetup.busy = true; $('player-error').hidden = true; renderPlayerSetup();
  try {
    const result = await api(`/api/rooms/${state.session.code}/player/mac/status`, { method: 'POST', body: {} });
    $('player-error').textContent = `Mac connection works.${result.track ? ` Spotify reports ${result.track.title} by ${result.track.artist}.` : ' No song is selected.'}`;
    $('player-error').hidden = false; $('player-error').classList.add('player-check-success');
  } catch (error) { $('player-error').textContent = error.message; $('player-error').hidden = false; $('player-error').classList.remove('player-check-success'); }
  finally { playerSetup.busy = false; renderPlayerSetup(); }
}
async function controlPlayer(action, automatic = {}) {
  if (!host() || playerSetup.busy || state.room.hostTransfer) return;
  if (!automatic.automatic) automaticStarts.clear();
  const session = state.session;
  playerSetup.busy = true; renderPlayer();
  try {
    if (state.room.hostProvider === 'apple') {
      const code = state.session.code, generation = appleBrowserPlayer.generation;
      if (!generation) throw new Error('Reconnect Apple Music playback in this host browser.');
      if (action === 'disconnect') { await appleBrowserPlayer.stop(); const result = await api(`/api/rooms/${code}/player/apple/disconnect`, { method: 'POST', body: { generation } }); acceptRoom(result.room); }
      else {
        const result = await api(`/api/rooms/${code}/player/apple/command`, { method: 'POST', body: { generation, action, ...automatic } });
        if (state.session !== session || !host() || appleBrowserPlayer.generation !== generation) return;
        acceptRoom(result.room); await appleBrowserPlayer.execute(result.command);
      }
    } else acceptRoom(await api(`/api/rooms/${state.session.code}/playback`, { method: 'POST', body: { action, generation: state.room?.playback.connectionId, ...automatic } }));
    if (action === 'disconnect') { playerSetup.loaded = false; renderPlayerSetup(); }
  }
  catch (error) { if (!automatic.automatic || !['request_changed', 'player_busy', 'room_busy'].includes(error.code)) toast(error.message, 'error'); }
  finally { playerSetup.busy = false; renderPlayer(); void startMatchedQueue(); }
}
async function connectApplePlayer() {
  if (!host() || state.room.hostProvider !== 'apple' || playerSetup.busy) return;
  playerSetup.busy = true; $('player-error').hidden = true;
  renderPlayerSetup();
  try {
    if (!appleAuthorization.ready && !await prepareAppleMusic()) throw new Error('Apple Music could not prepare playback. Try again.');
    await appleBrowserPlayer.prepare();
    const code = state.session.code, result = await api(`/api/rooms/${code}/player/connect`, { method: 'POST', body: { mode: 'apple-web' } });
    if (state.session?.code !== code) return;
    automaticStarts.clear(); appleBrowserPlayer.connect({ code, generation: result.player.generation }); acceptRoom(result.room); $('playback-dialog').close(); toast('Apple Music connected. Matched songs will play automatically.', 'success');
  } catch (error) { $('player-error').textContent = error.message || 'Apple Music playback could not connect.'; $('player-error').hidden = false; }
  finally { playerSetup.busy = false; renderPlayer(); void startMatchedQueue(); }
}
async function searchQQ() { if (state.provider !== 'qq') return; const term = $('search-input').value.trim(); if (!term) { state.playlist = null; renderLibrary(); return; } const list = { id: `search:${term}`, provider: 'qq', name: term, subtitle: 'QQ Music public song search · Private library not connected', isSearch: true, term }; state.playlist = list; renderLibrary(); await loadTracks(list); }
function bindEvents() {
  document.addEventListener('error', (event) => { if (event.target instanceof HTMLImageElement) event.target.hidden = true; }, true);
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.view) { if (button.dataset.view === 'library') { state.playlist = null; state.provider = 'all'; $('search-input').value = ''; renderLibrary(); } setView(button.dataset.view); }
    if (button.dataset.listeningMode) void setListeningMode(button.dataset.listeningMode);
    if (button.hasAttribute('data-host-offer')) showHandoff();
    if (button.hasAttribute('data-host-accept')) void respondHandoff('accept');
    if (button.hasAttribute('data-host-cancel')) void respondHandoff('cancel');
    if (button.hasAttribute('data-listening-start')) void startListening();
    if (button.hasAttribute('data-listening-stop')) void stopListening();
    if (button.hasAttribute('data-listening-devices')) void loadListeningDevices();
    if (button.hasAttribute('data-listening-retry')) { listeningUI.key = ''; listeningUI.error = ''; void prepareListening(); }
    if (button.dataset.listenerTrack) void prepareListening(button.dataset.listenerTrack);
    if (button.hasAttribute('data-taste-share')) void shareTaste();
    if (button.hasAttribute('data-taste-stop')) void stopSharingTaste();
    if (button.hasAttribute('data-taste-more')) void loadPlaylists('apple', true).then(renderTaste);
    if (button.hasAttribute('data-taste-pair')) { tasteUI.pair = button.dataset.tastePair; renderTaste(); void loadTasteSongs(); }
    if (button.hasAttribute('data-taste-more-songs')) void loadTasteSongs(true);
    if (button.dataset.tasteSong) void queueTasteSong(button.dataset.tasteSong);
    if (button.dataset.filter) { $('connection-dialog').close(); await selectProvider(button.dataset.filter); if (button.dataset.filter === 'qq' && state.connections.providers.qq?.capabilities?.search) $('search-input').focus(); }
    if (button.dataset.playlistKey) void openPlaylist(button.dataset.playlistKey);
    if (button.dataset.morePlaylists) void loadCollection(button.dataset.morePlaylists, true);
    if (button.dataset.collection) void selectCollection(button.dataset.collection);
    if (button.dataset.searchProvider) { songSearch.provider = button.dataset.searchProvider; void searchSongs(); }
    if (button.dataset.qqSource) { songSearch.qqSource = button.dataset.qqSource; void searchSongs(); }
    if (button.dataset.moreSearch) void loadSearchPage(button.dataset.moreSearch, true);
    if (button.dataset.searchRetry) void loadSearchPage(button.dataset.searchRetry);
    if (button.dataset.playerMode) { playerSetup.mode = button.dataset.playerMode; playerSetup.version++; playerSetup.loading = false; playerSetup.loaded = false; playerSetup.devices = []; renderPlayerSetup(); }
    if (button.hasAttribute('data-player-settings')) showPlaybackInfo();
    if (button.hasAttribute('data-player-refresh')) void refreshPlayerDevices();
    if (button.hasAttribute('data-player-connect')) void connectPlayer();
    if (button.hasAttribute('data-player-apple-connect')) void connectApplePlayer();
    if (button.hasAttribute('data-player-accounts')) $('playback-dialog').close();
    if (button.hasAttribute('data-player-check')) void checkMacPlayer();
    if (button.dataset.playerAction) void controlPlayer(button.dataset.playerAction);
    if (button.hasAttribute('data-player-start')) { $('playback-dialog').close(); openJam('create'); }
    if (button.dataset.matchSearch) void resolveHostMatch(button.dataset.matchSearch);
    if (button.dataset.matchTrack) void selectHostMatch(button.dataset.matchEntry, button.dataset.matchTrack);
    if (button.dataset.track) void addTrack(button.dataset.track, button.dataset.trackProvider);
    if (button.dataset.connect) void connectProvider(button.dataset.connect, button);
    if (button.dataset.connectionDetail) showConnectionDetail(button.dataset.connectionDetail);
    if (button.dataset.disconnect) void disconnectProvider(button.dataset.disconnect);
    if (button.dataset.remove) void removeEntry(button.dataset.remove);
    if (button.dataset.qqOpen) void openQQ(button.dataset.qqOpen, button);
    if (button.dataset.nearby) void submitRoom(button.dataset.nearby);
    if (button.dataset.mobile === 'queue') showQueue(); else if (button.dataset.mobile) setView(button.dataset.mobile);
    if (button.dataset.action === 'invite') showInvite(); if (button.dataset.action === 'leave') void leaveRoom();
    if (button.dataset.action === 'start-taste-jam') openJam('create');
    if (button.dataset.action === 'join-taste-jam') openJam('join');
    if (button.id === 'load-more-tracks') void loadTracks(state.playlist, true);
    if (button.id === 'refresh-library') void refreshLibrary();
  });
  $('taste-content').addEventListener('change', (event) => {
    if (event.target.id === 'taste-provider') {
      tasteUI.provider = event.target.value; tasteUI.playlistId = ''; tasteUI.error = ''; renderTaste();
      if (tasteUI.provider === 'apple' && connected('apple') && !state.playlists.has('apple')) void loadPlaylists('apple').then(renderTaste);
    }
    if (event.target.id === 'taste-playlist') { tasteUI.playlistId = event.target.value; renderTaste(); }
  });
  $('listening-panel').addEventListener('change', (event) => {
    if (event.target.id === 'automatic-output') void setListeningMode(state.room.listeningMode, event.target.checked);
    if (event.target.id === 'listener-provider') { listeningUI.provider = event.target.value; listeningUI.key = ''; listeningUI.match = null; listeningUI.devices = []; listeningUI.deviceId = ''; listeningUI.error = ''; renderListening(); }
    if (event.target.id === 'listener-device') { listeningUI.deviceId = event.target.value; renderListening(); }
  });
  $('handoff-panel').addEventListener('change', (event) => { if (event.target.id === 'handoff-service') { handoffUI.provider = event.target.value; handoffUI.error = ''; renderHandoff(); } });
  $('handoff-offer').onclick = offerHandoff;
  $('end-jam-confirm').onclick = () => { $('end-jam-dialog').close(); void finishLeavingRoom(); };
  $('end-jam-cancel').onclick = () => $('end-jam-dialog').close();
  $('connect-main').onclick = () => state.provider === 'qq' && state.connections.providers.qq?.capabilities?.search ? $('search-input').focus() : setView('accounts');
  $('profile-button').onclick = () => setView('accounts'); $('start-button').onclick = () => openJam('create'); $('join-button').onclick = () => state.room ? showInvite() : openJam('join');
  $('companion-new-code').onclick = pairMusicCompanion;
  $('queue-start').onclick = () => state.room ? setView('library') : openJam('create'); $('queue-join').onclick = () => state.room ? showInvite() : openJam('join');
  $('create-tab').onclick = () => setEntryMode('create'); $('join-tab').onclick = () => setEntryMode('join');
  $('entry-form').onsubmit = (event) => { event.preventDefault(); void submitRoom(); };
  $('code-fallback').ontoggle = () => { if (state.mode === 'join') $('enter-button').hidden = !$('code-fallback').open; };
  $('code-input').oninput = () => $('code-input').value = $('code-input').value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  $('jam-dialog').onclose = () => { clearInterval(state.nearbyTimer); state.nearbyTimer = null; state.deferredTrack = null; };
  $('back-library').onclick = () => { state.playlist = null; $('search-input').value = ''; renderLibrary(); };
  $('search-input').oninput = () => { clearTimeout(searchTimer); if (publicQQSearch()) searchTimer = setTimeout(searchQQ, 400); else if (state.playlist) renderTracks(); else renderLibrary(); };
  $('search-input').onkeydown = (event) => { if (event.key === 'Enter' && publicQQSearch()) { clearTimeout(searchTimer); void searchQQ(); } };
  $('catalog-search-form').onsubmit = (event) => { event.preventDefault(); void searchSongs(); };
  $('catalog-search-input').oninput = () => {
    resetCatalogSearch(); renderSongSearch();
    if ($('catalog-search-input').value.trim()) catalogSearchTimer = setTimeout(searchSongs, 500);
  };
  $('play-button').onclick = () => void controlPlayer(state.room?.playback.playing ? 'pause' : 'play'); $('skip-button').onclick = () => void controlPlayer('next'); $('playback-info').onclick = () => state.room?.listeningMode === 'everyone' && !host() ? showQueue() : showPlaybackInfo();
  $('copy-invite').onclick = async () => { try { await navigator.clipboard.writeText(state.room.inviteUrl); toast('Invite link copied'); } catch { const input = document.createElement('textarea'); input.value = state.room.inviteUrl; $('invite-dialog').append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); toast(copied ? 'Invite link copied' : 'Select the invite link or scan the QR code.'); } };
  $('invite-lock').onclick = async () => {
    $('invite-lock').disabled = true;
    try { acceptRoom(await api(`/api/rooms/${state.session.code}/access`, { method: 'POST', body: { locked: !state.room.locked } })); $('invite-lock').textContent = state.room.locked ? 'Allow new joins' : 'Lock new joins'; toast(state.room.locked ? 'New joins are locked. Your current friends stay connected.' : 'New joins are allowed.', 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { $('invite-lock').disabled = false; }
  };
  $('invite-dialog').addEventListener('close', () => { if (invitationImageUrl) URL.revokeObjectURL(invitationImageUrl); invitationImageUrl = null; });
  $('remember-connection').onchange = async (event) => {
    const remember = event.target.checked; event.target.disabled = true;
    try { state.connections = await api('/api/connections/preferences', { method: 'POST', body: { remember } }); try { localStorage.setItem('jamama-remember-connection', String(remember)); } catch {} toast(remember ? 'This connection will be remembered.' : 'Saved account tokens were removed from disk. You stay connected for this session.', 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { $('remember-connection').disabled = false; renderAccounts(); }
  };
  document.querySelectorAll('.dialog-close').forEach((button) => button.onclick = () => button.closest('dialog').close());
  document.addEventListener('visibilitychange', refreshActiveLibrary);
  window.addEventListener('focus', refreshActiveLibrary);
  setInterval(refreshActiveLibrary, 120000);
  setInterval(refreshMusicCompanion, 4000);
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
  $('track-list').ondragstart = (event) => { const row = event.target.closest('[data-track-row]'); if (row) { event.dataTransfer.setData('text/jamama-track', row.dataset.trackRow); event.dataTransfer.effectAllowed = 'copy'; } };
  let gesture = null;
  $('track-list').addEventListener('pointerdown', (event) => {
    const row = event.target.closest('[data-track-row]');
    if (!row || event.pointerType === 'mouse' || event.target.closest('button')) return;
    gesture = { row, x: event.clientX, y: event.clientY, distance: 0, sliding: false };
  });
  $('track-list').addEventListener('pointermove', (event) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.x, dy = Math.abs(event.clientY - gesture.y);
    if (!gesture.sliding && dy > 12 && dy > Math.abs(dx)) { gesture = null; return; }
    if (!gesture.sliding && dx > 15 && dx > dy * 1.3) { gesture.sliding = true; gesture.row.setPointerCapture(event.pointerId); gesture.row.classList.add('is-swiping'); }
    if (gesture.sliding) { gesture.distance = Math.max(0, Math.min(120, dx)); gesture.row.style.transform = `translateX(${gesture.distance}px)`; }
  });
  const finishSwipe = (event) => {
    if (!gesture) return;
    const { row, distance, sliding } = gesture; gesture = null;
    row.style.transform = ''; row.classList.remove('is-swiping');
    if (event.type === 'pointerup' && sliding && distance > 75) { const button = row.querySelector('[data-track]'); if (button) void addTrack(button.dataset.track, button.dataset.trackProvider); }
  };
  $('track-list').addEventListener('pointerup', finishSwipe);
  $('track-list').addEventListener('pointercancel', finishSwipe);
  $('queue-panel').ondragover = (event) => { if (event.dataTransfer.types.includes('text/jamama-track')) event.preventDefault(); };
  $('queue-panel').ondrop = (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/jamama-track'); if (trackFor(id)) void addTrack(id, trackFor(id).provider || state.playlist?.provider); };
}
async function init() {
  icons(); bindEvents();
  void api('/api/host-capabilities').then((capabilities) => { outputDetectionAvailable = capabilities.audioOutput; renderListening(); if (host()) void checkHostOutput(); }).catch(() => {});
  setInterval(() => { if (document.visibilityState === 'visible' && state.online) void checkHostOutput(); }, 10000);
  const results = await Promise.allSettled([api('/api/catalog'), api('/api/connections')]);
  if (results[0].status !== 'fulfilled') throw results[0].reason;
  state.catalog = results[0].value;
  if (results[1].status === 'fulfilled') state.connections = results[1].value;
  try { if (localStorage.getItem('jamama-remember-connection') === 'false' && state.connections.rememberConnection !== false) state.connections = await api('/api/connections/preferences', { method: 'POST', body: { remember: false } }); } catch {}
  state.provider = chooseConnectedMusicService(null, connected);
  songSearch.provider = chooseConnectedMusicService(null, connected);
  try { for (const [store, key] of [[localStorage, 'name'], [localStorage, 'provider'], [sessionStorage, 'session']]) { const old = store.getItem(`roomtone-${key}`); if (old !== null && store.getItem(`jamama-${key}`) === null) store.setItem(`jamama-${key}`, old); store.removeItem(`roomtone-${key}`); } } catch {}
  try { $('name-input').value = localStorage.getItem('jamama-name') || ''; if ($('name-input').value) $('profile-button').textContent = $('name-input').value.slice(0, 1).toUpperCase(); } catch {}
  renderLibrary(); renderAccounts(); renderRoom(); renderSongSearch();
  if (state.connections.providers.apple?.configured && connected('apple')) void prepareAppleMusic();
  const params = new URLSearchParams(location.search); const roomCode = params.get('room');
  try { const saved = JSON.parse(sessionStorage.getItem('jamama-session')); if (saved?.token) { state.session = saved; const room = await api(`/api/rooms/${saved.code}`); if (!room.members.some((member) => member.id === saved.memberId)) throw new Error('Session expired'); enterRoom({ ...saved, room }); } } catch { resetSession(); }
  if (roomCode && !state.room) { inviteCode = roomCode.toUpperCase(); invitationToken = params.get('invite'); $('code-input').value = inviteCode; $('code-fallback').open = true; history.replaceState(null, '', '/'); openJam('join'); }
  const connection = params.get('connection'), status = params.get('status');
  if (connection) { history.replaceState(null, '', '/'); if (status === 'connected') { state.provider = chooseVisibleMusicService(connection); toast(`${providerName(connection)} connected`, 'success'); renderLibrary(); } else { setView('accounts'); toast(status === 'cancelled' ? 'Sign-in was cancelled. Your account is not connected.' : 'Sign-in could not finish. Please try connecting again.', status === 'cancelled' ? 'warning' : 'error'); } }
  await Promise.all(order.filter(connected).map((provider) => loadPlaylists(provider)));
  state.lastLibraryRefresh = Date.now();
  if (['library', 'search', 'taste', 'accounts'].includes(params.get('view'))) setView(params.get('view'));
  if (params.get('view') === 'player' && status === 'connected' && order.includes(connection)) { if (['mac', 'web'].includes(params.get('player'))) playerSetup.mode = params.get('player'); showPlaybackInfo(); }
}
init().catch((error) => { toast(error.message, 'error'); $('library-error').textContent = `Could not load Jamama. ${error.message}`; $('library-error').hidden = false; });
