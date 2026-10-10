import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assets } from '../worker/assets.mjs';
import { autoStartDecision } from '../public/auto-start-policy.js';
const source = Buffer.from(assets['/app.js'].data, 'base64').toString();
function context() {
  const track = { provider: 'apple', providerId: '123' }, calls = [];
  const state = { session: { memberId: 'host' }, online: true, room: { code: 'ABC234', hostId: 'host', hostProvider: 'apple', queue: [{ id: 'request', hostMatch: { status: 'matched', provider: 'apple', track } }], nowPlaying: null, playback: { connected: true, available: true, playing: false, status: 'ready', autoStartArmed: true } } };
  const sandbox = { state, playerSetup: { busy: false }, appleBrowserPlayer: { connected: true }, automaticStarts: new Map(), autoStartDecision, Date, calls, controlPlayer: async (...args) => calls.push(args) };
  vm.createContext(sandbox); const begin = source.indexOf('async function startMatchedQueue()'), end = source.indexOf('async function matchQueuedTracks()', begin); vm.runInContext(source.slice(begin,end),sandbox); return sandbox;
}
test('new matched requests issue one automatic next, including repeated room updates', async () => { const c=context(); await c.startMatchedQueue(); await c.startMatchedQueue(); assert.equal(c.calls.length,1); assert.equal(c.calls[0][0],'next'); assert.equal(c.calls[0][1].entryId,'request'); });
test('automatic requests retry after backoff instead of permanently losing a queued song', async () => { const c=context(); await c.startMatchedQueue(); c.automaticStarts.set('ABC234/host/request',0); await c.startMatchedQueue(); assert.equal(c.calls.length,2); });
test('a host pause, playback failure or an offer never sends an automatic command', async () => { for(const change of [(c)=>c.state.room.playback.autoStartArmed=false,(c)=>c.state.room.playback.status='error',(c)=>c.state.room.hostTransfer={id:'offer'}]){const c=context();change(c);await c.startMatchedQueue();assert.equal(c.calls.length,0);} });
