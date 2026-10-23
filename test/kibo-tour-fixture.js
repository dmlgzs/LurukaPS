import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
export const cfg=configuration(),tables=new Tables(cfg.tables)
export function tourFixture(name,{file=':memory:',duration=10}={}){
 let now=1800000000,hardEnd=now+100,p=new Protocol(cfg.base),store=new Store(file),game,session={},seq=1
 const makeGame=()=>{
  game=new Game(p,store,tables,{clock:()=>now,tourPolicy:{durationSeconds:duration}})
  const original=game.activities.window.bind(game.activities)
  game.activities.window=(row,time)=>row.type===80?{activity_id:row.id,start_time:1799999900,end_time:hardEnd}:original(row,time)
 }
 makeGame()
 const call=(name,r={},who=session)=>{const e=p.byName.get('CSProto'+name),payload=p.encode(e.req,r);return game.dispatch(who,{id:e.id,seq:seq++,payload})}
 call('EnterGame',{open_id:name})
 const edit=fn=>store.transact(session.id,0,fn),state=()=>store.load(session.id).state
 edit(s=>{s.taskRecords=[...(s.taskRecords??[]),{task_id:106013,count:1,time:now}];s.player.basic_info.lv=50})
 return {call,edit,state,get game(){return game},get protocol(){return p},get session(){return session},get now(){return now},get hardEnd(){return hardEnd},set hardEnd(n){hardEnd=n},advance(n){now+=n},close(){store.close()},
  decode(packets,name){const e=p.byName.get('CSProto'+name)||p.byName.get(name),packet=packets.find(x=>x.id===e.id);return packet?p.decode(e.rsp,packet.payload):null},
  snapshot(){return game.activities.snapshot(state(),now)},
  reopen(){store.close();store=new Store(file);p=new Protocol(cfg.base);makeGame();session={};call('EnterGame',{open_id:name})},
  petIds(count=1,exclude=[]){return state().pets.filter(p=>!exclude.includes(p.guid)&&!p.trial&&!p.trail&&p.type!==2).slice(0,count).map(p=>p.guid)},
 }
}
