import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tourFixture } from './kibo-tour-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const ledger=f=>f.state().activities[8001].kiboTour
const start=(f,id,ids)=>f.call('StartKiboTour',{activity_id:8001,tour_id:id,pet_id_list:ids})
const cancel=(f,id)=>f.call('KiboTourCancel',{activity_id:8001,tour_id:id})
test('10409 cancels a real trip, releases pets without rewards or quota use, keeps a receipt and makes exact retry harmless',()=>{
 const f=tourFixture('tour-cancel-real')
 try{
  const ids=f.petIds(2);start(f,1001,ids)
  const before=f.state(),packets=cancel(f,1001)
  assert.equal(ledger(f).runs[1001],undefined);assert.equal(ledger(f).total_times,0)
  assert.equal(ledger(f).receipts[1].status,'cancelled');assert.ok(ids.every(id=>f.state().pets.find(p=>p.guid===id).tour_state===0))
  assert.equal(f.state().player.basic_info.gold,before.player.basic_info.gold);assert.deepEqual(f.state().player.sbag_infos,before.player.sbag_infos)
  assert.ok(packets.findIndex(p=>p.id===f.protocol.byName.get('CSProtoPetInfoSync').id)<packets.findIndex(p=>p.id===10409))
  const saved=ledger(f),revision=f.state().petRevision;cancel(f,1001)
  assert.deepEqual(ledger(f),saved);assert.equal(f.state().petRevision,revision)
  start(f,1001,ids);assert.equal(ledger(f).runs[1001].attempt_id,2)
 }finally{f.close()}
})
test('expired activity still permits running or ready trips to cancel, and the last closure restores original display times',()=>{
 const f=tourFixture('tour-cancel-expired')
 try{
  const ids=f.petIds(2);f.hardEnd=f.now+1;start(f,1001,[ids[0]]);start(f,1002,[ids[1]])
  f.advance(11);f.game.tick(f.session.id,f.session);assert.equal(ledger(f).runs[1001].state,1)
  cancel(f,1001);assert.ok(f.snapshot().activitys.some(r=>r.id===8001));assert.equal(f.state().pets.find(p=>p.guid===ids[1]).tour_state,1)
  const packets=cancel(f,1002),view=f.snapshot()
  assert.ok(!view.activitys.some(r=>r.id===8001));assert.equal(view.confs.find(r=>r.activity_id===8001).end_time,f.hardEnd)
  const times=f.decode(packets,'SyncCommonTimeConf').data_list
  assert.equal(Number(times.find(r=>r.time_id===998006).end_time),f.hardEnd)
  assert.throws(()=>start(f,1003,[ids[0]]),e=>e.code===ErrorCode.ActivityTimeLimit)
  assert.equal(ledger(f).total_times,0)
 }finally{f.close()}
})
test('nonexistent cancellation never fabricates a receipt; response encoding failure rolls back a real cancellation',()=>{
 const f=tourFixture('tour-cancel-codec')
 try{
  const before=f.state();assert.throws(()=>cancel(f,1001),e=>e.code===ErrorCode.ActivityTourNotExist);assert.deepEqual(f.state(),before)
  start(f,1001,f.petIds());const started=f.state(),encode=f.protocol.encode.bind(f.protocol),type=f.protocol.byName.get('CSProtoKiboTourCancel').rsp
  f.protocol.encode=(t,v)=>{if(t===type)throw Error('tour cancel codec');return encode(t,v)}
  assert.throws(()=>cancel(f,1001),/tour cancel codec/);f.protocol.encode=encode
  assert.deepEqual(f.state(),started)
 }finally{f.close()}
})
test('cancellation receipts and released ownership survive actual temporary SQLite close/reopen',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tour-cancel-')),file=path.join(dir,'state.sqlite'),f=tourFixture('tour-cancel-reopen',{file})
 try{
  const id=f.petIds()[0];start(f,1001,[id]);cancel(f,1001);f.reopen()
  assert.equal(ledger(f).receipts[1].status,'cancelled');assert.equal(ledger(f).runs[1001],undefined)
  assert.equal(f.state().pets.find(p=>p.guid===id).tour_state,0);cancel(f,1001)
  f.call('PetLock',{guid:id,lock_operate:false});f.call('DelPet',{pet_list:[id]})
  assert.ok(!f.state().pets.some(p=>p.guid===id))
 }finally{f.close();fs.rmSync(file,{force:true});fs.rmdirSync(dir)}
})
test('shared tour allocator refuses damaged counters and never overwrites an active or cancelled attempt receipt',()=>{
 const f=tourFixture('tour-attempt-receipt-integrity')
 try{
  const ids=f.petIds(2);start(f,1001,[ids[0]])
  f.edit(s=>s.activities[8001].kiboTour.next_attempt=1)
  let before=f.state();assert.throws(()=>start(f,1002,[ids[1]]),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
  cancel(f,1001)
  before=f.state();assert.throws(()=>start(f,1001,[ids[0]]),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
  for(const n of [-1,0,1.5,Number.MAX_SAFE_INTEGER]){
   f.edit(s=>s.activities[8001].kiboTour.next_attempt=n);before=f.state()
   assert.throws(()=>start(f,1001,[ids[0]]),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
  }
  f.edit(s=>s.activities[8001].kiboTour.next_attempt=2);start(f,1001,[ids[0]])
  assert.equal(ledger(f).runs[1001].attempt_id,2);assert.equal(ledger(f).receipts[1].status,'cancelled')
 }finally{f.close()}
})
test('a corrupt active/closed attempt collision cannot overwrite a permanent cancellation receipt',()=>{
 const f=tourFixture('tour-close-receipt-collision')
 try{
  start(f,1001,f.petIds());f.edit(s=>s.activities[8001].kiboTour.receipts[1]={attempt_id:1,tour_id:1002,status:'cancelled',pet_ids:[]})
  const before=f.state();assert.throws(()=>cancel(f,1001),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
 }finally{f.close()}
})
test('a damaged tour map identity fails snapshot, repeated Start and Cancel before changing state or writing a receipt',()=>{
 const f=tourFixture('tour-run-key-integrity')
 try{
  const ids=f.petIds();start(f,1001,ids)
  f.edit(s=>s.activities[8001].kiboTour.runs[1001].tour_id=1002)
  const before=f.state()
  assert.throws(()=>f.snapshot(),e=>e.code===ErrorCode.GameConfig)
  assert.deepEqual(f.state(),before)
  assert.throws(()=>start(f,1001,ids),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
  assert.throws(()=>cancel(f,1001),e=>e.code===ErrorCode.GameConfig);assert.deepEqual(f.state(),before)
  assert.deepEqual(ledger(f).receipts,{})
  assert.equal(f.state().pets.find(p=>p.guid===ids[0]).tour_state,1)
 }finally{f.close()}
})
