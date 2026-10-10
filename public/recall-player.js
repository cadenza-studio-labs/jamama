export function createRecallPlayer({ getSDK, getPlaybackPosition = (target) => target?.currentPlaybackTime, onState = () => {}, onError = () => {}, intervalMs = 25, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const cancelled = Symbol('cancelled');
  let music, active, pendingMutation, operation = 0, limit = null, busy = false, heard = false, ready = false, readyToken;
  const pendingPauses = new Set();
  const sdkPlaying = (target = music) => Boolean(target && target.playbackState === getSDK().PlaybackStates.playing);
  const playing = () => Boolean(active && sdkPlaying());
  const position = () => Number(getPlaybackPosition(music));
  const emit = (changes = {}) => { const time = position(); onState({ playing: playing(), busy, position: Number.isFinite(time) ? Math.max(0, time) : 0, limit, heard, ...changes }); };
  const current = (attempt) => active === attempt && !attempt.cancelled;
  function clearTimers(attempt) {
    if (!attempt) return;
    if (attempt.timer != null) clearIntervalFn(attempt.timer);
    if (attempt.watchdog != null) clearIntervalFn(attempt.watchdog);
  }
  function abandon(attempt) {
    if (!attempt) return;
    attempt.cancelled = true; attempt.resolveCancellation(cancelled); clearTimers(attempt);
  }
  function requestPause(target = music) {
    let pause;
    try { pause = Promise.resolve(target?.pause()); } catch (error) { pause = Promise.reject(error); }
    pause = pause.catch((error) => { if (typeof target?.stop === 'function') return target.stop(); throw error; });
    pendingPauses.add(pause);
    pause.then(() => pendingPauses.delete(pause), () => pendingPauses.delete(pause));
    return pause;
  }
  function cancel({ clearHeard = true, complete = false } = {}) {
    abandon(active); active = undefined; busy = false; limit = null;
    if (clearHeard) heard = false;
    const ticket = ++operation, pause = requestPause();
    emit();
    pause.then(() => { if (ticket === operation) emit(complete ? { complete: true } : {}); }, () => { if (ticket === operation) emit(); });
    return pause;
  }
  async function wait(attempt, promise) {
    const result = await Promise.race([promise, attempt.cancellation]);
    if (result === cancelled || !current(attempt)) throw cancelled;
    return result;
  }
  async function mutate(attempt, target, action, mayPlay = false) {
    if (!current(attempt)) throw cancelled;
    const result = Promise.resolve(action());
    let lateTimer, pausing = false;
    if (mayPlay) lateTimer = setIntervalFn(() => {
      if (!current(attempt) && sdkPlaying(target) && !pausing) {
        pausing = true;
        requestPause(target).catch(() => {}).finally(() => { pausing = false; });
      }
    }, intervalMs);
    // A cancelled SDK call can still change the shared player when it settles.
    const drain = result.then(async (value) => {
      if (mayPlay && attempt.cancelled) await requestPause(target).catch(() => {});
      return value;
    }, async (error) => {
      if (mayPlay && attempt.cancelled) await requestPause(target).catch(() => {});
      throw error;
    });
    pendingMutation = drain;
    const finish = () => { if (lateTimer != null) clearIntervalFn(lateTimer); if (pendingMutation === drain) pendingMutation = undefined; };
    drain.then(finish, finish);
    return wait(attempt, drain);
  }
  const errorMessage = (error) => error?.code === 'recall_authorization_required' ? error.message : Number.isInteger(error?.status) && error.status === 403 ? 'Apple Music did not permit this recording. Try another song.' : 'Apple Music could not finish playback. Try again in Safari or Chrome.';
  function fail(attempt, message) {
    if (!current(attempt)) return;
    void cancel().catch(() => {}); onError(new Error(message));
  }
  function poll(attempt) {
    if (!current(attempt) || !attempt.playRequested) return;
    const SDK = getSDK(), item = music.nowPlayingItem, time = position();
    if (item?.id && String(item.id) !== attempt.id && String(item.attributes?.playParams?.catalogId || '') !== attempt.id) { fail(attempt, 'Another song started playing. Replay this clue when you’re ready.'); return; }
    const finishedStates = [SDK.PlaybackStates.ended, SDK.PlaybackStates.completed].filter((value) => value != null);
    if (limit == null && heard && finishedStates.includes(music.playbackState)) { void cancel({ clearHeard: false }).catch(() => {}); return; }
    if (playing()) {
      const fullTypes = [SDK.PlaybackType?.encryptedFull, SDK.PlaybackType?.unencryptedFull].filter((value) => value != null);
      if (!fullTypes.includes(item?.playbackType)) { fail(attempt, 'Full Apple Music playback is required. Previews are not used for this game.'); return; }
      if (!Number.isFinite(time)) { emit(); return; }
      if (time > 0 && time + .1 < attempt.startAt) { fail(attempt, 'Apple Music could not reach this clue’s starting point. Replay the clue to retry.'); return; }
      if (!heard && time <= attempt.startAt) { emit(); return; }
      if (!heard || time > attempt.lastPosition) attempt.lastProgressAt = now();
      heard = true; attempt.lastPosition = time;
      if (limit != null && time >= limit) { void cancel({ clearHeard: false, complete: true }).catch((error) => onError(new Error(errorMessage(error)))); return; }
    }
    emit();
  }
  return {
    get playing() { return playing(); },
    async prepare() {
      const SDK = getSDK(); music = SDK.getInstance();
      const target = music, token = target.musicUserToken;
      if (!target.isAuthorized) throw Object.assign(new Error('Select Refresh songs to reconnect Apple Music before playing.'), { code: 'recall_authorization_required' });
      if (!await target.hasMusicSubscription()) throw new Error('An active Apple Music subscription is needed for full-song clues.');
      if (target !== music || !target.isAuthorized || target.musicUserToken !== token) throw Object.assign(new Error('Select Refresh songs to reconnect Apple Music before playing.'), { code: 'recall_authorization_required' });
      target.autoplayEnabled = false; ready = true; readyToken = token;
    },
    async play(track, seconds = null, { startAt = 0 } = {}) {
      if (busy) throw new Error('Apple Music is preparing the clue. Please wait.');
      const id = String(track.catalogId || track.providerId || '');
      if (!/^\d+$/.test(id)) throw new Error('This song has no playable Apple Music recording.');
      if (!Number.isFinite(startAt) || startAt < 0 || (seconds != null && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 16 || !Number.isFinite(track.durationMs) || startAt + seconds > track.durationMs / 1000))) throw new Error('Choose a clue within this recording.');
      abandon(active);
      const attempt = { id, startAt, startedAt: now(), lastPosition: startAt, lastProgressAt: null, cancelled: false, playRequested: false };
      attempt.cancellation = new Promise((resolve) => { attempt.resolveCancellation = resolve; });
      active = attempt; operation++; busy = true; heard = false; limit = null; emit();
      attempt.watchdog = setIntervalFn(() => {
        if (!current(attempt)) return;
        try { poll(attempt); } catch { fail(attempt, 'Playback timing could not be confirmed. Please retry.'); }
        if (!current(attempt)) return;
        if (!heard && now() - attempt.startedAt > 20000) fail(attempt, 'Apple Music took too long to start. Retry the clue.');
        else if (heard && now() - attempt.lastProgressAt > 15000) fail(attempt, 'Playback timing stopped updating. The recording was paused.');
      }, 1000);
      try {
        const pending = [pendingMutation, ...pendingPauses].filter(Boolean);
        if (pending.length) await wait(attempt, Promise.allSettled(pending));
        if (music && (!music.isAuthorized || music.musicUserToken !== readyToken)) ready = false;
        if (!ready) await wait(attempt, this.prepare());
        const target = music;
        await mutate(attempt, target, () => target.pause());
        await mutate(attempt, target, () => target.setQueue({ song: id, startTime: startAt }));
        await mutate(attempt, target, () => target.seekToTime(startAt));
        if (!current(attempt)) return;
        limit = seconds == null ? null : startAt + seconds; attempt.playRequested = true;
        attempt.timer = setIntervalFn(() => { try { poll(attempt); } catch { fail(attempt, 'Playback timing could not be confirmed. Please retry.'); } }, intervalMs);
        await mutate(attempt, target, () => target.play(), true);
        if (!current(attempt)) return;
        busy = false; emit();
      } catch (error) {
        if (error === cancelled || !current(attempt)) return;
        void cancel().catch(() => {});
        const message = errorMessage(error); onError(new Error(message)); throw new Error(message);
      }
    },
    pause: () => cancel(),
    stop: () => cancel(),
  };
}
