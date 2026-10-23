import current from '../configs/campaign-playable-current.json' with { type: 'json' }
import policy from '../configs/campaign-playable-policy.json' with { type: 'json' }
import playableRows from '../configs/playable-tables/playable.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { campaignStageSatisfied } from './campaign-stage-plan.js'
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const split=(text,sep)=>String(text??'').split(sep)
const pairs=(text)=>{
 const out=new Map()
 for(const token of split(text,'|').filter(Boolean)) {
  const at=token.indexOf('#');ensure(at>0&&!out.has(token.slice(0,at)),'Duplicate or malformed campaign graph parameter',ErrorCode.GameConfig)
  out.set(token.slice(0,at),token.slice(at+1))
 }
 return out
}
export function validateLocalCampaignPolicy(config) {
 ensure(config?.schema_version===1&&config.condition===13060&&
     ['local_four_field_current_instance_distinct_playable','closed'].includes(config.mode),
     'Local campaign condition policy is malformed',ErrorCode.GameConfig)
 ensure(config.mode!=='closed','Local campaign condition compatibility is closed',ErrorCode.FunctionClosed)
 return config
}
export function localCampaignCondition(text) {
 validateLocalCampaignPolicy(policy)
 const tokens=split(text,'#'), values=tokens.map(Number)
 ensure(tokens.length===4,'Unsupported local campaign condition shape',ErrorCode.FunctionClosed)
 ensure(tokens.every(s=>/^(0|[1-9]\d*)$/.test(s))&&values.every(uint),
     'Local campaign condition contains malformed values',ErrorCode.GameConfig)
 ensure(values[0]===policy.condition,'Local campaign condition kind is not supported',ErrorCode.FunctionClosed)
 ensure(values[1]>0&&values[3]>0,'Invalid local campaign condition parameters',ErrorCode.GameConfig)
 return values
}
export function campaignPlayableStagePlan(tables,map) {
 const scene=tables.find('dungeon_scene',map), params=pairs(scene?.stringParam),rows=tables.get('worldmap_'+map),used=new Set(),out=[]
 for(let index=0;index<=9;index++) {
  const suffix=index?'_'+index:'', word=params.get('finish_con_word'+suffix)
  if(!word)continue // Actual common graph routes blank word Fail to the next slot.
  const tokens=split(params.get('finish_con_intlist'+suffix),','),v=tokens.map(Number)
  ensure(tokens.length===5&&tokens.every(s=>/^(0|[1-9]\d*)$/.test(s))&&v.every(uint)&&v[4]>0,
      'Malformed common campaign target selector',ErrorCode.GameConfig)
  ensure(v[0]===2500&&v[1]>0&&v[2]===0&&v[3]>0&&v[4]===1,
      'Unsupported common campaign target selector',ErrorCode.FunctionClosed)
  const selected=rows.filter(r=>r.id===v[3]&&r.spawnerId===v[1]&&!used.has(r.id))
  ensure(selected.length===1,'Campaign target object is missing or ambiguous',ErrorCode.InstanceSceneConfNotExist)
  ensure(tables.find('world_spawner',selected[0].spawnerId)?.objectType===13,
      'Local playable campaign target interaction is not supported',ErrorCode.FunctionClosed)
  used.add(selected[0].id);out.push(selected)
 }
 ensure(out.length>0,'Common campaign has no supported explicit targets',ErrorCode.GameConfig)
 return out
}
export function localPlayableCampaignRoute(tables,dungeon) {
 ensure(current.schema_version===1&&Array.isArray(current.rows),'Current campaign source contract is malformed',ErrorCode.GameConfig)
 let condition=dungeon.victoryCondition
 const saved=current.rows.filter(r=>r.id===dungeon.id)
 ensure(saved.length<=1,'Duplicate current campaign override',ErrorCode.GameConfig)
 if(saved.length) {
  const row=saved[0], matches=s=>Object.entries(s).every(([k,v])=>dungeon[k]===v)
  ensure(matches(row.current)||matches(row.legacy),'Campaign external table conflicts with current source fingerprint',ErrorCode.GameConfig)
  condition=row.current.victoryCondition
 }
 if(!String(condition).startsWith('13060#'))return null
 const parts=localCampaignCondition(condition), map=parts[1]
 const scenes=tables.get('dungeon_scene').filter(s=>s.id===map&&s.mapId===map&&tables.find('world_blueprint',s.blueprintId)?.path===policy.common_blueprint)
 ensure(scenes.length===1&&tables.find('world_city',map)?.type===2,'Local campaign scene is not unique',ErrorCode.InstanceSceneConfNotExist)
 const scene=scenes[0], rows=tables.get('worldmap_'+map), plan=campaignPlayableStagePlan(tables,map)
 const points=tables.get('world_borthpos').filter(p=>p.cityId===map&&p.mainPoint===1)
 ensure(points.length===1,'Local campaign birth point is not unique',ErrorCode.NotFoundBirthPoint)
 tables.position(points[0])
 const ids=rows.filter(r=>tables.find('world_spawner',r.spawnerId)?.objectType===101).map(r=>r.expandId)
 ensure(ids.length>0&&new Set(ids).size===ids.length,'Local campaign playable objects are missing or duplicated',ErrorCode.GameConfig)
 for(const id of ids) {
  const p=playableRows.filter(p=>p.id===id)
  ensure(p.length===1&&tables.find('playable_type',p[0].type),'Campaign playable table is missing',ErrorCode.GameConfig)
  ensure(p[0].stepMax>0&&p[0].canReset===1&&p[0].canRestart===1,'Campaign playable lifecycle is unsupported',ErrorCode.FunctionClosed)
 }
 const eligible=ids.filter(id=>!parts[2]||playableRows.find(p=>p.id===id).type===parts[2])
 ensure(eligible.length>=parts[3],'Campaign distinct playable count is impossible',ErrorCode.GameConfig)
 const ints=pairs(scene.intParam), opening=Number(ints.get('story_id_0')),ending=Number(ints.get('story_id_last')),deleteTag=Number(ints.get('deleteItemTag1'))
 ensure([opening,ending,deleteTag].every(n=>uint(n)&&n>0),'Campaign common graph story bindings unavailable',ErrorCode.GameConfig)
 ensure(rows.some(r=>String(r.commonTag)===String(deleteTag)),'Campaign opening cleanup tag unavailable',ErrorCode.GameConfig)
 const trial=split(scene.trailGroup,'|').filter(Boolean).map(s=>split(s,'#').map(Number))
 ensure(trial.length>0&&trial.every(a=>a.length===2&&a.every(n=>uint(n)&&n>0)),'Campaign trial formation unavailable',ErrorCode.GameConfig)
 for(const [hero,pet]of trial){const h=tables.find('hero_interim',hero),p=tables.find('pet_interim',pet);ensure(h&&tables.find('hero',h.heroId)&&p&&tables.find('pet',p.petId),'Campaign trial actor configuration unavailable',ErrorCode.GameConfig)}
 // No roster is synthesized from dungeon.enemy: this scene contains a puzzle,
 // not the two enemy IDs retained in its preview table.
 ensure(!rows.some(r=>tables.find('world_spawner',r.spawnerId)?.objectType===50),'Mixed combat/playable local campaign is not supported',ErrorCode.FunctionClosed)
 return {mode:'local_playable',scene_ids:[map],opening_stories:[opening],local_condition:parts,playable_ids:ids,ending_story:ending,delete_tag:deleteTag,source:'LOCAL unique explicit four-field map and common blueprint',target_ids:plan.flat().map(r=>r.id)}
}
export function localCampaignSatisfied(tables,state) {
 const run=state.storyCampaign
 if(!run?.local_playable_condition||state.world.map_id!==run.map_id)return false
 if(!Number.isSafeInteger(run.instance_id)||run.instance_id<=0)return false
 ensure(Array.isArray(run.local_playable_condition)&&Array.isArray(run.playable_ids),'Campaign local ledger configuration is malformed',ErrorCode.GameConfig)
 const condition=localCampaignCondition(run.local_playable_condition.join('#'))
 const successes=Object.values(run.playable_successes??{}).filter(r=>r.instance_id===run.instance_id&&r.map_id===run.map_id&&run.playable_ids.includes(r.play_id)&&(!condition[2]||playableRows.find(p=>p.id===r.play_id)?.type===condition[2]))
 return new Set(successes.map(r=>r.play_id)).size>=condition[3]&&campaignPlayableStagePlan(tables,run.map_id).every(rows=>campaignStageSatisfied(tables,state,rows))
}

