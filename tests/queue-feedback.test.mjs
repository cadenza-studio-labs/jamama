import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture() {
  const attributes = {}, classes = new Map(), button = { dataset: { track: 'apple:123' }, disabled: false, textContent: '+', classList: { toggle: (name, active) => classes.set(name, active) }, setAttribute: (name, value) => attributes[name] = value };
  const session = { code: 'ABC234' }, timers = [], notices = [], received = [];
  const state = { room: { code: 'ABC234' }, session, online: true, pending: new Set(), provider: 'apple' };
  let requests = 0, reject = false;
  const context = { state, recentlyQueued: new Map(), document: { querySelectorAll: () => [button] }, trackFor: () => ({ title: 'Known song' }), Date, crypto: { randomUUID: () => 'request' }, setTimeout: (callback) => timers.push(callback), chooseVisibleMusicService: (value) => value, openJam() {}, toast: (...args) => notices.push(args), acceptRoom: (value) => received.push(value), api: async () => { requests++; if (reject) throw new Error('Service unavailable'); return { room: { queue: [{ id: 'entry' }] } }; } };
  vm.createContext(context);
  for (const name of ['updateAddButtons', 'addTrack']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')), next = source.slice(start + 1).search(/^(?:async )?function \w+\(/m);
    vm.runInContext(source.slice(start, next === -1 ? undefined : start + next + 1), context);
  }
  return { context, button, attributes, classes, timers, notices, received, requests: () => requests, reject: () => reject = true };
}
test('queue confirmation changes the existing button without rebuilding the list', async () => {
  const f = fixture(), original = f.button;
  const pending = f.context.addTrack('apple:123', 'apple'); assert.equal(f.button.disabled, true); assert.equal(f.button.textContent, '…');
  await pending; assert.equal(f.button, original); assert.equal(f.button.disabled, false); assert.equal(f.button.textContent, '✓'); assert.equal(f.classes.get('just-queued'), true); assert.match(f.attributes['aria-label'], /Known song queued/);
  f.timers[0](); assert.equal(f.button.textContent, '+'); assert.equal(f.classes.get('just-queued'), false);
});
test('failed additions show no success marker and repeated taps while pending make one request', async () => {
  const f = fixture(); f.reject(); const pending = f.context.addTrack('apple:123', 'apple'); await f.context.addTrack('apple:123', 'apple'); await pending;
  assert.equal(f.requests(), 1); assert.equal(f.button.textContent, '+'); assert.equal(f.received.length, 0); assert.equal(f.notices[0][1], 'error');
});
test('a queue reply from a departed Jam cannot alter the newly joined room', async () => {
  const f = fixture(); const pending = f.context.addTrack('apple:123', 'apple'); f.context.state.session = { code: 'NEW234' }; await pending;
  assert.equal(f.received.length, 0); assert.equal(f.notices.length, 0); assert.equal(f.button.textContent, '+');
});
