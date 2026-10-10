import { hostIsPlaying, targetPosition } from './playback-clock.js';
import { drainApplePlaybackMutations, trackApplePlaybackMutation } from './apple-player.js';

export function createAppleListener({ getSDK, resolveTrack, reportState, onStatus, now = Date.now, intervalMs = 1000 }) {
  let SDK, music, room, match, binding, timer, enabled = false, ready = false, busy = false, reporting = false, epoch = 0, offset = 0, lastSeek = 0, confirmed = false, pausedByHost = false;
  let activation;
  const pendingMutations = new Set();
  const stamp = (value) => `${value?.nowPlaying?.id || ''}/${value?.nowPlaying?.hostTrack?.id || ''}`;
  function track(promise) {
    pendingMutations.add(promise);
    promise.then(() => pendingMutations.delete(promise), () => pendingMutations.delete(promise));
    return promise;
  }
  function pause(target = music) {
    let result;
    try { result = Promise.resolve(target?.pause()); } catch (error) { result = Promise.reject(error); }
    return track(trackApplePlaybackMutation(target, result.catch((error) => { if (typeof target?.stop === 'function') return target.stop(); throw error; })));
  }
  function mutate(currentEpoch, target, action, mayPlay = false) {
    let result;
    try { result = Promise.resolve(action()); } catch (error) { result = Promise.reject(error); }
    return track(trackApplePlaybackMutation(target, result.then(async (value) => {
      if (mayPlay && currentEpoch !== epoch) await pause(target).catch(() => {});
      return value;
    }, async (error) => {
      if (mayPlay && currentEpoch !== epoch) await pause(target).catch(() => {});
      throw error;
    })));
  }
  function state() {
    const item = music?.nowPlayingItem;
    return { trackId: String(item?.attributes?.playParams?.catalogId || item?.id || ''), playing: music?.playbackState === SDK?.PlaybackStates?.playing,
      fullPlayback: [SDK?.PlaybackType?.encryptedFull, SDK?.PlaybackType?.unencryptedFull].some((type) => type !== undefined && item?.playbackType === type),
      position: Number.isFinite(music?.currentPlaybackTime) ? Math.max(0, music.currentPlaybackTime * 1000) : 0 };
  }
  async function prepare(nextRoom, selectedMatch) {
    if (enabled) throw new Error('Stop listening before preparing another player.');
    const currentEpoch = ++epoch;
    ready = false; activation = undefined;
    if (pendingMutations.size) await Promise.allSettled([...pendingMutations]);
    if (currentEpoch !== epoch) return;
    SDK = getSDK(); music = SDK.getInstance(); room = nextRoom; match = selectedMatch;
    const target = music;
    await drainApplePlaybackMutations(target);
    if (currentEpoch !== epoch) return;
    if (!music.isAuthorized) throw new Error('Sign in with your own Apple Music account first.');
    if (!await target.hasMusicSubscription()) throw new Error('Your device needs an active Apple Music subscription.');
    if (currentEpoch !== epoch) return;
    target.autoplayEnabled = false;
    await mutate(currentEpoch, target, () => target.setQueue({ song: match.track.providerId }));
    if (currentEpoch !== epoch) return;
    ready = true;
  }
  function observe(nextRoom) {
    room = nextRoom;
    if (enabled && (!room || room.listeningMode !== 'everyone')) void stop();
    else if (enabled) void reconcile();
  }
  async function report(error = false) {
    if (!binding || reporting) return;
    const current = binding; reporting = true;
    try {
      const result = await reportState(current.code, { generation: current.generation, sourceKey: match.sourceKey, ...state(), error });
      if (binding !== current) return;
      if (result.room?.code === room?.code && result.room.version >= room.version) room = result.room;
      if (result.pause) { pausedByHost = !hostIsPlaying(room, now() + offset); await pause(); }
      if (binding !== current) return;
      const status = result.room?.members.find((member) => member.id === current.memberId)?.listener;
      if (status) onStatus(status);
    } catch (error) { if (binding === current) { await stop(); onStatus({ status: 'error', error: error.message }); } }
    finally { reporting = false; }
  }
  async function reconcile() {
    if (!enabled || busy || !room || !binding) return;
    busy = true; const currentEpoch = epoch;
    try {
      const playing = hostIsPlaying(room, now() + offset);
      if (!playing) { pausedByHost = true; if (state().playing) await pause(); if (currentEpoch === epoch) await report(); return; }
      if (match.sourceKey !== stamp(room)) {
        const next = await resolveTrack(room.code, 'apple');
        if (currentEpoch !== epoch || !enabled) return;
        if (next.status !== 'matched') { await stop(); onStatus({ status: 'choose_recording', error: next.message || 'Choose the Apple Music recording.' }); return; }
        match = next;
        confirmed = false;
        await mutate(currentEpoch, music, () => music.setQueue({ song: match.track.providerId }));
        if (currentEpoch !== epoch || !enabled) return;
      }
      const before = state();
      const finished = [SDK.PlaybackStates.ended, SDK.PlaybackStates.completed].some((value) => value !== undefined && music.playbackState === value);
      if (confirmed && !pausedByHost && (before.trackId !== match.track.providerId || !before.playing && !finished)) { await stop(); onStatus({ status: 'stopped', error: 'Playback changed on this device. Tap Listen to rejoin.' }); return; }
      if (finished && match.sourceKey === stamp(room)) { await report(); return; }
      if (!state().playing) await mutate(currentEpoch, music, () => music.play(), true);
      if (currentEpoch !== epoch || !enabled) return;
      const snapshot = state();
      confirmed = snapshot.playing; pausedByHost = false;
      if (snapshot.playing && !snapshot.fullPlayback) { await pause(); if (currentEpoch !== epoch) return; await report(true); if (currentEpoch !== epoch) return; await stop(); onStatus({ status: 'error', error: 'Full Apple Music playback is required. A preview cannot join the Jam.' }); return; }
      const target = targetPosition(room.playback, now() + offset);
      if (Math.abs(snapshot.position - target) > 1000 && now() - lastSeek > 5000) { await mutate(currentEpoch, music, () => music.seekToTime(target / 1000)); if (currentEpoch !== epoch) return; lastSeek = now(); }
      await report();
    } catch (error) { if (currentEpoch === epoch && enabled) { await pause().catch(() => {}); if (currentEpoch !== epoch) return; await report(true); if (currentEpoch !== epoch) return; await stop(); onStatus({ status: 'error', error: error.message || 'This browser could not play Apple Music. Try Safari or Chrome.' }); } }
    finally { if (currentEpoch === epoch) busy = false; }
  }
  function unlock() {
    if (!ready) throw new Error('Prepare your Apple Music player first.');
    if (pendingMutations.size) throw new Error('Apple Music is still stopping. Try again shortly.');
    const current = { epoch };
    activation = current;
    current.promise = mutate(current.epoch, music, () => music.play(), true);
    return current.promise;
  }
  async function start(nextBinding, playPromise, clockOffset) {
    const current = activation;
    if (!ready || !current || current.promise !== playPromise || current.epoch !== epoch) throw new Error('The Apple Music listening connection changed. Prepare it again.');
    binding = nextBinding; offset = clockOffset; enabled = true; confirmed = false; pausedByHost = false;
    try { await playPromise; } catch (error) { if (current.epoch === epoch) await stop(); throw error; }
    if (!enabled || current.epoch !== epoch) return;
    timer = intervalMs > 0 ? setInterval(() => { void reconcile(); }, intervalMs) : null;
    await reconcile();
  }
  async function stop() {
    enabled = false; ready = false; busy = false; activation = undefined; epoch++; binding = null; clearInterval(timer); timer = null;
    if (music) await pause().catch(() => {});
  }
  return { prepare, observe, unlock, start, stop, reconcile, state, get enabled() { return enabled; }, get prepared() { return ready; } };
}
