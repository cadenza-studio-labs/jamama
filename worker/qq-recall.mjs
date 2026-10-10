import { selectExactMatch } from './recording-match.mjs';

const fields = new Set(['id', 'provider', 'title', 'artist', 'album', 'durationMs', 'isrc']);
const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const codeFor = (value) => typeof value === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value) ? value.toUpperCase() : null;
const fail = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid_qq_selection' });
const validText = (value) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

function readSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'tracks')
    || !Array.isArray(input.tracks) || !input.tracks.length || input.tracks.length > 20) throw fail('Choose a QQ selection with 1–20 songs per batch.');
  return input.tracks.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => !fields.has(key))
      || typeof row.id !== 'string' || !/^qq:[1-9]\d{0,15}$/.test(row.id) || !Number.isSafeInteger(Number(row.id.slice(3)))
      || row.provider != null && row.provider !== 'qq' || !validText(row.title) || !validText(row.artist)
      || normalize(row.artist) === 'unknown artist' || row.album != null && row.album !== '' && !validText(row.album)
      || row.durationMs != null && (!Number.isFinite(row.durationMs) || row.durationMs <= 0 || row.durationMs > 24 * 3600000)
      || row.isrc != null && !codeFor(row.isrc)) throw fail('Choose QQ song metadata with a valid song ID, title and artist. Do not include URLs or account details.');
    return { id: row.id, provider: 'qq', title: row.title.trim(), artist: row.artist.trim(), album: row.album?.trim() || '', durationMs: row.durationMs ?? null, isrc: codeFor(row.isrc) };
  });
}

function pageFor(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > 100 || value.nextOffset != null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0)
    || value.total != null && (!Number.isSafeInteger(value.total) || value.total < 0)) throw Object.assign(new Error('Apple Music returned an unreadable matching page. Try again.'), { status: 502, code: 'invalid_catalog_page' });
  return value;
}

function candidateFor(track) {
  const id = track?.catalogId || track?.providerId;
  if (track?.provider !== 'apple' || typeof id !== 'string' || !/^[1-9]\d{0,29}$/.test(id) || !validText(track.title)
    || !validText(track.artist) || !Number.isFinite(track.durationMs) || track.durationMs < 17000) return null;
  return { ...track, id: `apple:${id}`, providerId: id, catalogId: id, source: 'selected_playlist' };
}

function chooseRecording(source, candidates) {
  const eligible = [...new Map(candidates.map(candidateFor).filter(Boolean).map((track) => [track.catalogId, track])).values()];
  const byCode = source.isrc ? eligible.filter((track) => codeFor(track.isrc) === source.isrc) : [];
  let matches = byCode.length ? byCode : eligible.filter((track) => normalize(track.title) === normalize(source.title) && normalize(track.artist) === normalize(source.artist));
  matches = matches.filter((track) => (!source.isrc || codeFor(track.isrc) === source.isrc)
    && (source.durationMs == null || Math.abs(source.durationMs - track.durationMs) <= 3000));
  if (!matches.length) return { status: 'skipped' };
  if (byCode.length && !selectExactMatch(source, matches)) return { status: 'ambiguous' };
  if (source.album) {
    const sameAlbum = matches.filter((track) => normalize(track.album) === normalize(source.album));
    if (sameAlbum.length) matches = sameAlbum;
  }
  if (matches.length !== 1) return { status: 'ambiguous' };
  return { status: 'matched', track: matches[0] };
}

export async function resolveQQRecall(input, { search, byIsrc } = {}) {
  const tracks = readSelection(input);
  if (typeof search !== 'function') throw new Error('QQ quiz catalog search is not configured.');
  const results = new Array(tracks.length);
  let cursor = 0;
  async function resolve(source) {
    let calls = 0;
    if (source.isrc && typeof byIsrc === 'function') {
      const page = pageFor(await byIsrc(source.isrc)); calls++;
      if (page.nextOffset != null || page.total != null && page.total > page.items.length) return { status: 'ambiguous' };
      const match = chooseRecording(source, page.items);
      if (match.status !== 'skipped') return match;
    }
    const term = `${source.title} ${source.artist}`.slice(0, 200);
    let page = pageFor(await search(term, 0)); calls++;
    const candidates = [...page.items];
    const total = page.total;
    if (page.nextOffset != null) {
      if (calls >= 2 || page.nextOffset === 0) return { status: 'ambiguous' };
      const nextOffset = page.nextOffset;
      page = pageFor(await search(term, nextOffset));
      candidates.push(...page.items);
      if (page.nextOffset != null || page.total != null && page.total > candidates.length) return { status: 'ambiguous' };
    }
    if (total != null && total > candidates.length) return { status: 'ambiguous' };
    return chooseRecording(source, candidates);
  }
  await Promise.all(Array.from({ length: Math.min(3, tracks.length) }, async () => {
    while (cursor < tracks.length) {
      const index = cursor++;
      results[index] = await resolve(tracks[index]);
    }
  }));
  return { items: results.filter((result) => result.status === 'matched').map((result) => result.track),
    skipped: results.filter((result) => result.status === 'skipped').length,
    ambiguous: results.filter((result) => result.status === 'ambiguous').length, total: tracks.length };
}
