import test from 'node:test';
import assert from 'node:assert/strict';
import { sameServiceMatch, selectExactMatch } from '../worker/recording-match.mjs';

const code = 'USABC2600001';
const spotify = (suffix = 'A', extra = {}) => ({ id: `spotify:${suffix.repeat(22)}`, providerId: suffix.repeat(22), provider: 'spotify', title: 'Hello', artist: 'Adele', album: '25', durationMs: 295000, isrc: code, ...extra });
const apple = (id = '100', extra = {}) => ({ id: `apple:${id}`, providerId: id, provider: 'apple', title: 'Hello', artist: 'Adele', album: '25', durationMs: 295000, isrc: code, ...extra });

test('same-service Spotify requests match without changing the source', () => {
  const source = spotify();
  assert.deepEqual(sameServiceMatch('spotify', source), source);
  assert.notEqual(sameServiceMatch('spotify', source), source);
  assert.equal(sameServiceMatch('apple', source), null);
});

test('Spotify requires a canonical track ID and rejects contradictory IDs', () => {
  for (const source of [spotify('!'), spotify('A', { id: 'spotify:short' }), spotify('A', { providerId: 'B'.repeat(22) }), spotify('A', { id: 'spotify:local:Hello' })]) assert.equal(sameServiceMatch('spotify', source), null);
});

test('Apple library tracks match only through a catalog ID', () => {
  const source = apple('i.private', { catalogId: '123456789' });
  assert.equal(sameServiceMatch('apple', source)?.id, 'apple:123456789');
  assert.equal(sameServiceMatch('apple', source)?.providerId, '123456789');
  assert.equal(source.id, 'apple:i.private');
  assert.equal(sameServiceMatch('apple', apple('i.private')), null);
  assert.equal(sameServiceMatch('apple', apple('i.private', { catalogId: 'i.other' })), null);
  assert.equal(sameServiceMatch('apple', apple('123'))?.id, 'apple:123');
});

test('metadata alone never causes an automatic match', () => {
  assert.equal(selectExactMatch(spotify('A', { isrc: undefined }), [apple()]), null);
  assert.equal(selectExactMatch(spotify(), [apple('100', { isrc: 'USABC2600002' })]), null);
  assert.equal(selectExactMatch(spotify('A', { isrc: 'invalid' }), [apple('100', { isrc: 'invalid' })]), null);
});

test('one verified recording allows localized titles and artists', () => {
  const source = spotify('A', { title: '你好', artist: '阿黛尔' });
  assert.equal(selectExactMatch(source, [apple()])?.id, 'apple:100');
  assert.equal(selectExactMatch(spotify('A', { isrc: code.toLowerCase() }), [apple()])?.id, 'apple:100');
});

test('single exact recordings reject obvious version or duration conflicts', () => {
  assert.equal(selectExactMatch(spotify(), [apple('100', { title: 'Hello (Live)' })]), null);
  assert.equal(selectExactMatch(spotify(), [apple('100', { title: 'Hello - 2026 Remaster' })]), null);
  assert.equal(selectExactMatch(spotify(), [apple('100', { durationMs: 298001 })]), null);
  assert.equal(selectExactMatch(spotify(), [apple('100', { durationMs: 298000 })])?.id, 'apple:100');
});

test('album variants of the same recording match deterministically', () => {
  const candidates = [apple('200', { album: 'Greatest Hits' }), apple('100'), apple('100')];
  assert.equal(selectExactMatch(spotify(), candidates)?.id, 'apple:100');
  assert.equal(selectExactMatch(spotify(), candidates.toReversed())?.id, 'apple:100');
  assert.equal(selectExactMatch(spotify('A', { album: 'Other' }), candidates)?.id, 'apple:100');
  assert.equal(selectExactMatch(spotify('A', { album: 'Greatest Hits' }), candidates)?.id, 'apple:200');
});

test('equivalent duplicates tolerate capitalization and punctuation', () => {
  assert.equal(selectExactMatch(spotify(), [apple('100'), apple('200', { title: 'HELLO!', artist: 'ADELE', durationMs: 297000 })])?.id, 'apple:100');
});

test('duplicate recordings with different names, artists, or durations need review', () => {
  for (const changes of [{ title: 'Someone Like You' }, { artist: 'Cover Artist' }, { title: 'Hello (Remastered)' }, { durationMs: 298001 }, { durationMs: null }]) assert.equal(selectExactMatch(spotify(), [apple('100'), apple('200', changes)]), null);
  assert.equal(selectExactMatch(spotify('A', { artist: 'Other' }), [apple('100'), apple('200')]), null);
  assert.equal(selectExactMatch(spotify(), [apple('100'), apple('200', { durationMs: 292000 }), apple('300', { durationMs: 298000 })]), null);
});

test('different version suffixes remain ambiguous even with matching ISRCs', () => {
  const source = spotify('A', { title: 'Hello (Live)' });
  assert.equal(selectExactMatch(source, [apple('100', { title: 'Hello (Live)' })])?.id, 'apple:100');
  assert.equal(selectExactMatch(source, [apple('100', { title: 'Hello (Live)' }), apple('200', { title: 'Hello (Live at Wembley)' })]), null);
});

test('unplayable catalog records are not selected', () => {
  assert.equal(selectExactMatch(spotify(), [apple('i.private')]), null);
  assert.equal(selectExactMatch(apple(), [spotify('!')]), null);
});

test('matching never mutates candidate order or metadata', () => {
  const candidates = [apple('200'), apple('100')];
  const before = JSON.stringify(candidates);
  selectExactMatch(spotify(), candidates);
  assert.equal(JSON.stringify(candidates), before);
});
