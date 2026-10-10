const playbackMutations = new WeakMap();

export function trackApplePlaybackMutation(target, promise) {
  if (!target) return promise;
  let pending = playbackMutations.get(target);
  if (!pending) { pending = new Set(); playbackMutations.set(target, pending); }
  pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}

export function drainApplePlaybackMutations(target) {
  return Promise.allSettled([...(playbackMutations.get(target) || [])]);
}

export function createAppleBrowserPlayer({ getSDK, sendState, onRoom, onError, intervalMs = 1000 }) {
  let SDK, music, binding, timer, reporting = false, executing = false, commandId = null, completedTrackId = null, lastTrackId = null, errorCode = null;
  const numericId = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
  const milliseconds = (value) => Number.isFinite(value) && value >= 0 ? Math.min(86400000, value * 1000) : 0;
  const pendingPauses = new Set();
  function pause(target) {
    const result = trackApplePlaybackMutation(target, (async () => { try { await target.pause(); } catch { if (typeof target.stop === 'function') await Promise.resolve(target.stop()).catch(() => {}); } })());
    pendingPauses.add(result);
    result.then(() => pendingPauses.delete(result), () => pendingPauses.delete(result));
    return result;
  }
  function snapshot() {
    const item = music.nowPlayingItem;
    const trackId = [item?.id, item?.attributes?.playParams?.catalogId, item?.playParams?.catalogId].find(numericId) || null;
    if (trackId) lastTrackId = trackId;
    const playing = music.playbackState === SDK.PlaybackStates.playing;
    const fullPlayback = [SDK.PlaybackType?.encryptedFull, SDK.PlaybackType?.unencryptedFull].some((value) => value !== undefined && item?.playbackType === value);
    return { generation: binding.generation, commandId, trackId, playing, fullPlayback, completedTrackId,
      position: milliseconds(music.currentPlaybackTime), duration: milliseconds(music.currentPlaybackDuration), ...(errorCode ? { errorCode } : {}) };
  }
  function classify(error) {
    return ['DRM_UNSUPPORTED', 'MEDIA_LICENSE', 'UNSUPPORTED_ERROR'].includes(error?.reason) ? 'unsupported_browser'
      : error?.reason === 'SUBSCRIPTION_ERROR' ? 'subscription_required' : 'playback_failed';
  }
  async function report() {
    if (!binding || reporting || executing) return;
    const current = binding;
    reporting = true;
    let next;
    try {
      const result = await sendState(current.code, snapshot());
      if (binding !== current) return;
      onRoom(result.room); next = result.command;
      if (result.room.playback?.status === 'error') { await pause(music); if (binding === current) errorCode = null; }
    } catch (error) {
      if (binding === current) { await stop(); onError(error); }
    } finally { reporting = false; }
    if (next && binding === current) await execute(next);
  }
  function stateChanged(event) {
    if ([SDK.PlaybackStates.ended, SDK.PlaybackStates.completed].includes(event?.state)) completedTrackId = lastTrackId;
    void report();
  }
  function playbackError(event) { errorCode = classify(event); void report(); }
  async function prepare() {
    SDK = getSDK(); music = SDK.getInstance();
    if (!music.isAuthorized) await music.authorize();
    await drainApplePlaybackMutations(music);
    if (!await music.hasMusicSubscription()) throw new Error('The host needs an active Apple Music subscription.');
    music.autoplayEnabled = false;
    if (music.playbackState === SDK.PlaybackStates.playing) await pause(music);
  }
  function connect({ code, generation }) {
    if (!music || !generation) throw new Error('Prepare Apple Music playback first.');
    if (binding) throw new Error('Disconnect the previous Apple Music player first.');
    binding = { code, generation }; commandId = null; completedTrackId = null; errorCode = null;
    music.addEventListener(SDK.Events.playbackStateDidChange, stateChanged);
    music.addEventListener(SDK.Events.mediaPlaybackError, playbackError);
    timer = intervalMs > 0 ? setInterval(() => { void report(); }, intervalMs) : null;
    void report();
  }
  async function execute(command) {
    if (!binding || command.generation !== binding.generation) throw new Error('The Apple Music playback connection changed.');
    const current = binding;
    if (executing) {
      if (executing.binding === current) throw new Error('The Apple Music playback connection changed.');
      await executing.promise;
      if (binding !== current) return;
    }
    if (pendingPauses.size) { await Promise.allSettled([...pendingPauses]); if (binding !== current) return; }
    await drainApplePlaybackMutations(music);
    if (binding !== current) return;
    if (executing) throw new Error('The Apple Music playback connection changed.');
    const target = music, attempt = { binding: current };
    executing = attempt; commandId = command.id; completedTrackId = null; errorCode = null;
    attempt.promise = trackApplePlaybackMutation(target, (async () => {
      try {
        if (command.action === 'pause') await target.pause();
        else if (command.action === 'play' && numericId(command.track?.providerId)) {
          const currentId = target.nowPlayingItem?.id;
          if (currentId !== command.track.providerId) { target.autoplayEnabled = false; await target.setQueue({ song: command.track.providerId }); }
          if (binding === current) {
            try { await target.play(); }
            finally { if (binding !== current) await pause(target); }
          }
        } else throw new Error('Choose a verified Apple Music recording.');
      } catch (error) { if (binding === current) errorCode = classify(error); }
      finally { if (executing === attempt) executing = false; }
    })());
    await attempt.promise;
    if (binding === current) await report();
  }
  async function stop() {
    binding = null; clearInterval(timer); timer = null;
    if (music) {
      music.removeEventListener(SDK.Events.playbackStateDidChange, stateChanged);
      music.removeEventListener(SDK.Events.mediaPlaybackError, playbackError);
      await pause(music);
    }
  }
  return { prepare, connect, execute, stop, report, snapshot, get connected() { return Boolean(binding); }, get generation() { return binding?.generation; } };
}
