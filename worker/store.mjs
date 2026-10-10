const encoder = new TextEncoder(), decoder = new TextDecoder();
const cookieName = 'jamama_cloud_session';
export const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
export const randomHex = (length) => [...crypto.getRandomValues(new Uint8Array(length))].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); };
const unb64 = (value) => Uint8Array.from(atob(value), (x) => x.charCodeAt(0));
export const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i); return mismatch === 0; };

export class Store {
  constructor(env, now = Date.now) { this.db = env.DB; this.secret = env.SESSION_ENCRYPTION_KEY; this.now = now; }
  async key() {
    if (!/^[a-f0-9]{64}$/.test(this.secret || '')) throw fail(503, 'setup_required', 'Jamama’s secure storage is not configured yet.');
    return crypto.subtle.importKey('raw', Uint8Array.from(this.secret.match(/../g), (x) => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async seal(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), encoder.encode(JSON.stringify(value))));
    return `${b64(iv)}.${b64(data)}`;
  }
  async unseal(value) { const [iv, data] = value.split('.'); return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await this.key(), unb64(data)))); }
  async session(request, create = false) {
    const prefix = cookieName + '=';
    const id = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
    let row = /^[a-f0-9]{64}$/.test(id || '') ? await this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').bind(id, this.now()).first() : null;
    if (!row && create) {
      await this.limit(request, 'new-session', 30, 300);
      const data = { csrfToken: randomHex(32), providers: {}, tracks: {}, remember: true };
      row = { id: randomHex(32), payload: await this.seal(data), revision: 0, expires_at: this.now() + 30 * 86400000 };
      await this.db.prepare('INSERT INTO sessions (id, payload, revision, expires_at) VALUES (?, ?, 0, ?)').bind(row.id, row.payload, row.expires_at).run();
    }
    return row ? { id: row.id, revision: row.revision, expiresAt: row.expires_at, data: await this.unseal(row.payload) } : null;
  }
  async saveSession(session) {
    const expiresAt = this.now() + (session.data.remember === false ? 8 * 3600000 : 30 * 86400000);
    const result = await this.db.prepare('UPDATE sessions SET payload = ?, revision = revision + 1, expires_at = ? WHERE id = ? AND revision = ?').bind(await this.seal(session.data), expiresAt, session.id, session.revision).run();
    if (!result.meta.changes) throw fail(409, 'connection_changed', 'Your connection changed. Refresh and try again.');
    session.revision++; session.expiresAt = expiresAt;
  }
  async mergeLibrary(session, provider, item, tracks, { previousProvider = item } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').bind(session.id, this.now()).first();
      if (!row) throw fail(409, 'connection_changed', 'Your connection changed. Refresh and try again.');
      const current = { id: row.id, revision: row.revision, data: await this.unseal(row.payload) };
      if (item) {
        if (current.data.providers[provider]?.generation !== item.generation) throw fail(409, 'connection_changed', 'Your music connection changed. Refresh and try again.');
        const tokenFields = (value) => JSON.stringify([value?.accessToken, value?.refreshToken, value?.expiresAt]);
        if (tokenFields(item) !== tokenFields(previousProvider) && (tokenFields(current.data.providers[provider]) === tokenFields(previousProvider) || item.expiresAt > current.data.providers[provider].expiresAt)) current.data.providers[provider] = { ...current.data.providers[provider], ...item };
      }
      for (const track of tracks || []) if (track.providerId) current.data.tracks[track.id] = track;
      const ids = Object.keys(current.data.tracks); for (const id of ids.slice(0, Math.max(0, ids.length - 2500))) delete current.data.tracks[id];
      try { await this.saveSession(current); Object.assign(session, current); return; }
      catch (error) { if (error.code !== 'connection_changed' || attempt === 4) throw error; }
    }
  }
  cookie(session) { return `${cookieName}=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/${session.data.remember === false ? '' : '; Max-Age=2592000'}`; }
  async currentProvider(session, provider, generation) {
    const row = await this.db.prepare('SELECT payload FROM sessions WHERE id = ? AND expires_at > ?').bind(session.id, this.now()).first();
    const current = row ? (await this.unseal(row.payload)).providers[provider] : null;
    if (!current || current.generation !== generation) throw fail(409, 'connection_changed', 'Your music connection changed. Refresh and try again.');
  }
  async dropProvider(session, provider, generation) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').bind(session.id, this.now()).first();
      if (!row) return false;
      const current = { id: row.id, revision: row.revision, data: await this.unseal(row.payload) };
      if (generation && current.data.providers[provider]?.generation !== generation) return false;
      delete current.data.providers[provider];
      for (const id of Object.keys(current.data.tracks)) if (id.startsWith(`${provider}:`)) delete current.data.tracks[id];
      try { await this.saveSession(current); Object.assign(session, current); return true; }
      catch (error) { if (error.code !== 'connection_changed' || attempt === 4) throw error; }
    }
  }
  async room(code) {
    const row = await this.db.prepare('SELECT * FROM rooms WHERE code = ? AND expires_at > ?').bind(code, this.now()).first();
    if (!row) throw fail(404, 'room_closed', 'This Jam is closed. Start or join another Jam.');
    return { state: JSON.parse(row.payload), revision: row.revision };
  }
  async insertRoom(room) {
    await this.db.prepare('INSERT INTO rooms (code, payload, revision, expires_at) VALUES (?, ?, 0, ?)').bind(room.code, JSON.stringify(room), this.now() + 86400000).run();
  }
  async mutateRoom(code, update, { connection } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let sessionRevision;
      if (connection) {
        const row = await this.db.prepare('SELECT payload, revision FROM sessions WHERE id = ? AND expires_at > ?').bind(connection.sessionId, this.now()).first();
        const provider = row ? (await this.unseal(row.payload)).providers[connection.provider] : null;
        if (!provider || provider.generation !== connection.generation) throw fail(409, 'connection_changed', 'Your music connection changed. Refresh and try again.');
        sessionRevision = row.revision;
      }
      const { state, revision } = await this.room(code), result = await update(state);
      const payload = JSON.stringify(state);
      if (encoder.encode(payload).length > 1500000) throw fail(413, 'room_storage_limit', 'This song selection is too large for the Jam. Choose a smaller playlist.');
      const guard = connection ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND revision = ? AND expires_at > ?)' : '';
      const parameters = connection ? [connection.sessionId, sessionRevision, this.now()] : [];
      const write = state.endedAt != null
        ? await this.db.prepare('DELETE FROM rooms WHERE code = ? AND revision = ?' + guard).bind(code, revision, ...parameters).run()
        : await this.db.prepare('UPDATE rooms SET payload = ?, revision = revision + 1, expires_at = ? WHERE code = ? AND revision = ?' + guard).bind(payload, this.now() + 86400000, code, revision, ...parameters).run();
      if (write.meta.changes) return result;
    }
    throw fail(409, 'room_busy', 'The Jam changed while updating. Please try again.');
  }
  async limit(request, category, max, seconds = 60) {
    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(address)));
    const key = `${category}:${Math.floor(this.now() / (seconds * 1000))}:${b64(digest)}`;
    const row = await this.db.prepare('INSERT INTO limits (id, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count = count + 1 RETURNING count').bind(key, this.now() + seconds * 2000).first();
    if (row.count > max) throw fail(429, 'too_many_attempts', 'Too many requests. Wait a moment and try again.');
  }
  async cleanup() { const now = this.now(); await this.db.batch([this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now), this.db.prepare('DELETE FROM rooms WHERE expires_at < ?').bind(now), this.db.prepare('DELETE FROM limits WHERE expires_at < ?').bind(now)]); }
}
