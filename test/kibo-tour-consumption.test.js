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
import { ErrorCode } from '../src/error-codes.js'
import { petInKiboTour } from '../src/kibo-tour-ledger.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const cfg=configuration(),tables=new Tables(cfg.tables)
function fixture(name,file=':memory:'){
 let store=new Store(file),p=new Protocol(cfg.base),game=new Game(p,store,tables,{clock:()=>1800000000}),session={};let seq=1
 const call=(name,r={})=>{const e=p.byName.get('CSProto'+name);return game.dispatch(session,{id:e.id,seq:seq++,payload:p.encode(e.req,r)})}
 call('EnterGame',{open_id:name});const id=store.load(session.id).state.pets[0].guid
 call('PetLock',{guid:id,lock_operate:false})
 return {id,call,edit:fn=>store.transact(session.id,0,fn),state:()=>store.load(session.id).state,close:()=>store.close(),reopen(){store.close();store=new Store(file);p=new Protocol(cfg.base);game=new Game(p,store,tables,{clock:()=>1800000000});session={};call('EnterGame',{open_id:name})}}
}
const reserve=(f,state)=>f.edit(s=>{s.activities={8001:{kiboTour:{version:1,next_attempt:2,total_times:0,runs:{1001:{attempt_id:1,tour_id:1001,pet_ids:[f.id],state,start_time:1700000000,end_time:1700003600}},receipts:{}}}};s.pets[0].tour_state=0})
test('6512 uses real unfinished tour receipts rather than stale pet flags or activity time, and refusal is atomic',()=>{
 const f=fixture('tour-reserve-release')
 try{
  for(const state of [0,1]){
   reserve(f,state);assert.ok(petInKiboTour(f.state(),f.id));const before=f.state()
   assert.throws(()=>f.call('DelPet',{pet_list:[f.id]}),e=>e.code===ErrorCode.ActivityPetTourCannotDel)
   assert.deepEqual(f.state(),before)
  }
  f.edit(s=>{s.activities[8001].kiboTour.runs[1001].state=2;s.pets[0].tour_state=1})
  assert.equal(petInKiboTour(f.state(),f.id),null)
  f.call('DelPet',{pet_list:[f.id]});assert.ok(!f.state().pets.some(p=>p.guid===f.id))
 }finally{f.close()}
})
test('6512 ready-tour reservation persists through actual temporary SQLite close and reopen',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tour-reserve-')),file=path.join(dir,'state.sqlite'),f=fixture('tour-reserve-reopen',file)
 try{
  reserve(f,1);f.reopen();assert.ok(petInKiboTour(f.state(),f.id))
  assert.throws(()=>f.call('DelPet',{pet_list:[f.id]}),e=>e.code===ErrorCode.ActivityPetTourCannotDel)
  f.edit(s=>{delete s.activities[8001].kiboTour.runs[1001]})
  f.call('DelPet',{pet_list:[f.id]});assert.ok(!f.state().pets.some(p=>p.guid===f.id))
 }finally{f.close();fs.rmSync(file,{force:true});fs.rmdirSync(dir)}
})
test('9854 actual pet-instance delivery shares the unfinished-tour guard and only consumes after reservation is released',()=>{
 const f=fixture('tour-reserve-task-delivery')
 try{
  f.edit(s=>{
   const p=s.pets.find(p=>p.config_id===500026);assert.ok(p);f.id=p.guid
   Object.assign(p,{is_lock:false,hero_id:'0',roulette_pos:0,work_status:0,work_build:0,capacity_id:0,station_lock:0,can_not_release:false})
   s.pets=[p];s.world.map_id=924;s.taskEpochs={100002:1}
   const graph=new TaskGraphs(tables).get(100002)
   s.tasks=[{task_id:100002,start_time:1,finish_nodes:[],reward_nodes:[],nodes:[{...makeNode(graph,21,s),client_before:true}]}]
  })
  const r={task_id:100002,node_id:21,node_index:0,items:[{item_type:5,item_id:500026,item_guid:f.id,item_count:1}]}
  for(const state of [0,1]){
   reserve(f,state);const before=f.state()
   assert.throws(()=>f.call('TaskSubmitItem',r),e=>e.code===ErrorCode.ActivityPetTourCannotDel);assert.deepEqual(f.state(),before)
  }
  f.edit(s=>{delete s.activities[8001].kiboTour.runs[1001]})
  f.call('TaskSubmitItem',r);assert.equal(f.state().pets.length,0)
  assert.equal(f.state().tasks.find(t=>t.task_id===100002).nodes[0].node_values[0],1)
  assert.equal(f.state().releaseLedgers,undefined)
 }finally{f.close()}
})
