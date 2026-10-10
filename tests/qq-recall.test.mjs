import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQQRecall } from '../worker/qq-recall.mjs';

const qq = { id: 'qq:42', provider: 'qq', title: 'Example Song', artist: 'Example Artist', album: 'Example Album', durationMs: null, isrc: null };
const apple = { id: 'apple:123', provider: 'apple', providerId: '123', title: qq.title, artist: qq.artist, album: qq.album, durationMs: 200000 };
const resolver = (items) => ({ search: async () => ({ items, nextOffset: null }) });

test('QQ metadata resolves to one playable Apple track with summary-only rejection counts', async () => {
  const result = await resolveQQRecall({ tracks: [qq] }, resolver([apple]));
  assert.equal(result.items.length, 1); assert.equal(result.items[0].catalogId, '123'); assert.equal(result.items[0].source, 'selected_playlist');
  assert.deepEqual([result.total, result.skipped, result.ambiguous], [1, 0, 0]); assert.equal(result.tracks, undefined);
});

test('validates JSON shape, batch bound and fields without searching', async () => {
  let calls = 0;
  for (const input of [null, [], { tracks: [] }, { tracks: Array(21).fill(qq) }, { tracks: [qq], cookie: 'secret' }, { tracks: [{ ...qq, url: 'http://127.0.0.1' }] },
    { tracks: [{ ...qq, musicUserToken: 'secret' }] }, { tracks: [{ ...qq, id: 'qq:0' }] }, { tracks: [{ ...qq, title: 'x'.repeat(201) }] },
    { tracks: [{ ...qq, artist: '' }] }, { tracks: [{ ...qq, provider: 'spotify' }] }, { tracks: [{ ...qq, durationMs: -1 }] }, { tracks: [{ ...qq, isrc: 'invalid' }] }]) {
    await assert.rejects(resolveQQRecall(input, { search: async () => { calls++; } }), (error) => error.status === 400);
  }
  assert.equal(calls, 0);
});

test('supports exact CJK titles and performers without romanization guesses', async () => {
  const source = { ...qq, title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' };
  const result = await resolveQQRecall({ tracks: [source] }, resolver([{ ...apple, title: source.title, artist: source.artist, album: source.album }]));
  assert.equal(result.items.length, 1);
  const other = await resolveQQRecall({ tracks: [source] }, resolver([{ ...apple, title: 'Nocturne', artist: 'Jay Chou' }]));
  assert.equal(other.skipped, 1);
});

test('skips covers, remasters, too-short songs and conflicting durations', async () => {
  for (const candidate of [{ ...apple, artist: 'Cover Artist' }, { ...apple, title: 'Example Song (2016 Remaster)' }, { ...apple, durationMs: 10000 }, { ...apple, provider: 'qq' }, { ...apple, providerId: 'l.library-id' }]) {
    const result = await resolveQQRecall({ tracks: [qq] }, resolver([candidate])); assert.equal(result.skipped, 1); assert.equal(result.items.length, 0);
  }
  const result = await resolveQQRecall({ tracks: [{ ...qq, durationMs: 180000 }] }, resolver([apple])); assert.equal(result.skipped, 1);
});

test('never chooses between ambiguous editions; matching album wins only when unique', async () => {
  const other = { ...apple, id: 'apple:124', providerId: '124', album: 'Other Album' };
  assert.equal((await resolveQQRecall({ tracks: [{ ...qq, album: '' }] }, resolver([apple, other]))).ambiguous, 1);
  assert.equal((await resolveQQRecall({ tracks: [qq] }, resolver([apple, other]))).items[0].catalogId, '123');
  assert.equal((await resolveQQRecall({ tracks: [qq] }, resolver([apple, { ...other, album: qq.album }]))).ambiguous, 1);
});

test('limits catalog reads to two pages and rejects partial catalog candidates', async () => {
  let calls = 0;
  const partial = await resolveQQRecall({ tracks: [qq] }, { search: async (_term, offset) => { calls++; return { items: offset === 0 ? [apple] : [], nextOffset: offset + 25, total: 75 }; } });
  assert.equal(calls, 2); assert.equal(partial.ambiguous, 1); assert.equal(partial.items.length, 0);
  const broken = await resolveQQRecall({ tracks: [qq] }, { search: async () => ({ items: [apple], total: 2, nextOffset: null }) });
  assert.equal(broken.ambiguous, 1);
});

test('two complete catalog pages include later candidates before choosing', async () => {
  const result = await resolveQQRecall({ tracks: [{ ...qq, album: '' }] }, { search: async (_term, offset) => offset === 0 ? { items: [apple], nextOffset: 25, total: 2 }
    : { items: [{ ...apple, providerId: '124', id: 'apple:124' }], nextOffset: null, total: 2 } });
  assert.equal(result.ambiguous, 1);
});

test('uses exact ISRC recording checks and never silently substitutes a different recording', async () => {
  let searches = 0;
  const source = { ...qq, isrc: 'USAAA2000001' };
  const result = await resolveQQRecall({ tracks: [source] }, { byIsrc: async () => ({ items: [{ ...apple, isrc: source.isrc }], nextOffset: null }),
    search: async () => { searches++; return { items: [] }; } });
  assert.equal(result.items.length, 1); assert.equal(searches, 0);
  const conflict = await resolveQQRecall({ tracks: [source] }, { byIsrc: async () => ({ items: [], nextOffset: null }), search: async () => ({ items: [{ ...apple, isrc: 'USAAA2000002' }], nextOffset: null }) });
  assert.equal(conflict.skipped, 1);
});

test('ISRC lookup plus search still makes at most two calls and avoids incomplete matches', async () => {
  let calls = 0;
  const result = await resolveQQRecall({ tracks: [{ ...qq, isrc: 'USAAA2000001' }] }, { byIsrc: async () => { calls++; return { items: [] }; },
    search: async () => { calls++; return { items: [{ ...apple, isrc: 'USAAA2000001' }], nextOffset: 25 }; } });
  assert.equal(calls, 2); assert.equal(result.ambiguous, 1);
});

test('malformed catalog pages and service authorization failures remain actionable errors', async () => {
  await assert.rejects(resolveQQRecall({ tracks: [qq] }, { search: async () => ({ items: [apple], nextOffset: '25' }) }), (error) => error.status === 502);
  const rejected = Object.assign(new Error('Reconnect Apple Music.'), { status: 401, code: 'reconnect_required' });
  await assert.rejects(resolveQQRecall({ tracks: [qq] }, { search: async () => { throw rejected; } }), (error) => error === rejected);
});
