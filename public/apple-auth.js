export function createAppleAuthorization({ getConfiguration, loadSDK, timeoutMs = 0, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let preparation, instance, pending;
  return {
    get ready() { return Boolean(instance); },
    getInstance() { if (!instance) throw new Error('Apple Music is still preparing.'); return instance; },
    prepare() {
      if (!preparation) preparation = Promise.all([getConfiguration(), loadSDK()])
        .then(async ([configuration, SDK]) => {
          await SDK.configure(configuration);
          instance = SDK.getInstance();
        })
        .catch((error) => { preparation = undefined; throw error; });
      return preparation;
    },
    authorize() {
      if (!instance) throw new Error('Apple Music is still preparing. Please try again shortly.');
      if (pending) return pending.promise;
      // Open Apple's popup during the click, before any network request can lose user activation.
      const authorization = instance.authorize();
      const attempt = {};
      attempt.promise = new Promise((resolve, reject) => {
        attempt.finish = (error, token) => {
          if (pending !== attempt) return;
          pending = undefined; clearTimeoutFn(attempt.timer);
          if (error) reject(error); else resolve(token);
        };
      });
      pending = attempt;
      if (timeoutMs > 0) attempt.timer = setTimeoutFn(() => attempt.finish(new Error('Apple sign-in took too long. Close its window, then try again.')), timeoutMs);
      Promise.resolve(authorization).then((token) => {
        if (typeof token !== 'string' || !token.trim()) attempt.finish(new Error('Apple did not return library access.'));
        else attempt.finish(null, token);
      }, (error) => attempt.finish(error));
      return attempt.promise;
    },
    cancel() {
      const error = new Error('Sign-in cancelled. Close Apple’s window before trying again.');
      error.code = 'authorization_cancelled';
      pending?.finish(error);
    },
  };
}

export function observeAppleAuthorization(target) {
  const events = [];
  const allowed = new Set(['authorize', 'decline', 'unavailable', 'switchUserId']);
  function receive(event) {
    if (event.origin !== 'https://authorize.music.apple.com' || event.data?.jsonrpc !== '2.0' || !allowed.has(event.data.method)) return;
    events.push(event.data.method);
  }
  target.addEventListener('message', receive);
  return {
    finish() {
      target.removeEventListener('message', receive);
      return { permissionReturned: events.includes('authorize'), permissionDeclined: events.includes('decline'), serviceUnavailable: events.includes('unavailable') };
    },
  };
}
