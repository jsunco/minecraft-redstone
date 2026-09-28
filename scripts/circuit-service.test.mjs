import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CircuitService,decodeCircuit} from './circuit-service.mjs';

const session='11111111-1111-4111-8111-111111111111',watch='22222222-2222-4222-8222-222222222222';
const definition={id:'adder',dimension:'minecraft:overworld',signals:[
 {name:'low',position:{x:0,y:64,z:0},property:'powered'},
 {name:'high',position:{x:1,y:64,z:0},property:'powered'},
],buses:[{name:'sum',bits:['low','high']}]};
const row=(x,value=false,status='loaded')=>({index:x,position:{x,y:64,z:0},status,properties:status==='loaded'?{powered:String(value)}:{}});
const decode=result=>JSON.parse(result.content[0].text);
const clone=value=>structuredClone(value);
function fixture({stateDir=null,def=definition}={}){
 const calls=[];let initial=def.signals.map((s,i)=>({index:i,position:s.position,status:'loaded',properties:{[s.property]:'false'}}));
 const start={watch_id:watch,session_id:session,started_tick:100,last_sample_tick:100,next_seq:0,active:true,initial_states:initial,sampling_phase:'end_server_tick'};
 const page={watch_id:watch,session_id:session,next_seq:0,latest_seq:0,gap:false,entries:[],last_sample_tick:101,active:true,dropped_total:0};
 const batch={atomic:true,session_id:session,server_tick:100,phase:'server_task',states:initial};
 const bridge={async call(source,tool,args){calls.push({source,tool,args});
  if(tool==='block_watch_start')return{structuredContent:clone(start)};
  if(tool==='block_watch_poll')return{structuredContent:clone(page)};
  if(tool==='block_watch_stop')return{structuredContent:{watch_id:watch,session_id:session,active:false,end_reason:'stopped'}};
  if(tool==='block_get_states_batch')return{structuredContent:clone(batch)};
  throw Error(tool);
 }};
 const service=new CircuitService(bridge,{stateDir});service.register(def);
 return{service,bridge,calls,start,page,batch};
}
const begin=async f=>decode(await f.service.trace({action:'start',id:'adder'})).trace_id;

test('32-bit buses retain unsigned values and unknown or invalid signals remain unknown',()=>{
 const def={signals:Array.from({length:32},(_,i)=>({name:`b${i}`,position:{x:i,y:64,z:0},property:'power'})),buses:[{name:'word',bits:Array.from({length:32},(_,i)=>`b${i}`)}]};
 const rows=def.signals.map((s,i)=>({...row(i),properties:{power:'15'}}));
 assert.equal(decodeCircuit(def,rows).buses.word.value,4294967295);
 rows.slice(0,31).forEach(r=>r.properties.power='0');assert.equal(decodeCircuit(def,rows).buses.word.value,2147483648);
 for(const invalid of ['16','-1','1.5','garbage',true,null]){rows[0].properties.power=invalid;assert.equal(decodeCircuit(def,rows).signals.b0.bit,null);assert.equal(decodeCircuit(def,rows).buses.word.value,null);}
 rows[0].properties.power='0';rows[0].status='unloaded';assert.equal(decodeCircuit(def,rows).signals.b0.bit,null);
 assert.equal(decodeCircuit(def,rows.slice(1)).signals.b0.status,'missing');
});

test('registration rejects duplicate/broken buses and handles prototype-like names safely',()=>{
 const {service}=fixture();
 assert.throws(()=>service.register({...definition,signals:[definition.signals[0],definition.signals[0]]}),/Duplicate/);
 assert.throws(()=>service.register({...definition,buses:[{name:'sum',bits:['missing']}]}),/registered signal/);
 assert.throws(()=>service.register({...definition,buses:[{name:'sum',bits:['low','low']}]}),/distinct/);
 assert.throws(()=>service.get('constructor'),/Unknown circuit/);
 service.register({...definition,id:'constructor'});assert.equal(service.get('constructor').id,'constructor');
});

test('observation uses one deduplicated atomic batch and unknown assertions cannot pass',async()=>{
 const def={...definition,signals:[definition.signals[0],{name:'high',position:definition.signals[0].position,property:'lit'}]};
 const f=fixture({def});f.batch.states=[{...row(0,true),properties:{powered:'true',lit:'false'}}];
 const result=decode(await f.service.observe({id:'adder',expect:{sum:1,low:1}}));
 assert.equal(result.pass,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].tool,'block_get_states_batch');assert.equal(f.calls[0].args.positions.length,1);
 assert.deepEqual(f.calls[0].args.properties,['powered','lit']);
 f.batch.states[0].status='unloaded';const unknown=decode(await f.service.observe({id:'adder',expect:{sum:0}}));
 assert.equal(unknown.pass,false);assert.equal(unknown.assertions[0].actual,null);
 f.batch.atomic=false;await assert.rejects(f.service.observe({id:'adder'}),/atomic batch unavailable/);
});

test('assertion typos and out-of-width values fail before an upstream read',async()=>{
 const f=fixture();await assert.rejects(f.service.observe({id:'adder',expect:{typo:0}}),/Unknown asserted/);
 await assert.rejects(f.service.observe({id:'adder',expect:{sum:4}}),/exceeds width/);
 await assert.rejects(f.service.observe({id:'adder',expect:{low:2}}),/exceeds width/);assert.equal(f.calls.length,0);
});

test('ordered finite trace pages update named buses and idle completion advances coverage tick',async()=>{
 const f=fixture(),trace_id=await begin(f);
 Object.assign(f.page,{next_seq:2,latest_seq:2,last_sample_tick:103,entries:[
  {seq:1,tick:101,missed_ticks:0,states:[row(0,true)]},
  {seq:2,tick:102,missed_ticks:0,states:[row(1,true)]},
 ]});
 const result=decode(await f.service.trace({action:'poll',trace_id}));
 assert.equal(result.current.buses.sum.value,3);assert.equal(result.transitions_this_poll,2);assert.equal(result.last_tick,103);assert.equal(result.complete,true);
 Object.assign(f.page,{entries:[],active:false,last_sample_tick:300,end_reason:'duration_reached'});
 const done=decode(await f.service.trace({action:'poll',trace_id}));assert.equal(done.last_tick,300);assert.equal(done.active,false);assert.equal(done.has_more,false);
 assert.deepEqual(f.calls.map(c=>c.tool),['block_watch_start','block_watch_poll','block_watch_poll']);
 assert.equal(f.calls[2].args.after_seq,2);
});

test('invalid later entries cannot partially mutate a trace baseline or cursor',async()=>{
 const f=fixture(),trace_id=await begin(f),before=clone(f.service.traces[trace_id]);
 Object.assign(f.page,{next_seq:2,latest_seq:2,last_sample_tick:102,entries:[
  {seq:1,tick:101,missed_ticks:0,states:[row(0,true)]},
  {seq:1,tick:102,missed_ticks:0,states:[row(1,true)]},
 ]});
 await assert.rejects(f.service.trace({action:'poll',trace_id}),/sequence/);
 assert.deepEqual(f.service.traces[trace_id],before);
 f.page.entries[1].seq=2;f.page.entries[1].tick=99;
 await assert.rejects(f.service.trace({action:'poll',trace_id}),/sequence/);assert.deepEqual(f.service.traces[trace_id],before);
 f.page.entries[1].tick=102;f.page.next_seq=1;
 await assert.rejects(f.service.trace({action:'poll',trace_id}),/cursor/);assert.deepEqual(f.service.traces[trace_id],before);
});

test('unknown intervals and missed ticks never become proven signal transitions',async()=>{
 const f=fixture(),trace_id=await begin(f);
 Object.assign(f.page,{next_seq:2,latest_seq:2,last_sample_tick:105,entries:[
  {seq:1,tick:101,missed_ticks:0,states:[row(0,false,'unloaded')]},
  {seq:2,tick:105,missed_ticks:3,states:[row(0,true)]},
 ]});
 const result=decode(await f.service.trace({action:'poll',trace_id}));
 assert.equal(result.complete,false);assert.equal(result.gaps,1);assert.equal(result.transitions_this_poll,0);assert.equal(result.uncertain_changes_this_poll,2);
 assert.equal(result.current.buses.sum.value,1);assert.equal(result.samples[0].edges.low.unknown,true);
});

test('overflow requires full recovery and does not invent transitions across the missing interval',async()=>{
 const f=fixture(),trace_id=await begin(f),before=clone(f.service.traces[trace_id]);
 Object.assign(f.page,{gap:true,next_seq:20,latest_seq:20,last_sample_tick:130,recovery_tick:130,recovery_states:[row(0,true)],dropped_total:18});
 await assert.rejects(f.service.trace({action:'poll',trace_id}),/requires all/);assert.deepEqual(f.service.traces[trace_id],before);
 f.page.recovery_states.push(row(1,true));const result=decode(await f.service.trace({action:'poll',trace_id}));
 assert.equal(result.complete,false);assert.equal(result.gaps,1);assert.equal(result.current.buses.sum.value,3);assert.equal(result.transitions_this_poll,0);assert.equal(result.next_seq,20);assert.match(result.warning,/unknown/);
});

test('session mismatch invalidates the trace and persists that decision across process restart',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'circuit-session-'));
 try{
  const f=fixture({stateDir}),trace_id=await begin(f);f.page.session_id='33333333-3333-4333-8333-333333333333';
  await assert.rejects(f.service.trace({action:'poll',trace_id}),/World session changed/);
  assert.equal(f.service.traces[trace_id].complete,false);assert.equal(f.service.traces[trace_id].active,false);
  const restored=new CircuitService(f.bridge,{stateDir});const reads=f.calls.length;
  await assert.rejects(restored.trace({action:'poll',trace_id}),/start a new trace/);assert.equal(f.calls.length,reads);
  assert.match(readFileSync(join(stateDir,`${trace_id}.jsonl`),'utf8'),/session_changed/);
 }finally{rmSync(stateDir,{recursive:true,force:true});}
});

test('restart restores trace cursor, frozen circuit definition and its detailed artifact',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'circuit-state-'));
 try{
  const f=fixture({stateDir}),trace_id=await begin(f);
  Object.assign(f.page,{next_seq:1,latest_seq:1,last_sample_tick:101,entries:[{seq:1,tick:101,missed_ticks:0,states:[row(0,true)]}]});
  await f.service.trace({action:'poll',trace_id});
  f.service.register({...definition,description:'new definition',signals:[{...definition.signals[0],position:{x:99,y:64,z:0}},definition.signals[1]]});
  const restored=new CircuitService(f.bridge,{stateDir});assert.equal(restored.get('adder').signals[0].position.x,99);assert.equal(restored.traces[trace_id].definition.signals[0].position.x,0);
  Object.assign(f.page,{entries:[],last_sample_tick:102});await restored.trace({action:'poll',trace_id});
  assert.equal(f.calls.at(-1).args.after_seq,1);const events=readFileSync(join(stateDir,`${trace_id}.jsonl`),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e=>e.kind),['start','poll','poll']);assert.equal(events[1].entries[0].seq,1);
 }finally{rmSync(stateDir,{recursive:true,force:true});}
});

test('large trace responses stay below 12KB while the artifact preserves every detailed entry',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'circuit-size-'));
 try{
  const signals=Array.from({length:64},(_,i)=>({name:`signal${i}`.padEnd(32,'x'),position:{x:i,y:64,z:0},property:'powered'}));
  const buses=Array.from({length:16},(_,i)=>({name:`bus${i}`.padEnd(32,'x'),bits:signals.slice(0,32).map(s=>s.name)}));
  const f=fixture({stateDir,def:{...definition,signals,buses}}),trace_id=await begin(f);
  Object.assign(f.page,{next_seq:16,latest_seq:16,last_sample_tick:116,entries:Array.from({length:16},(_,i)=>({seq:i+1,tick:101+i,missed_ticks:0,states:signals.map((s,index)=>({...row(index,i%2===0),position:s.position}))}))});
  const response=await f.service.trace({action:'poll',trace_id}),result=decode(response);
  assert.ok(Buffer.byteLength(response.content[0].text)<=12000);assert.equal(result.summary_compacted,true);assert.ok(result.samples_omitted>4);
  assert.equal(result.transitions_total,16*64);assert.equal(result.current.signal_bits[signals[0].name],0);
  const events=readFileSync(result.artifact,'utf8').trim().split('\n').map(JSON.parse);assert.equal(events[1].entries.length,16);assert.equal(events[1].entries[0].states.length,64);
 }finally{rmSync(stateDir,{recursive:true,force:true});}
});

test('stop preserves the native buffer for a final poll and corrupt state fails closed',async()=>{
 const f=fixture(),trace_id=await begin(f);await f.service.trace({action:'stop',trace_id});
 assert.deepEqual(f.calls.at(-1).args,{watch_id:watch,discard:false});assert.equal(f.service.traces[trace_id].active,false);
 const stateDir=mkdtempSync(join(tmpdir(),'circuit-corrupt-'));
 try{writeFileSync(join(stateDir,'circuits.json'),'{bad');assert.throws(()=>new CircuitService(f.bridge,{stateDir}),/preserve and repair/);assert.equal(readFileSync(join(stateDir,'circuits.json'),'utf8'),'{bad');}
 finally{rmSync(stateDir,{recursive:true,force:true});}
});

test('discard releases only inactive fully drained native recorders and preserves local history',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'circuit-discard-'));
 try{
  const f=fixture({stateDir}),trace_id=await begin(f),original=f.bridge.call.bind(f.bridge);
  f.bridge.call=async(source,tool,args)=>{const result=await original(source,tool,args);if(tool==='block_watch_stop')result.structuredContent.discarded=args.discard;return result;};
  await assert.rejects(f.service.trace({action:'discard',trace_id}),/inactive and fully drained/);
  await f.service.trace({action:'stop',trace_id});await assert.rejects(f.service.trace({action:'discard',trace_id}),/fully drained/);
  Object.assign(f.page,{active:false,next_seq:1,latest_seq:2,last_sample_tick:102,entries:[{seq:1,tick:101,missed_ticks:0,states:[row(0,true)]}]});
  await f.service.trace({action:'poll',trace_id});await assert.rejects(f.service.trace({action:'discard',trace_id}),/fully drained/);
  Object.assign(f.page,{next_seq:2,entries:[{seq:2,tick:102,missed_ticks:0,states:[row(1,true)]}]});await f.service.trace({action:'poll',trace_id});
  const discarded=decode(await f.service.trace({action:'discard',trace_id}));assert.equal(discarded.discarded,true);assert.equal(discarded.local_history,'preserved');
  assert.deepEqual(f.calls.at(-1).args,{watch_id:watch,discard:true});
  const retained=readFileSync(discarded.artifact,'utf8');assert.match(retained,/"kind":"start"/);assert.match(retained,/"kind":"discard"/);
  const restarted=new CircuitService(f.bridge,{stateDir}),callCount=f.calls.length;
  const local=decode(await restarted.trace({action:'poll',trace_id}));assert.equal(local.current.buses.sum.value,3);assert.equal(local.discarded,true);assert.equal(f.calls.length,callCount);
 }finally{rmSync(stateDir,{recursive:true,force:true});}
});

test('unknown native watch invalidates only after a separately verified changed server session',async()=>{
 for(const changed of [false,true]){
  const f=fixture(),trace_id=await begin(f),original=f.bridge.call.bind(f.bridge);
  f.bridge.call=async(source,tool,args)=>{
   if(tool==='block_watch_poll')throw new Error('Unknown watch_id');
   if(tool==='server_get_status')return{structuredContent:{session_id:changed?'33333333-3333-4333-8333-333333333333':session}};
   return original(source,tool,args);
  };
  await assert.rejects(f.service.trace({action:'poll',trace_id}),changed?/World session changed/:/Unknown watch/);
  assert.equal(f.service.traces[trace_id].invalidated??false,changed);assert.equal(f.service.traces[trace_id].active,!changed);
 }
});

test('transient trace and status failures retain the cursor for a retry instead of claiming a new session',async()=>{
 const f=fixture(),trace_id=await begin(f),before=clone(f.service.traces[trace_id]);
 f.bridge.call=async()=>{throw new Error('offline');};
 await assert.rejects(f.service.trace({action:'stop',trace_id}),/offline/);assert.deepEqual(f.service.traces[trace_id],before);
});

test('known endpoint differences across missed ticks are uncertain rather than exact recorded edges',async()=>{
 const f=fixture(),trace_id=await begin(f);
 Object.assign(f.page,{next_seq:1,latest_seq:1,last_sample_tick:105,entries:[{seq:1,tick:105,missed_ticks:4,states:[row(0,true)]}]});
 const result=decode(await f.service.trace({action:'poll',trace_id}));
 assert.equal(result.complete,false);assert.equal(result.transitions_this_poll,0);assert.equal(result.uncertain_changes_this_poll,1);assert.equal(result.samples[0].edges.low.unknown,true);
});

test('failed persistence leaves trace cursor and registration at the last committed state',async()=>{
 const f=fixture(),trace_id=await begin(f),before=clone(f.service.traces[trace_id]);
 Object.assign(f.page,{next_seq:1,latest_seq:1,last_sample_tick:101,entries:[{seq:1,tick:101,missed_ticks:0,states:[row(0,true)]}]});
 const originalSave=f.service.save.bind(f.service);f.service.save=()=>{throw new Error('disk unavailable');};
 await assert.rejects(f.service.trace({action:'poll',trace_id}),/disk unavailable/);
 assert.deepEqual(f.service.traces[trace_id],before);
 assert.throws(()=>f.service.register({...definition,id:'new'}),/disk unavailable/);
 assert.throws(()=>f.service.get('new'),/Unknown circuit/);
 assert.throws(()=>f.service.register({...definition,description:'undelivered edit'}),/disk unavailable/);
 assert.equal(f.service.get('adder').description,'');
 f.service.save=originalSave;
 const retried=decode(await f.service.trace({action:'poll',trace_id}));
 assert.equal(f.calls.at(-1).args.after_seq,0);assert.equal(retried.transitions_total,1);assert.equal(retried.current.buses.sum.value,1);
});
