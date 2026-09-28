import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CircuitService} from './circuit-service.mjs';
import {TestRunnerService} from './test-runner-service.mjs';

const session='11111111-1111-4111-8111-111111111111',watch='22222222-2222-4222-8222-222222222222';
const pos=x=>({x,y:64,z:0}),decode=reply=>JSON.parse(reply.content[0].text),text=value=>({content:[{type:'text',text:value}]}),reply=value=>({structuredContent:structuredClone(value)});
const definition={id:'or_gate',dimension:'minecraft:overworld',signals:[{name:'out',position:pos(10),property:'lit'}],buses:[{name:'result',bits:['out']}]};
const spec=()=>({circuit_id:'or_gate',inputs:[{name:'a',position:pos(0)},{name:'b',position:pos(1)}],cases:[
  {name:'zero',inputs:{a:false,b:false},expect:{out:0,result:0}},
  {name:'a',inputs:{a:true,b:false},expect:{out:1,result:1}},
  {name:'b',inputs:{a:false,b:true},expect:{out:1,result:1}},
  {name:'both',inputs:{a:true,b:true},expect:{out:1,result:1}},
],settle_ticks:2});
function fixture(t,options={}){
  const stateDir=mkdtempSync(join(tmpdir(),'minecraft-runner-'));t.after(()=>rmSync(stateDir,{recursive:true,force:true}));
  const world=new Map([0,1].map(x=>[x,{id:'minecraft:lever',properties:{face:x?'wall':'floor',facing:x?'west':'north',powered:'false'}}]));
  const f={now:0,tick:100,session,calls:[],world,advance:true,outputStatus:'loaded',stateDir,watchActive:false};
  const rows=positions=>positions.map((p,index)=>p.x===10?{index,position:p,status:f.outputStatus,id:'minecraft:redstone_lamp',properties:{lit:String([...world.values()].some(w=>w.properties?.powered==='true'))}}:{index,position:p,status:world.has(p.x)?'loaded':'unloaded',...structuredClone(world.get(p.x)),properties:structuredClone(world.get(p.x)?.properties??{})});
  const bridge={async call(source,tool,args){
    f.calls.push({source,tool,args:structuredClone(args)});f.now+=2;if(f.advance)f.tick++;
    const intercept=await f.intercept?.(tool,args);if(intercept!==undefined)return intercept;
    if(tool==='block_get_states_batch')return reply({atomic:true,session_id:f.session,server_tick:f.tick,phase:'server_task',states:rows(args.positions)});
    if(tool==='block_set_state'){world.set(args.position.x,structuredClone(args.block));return text(`placed ${args.block.id}`);}
    if(tool==='block_watch_start'){f.watchActive=true;return reply({watch_id:watch,session_id:f.session,started_tick:f.tick,next_seq:0,active:true,initial_states:rows(args.positions),sampling_phase:'end_server_tick'});}
    if(tool==='block_watch_stop'){f.watchActive=false;return reply({watch_id:watch,session_id:f.session,active:false,discarded:args.discard,end_reason:'stopped'});}
    if(tool==='block_watch_poll')return reply({watch_id:watch,session_id:f.session,next_seq:0,latest_seq:0,gap:false,entries:[],last_sample_tick:f.tick,active:f.watchActive,dropped_total:0});
    if(tool==='server_get_status')return reply({session_id:f.session,server_tick:f.tick});
    throw Error(tool);
  }};
  const circuits=new CircuitService(bridge,{stateDir:join(stateDir,'circuits')});circuits.register(definition);
  const runner=new TestRunnerService(bridge,circuits,{stateDir,clock:()=>f.now,sleep:async ms=>{f.now+=ms;await f.onSleep?.();},pollIntervalMs:50,stallTimeoutMs:200,...options});
  Object.assign(f,{runner,circuits,bridge});return f;
}
const writes=f=>f.calls.filter(c=>c.tool==='block_set_state');

test('runs a complete truth table from CircuitService observations and restores exact lever orientations',async t=>{
  const f=fixture(t),before=structuredClone([...f.world]);const result=decode(await f.runner.run(spec()));
  assert.equal(result.status,'passed');assert.equal(result.completed,4);assert.equal(result.passed,4);assert.equal(result.restore.status,'restored');
  assert.deepEqual([...f.world],before);assert.ok(result.metrics.input_writes>0);assert.ok(result.metrics.response_json_bytes>0);
  assert.equal(result.metrics.latency_ms.input_writes.count,result.metrics.input_writes);
  assert.ok(writes(f).every(c=>c.args.block.id==='minecraft:lever'&&c.args.block.properties.face===before[c.args.position.x][1].properties.face));
  const events=readFileSync(result.artifact,'utf8').trim().split('\n').map(JSON.parse),cases=events.filter(e=>e.kind==='case');
  assert.equal(cases.length,4);assert.ok(cases.every(c=>c.settled_ticks>=2&&c.observation.atomic));
  assert.equal(f.runner.active,null);assert.equal(decode(f.runner.status({job_id:result.job_id})).status,'passed');
});

test('validates every case, exact input names and output widths before reading or writing',async t=>{
  const f=fixture(t);
  for(const change of [s=>s.cases[3].expect.typo=0,s=>s.cases[3].expect.result=2,s=>delete s.cases[3].inputs.a,s=>s.cases[3].inputs.extra=false,s=>s.inputs.push(s.inputs[0]),s=>s.cases[3].expect={},s=>s.settle_ticks=300,s=>s.inputs[0].position.x=1.5]){
    const input=spec();change(input);assert.throws(()=>f.runner.start(input));
  }
  assert.equal(f.calls.length,0);assert.equal(f.runner.jobs.size,0);
});

test('initial unloaded or non-lever inputs fail before any world writes',async t=>{
  for(const value of [null,{id:'minecraft:stone',properties:{}},{id:'minecraft:lever',properties:{face:'floor',facing:'north',powered:'bad'}}]){
    const f=fixture(t);if(value)f.world.set(1,value);else f.world.delete(1);
    const result=decode(await f.runner.run(spec()));assert.equal(result.status,'aborted');assert.match(result.reason,/loaded vanilla lever/);assert.equal(writes(f).length,0);
  }
});

test('wrong expected values are real failures and stop_on_failure defaults to stopping',async t=>{
  const f=fixture(t),input=spec();input.cases[0].expect.out=1;
  const result=decode(await f.runner.run(input));assert.equal(result.status,'failed');assert.equal(result.completed,1);assert.equal(result.failures[0].assertions[0].actual,0);assert.equal(result.failures[0].assertions[0].pass,false);
});

test('unknown observations abort rather than passing a zero expectation',async t=>{
  const f=fixture(t);f.outputStatus='unloaded';
  const result=decode(await f.runner.run(spec()));assert.equal(result.status,'aborted');assert.equal(result.failed,1);assert.equal(result.failures[0].unknown,true);assert.equal(result.failures[0].assertions[0].actual,null);assert.equal(result.completed,1);
});

test('world session changes stop further writes and prevent restoration into the new world',async t=>{
  const f=fixture(t),input=spec();input.cases=input.cases.slice(1);let changed=false;
  f.intercept=(tool,args)=>{if(tool==='block_get_states_batch'&&args.positions[0].x===10&&!changed){changed=true;f.session='33333333-3333-4333-8333-333333333333';}};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'aborted');assert.match(result.reason,/session changed/);assert.equal(writes(f).length,1);assert.equal(result.restore.status,'incomplete');
});

test('outside toggles and structural edits are detected without overwriting concurrent changes',async t=>{
  const f=fixture(t),input=spec();input.cases=input.cases.slice(1);let edited=false;
  f.onSleep=()=>{if(!edited){edited=true;f.world.set(0,{id:'minecraft:stone',properties:{}});}};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'aborted');assert.equal(f.world.get(0).id,'minecraft:stone');assert.equal(writes(f).length,1);assert.equal(result.restore.status,'incomplete');
});

test('restoration still restores unaffected inputs when another input was replaced',async t=>{
  const f=fixture(t),input=spec();input.cases=[input.cases[3]];f.onSleep=()=>{f.world.set(0,{id:'minecraft:stone',properties:{}});};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'aborted');assert.equal(f.world.get(0).id,'minecraft:stone');assert.equal(f.world.get(1).properties.powered,'false');assert.equal(result.restore.inputs.find(i=>i.name==='b').status,'restored');
});

test('unacknowledged but applied write is journaled and safely restored after readback',async t=>{
  const f=fixture(t),input=spec();input.cases=[input.cases[1]];let failed=false;
  f.intercept=(tool,args)=>{if(tool==='block_set_state'&&!failed){failed=true;f.world.set(args.position.x,structuredClone(args.block));return text('ambiguous response');}};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'aborted');assert.match(result.reason,/acknowledged/);assert.equal(f.world.get(0).properties.powered,'false');assert.equal(result.restore.status,'restored');
});

test('cancellation is serviced during a background run and restores changed inputs',async t=>{
  const f=fixture(t),input=spec();input.cases=input.cases.slice(1);const started=decode(f.runner.start(input));
  f.onSleep=()=>{assert.equal(decode(f.runner.cancel({job_id:started.job_id})).cancel_requested,true);};
  await f.runner.current.promise;const result=decode(f.runner.status({job_id:started.job_id}));assert.equal(result.status,'cancelled');assert.equal(f.world.get(0).properties.powered,'false');assert.equal(result.completed,0);
});

test('another process facade can cancel a persisted active run with a marker',async t=>{
  const f=fixture(t),input=spec();input.cases=input.cases.slice(1);const started=decode(f.runner.start(input));
  f.onSleep=()=>{const other=new TestRunnerService(f.bridge,f.circuits,{stateDir:f.stateDir});other.cancel({job_id:started.job_id});};
  await f.runner.current.promise;assert.equal(decode(f.runner.status({job_id:started.job_id})).status,'cancelled');
});

test('paused native ticks are not replaced by wall time and deadline limits advancing jobs',async t=>{
  const f=fixture(t);f.advance=false;const result=decode(await f.runner.run(spec()));assert.equal(result.status,'aborted');assert.match(result.reason,/ticks stopped/);assert.equal(result.completed,0);
  const g=fixture(t),input=spec();input.timeout_ms=1000;input.settle_ticks=200;input.cases=[input.cases[0]];
  const timeout=decode(await g.runner.run(input));assert.equal(timeout.status,'timed_out');assert.equal(timeout.completed,0);
});

test('changed definitions and clock regressions abort with no further cases',async t=>{
  const f=fixture(t);f.onSleep=()=>{f.circuits.register({...definition,description:'edited'});};
  assert.match(decode(await f.runner.run(spec())).reason,/definition changed/);
  const g=fixture(t);g.onSleep=()=>{g.tick=1;};assert.match(decode(await g.runner.run(spec())).reason,/clock moved backwards/);
});

test('requested finite traces are stopped, drained and discarded with artifacts retained',async t=>{
  const f=fixture(t),input=spec();input.trace=true;const result=decode(await f.runner.run(input));
  assert.equal(result.status,'passed');assert.equal(result.trace.discarded,true);assert.equal(result.trace.gaps,0);
  assert.ok(readFileSync(result.trace.artifact,'utf8').includes('"kind":"discard"'));
  assert.deepEqual(f.calls.filter(c=>c.tool.startsWith('block_watch')).map(c=>c.tool),['block_watch_start','block_watch_stop','block_watch_poll','block_watch_stop']);
});

test('large failure sets stay in local artifacts while summaries are bounded',async t=>{
  const f=fixture(t),input=spec();input.stop_on_failure=false;input.settle_ticks=1;input.cases=Array.from({length:256},(_,i)=>({name:`case${i}`,inputs:{a:false,b:false},expect:{out:1}}));
  const resultReply=await f.runner.run(input),result=decode(resultReply);assert.equal(result.failed,256);assert.equal(result.completed,256);assert.ok(Buffer.byteLength(resultReply.content[0].text)<=8000);assert.equal(result.failures.length,5);assert.equal(result.failures_omitted,251);
  assert.equal(readFileSync(result.artifact,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.kind==='case').length,256);
});

test('process restart marks orphaned work interrupted and preserves input recovery journal',async t=>{
  const f=fixture(t),result=decode(await f.runner.run(spec())),path=join(f.stateDir,'runs',`${result.job_id}.json`),saved=JSON.parse(readFileSync(path,'utf8'));
  saved.status='running';saved.owner_pid=2147483647;writeFileSync(path,JSON.stringify(saved));
  const restarted=new TestRunnerService(f.bridge,f.circuits,{stateDir:f.stateDir}),status=decode(restarted.status({job_id:result.job_id}));assert.equal(status.status,'interrupted');assert.equal(status.restore.status,'unknown_after_interruption');assert.ok(JSON.parse(readFileSync(path,'utf8')).input_journal.length);
});

test('locks cover the entire experiment and cleanup; rejected lock leaves no job',async t=>{
  let locked=false,released=0;const f=fixture(t,{lock:{acquire(){assert.equal(locked,false);locked=true;return()=>{assert.equal(locked,true);locked=false;released++;};}}});
  f.onSleep=()=>assert.equal(locked,true);await f.runner.run(spec());assert.equal(locked,false);assert.equal(released,1);
  const g=fixture(t,{lock:{acquire(){throw Error('busy');}}});assert.throws(()=>g.runner.start(spec()),/busy/);assert.equal(g.runner.jobs.size,0);assert.equal(g.calls.length,0);
});

test('cancellation arriving during a write waits for acknowledgement then restores its uncertain result',async t=>{
  const f=fixture(t),input=spec();input.cases=[input.cases[1]];let release,entered;
  const inside=new Promise(resolve=>{entered=resolve;});
  f.intercept=async(tool,args)=>{if(tool==='block_set_state'&&!release){await new Promise(resolve=>{release=resolve;entered();});f.world.set(args.position.x,structuredClone(args.block));return text('placed minecraft:lever');}};
  const started=decode(f.runner.start(input));await inside;f.runner.cancel({job_id:started.job_id});assert.equal(f.runner.active,started.job_id);release();await f.runner.current.promise;
  const result=decode(f.runner.status({job_id:started.job_id}));assert.equal(result.status,'cancelled');assert.equal(f.world.get(0).properties.powered,'false');assert.equal(result.restore.status,'restored');
});

test('deadline reached during the final observation cannot produce a passing case',async t=>{
  const f=fixture(t),input=spec();input.timeout_ms=1000;input.cases=[input.cases[0]];
  f.intercept=(tool,args)=>{if(tool==='block_get_states_batch'&&args.positions[0].x===10)f.now+=1000;};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'timed_out');assert.equal(result.completed,0);assert.equal(result.passed,0);
});

test('duplicate native rows and persistence failure before a write both fail closed',async t=>{
  const f=fixture(t);f.intercept=tool=>tool==='block_get_states_batch'?reply({atomic:true,session_id:session,server_tick:f.tick,states:[{position:pos(0),status:'loaded',...f.world.get(0)},{position:pos(0),status:'loaded',...f.world.get(0)}]}):undefined;
  assert.match(decode(await f.runner.run(spec())).reason,/duplicate/);assert.equal(writes(f).length,0);
  const g=fixture(t),input=spec();input.cases=[input.cases[1]];const save=g.runner.save.bind(g.runner);let failed=false;
  g.runner.save=job=>{if(!failed&&job.input_journal.some(i=>i.pending_powered!==undefined)){failed=true;throw Error('disk full');}return save(job);};
  const result=decode(await g.runner.run(input));assert.equal(result.status,'aborted');assert.match(result.reason,/disk full/);assert.equal(writes(g).length,0);assert.equal(g.world.get(0).properties.powered,'false');
});

test('an expired trace cannot claim coverage of cases observed after its last sample',async t=>{
  const f=fixture(t),input=spec();input.trace=true;let startedTick;
  f.intercept=(tool)=>{
    if(tool==='block_watch_start')startedTick=f.tick;
    if(tool==='block_watch_poll')return reply({watch_id:watch,session_id:f.session,next_seq:0,latest_seq:0,gap:false,entries:[],last_sample_tick:startedTick+1,active:false,dropped_total:0,end_reason:'duration_reached'});
  };
  const result=decode(await f.runner.run(input));assert.equal(result.passed,4);assert.equal(result.status,'aborted');assert.equal(result.trace.complete,false);assert.equal(result.trace.discarded,true);assert.ok(result.trace.last_tick<result.trace.required_through_tick);assert.match(result.trace.error,/before the final observed/);
});

test('cancellation during successful native trace start still drains and discards the recorder',async t=>{
  const f=fixture(t),input=spec();input.trace=true;
  f.intercept=tool=>{if(tool==='block_watch_start')f.runner.cancel({job_id:f.runner.active});};
  const result=decode(await f.runner.run(input));assert.equal(result.status,'cancelled');assert.equal(result.trace.discarded,true);assert.equal(f.watchActive,false);assert.equal(result.completed,0);assert.equal(writes(f).length,0);
  assert.deepEqual(f.calls.filter(c=>c.tool.startsWith('block_watch')).map(c=>c.tool),['block_watch_start','block_watch_stop','block_watch_poll','block_watch_stop']);
});

test('unknown registered signals cannot contribute a passing case even when unasserted',async t=>{
  const f=fixture(t);f.circuits.register({...definition,signals:[...definition.signals,{name:'missing',position:pos(11),property:'lit'}]});
  const result=decode(await f.runner.run(spec()));assert.equal(result.status,'aborted');assert.equal(result.passed,0);assert.equal(result.failed,1);assert.equal(result.failures[0].pass,false);assert.equal(result.failures[0].unknown,true);
});
