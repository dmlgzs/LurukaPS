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
const cfg=configuration(),tables=new Tables(cfg.tables)
function fixture(name,file=':memory:'){
 let store=new Store(file),p=new Protocol(cfg.base),game=new Game(p,store,tables,{clock:()=>1800000000}),session={};let seq=1
 const call=(name,r={})=>{const e=p.byName.get('CSProto'+name);return game.dispatch(session,{id:e.id,seq:seq++,payload:p.encode(e.req,r)})}
 call('EnterGame',{open_id:name});const id=store.load(session.id).state.pets[0].guid
 call('PetLock',{guid:id,lock_operate:false})
 return {id,call,edit:fn=>store.transact(session.id,0,fn),state:()=>store.load(session.id).state,close:()=>store.close(),reopen(){store.close();store=new Store(file);p=new Protocol(cfg.base);game=new Game(p,store,tables,{clock:()=>1800000000});session={};call('EnterGame',{open_id:name})}}
}
const reserve=(f,state)=>f.edit(s=>{s.activities={8001:{kiboTour:{next_attempt:2,runs:{1001:{attempt_id:1,tour_id:1001,pet_ids:[f.id],state,start_time:1700000000,end_time:1700003600}},receipts:{}}}};s.pets[0].tour_state=0})
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
