import test from 'node:test';
import assert from 'node:assert/strict';
import { connectSpotify, observeSpotify } from '../worker/spotify-playback.mjs';
const track={provider:'spotify',providerId:'a'.repeat(22),id:'spotify:'+'a'.repeat(22)};
const state=(playing=false,song=null)=>({playing,track:song,type:song?'track':'none',device:{id:'device'},position:1000,duration:song?180000:0});
const account={sessionId:'host-session'};
function fixture(observed=state()) { const room={hostId:'host',hostProvider:'spotify',members:[],queue:[],nowPlaying:null,playback:{},played:0};connectSpotify(room,account,{id:'device'},{state:observed,now:1000});return room; }
test('connecting a Spotify device already playing never arms automatic replacement',()=>{const room=fixture(state(true,track));assert.equal(room.playback.playing,true);assert.equal(room.playback.autoStartArmed,false);assert.equal(room.playback.currentTrack.providerId,track.providerId);});
test('an unchanged untouched idle Spotify player stays ready during heartbeat checks',()=>{const room=fixture();observeSpotify(room,account,state(),{now:2000});assert.equal(room.playback.status,'ready');assert.equal(room.playback.autoStartArmed,true);});
test('outside music appearing on an idle Spotify device disarms automatic requests',()=>{for(const playing of [false,true]){const room=fixture();observeSpotify(room,account,state(playing,track),{now:2000});assert.equal(room.playback.status,'changed');assert.equal(room.playback.autoStartArmed,false);assert.equal(room.queue.length,0);}});
