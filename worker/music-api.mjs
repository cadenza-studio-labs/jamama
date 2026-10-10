const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = (length) => crypto.getRandomValues(new Uint8Array(length));
const decodeClaims = (token) => {
  const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')), (value) => value.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

export const providerError = (status, code, message) => Object.assign(new Error(message), { status, code });
const playback = { available: false, reason: "This song can be requested. Playback uses a separately connected host player." };
const duration = (milliseconds) => Number.isFinite(milliseconds) ? `${Math.floor(milliseconds / 60000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}` : "—";
const recordingCode = (value) => typeof value === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value) ? value.toUpperCase() : null;
const httpsUrl = (value) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
};

export function spotifyTrack(track) {
  if (!track?.id || track.type !== "track" || track.is_local) return null;
  return {
    id: `spotify:${track.id}`, provider: "spotify", providerId: track.id, isDemo: false,
    title: track.name || "Untitled song", artist: track.artists?.map((artist) => artist.name).join(", ") || "Unknown artist",
    album: track.album?.name || "", duration: duration(track.duration_ms), durationMs: track.duration_ms ?? null,
    artworkUrl: httpsUrl(track.album?.images?.[0]?.url), externalUrl: httpsUrl(track.external_urls?.spotify) || `https://open.spotify.com/track/${encodeURIComponent(track.id)}`,
    isrc: recordingCode(track.external_ids?.isrc), playback,
  };
}

export function appleTrack(track) {
  if (!track?.id || !["library-songs", "songs"].includes(track.type)) return null;
  const attributes = track.attributes || {};
  const catalogId = track.type === "songs" ? track.id : attributes.playParams?.catalogId || null;
  return {
    id: `apple:${track.id}`, provider: "apple", providerId: track.id, catalogId, isDemo: false,
    title: attributes.name || "Untitled song", artist: attributes.artistName || "Unknown artist", album: attributes.albumName || "",
    duration: duration(attributes.durationInMillis), durationMs: attributes.durationInMillis ?? null,
    artworkUrl: httpsUrl(attributes.artwork?.url?.replaceAll("{w}", "300").replaceAll("{h}", "300")),
    externalUrl: httpsUrl(attributes.url) || (catalogId ? `https://music.apple.com/song/${encodeURIComponent(catalogId)}` : null),
    isrc: recordingCode(attributes.isrc), playback,
  };
}

async function upstream(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    if (response.status >= 300 && response.status < 400) throw new Error('Unexpected service redirect');
  }
  catch { throw providerError(502, "service_unavailable", "The music service couldn't be reached. Please try again."); }
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { response, data };
}

function checkResponse(response, provider) {
  if (response.ok) return;
  if (response.status === 429) {
    const error = providerError(429, "rate_limited", `${provider} needs a short pause before another request. Please try again shortly.`);
    const seconds = Number(response.headers.get("retry-after"));
    if (Number.isFinite(seconds) && seconds > 0) error.retryAfter = Math.ceil(seconds);
    throw error;
  }
  if (response.status === 401 && provider === "Apple Music") throw providerError(503, "app_configuration_required", "The app's Apple Music developer token is invalid or expired. The app owner needs to update it before library access can resume.");
  if (response.status === 403 && provider === "Apple Music") throw providerError(401, "reconnect_required", "Apple Music library permission was denied or expired. Connect Apple Music again to restore access.");
  if (response.status === 401) throw providerError(401, "reconnect_required", `Connect ${provider} again to access your library.`);
  if (response.status === 403) throw providerError(403, "access_denied", provider === "Spotify"
    ? "Spotify denied access. Development apps need an approved user and a Premium app owner. Playlist contents are limited to playlists you own or collaborate on."
    : "Apple Music denied access. Check the developer token, your Apple Music subscription, and the library permission, then reconnect.");
  if (response.status === 404) throw providerError(404, "not_found", `${provider} couldn't find that playlist or song.`);
  throw providerError(502, "service_unavailable", `${provider} couldn't complete that request. Please try again.`);
}

function page(data, items, base) {
  let nextOffset = null;
  if (data?.next) {
    let next;
    try { next = new URL(data.next, base); } catch {}
    const value = next?.searchParams.get('offset');
    if (next?.origin !== new URL(base).origin || next.username || next.password || !/^\d{1,8}$/.test(value || '')) {
      throw providerError(502, 'invalid_library_page', 'The music service returned an unreadable library page. Try again.');
    }
    nextOffset = Number(value);
  }
  return { items, nextOffset, total: Number.isFinite(data?.total) ? data.total : Number.isFinite(data?.meta?.total) ? data.meta.total : null };
}

function spotifyAlbum(album) {
  return { id: album.id, provider: "spotify", kind: "album", source: "library", name: album.name || "Untitled album",
    subtitle: album.artists?.map((artist) => artist.name).join(", ") || "Spotify album", trackCount: album.total_tracks ?? null,
    artworkUrl: httpsUrl(album.images?.[0]?.url), externalUrl: httpsUrl(album.external_urls?.spotify) };
}

function appleAlbum(album) {
  const attributes = album.attributes || {};
  return { id: album.id, provider: "apple", kind: "album", source: "library", name: attributes.name || "Untitled album",
    subtitle: attributes.artistName || "Apple Music album", trackCount: attributes.trackCount ?? null,
    artworkUrl: httpsUrl(attributes.artwork?.url?.replaceAll("{w}", "300").replaceAll("{h}", "300")), externalUrl: httpsUrl(attributes.url) };
}

export function createSpotify({ clientId, redirectUri, fetchImpl = fetch, now = Date.now }) {
  const tokenEndpoint = "https://accounts.spotify.com/api/token";
  const apiBase = "https://api.spotify.com/v1";

  async function authorization(playbackMode = '', callbackUri = redirectUri) {
    if (!['', 'web', 'listen'].includes(playbackMode)) throw providerError(400, 'invalid_player_mode', 'Choose a cloud-supported Spotify playback mode.');
    const verifier = base64url(random(48));
    const state = [...random(32)].map((value) => value.toString(16).padStart(2, '0')).join('');
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const requestedScope = `playlist-read-private playlist-read-collaborative user-library-read${playbackMode ? ' user-read-playback-state' : ''}${['web', 'listen'].includes(playbackMode) ? ' user-modify-playback-state' : ''}`;
    const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: callbackUri, state,
      scope: requestedScope, code_challenge_method: "S256",
      code_challenge: challenge });
    return { verifier, state, requestedScope, playbackMode, redirectUri: callbackUri, startedAt: now(), url: `https://accounts.spotify.com/authorize?${params}` };
  }

  async function token(params, previous) {
    const { response, data } = await upstream(fetchImpl, tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, ...params }).toString() });
    if ([400, 401].includes(response.status)) throw providerError(401, "reconnect_required", "Spotify authorization expired or was rejected. Please connect again.");
    checkResponse(response, "Spotify");
    if (!data?.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || (data.token_type && data.token_type.toLowerCase() !== "bearer")) {
      throw providerError(502, "service_unavailable", "Spotify returned an incomplete authorization. Please connect again.");
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token || previous?.refreshToken,
      expiresAt: now() + data.expires_in * 1000, scope: data.scope || previous?.scope || "" };
  }

  async function refresh(connection) {
    if (!connection.refreshToken) throw providerError(401, "reconnect_required", "Your Spotify connection expired. Please connect again.");
    if (!connection.refreshing) {
      connection.refreshing = token({ grant_type: "refresh_token", refresh_token: connection.refreshToken }, connection)
        .then((tokens) => Object.assign(connection, tokens)).finally(() => { delete connection.refreshing; });
    }
    await connection.refreshing;
  }

  async function get(connection, path, allowEmpty = false) {
    if (connection.expiresAt <= now() + 30_000) await refresh(connection);
    let result = await upstream(fetchImpl, apiBase + path, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
    if (result.response.status === 401) {
      await refresh(connection);
      result = await upstream(fetchImpl, apiBase + path, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
    }
    checkResponse(result.response, "Spotify");
    if (allowEmpty && result.response.status === 204) return null;
    if (!result.data || typeof result.data !== "object") throw providerError(502, "service_unavailable", "Spotify returned an unreadable response. Please try again.");
    return result.data;
  }

  async function playerCommand(connection, action, deviceId, trackId, position) {
    if (!['play', 'pause', 'seek'].includes(action)) throw providerError(400, 'invalid_player_action', 'Choose a supported playback action.');
    if (position !== undefined && (!Number.isFinite(position) || position < 0 || position > 86400000) || action === 'seek' && position === undefined) throw providerError(400, 'invalid_position', 'Choose a valid song position.');
    if (connection.expiresAt <= now() + 30_000) await refresh(connection);
    const params = new URLSearchParams({ device_id: deviceId });
    if (action === 'seek') params.set('position_ms', String(Math.floor(position)));
    const options = { method: 'PUT', headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
      ...(trackId ? { body: JSON.stringify({ uris: [`spotify:track:${trackId}`], ...(position === undefined ? {} : { position_ms: Math.floor(position) }) }) } : {}) };
    let result = await upstream(fetchImpl, `${apiBase}/me/player/${action}?${params}`, options);
    if (result.response.status === 401) { await refresh(connection); options.headers.Authorization = `Bearer ${connection.accessToken}`; result = await upstream(fetchImpl, `${apiBase}/me/player/${action}?${params}`, options); }
    const reason = result.data?.error?.reason;
    if (reason === 'PREMIUM_REQUIRED') throw providerError(403, 'premium_required', 'Spotify web playback requires Premium on the host account. Guests can still browse and request songs.');
    if (reason === 'NO_ACTIVE_DEVICE') throw providerError(409, 'device_inactive', 'Open Spotify on the selected device, then try again.');
    checkResponse(result.response, 'Spotify');
  }

  function device(item) {
    return item?.id ? { id: item.id, name: item.name || 'Spotify device', type: item.type || 'unknown', active: Boolean(item.is_active), restricted: Boolean(item.is_restricted) } : null;
  }

  function items(data) {
    if (!Array.isArray(data?.items)) throw providerError(502, "service_unavailable", "Spotify returned an unreadable library response. Please try again.");
    return data.items;
  }

  return {
    authorization,
    exchange: (code, verifier, callbackUri = redirectUri) => token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callbackUri }),
    async playerDevices(connection) { const data = await get(connection, '/me/player/devices'); return (data.devices || []).map(device).filter(Boolean); },
    async playerState(connection) {
      const data = await get(connection, '/me/player', true);
      if (!data) return { device: null, playing: false, position: 0, duration: 0, track: null, type: 'none' };
      return { device: device(data.device), playing: Boolean(data.is_playing), position: Math.max(0, data.progress_ms || 0), duration: Math.max(0, data.item?.duration_ms || 0), track: spotifyTrack(data.item), type: data.currently_playing_type || 'unknown' };
    },
    playerCommand,
    async playlists(connection, offset) {
      const data = await get(connection, `/me/playlists?limit=50&offset=${offset}`);
      const playlists = items(data).filter(Boolean).map((item) => ({ id: item.id, provider: "spotify", name: item.name || "Untitled playlist",
        subtitle: item.owner?.display_name || "Spotify playlist", artworkUrl: httpsUrl(item.images?.[0]?.url),
        externalUrl: httpsUrl(item.external_urls?.spotify) || `https://open.spotify.com/playlist/${encodeURIComponent(item.id)}`,
        trackCount: item.items?.total ?? item.tracks?.total ?? null }));
      return page(data, playlists, apiBase);
    },
    async tracks(connection, playlistId, offset) {
      const path = playlistId ? `/playlists/${encodeURIComponent(playlistId)}/items` : "/me/tracks";
      const data = await get(connection, `${path}?limit=50&offset=${offset}`);
      return page(data, items(data).map((item) => spotifyTrack(item?.item ?? item?.track)).filter(Boolean), apiBase);
    },
    async albums(connection, offset) {
      const data = await get(connection, `/me/albums?limit=50&offset=${offset}`);
      return page(data, items(data).map((item) => item?.album).filter((album) => album?.id).map(spotifyAlbum), apiBase);
    },
    async albumTracks(connection, albumId, offset) {
      const album = await get(connection, `/albums/${encodeURIComponent(albumId)}`);
      if (!album.id) throw providerError(502, "service_unavailable", "Spotify returned unreadable album details.");
      const data = await get(connection, `/albums/${encodeURIComponent(albumId)}/tracks?limit=50&offset=${offset}`);
      return page(data, items(data).map((track) => spotifyTrack(track && { ...track, album })).filter(Boolean), apiBase);
    },
    async search(connection, term, offset = 0) {
      const params = new URLSearchParams({ q: term, type: "track", limit: "10", offset: String(offset) });
      const data = await get(connection, `/search?${params}`);
      return page(data.tracks, items(data.tracks).map(spotifyTrack).filter(Boolean), apiBase);
    },
  };
}

export function createApple({ developerToken, fetchImpl = fetch }) {
  const apiBase = "https://api.music.apple.com";
  let origin;
  try {
    const claims = decodeClaims(developerToken);
    for (const value of Array.isArray(claims.origin) ? claims.origin : []) {
      const url = new URL(value);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
        origin = url.origin; break;
      }
    }
  } catch { /* Apple validates the signed token; this only selects its origin header. */ }
  async function get(musicUserToken, path) {
    const { response, data } = await upstream(fetchImpl, apiBase + path, { headers: {
      Authorization: `Bearer ${developerToken}`, ...(musicUserToken ? { 'Music-User-Token': musicUserToken } : {}),
      ...(origin ? { Origin: origin } : {}),
    } });
    checkResponse(response, "Apple Music");
    if (!data || typeof data !== "object") throw providerError(502, "service_unavailable", "Apple Music returned an unreadable response. Please try again.");
    return data;
  }
  return {
    async connect(musicUserToken) {
      const data = await get(musicUserToken, "/v1/me/storefront");
      const storefront = data.data?.[0]?.id;
      if (!/^[a-z]{2}$/.test(storefront || "")) throw providerError(502, "service_unavailable", "Apple Music didn't return an account storefront. Please connect again.");
      return { musicUserToken, storefront };
    },
    async playlists(connection, offset) {
      const data = await get(connection.musicUserToken, `/v1/me/library/playlists?limit=100&offset=${offset}`);
      if (!Array.isArray(data.data)) throw providerError(502, "service_unavailable", "Apple Music returned an unreadable playlist response.");
      const items = data.data.map((item) => ({ id: item.id, provider: "apple", name: item.attributes?.name || "Untitled playlist",
        subtitle: item.attributes?.description?.standard || "Apple Music playlist",
        artworkUrl: httpsUrl(item.attributes?.artwork?.url?.replaceAll("{w}", "300").replaceAll("{h}", "300")),
        externalUrl: httpsUrl(item.attributes?.url), trackCount: null }));
      return page(data, items, apiBase);
    },
    async tracks(connection, playlistId, offset) {
      const path = playlistId ? `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks` : "/v1/me/library/songs";
      const data = await get(connection.musicUserToken, `${path}?limit=100&offset=${offset}`);
      if (!Array.isArray(data.data)) throw providerError(502, "service_unavailable", "Apple Music returned an unreadable song response.");
      return page(data, data.data.map(appleTrack).filter(Boolean), apiBase);
    },
    async recentTracks(connection, offset = '') {
      const params = new URLSearchParams({ types: 'songs,library-songs', limit: '30' });
      if (offset) params.set('offset', String(offset));
      const data = await get(connection.musicUserToken, `/v1/me/recent/played/tracks?${params}`);
      if (!Array.isArray(data.data)) throw providerError(502, 'service_unavailable', 'Apple Music returned unreadable listening history.');
      let nextOffset = null;
      if (data.next) {
        let next;
        try { next = new URL(data.next, apiBase); } catch {}
        if (next?.origin !== apiBase || next.pathname !== '/v1/me/recent/played/tracks' || !next.searchParams.get('offset')) throw providerError(502, 'invalid_history_page', 'Apple Music returned an unreadable history page.');
        nextOffset = next.searchParams.get('offset');
      }
      return { items: data.data.map(appleTrack).filter(Boolean).map((track) => ({ ...track, source: 'recently_played' })), nextOffset };
    },
    async albums(connection, offset) {
      const data = await get(connection.musicUserToken, `/v1/me/library/albums?limit=100&offset=${offset}`);
      if (!Array.isArray(data.data)) throw providerError(502, "service_unavailable", "Apple Music returned an unreadable album response.");
      return page(data, data.data.filter((album) => album?.id).map(appleAlbum), apiBase);
    },
    async albumTracks(connection, albumId, offset) {
      const data = await get(connection.musicUserToken, `/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks?limit=100&offset=${offset}`);
      if (!Array.isArray(data.data)) throw providerError(502, "service_unavailable", "Apple Music returned an unreadable album track response.");
      return page(data, data.data.map(appleTrack).filter(Boolean), apiBase);
    },
    async byIsrc(connection, isrc) {
      const params = new URLSearchParams({ "filter[isrc]": isrc });
      const data = await get(connection.musicUserToken, `/v1/catalog/${connection.storefront}/songs?${params}`);
      if (!Array.isArray(data.data)) throw providerError(502, "service_unavailable", "Apple Music returned an unreadable song response.");
      return page(data, data.data.map(appleTrack).filter(Boolean), apiBase);
    },
    async publicSearch(term, offset = 0) {
      const params = new URLSearchParams({ term, types: 'songs', limit: '25', offset: String(offset) });
      const data = await get(null, `/v1/catalog/us/search?${params}`);
      const songs = data.results?.songs || { data: [] };
      return page(songs, (songs.data || []).map(appleTrack).filter(Boolean).map((track) => ({ ...track, source: 'public_catalog' })), apiBase);
    },
    async search(connection, term, offset) {
      const params = new URLSearchParams({ term, types: "songs", limit: "25", offset: String(offset) });
      const data = await get(connection.musicUserToken, `/v1/catalog/${connection.storefront}/search?${params}`);
      const songs = data.results?.songs || { data: [] };
      return page(songs, (songs.data || []).map(appleTrack).filter(Boolean), apiBase);
    },
  };
}
