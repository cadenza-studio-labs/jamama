import { createAppleAuthorization } from './apple-auth.js';
import { clueLengths, createRecallGame, listeningPool, playlistPool } from './recall-game.js';
import { createRecallPlayer } from './recall-player.js';
import { readRecallCollection } from './recall-library.js';

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const game = createRecallGame();
const state = { connections: null, songs: [], playlists: [], playlistsLoading: false, qqPlaylists: [], qqPlaylistId: '', qqImporting: false, qqImportVersion: 0, matchingProgress: null, source: 'playlist', playlistId: '', poolSource: null, loading: false, loadingStage: '', prepared: false, preparing: false, mode: 'middle', playbackToken: null, clueStarting: false, clueAttempt: null, playback: { playing: false, busy: false, heard: false }, status: '', version: 0 };
const qqFileLimit = 2 * 1024 * 1024, qqQuizLimit = 100;
let playlistRead;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(state.connections?.csrfToken ? { 'X-CSRF-Token': state.connections.csrfToken } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let result;
  try { result = await response.json(); } catch { throw new Error('Recall couldn’t read the server response. Try refreshing the page.'); }
  if (!response.ok) {
    const error = new Error(result.error || 'Please try again.'); error.code = result.code;
    if (['connect_required', 'reconnect_required', 'connection_changed'].includes(error.code)) {
      state.connections = await fetch('/api/connections').then((response) => response.json());
      state.songs = []; state.poolSource = null; state.playbackToken = null; game.load([]); await player.stop(); render();
    }
    throw error;
  }
  return result;
}

async function loadSDK() {
  if (window.MusicKit) return window.MusicKit;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'; script.async = true;
    const timer = setTimeout(() => reject(new Error('Apple Music took too long to load. Refresh and try again.')), 15000);
    const ready = () => { if (window.MusicKit) { clearTimeout(timer); resolve(window.MusicKit); } };
    document.addEventListener('musickitloaded', ready, { once: true }); script.onload = ready;
    script.onerror = () => { clearTimeout(timer); reject(new Error('Apple Music could not load. Use Safari or Chrome and check your connection.')); };
    document.head.append(script);
  });
}

const authorization = createAppleAuthorization({
  getConfiguration: async () => {
    const configuration = await api('/api/connections/apple/config');
    return { ...configuration, features: [...(configuration.features || []), 'player-accurate-timing'] };
  }, loadSDK, timeoutMs: 180000,
});
const player = createRecallPlayer({ getSDK: () => window.MusicKit,
  onState: (playback) => {
    state.playback = playback;
    if (playback.heard && state.clueAttempt?.round === game.snapshot().round) state.clueAttempt.started = true;
    if (playback.complete && state.clueAttempt?.round === game.snapshot().round) {
      game.listened(state.clueAttempt.target);
      state.status = 'Know it? Guess below, or hear a little more.';
    }
    renderControls();
  },
  onError: (error) => { game.cancelClue(state.clueAttempt); showError(error); render(); },
});

function showError(error) { $('error').textContent = error.message || 'Please try again.'; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function safeUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
const selectedQQPlaylist = () => state.qqPlaylists.find((playlist) => playlist.id === state.qqPlaylistId);
const selectionMissing = () => state.source === 'playlist' ? state.playlistsLoading || !state.playlistId : state.source === 'qq' ? !state.connections?.providers.apple?.connected || state.qqImporting || !selectedQQPlaylist()?.tracks.length : false;
const matchingMessage = () => `Matching QQ songs · ${state.matchingProgress?.done || 0} / ${state.matchingProgress?.total || 0}`;

function parseQQExport(text) {
  if (typeof text !== 'string' || text.length > qqFileLimit) throw new Error('Choose a QQ playlist file smaller than 2 MiB.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose the file created by the QQ playlist exporter.'); }
  if (data?.format !== 'jamama-qq-playlists' || data.version !== 1 || !Array.isArray(data.playlists) || !data.playlists.length || data.playlists.length > 200) throw new Error('Choose a QQ playlist export containing 1–200 playlists.');
  const string = (value, max, required = true) => {
    if (!required && (value == null || value === '')) return '';
    if (typeof value !== 'string') throw new Error('The QQ export contains an unreadable playlist or song. Export it again.');
    const text = value.trim();
    if (text.length > max || (required && !text)) throw new Error('The QQ export contains an unreadable playlist or song. Export it again.');
    return text;
  };
  let total = 0; const ids = new Set();
  return data.playlists.map((playlist) => {
    const id = string(playlist?.id, 128), name = string(playlist?.name, 200);
    if (ids.has(id) || !Array.isArray(playlist.tracks) || (total += playlist.tracks.length) > 10000) throw new Error('The QQ export must contain unique playlists and at most 10,000 songs.');
    ids.add(id);
    const tracks = playlist.tracks.map((track) => {
      if (!track || track.provider !== 'qq' || typeof track.id !== 'string' || (!/^qq:[1-9]\d{0,15}$/.test(track.id) || !Number.isSafeInteger(Number(track.id.slice(3))))) throw new Error('This file contains songs outside the QQ playlist export format.');
      const durationMs = track.durationMs ?? null, isrc = string(track.isrc, 12, false).toUpperCase() || null;
      if ((durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) || (isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc))) throw new Error('The QQ export contains unreadable song timing or recording details. Export it again.');
      return { id: track.id, provider: 'qq', title: string(track.title, 200), artist: string(track.artist, 200), album: string(track.album, 200, false), durationMs, isrc };
    });
    return { id, name, tracks };
  });
}

async function importQQFile(file) {
  if (!file || state.loading || state.clueStarting || state.playback.busy || state.playback.playing) return;
  clearError(); const version = ++state.qqImportVersion;
  state.qqPlaylists = []; state.qqPlaylistId = ''; state.qqImporting = true;
  $('qq-playlist-choice').innerHTML = '<option value="">Reading your QQ playlist file…</option>'; render();
  try {
    if (!Number.isFinite(file.size) || file.size > qqFileLimit) throw new Error('Choose a QQ playlist file smaller than 2 MiB.');
    const playlists = parseQQExport(await file.text());
    if (version !== state.qqImportVersion) return;
    state.qqPlaylists = playlists; state.qqPlaylistId = (playlists.find((playlist) => playlist.tracks.length) || playlists[0]).id;
    $('qq-playlist-choice').innerHTML = playlists.map((playlist) => `<option value="${escape(playlist.id)}" ${playlist.id === state.qqPlaylistId ? 'selected' : ''}>${escape(playlist.name)} · ${playlist.tracks.length} songs</option>`).join('');
  } catch (error) {
    if (version !== state.qqImportVersion) return;
    $('qq-playlist-choice').innerHTML = '<option value="">Choose a QQ playlist file first</option>'; showError(error);
  } finally { if (version === state.qqImportVersion) { state.qqImporting = false; render(); } }
}

function renderControls() {
  const current = game.snapshot(), round = current.round, locked = state.loading || state.clueStarting || state.playback.busy || state.playback.playing;
  $('score').textContent = current.score; $('wins').textContent = current.wins; $('total').textContent = ` / ${current.total}`; $('streak').textContent = current.streak;
  const allHeard = round?.listened && round.step === clueLengths.length - 1;
  const nextLength = round ? clueLengths[Math.min(clueLengths.length - 1, round.step + (round.listened ? 1 : 0))] : 1;
  $('listen').disabled = state.loading || locked || !round || round.finished || !round.completedThrough || allHeard;
  $('listen').querySelector('span').textContent = allHeard ? 'All clues heard' : `Hear more · +${nextLength - (round?.completedThrough || 0)}s`;
  $('listen').setAttribute('aria-label', allHeard ? 'All clues heard' : `Hear ${nextLength - (round?.completedThrough || 0)} more seconds, ${nextLength} seconds total`);
  $('replay').hidden = false;
  $('replay').disabled = state.loading || locked || !round || round.finished;
  $('replay').querySelector('span').textContent = state.clueStarting || state.playback.busy ? 'Loading…' : state.playback.playing ? 'Playing…' : `Play ${round?.completedThrough || 1}s`;
  $('replay').setAttribute('aria-label', round?.completedThrough ? `Replay ${round.completedThrough}-second clue` : 'Play first 1-second clue');
  $('pause').disabled = !state.playback.playing && !state.playback.busy;
  $('guess-submit').disabled = !round?.listened || round.finished || locked || !$('guess').value.trim();
  $('guess').disabled = state.loading || !round || round.finished || state.playback.busy;
  $('reveal').disabled = state.loading || !round || round.finished || state.playback.busy;
  $('next').disabled = state.playback.busy || state.loading;
  $('full-song').disabled = state.loading || !round?.finished || state.playback.busy;
  $('answer-pause').disabled = !state.playback.playing && !state.playback.busy;
  $('refresh-history').disabled = state.playback.busy || state.loading;
  const clueDuration = clueLengths[round?.step || 0];
  const elapsed = round ? state.playback.playing && state.clueAttempt?.round === round ? Math.max(0, Math.min(clueDuration, (state.playback.position || 0) - round.startAt)) : round.completedThrough : 0;
  $('clue-progress').max = clueDuration; $('clue-progress').value = elapsed;
  $('clue-timing').textContent = `${elapsed.toFixed(1)} / ${clueDuration} seconds`;
  $('round').classList.toggle('is-playing', state.playback.playing);
  $('clue-mode').disabled = state.loading || state.playback.busy;
  $('song-source').disabled = state.loading || state.playback.busy || state.playback.playing;
  $('playlist-choice').disabled = state.loading || state.playlistsLoading || state.playback.busy || state.playback.playing || !state.playlists.length;
  $('qq-file').disabled = state.loading || locked;
  $('qq-playlist-choice').disabled = state.loading || locked || state.qqImporting || !state.qqPlaylists.length;
  $('switch-pool').disabled = state.loading || state.playback.busy || selectionMissing();
  $('cancel-sign-in').hidden = state.loadingStage !== 'authorization';
  $('game-status').textContent = state.playback.authorizing ? 'Finish Apple’s sign-in window to enable playback.' : state.loadingStage === 'matching' ? matchingMessage() : state.loading ? 'Preparing Apple Music playback…' : state.playback.busy ? 'Apple Music is loading the recording…' : state.playback.playing ? 'Listening… the clue will pause automatically.' : state.status || 'Press Play to hear your first clue.';
}

function render() {
  const current = game.snapshot(), round = current.round, apple = state.connections?.providers.apple;
  document.querySelector('.scoreboard').hidden = !round;
  $('game-options').hidden = !apple?.connected;
  $('setup').hidden = Boolean(round);
  $('round').hidden = !round || round.finished;
  $('answer').hidden = !round?.finished;
  $('connect-apple').hidden = Boolean(apple?.connected) || !apple?.configured;
  $('connect-apple').disabled = !state.prepared || state.loading;
  $('load-history').hidden = !apple?.connected;
  $('load-history').disabled = !state.prepared || state.loading || selectionMissing();
  $('load-history').textContent = state.loadingStage === 'authorization' ? 'Waiting for Apple sign-in…' : state.loadingStage === 'matching' ? matchingMessage() : state.loading ? 'Reading your songs…' : 'Start guessing';
  $('playlist-field').hidden = state.source !== 'playlist';
  $('qq-field').hidden = state.source !== 'qq';
  $('source-note').textContent = state.source === 'playlist' ? 'Choose a playlist you know well.' : state.source === 'qq' ? 'QQ picks. Apple Music plays the clues.' : 'Apple’s recent history, including songs you may have skipped.';
  const qqPlaylist = selectedQQPlaylist();
  $('qq-import-note').textContent = state.qqImporting ? 'Reading the file on this device…' : qqPlaylist ? `${qqPlaylist.tracks.length} songs in ${qqPlaylist.name}. ${qqPlaylist.tracks.length > qqQuizLimit ? 'This quiz matches the first 100 songs. ' : ''}Only this selection is sent for matching when you start.` : 'The file stays on this device until you start. Only your selected playlist’s songs are sent for matching.';
  $('selection-summary').textContent = state.source === 'playlist' ? state.playlists.find((list) => list.id === state.playlistId)?.name || 'Choose your songs' : state.source === 'qq' ? qqPlaylist?.name || 'Choose a QQ playlist file' : 'Recently played';
  $('switch-pool').hidden = !round;
  $('round-heading').textContent = state.poolSource ? state.poolSource.kind === 'qq' ? `QQ PICKS · ${state.poolSource.name}` : state.poolSource.kind === 'playlist' ? `PLAYLIST · ${state.poolSource.name}` : 'YOUR RECENT LISTENING' : state.source === 'qq' ? 'YOUR QQ MUSIC PLAYLISTS' : state.source === 'playlist' ? 'YOUR APPLE MUSIC PLAYLISTS' : 'YOUR RECENT LISTENING';
  $('connection-status').textContent = !state.connections ? 'Checking your Apple Music connection…' : !apple?.configured ? 'Apple Music needs developer setup for this website address. Open Jamama’s Music accounts for details.' : state.loadingStage === 'authorization' ? 'Finish Apple’s sign-in window to use the same account for songs and playback.' : state.loadingStage === 'matching' ? `${matchingMessage()}. QQ picks. Apple Music plays the clues.` : state.loading ? 'Reading your selected songs from Apple Music. Your playlists stay untouched.' : apple.connected ? 'Apple Music is connected. Choose your songs and start a game.' : 'Connect Apple Music to play from your own songs.';
  $('round-label').textContent = round ? `ROUND ${String(round.number).padStart(2, '0')}` : 'APPLE MUSIC';
  $('mode-note').textContent = `${state.mode === 'intro' ? 'Starts at the beginning.' : state.mode === 'random' ? 'Chooses a point between 20% and 60% into each song.' : 'Starts about a third of the way into the song.'} Every clue continues from the same excerpt.${round && round.mode !== state.mode ? ' Applies to the next song.' : ''}`;
  $('history-note').hidden = !state.songs.length;
  $('history-details').hidden = !state.songs.length;
  $('refresh-history').hidden = !state.songs.length;
  $('pool-summary').textContent = state.songs.length ? `${state.songs.length} ${state.songs.length === 1 ? 'song' : 'songs'} from ${['playlist', 'qq'].includes(state.poolSource?.kind) ? state.poolSource.name : 'your recent listening'}.${state.poolSource?.kind === 'qq' ? ' QQ picks. Apple Music plays the clues.' : ''} Stored in this tab for this session.` : 'Your song selection stays private.';
  if (round) {
    $('clue-length').textContent = clueLengths[round.step];
    $('steps').innerHTML = clueLengths.map((length, index) => `<span class="${index === round.step ? 'current' : index > round.step ? 'locked' : ''}" ${index === round.step ? 'aria-current="step"' : ''}>${length}s</span>`).join('');
    $('guesses').innerHTML = round.guesses.map((guess) => `<li><span class="${guess.correct ? '' : 'wrong-mark'}" aria-label="${guess.correct ? 'Correct' : 'Incorrect'}">${guess.correct ? '✓' : '×'}</span><span>${escape(guess.title)}</span></li>`).join('');
    if (round.finished) {
      $('answer-result').textContent = round.correct ? `YOU GOT IT · +${round.points} ${round.points === 1 ? 'POINT' : 'POINTS'}` : 'A LITTLE REDISCOVERY';
      $('answer-title').textContent = round.track.title; $('answer-artist').textContent = round.track.artist; $('answer-album').textContent = round.track.album || '';
      const art = safeUrl(round.track.artworkUrl);
      $('answer-art').innerHTML = art ? `<img src="${escape(art)}" alt="Album cover for ${escape(round.track.album || round.track.title)}" referrerpolicy="no-referrer">` : '<span aria-hidden="true">♫</span>';
      const link = safeUrl(round.track.externalUrl);
      $('apple-link').hidden = !link; if (link) $('apple-link').href = link;
    }
  }
  renderControls();
}

async function prepare() {
  state.preparing = true;
  try { await authorization.prepare(); state.prepared = true; }
  catch (error) { showError(error); }
  finally { state.preparing = false; render(); }
}

async function connect() {
  clearError();
  if (!authorization.ready) { await prepare(); return; }
  state.loading = true; state.loadingStage = 'authorization'; render();
  try {
    const musicUserToken = await authorization.authorize();
    state.loadingStage = 'history'; render();
    state.connections = await api('/api/connections/apple/connect', { method: 'POST', body: { musicUserToken } });
    await loadPlaylists();
  } catch (error) { showError(error); }
  finally { state.loading = false; state.loadingStage = ''; render(); }
}

function loadPlaylists() {
  if (playlistRead) return playlistRead;
  if (!state.connections?.providers.apple?.connected) return Promise.resolve();
  state.playlistsLoading = true; render(); $('playlist-choice').innerHTML = '<option value="">Loading your playlists…</option>';
  playlistRead = readPlaylists().finally(() => { playlistRead = undefined; state.playlistsLoading = false; render(); });
  return playlistRead;
}

async function readPlaylists() {
  try {
    state.playlists = await readRecallCollection((offset) => api(`/api/library/apple/playlists?offset=${offset}`), { maxItems: 1000, maxPages: 20 });
    if (!state.playlists.some((playlist) => playlist.id === state.playlistId)) state.playlistId = state.playlists[0]?.id || '';
    $('playlist-choice').innerHTML = state.playlists.length ? state.playlists.map((playlist) => `<option value="${escape(playlist.id)}" ${playlist.id === state.playlistId ? 'selected' : ''}>${escape(playlist.name)}</option>`).join('') : '<option value="">No playlists in this Apple Music library yet</option>';
  } catch (error) {
    state.playlists = []; state.playlistId = '';
    $('playlist-choice').innerHTML = '<option value="">Playlists could not load. Refresh to retry.</option>';
    throw error;
  }
}

async function loadHistory() {
  if (state.loading) return;
  clearError();
  if (!authorization.ready) { await prepare(); return; }
  const version = ++state.version; state.loading = true; state.loadingStage = 'authorization'; render();
  try {
    const source = state.source, selectedPlaylistId = state.playlistId, qqPlaylist = selectedQQPlaylist();
    if (source === 'playlist' && !selectedPlaylistId) throw new Error('Choose a playlist first.');
    if (source === 'qq' && (!state.connections?.providers.apple?.connected || !qqPlaylist?.tracks.length)) throw new Error('Connect Apple Music and choose a QQ playlist containing songs first.');
    const [musicUserToken] = await Promise.all([authorization.authorize(), player.stop()]);
    state.connections = await api('/api/connections/apple/connect', { method: 'POST', body: { musicUserToken } });
    state.loadingStage = 'history'; render();
    let tracks = [], more = false, pool, poolSource, qqSummary = '';
    if (source === 'playlist') {
      await loadPlaylists();
      const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId);
      if (!selected) throw new Error('The Apple Music account or playlist changed. Choose a playlist again.');
      tracks = await readRecallCollection((offset) => api(`/api/library/apple/playlists/${encodeURIComponent(selectedPlaylistId)}/tracks?offset=${offset}`));
      pool = playlistPool(tracks.map((track) => ({ ...track, source: 'selected_playlist' })));
      poolSource = { kind: 'playlist', id: selected.id, name: selected.name };
    } else if (source === 'qq') {
      const selected = qqPlaylist.tracks.slice(0, qqQuizLimit); let skipped = 0, ambiguous = 0;
      state.loadingStage = 'matching'; state.matchingProgress = { done: 0, total: selected.length }; render();
      for (let offset = 0; offset < selected.length; offset += 20) {
        const batch = selected.slice(offset, offset + 20);
        const result = await api('/api/recall/qq/resolve', { method: 'POST', body: { tracks: batch } });
        if (version !== state.version) return;
        if (!Array.isArray(result.items) || result.items.length > batch.length || result.total !== batch.length || !Number.isSafeInteger(result.skipped) || result.skipped < 0 || !Number.isSafeInteger(result.ambiguous) || result.ambiguous < 0 || result.items.length + result.skipped + result.ambiguous !== batch.length) throw new Error('QQ song matching returned an unreadable result. Start again to retry.');
        tracks.push(...result.items); skipped += result.skipped; ambiguous += result.ambiguous;
        state.matchingProgress = { done: offset + batch.length, total: selected.length }; render();
      }
      pool = playlistPool(tracks.map((track) => ({ ...track, source: 'selected_playlist' })));
      poolSource = { kind: 'qq', id: qqPlaylist.id, name: qqPlaylist.name };
      qqSummary = `${pool.songs.length} matched recordings from ${selected.length} QQ songs. ${skipped} not found; ${ambiguous} uncertain matches left out.${qqPlaylist.tracks.length > qqQuizLimit ? ' This quiz uses the first 100 songs in the selected playlist.' : ''} QQ picks. Apple Music plays the clues.`;
    } else {
      const seen = new Set(); let offset = '';
      for (let page = 0; page < 20; page++) {
        if (seen.has(offset)) throw new Error('Apple repeated a listening-history page. Refresh and try again.');
        seen.add(offset);
        const result = await api(`/api/library/apple/recent${offset ? `?offset=${encodeURIComponent(offset)}` : ''}`);
        if (version !== state.version) return;
        tracks.push(...result.items);
        offset = result.nextOffset; more = offset != null;
        if (!more) break;
      }
      pool = listeningPool(tracks); poolSource = { kind: 'recent', name: 'recent listening' };
    }
    if (version !== state.version) return;
    if (!pool.songs.length) throw new Error(source === 'qq' ? `No confirmed Apple Music recordings were found for this QQ selection. ${qqSummary} Choose another playlist.` : source === 'playlist' ? 'This playlist has no songs that can play through Apple Music yet. Choose another playlist.' : 'Apple returned no recently played songs that can be used yet. Play a few familiar songs in Apple Music, then refresh.');
    state.songs = pool.songs; state.poolSource = poolSource; state.playbackToken = musicUserToken;
    game.load(state.songs);
    const limit = more ? ' This session uses the first 20 history pages.' : '';
    $('history-note').textContent = `${source === 'qq' ? qqSummary : source === 'playlist' ? 'This session uses the selected playlist. It may include songs you have not heard yet.' : 'Apple’s recent history is a snapshot, not your lifetime listening history. It may include songs you skipped.'}${pool.unavailable ? ` ${pool.unavailable} unavailable or very short entries were left out.` : ''}${limit} Clues stream the original song and pause at its playback position; tiny timing differences can occur.`;
    game.next(state.mode); $('game-options').open = false; state.status = 'Press Play to hear your first clue.'; $('guess').value = ''; render();
  } catch (error) { showError(error); }
  finally { state.loading = false; state.loadingStage = ''; state.matchingProgress = null; render(); }
}

function suggestions() {
  const term = $('guess').value.trim().toLowerCase();
  const matches = term.length >= 2 ? state.songs.filter((track) => `${track.title} ${track.artist}`.toLowerCase().includes(term)).slice(0, 6) : [];
  $('suggestions').hidden = !matches.length;
  $('guess').setAttribute('aria-expanded', String(Boolean(matches.length)));
  $('suggestions').innerHTML = matches.map((track) => `<button type="button" data-title="${escape(track.title)}"><strong>${escape(track.title)}</strong><small>${escape(track.artist)}</small></button>`).join('');
  renderControls();
}

$('connect-apple').onclick = () => void connect();
$('load-history').onclick = () => void loadHistory();
$('refresh-history').onclick = () => void loadHistory();
$('switch-pool').onclick = () => void loadHistory();
$('cancel-sign-in').onclick = () => authorization.cancel();
$('song-source').onchange = () => { state.source = $('song-source').value; render(); if (state.source === 'playlist') void loadPlaylists().catch(showError); };
$('playlist-choice').onchange = () => { state.playlistId = $('playlist-choice').value; render(); };
$('qq-file').onchange = () => void importQQFile($('qq-file').files?.[0]);
$('qq-playlist-choice').onchange = () => { state.qqPlaylistId = $('qq-playlist-choice').value; render(); };
$('clue-mode').onchange = () => { state.mode = $('clue-mode').value; render(); };
async function playClue(replay = false) {
  clearError(); const round = game.snapshot().round;
  if (!round || round.finished || state.clueStarting || state.playback.busy || state.playback.playing || state.loading) return;
  if (authorization.getInstance().musicUserToken !== state.playbackToken) { void loadHistory(); return; }
  state.clueStarting = true;
  try {
    const plan = game.clue({ replay }); state.clueAttempt = plan; render();
    await player.play(plan.track, plan.seconds, { startAt: plan.startAt });
  }
  catch (error) { game.cancelClue(state.clueAttempt); showError(error); }
  finally { state.clueStarting = false; renderControls(); }
}
$('listen').onclick = () => void playClue();
$('replay').onclick = () => void playClue(Boolean(game.snapshot().round?.completedThrough));
$('pause').onclick = () => void player.pause().catch(showError);
$('answer-pause').onclick = () => void player.pause().catch(showError);
$('guess').oninput = suggestions;
$('guess').onkeydown = (event) => { if (event.key === 'Escape') { $('suggestions').hidden = true; $('guess').setAttribute('aria-expanded', 'false'); } };
$('suggestions').onclick = (event) => {
  const button = event.target.closest('[data-title]'); if (!button) return;
  $('guess').value = button.dataset.title; $('suggestions').hidden = true; $('guess').setAttribute('aria-expanded', 'false'); renderControls(); $('guess').focus();
};
$('guess-form').onsubmit = async (event) => {
  event.preventDefault(); clearError();
  if (state.loading || state.clueStarting || state.playback.busy || state.playback.playing) return;
  try {
    game.guess($('guess').value); await player.pause();
    const round = game.snapshot().round;
    state.status = round.finished ? '' : 'Not quite. Your next clue is longer.';
    $('guess').value = ''; $('suggestions').hidden = true; render();
  } catch (error) { showError(error); }
};
$('reveal').onclick = async () => { game.reveal(); await player.pause().catch(showError); render(); };
$('next').onclick = async () => { clearError(); await player.stop().catch(showError); try { game.next(state.mode); $('game-options').open = false; $('guess').value = ''; $('suggestions').hidden = true; state.status = 'Press Play to hear your first clue.'; render(); } catch (error) { showError(error); } };
$('full-song').onclick = async () => { clearError(); if (authorization.getInstance().musicUserToken !== state.playbackToken) { void loadHistory(); return; } state.clueAttempt = null; try { await player.play(game.snapshot().round.track); } catch (error) { showError(error); } };
document.addEventListener('visibilitychange', () => { if (document.hidden) void player.pause().catch(() => {}); });
window.addEventListener('pagehide', () => { void player.stop(); });

async function init() {
  if (location.hostname === '127.0.0.1' && location.port === '4180') {
    document.querySelector('.back-jam').href = 'http://127.0.0.1:4177/';
    document.querySelector('[data-jam-link]').href = 'http://127.0.0.1:4177/';
    document.querySelector('[data-taste-link]').href = 'http://127.0.0.1:4177/?view=taste';
  }
  state.connections = await api('/api/connections'); render();
  if (state.connections.providers.apple?.connected) void loadPlaylists().catch(showError);
  if (state.connections.providers.apple?.configured) await prepare();
}
init().catch(showError);
