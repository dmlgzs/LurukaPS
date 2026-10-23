import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { playableWire } from '../src/campaign-playable-ledger.js'
const cfg=configuration(), tables=new Tables(cfg.tables), protocol=new Protocol(cfg.base)
function fixture(name) {
 const store=new Store(':memory:'), game=new Game(protocol,store,tables,{clock:()=>1800000000}),session={};let seq=1
 const call=(name,r={})=>{const e=protocol.byName.get('CSProto'+name);return game.dispatch(session,{id:e.id,seq:seq++,payload:protocol.encode(e.req,r)}).map(p=>({id:p.id,data:protocol.decode(protocol.byId.get(p.id).rsp,p.payload)}))}
 call('EnterGame',{open_id:name})
 store.transact(session.id,0,s=>{s.world.map_id=6226;s.storyCampaign={instance_id:71,map_id:6226,scenes:[6226],task_ids:[],status:2,local_playable_condition:[13060,6226,0,1],playable_ids:[62071]}})
 return {store,call,state:()=>store.load(session.id).state,edit:fn=>store.transact(session.id,0,fn)}
}
test('campaign Start binds an epoch, ignores legacy successful facts, preserves permanent score masks and repeats idempotently',()=>{
 const f=fixture('campaign-start-epoch')
 try {
  f.edit(s=>{s.playableRuns={62071:{play_id:62071,map_id:6226,status:3,finish_step:1}};s.playableFinishes={62071:{play_id:62071,map_id:6226,reward_info:2}};s.playableScoreClaims={62071:4}})
  const packets=f.call('PlayableStart',{u32:62071}),run=f.state().playableRuns[62071]
  assert.equal(run.campaign_instance_id,71);assert.equal(run.campaign_attempt_id,1);assert.equal(run.finish_step,0)
  assert.equal(f.state().playableFinishes[62071],undefined);assert.equal(f.state().playableScoreClaims[62071],6)
  assert.equal(packets.find(p=>p.id===9400).data.plays[0].status,1)
  f.call('PlayableStart',{u32:62071});assert.deepEqual(f.state().playableRuns[62071],run)
  assert.ok(!Object.keys(playableWire(run)).some(k=>k.startsWith('campaign_')))
 }finally{f.store.close()}
})
test('campaign Start refuses missing instance or wrong campaign membership atomically',()=>{
 const f=fixture('campaign-start-invalid')
 try {
  f.edit(s=>{delete s.storyCampaign.instance_id});const before=f.state()
  assert.throws(()=>f.call('PlayableStart',{u32:62071}),/instance is missing/);assert.deepEqual(f.state(),before)
  f.edit(s=>{s.storyCampaign.instance_id=72;s.storyCampaign.playable_ids=[]})
  assert.throws(()=>f.call('PlayableStart',{u32:62071}),/does not belong/)
 }finally{f.store.close()}
})
