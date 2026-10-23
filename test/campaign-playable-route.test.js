import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { storyCampaignConfig } from '../src/story-campaign.js'
import { localCampaignCondition,localPlayableCampaignRoute,validateLocalCampaignPolicy } from '../src/campaign-playable-route.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg=configuration(),tables=new Tables(cfg.tables)
function fixture(name,filename=':memory:') {
 let store=new Store(filename),protocol=new Protocol(cfg.base),game=new Game(protocol,store,tables,{clock:()=>1800000000}),session={};let seq=1
 const call=(name,r={})=>{const e=protocol.byName.get('CSProto'+name),payload=protocol.encode(e.req,r);return game.dispatch(session,{id:e.id,seq:seq++,payload}).map(p=>({id:p.id,data:protocol.decode(protocol.byId.get(p.id).rsp,p.payload)}))}
 call('EnterGame',{open_id:name})
 const edit=fn=>store.transact(session.id,0,fn)
 edit(s=>{s.world.map_id=100;s.player.basic_info.lv=50;s.taskRecords=tables.get('task').filter(t=>t.type===1&&t.id!==213004).map(t=>({task_id:t.id,count:1,time:1}));s.tasks=[{task_id:213004,nodes:[{...makeNode(new TaskGraphs(tables).get(213004),6,s),client_before:true}],finish_nodes:[],reward_nodes:[],start_time:1}]})
 return {call,edit,state:()=>store.load(session.id).state,get protocol(){return protocol},close:()=>store.close(),reopen(){store.close();store=new Store(filename);protocol=new Protocol(cfg.base);game=new Game(protocol,store,tables,{clock:()=>1800000000});session={};call('EnterGame',{open_id:name})}}
}
const enter=f=>f.call('CampaignCreate',{group_id:222,difficulty:1})
function target(f){f.edit(s=>s.world.pos={...s.worldObjects['6226:1000011'].pos});return f.call('WorldObjInteract',{objs:[{obj:{obj_id:1000011,complete:true,state_data:{step:1,complete:true}}}]})}
const success=f=>{f.call('PlayableStart',{u32:62071});f.call('PlayableStep',{playId:62071,is_step:true,finish_step:1});return f.call('PlayableFinish',{playId:62071,score:0})}
test('fresh four-field route validates exact old/current table identity and unique scene without treating preview enemies as real waves',()=>{
 const config=storyCampaignConfig(tables,222,1)
 assert.equal(config.dungeon.id,10074);assert.deepEqual(config.localPlayableRoute.scene_ids,[6226]);assert.deepEqual(config.localPlayableRoute.local_condition,[13060,6226,0,1]);assert.deepEqual(config.localPlayableRoute.target_ids,[1000011])
 assert.throws(()=>localCampaignCondition('13060#0#0#0#1'),/shape/)
 assert.throws(()=>localCampaignCondition('13060#0#0#1'),/parameters/)
 assert.throws(()=>localPlayableCampaignRoute(tables,{...tables.find('dungeon',10074),enemy:'310001#1'}),/fingerprint/)
 const duplicate=Object.create(tables);duplicate.get=n=>n==='dungeon_scene'?[tables.find(n,6226),tables.find(n,6226)]:tables.get(n)
 assert.throws(()=>localPlayableCampaignRoute(duplicate,tables.find('dungeon',10074)),/not unique/)
})
test('local campaign condition distinguishes unsupported contracts, malformed configuration and explicit closure using client error semantics',()=>{
 const code=(value,expected)=>assert.throws(value,e=>e.code===expected)
 code(()=>localCampaignCondition('13060#0#0#0#1'),ErrorCode.FunctionClosed)
 code(()=>localCampaignCondition('13060#6226#0'),ErrorCode.FunctionClosed)
 for(const value of ['13060#0#0#1','13060#6226#0#0','13060#06226#0#1','13060#6226#0#1.5','13060#4294967296#0#1'])code(()=>localCampaignCondition(value),ErrorCode.GameConfig)
 code(()=>localCampaignCondition('13061#6226#0#1'),ErrorCode.FunctionClosed)
 code(()=>validateLocalCampaignPolicy({schema_version:1,condition:13060,mode:'closed'}),ErrorCode.FunctionClosed)
 for(const value of [{schema_version:0,condition:13060,mode:'closed'},{schema_version:1,condition:0,mode:'closed'},{schema_version:1,condition:13060,mode:'unknown'}])code(()=>validateLocalCampaignPolicy(value),ErrorCode.GameConfig)
})
test('10074 actual route starts with clean visible puzzle and trial actors, requires both target and same-instance success, then final story and9503 return',()=>{
 const f=fixture('campaign-local-complete')
 try{
  f.edit(s=>{s.playableRuns={62071:{play_id:62071,map_id:6226,status:3}};s.playableFinishes={62071:{play_id:62071,map_id:6226,reward_info:2}};s.playableScoreClaims={62071:4};s.playableStageClaims={62071:{map_id:6226,flag:'2'}}})
  const entry=enter(f),run=f.state().storyCampaign
  assert.equal(f.state().world.map_id,6226);assert.equal(run.status,2);assert.equal(f.state().worldObjects['6226:1000010'].active,true)
  assert.ok(tables.get('worldmap_6226').every(row=>f.state().worldObjects['6226:'+row.id]),'entry builds every static object before story callbacks')
  assert.equal(f.state().playableRuns[62071],undefined);assert.equal(f.state().playableFinishes[62071],undefined);assert.equal(f.state().playableScoreClaims[62071],6)
  assert.equal(f.state().playableStageClaims[62071].flag,'2');assert.equal(entry.find(p=>p.id===9501)?.data.status??2,2)
  const entryPlayable=entry.find(p=>p.id===f.protocol.byName.get('CSProtoPlayableSync').id).data
  assert.equal(entryPlayable.all_sync,true);assert.deepEqual(entryPlayable.finish_plays,[])
  f.call('TrialGroupChange',{open:true,force:true,trial_heros:[{id:2108103,pos:0}],trial_pets:[{id:104,pos:0}]})
  assert.equal(f.state().trialGroup.heroes[0].conf_id,108003);assert.equal(f.state().trialGroup.pets[0].config_id,500156)
  f.call('ClientBehaviourRecord',{key:1004,args:[208215,1]});assert.equal(f.state().worldObjects['6226:1500036'].active,false)
  target(f);assert.equal(f.state().storyCampaign.status,2);assert.deepEqual(f.state().storyCampaign.completed_scenes,[])
  assert.throws(()=>f.call('EndDungeonScene',{result:3}),/not defeated/)
  const win=success(f)
  assert.equal(f.state().storyCampaign.status,3);assert.equal(f.state().storyCampaignClears[10074].count,1)
  assert.ok(win.some(p=>p.id===f.protocol.byName.get('CSProtoCampaignInfoSync').id&&p.data.status===3),'server victory must reach DungeonPlaying event9 before the ending story')
  assert.equal(f.state().tasks.find(t=>t.task_id===213004).nodes[0].node_values[0],1)
  f.call('ClientBehaviourRecord',{key:1004,args:[980130,1]});assert.equal(f.state().storyCampaign.ending_story_complete,true)
  f.call('CampaignQuit');assert.equal(f.state().world.map_id,100);assert.equal(f.state().storyCampaign,undefined)
  assert.equal(f.state().trialGroup,undefined);assert.equal(f.state().playableFinishes[62071],undefined)
  assert.equal(f.state().playableScoreClaims[62071],6);assert.equal(f.state().storyCampaignClears[10074].count,1)
 }finally{f.close()}
})
test('success before target remains pending; cancelled/re-entered campaign cannot reuse either previous-instance or legacy facts',()=>{
 const f=fixture('campaign-local-reentry')
 try{
  enter(f);success(f);assert.equal(f.state().storyCampaign.status,2)
  const first=f.state().storyCampaign.instance_id;f.call('CampaignQuit');assert.equal(f.state().storyCampaignClears?.[10074],undefined)
  enter(f);assert.ok(f.state().storyCampaign.instance_id>first);assert.deepEqual(f.state().storyCampaign.playable_successes,{})
  target(f);assert.equal(f.state().storyCampaign.status,2);assert.throws(()=>f.call('PlayableFinish',{playId:62071}),/current campaign instance/)
  f.call('PlayableStart',{u32:62071});f.call('PlayableCancel',{playId:62071});assert.equal(f.state().storyCampaign.status,2)
  success(f);assert.equal(f.state().storyCampaign.status,3)
 }finally{f.close()}
})
test('same-instance incomplete run and distinct success survive actual SQLite close/reopen without being transformed into a new attempt',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-playable-')),file=path.join(dir,'state.sqlite'),f=fixture('campaign-local-reopen',file)
 try{
  enter(f);f.call('ClientBehaviourRecord',{key:1004,args:[208215,1]});f.call('PlayableStart',{u32:62071});f.call('PlayableStep',{playId:62071,is_step:true,finish_step:1})
  const run=f.state().playableRuns[62071],epoch=f.state().storyCampaign.instance_id
  f.reopen();assert.deepEqual(f.state().playableRuns[62071],run);assert.equal(f.state().storyCampaign.instance_id,epoch)
  assert.equal(f.state().worldObjects['6226:1500036'].active,false,'opening tag deletion persists across SQLite reopen')
  f.call('PlayableFinish',{playId:62071});const receipt=f.state().storyCampaign.playable_successes
  f.reopen();assert.deepEqual(f.state().storyCampaign.playable_successes,receipt);assert.equal(f.state().storyCampaign.status,2)
  target(f);assert.equal(f.state().storyCampaign.status,3)
  f.reopen();assert.equal(f.state().storyCampaign.status,3);assert.equal(f.state().storyCampaignClears[10074].count,1)
 }finally{f.close();fs.rmSync(file,{force:true});fs.rmdirSync(dir)}
})
test('9403/9406/9404 response encoding failures roll back all local campaign state and receipts in SQLite',()=>{
 const f=fixture('campaign-local-codec')
 try{
  enter(f)
  for(const [name,request]of [['PlayableStart',{u32:62071}],['PlayableStep',{playId:62071,is_step:true,finish_step:1}],['PlayableFinish',{playId:62071,score:0}]]){
   const before=f.state(),entry=f.protocol.byName.get('CSProto'+name),encode=f.protocol.encode.bind(f.protocol)
   f.protocol.encode=(type,value)=>{if(type===entry.rsp)throw Error('injected response codec');return encode(type,value)}
   assert.throws(()=>f.call(name,request),/injected response codec/);f.protocol.encode=encode;assert.deepEqual(f.state(),before)
   f.call(name,request)
  }
  assert.equal(Object.keys(f.state().storyCampaign.playable_successes).length,1)
 }finally{f.close()}
})
test('9500 refuses damaged instance seeds before entering the new local mode and does not fabricate legacy success',()=>{
 const f=fixture('campaign-local-instance-seed')
 try{
  for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER]){
   f.edit(s=>s.nextStoryCampaignInstanceId=value)
   const before=f.state();assert.throws(()=>enter(f),/counter is damaged or exhausted/);assert.deepEqual(f.state(),before)
  }
 }finally{f.close()}
})
