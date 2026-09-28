import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReading } from './telemetry-service.mjs';

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
const position = z.object({x:z.number().int().min(-29999984).max(29999984),y:z.number().int().min(-2048).max(4096),z:z.number().int().min(-29999984).max(29999984)}).strict();
export const testRunSchema = z.object({
  circuit_id:name,
  inputs:z.array(z.object({name,position}).strict()).min(1).max(16),
  cases:z.array(z.object({name,inputs:z.record(name,z.boolean()),expect:z.record(name,z.number().int().min(0).max(4294967295))}).strict()).min(1).max(256),
  settle_ticks:z.number().int().min(1).max(200).default(4),
  timeout_ms:z.number().int().min(1000).max(300000).default(60000),
  stop_on_failure:z.boolean().default(true),restore_inputs:z.boolean().default(true),trace:z.boolean().default(false),
}).strict();
export const testJobRefSchema=z.object({job_id:z.string().uuid()}).strict();
export const testStatusSchema=z.object({job_id:z.string().uuid().optional()}).strict();
const terminal=new Set(['passed','failed','cancelled','timed_out','aborted','interrupted']);
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const text=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const key=p=>`${p.x},${p.y},${p.z}`;
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const structure=row=>canonical({id:row.id,...Object.fromEntries(Object.entries(row.properties).filter(([k])=>k!=='powered'))});
const clone=value=>structuredClone(value);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const cleanError=error=>String(error?.message??error).slice(0,240);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const summaryFields=['job_id','circuit_id','status','owner_pid','started_at','finished_at','session_id','completed','total','passed','failed','reason','restore','trace','metrics','artifact','state_artifact','duration_ms'];

/** Finite local experiments. All actual output values come from CircuitService. */
export class TestRunnerService {
  constructor(bridge,circuits,{stateDir=null,lock=null,clock=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pollIntervalMs=50,stallTimeoutMs=5000}={}) {
    this.bridge=bridge;this.circuits=circuits;this.stateDir=stateDir;this.lock=lock;this.clock=clock;this.sleep=sleep;
    this.pollIntervalMs=pollIntervalMs;this.stallTimeoutMs=stallTimeoutMs;this.jobs=new Map();this.current=null;this.closed=false;
    if(stateDir){mkdirSync(join(stateDir,'runs'),{recursive:true,mode:0o700});this.reload();}
  }
  get active(){return this.current?.job.job_id??null;}
  file(id,suffix='json'){return this.stateDir?join(this.stateDir,'runs',`${id}.${suffix}`):null;}
  save(job){
    if(!this.stateDir)return;
    const target=this.file(job.job_id),temp=`${target}.${randomUUID()}.tmp`;
    writeFileSync(temp,JSON.stringify(job),{mode:0o600});renameSync(temp,target);
  }
  record(job,event){if(this.stateDir)appendFileSync(this.file(job.job_id,'jsonl'),JSON.stringify({...event,at:new Date(this.clock()).toISOString()})+'\n',{mode:0o600});}
  reload(){
    if(!this.stateDir)return;
    const files=readdirSync(join(this.stateDir,'runs')).filter(file=>/^[0-9a-f-]{36}\.json$/.test(file));
    if(files.length>128)throw new Error('Test run history exceeds 128 jobs; archive completed artifacts before continuing.');
    for(const file of files){
      let job;
      try{
        const raw=readFileSync(join(this.stateDir,'runs',file),'utf8');if(Buffer.byteLength(raw)>2_000_000)throw Error();job=JSON.parse(raw);
        z.string().uuid().parse(job.job_id);
        if(file!==`${job.job_id}.json`||!['running',...terminal].includes(job.status)||!Number.isInteger(job.owner_pid)||job.owner_pid<=0||!Number.isInteger(job.total)||job.total<1||job.total>256||!Number.isInteger(job.completed)||job.completed<0||job.completed>job.total)throw Error();
      }catch{throw new Error('Test run state cannot be read; preserve and repair the runs directory.');}
      if(job.job_id===this.active)continue;
      if(job.status==='running'&&!alive(job.owner_pid)){
        job.status='interrupted';job.reason='Runner process ended; inputs were not automatically restored. Inspect the saved input journal before recovery.';
        job.finished_at=new Date(this.clock()).toISOString();job.restore={status:'unknown_after_interruption'};this.save(job);
      }
      this.jobs.set(job.job_id,job);
    }
  }
  validate(input){
    const spec=testRunSchema.parse(input),definition=this.circuits.get(spec.circuit_id);
    if(spec.cases.length*spec.settle_ticks>6000)throw new Error('Requested settle time exceeds 6000 server ticks; split the experiment.');
    if(spec.trace&&!this.stateDir)throw new Error('Trace recording requires a persistent state directory.');
    const names=new Set(spec.inputs.map(i=>i.name));
    if(names.size!==spec.inputs.length||new Set(spec.inputs.map(i=>key(i.position))).size!==spec.inputs.length)throw new Error('Input names and positions must be distinct.');
    const caseNames=new Set();
    for(const item of spec.cases){
      if(caseNames.has(item.name))throw new Error('Test case names must be distinct.');caseNames.add(item.name);
      if(Object.keys(item.inputs).length!==names.size||Object.keys(item.inputs).some(n=>!names.has(n)))throw new Error('Every case must explicitly specify every registered input, with no extra names.');
      if(!Object.keys(item.expect).length)throw new Error('Every case requires at least one expected output.');
      for(const [output,value]of Object.entries(item.expect)){
        const signal=definition.signals.find(s=>s.name===output),bus=definition.buses.find(b=>b.name===output);
        if(!signal&&!bus)throw new Error(`Unknown expected output: ${output}`);
        if(value>(bus?2**bus.bits.length-1:1))throw new Error(`Expected value exceeds width of ${output}`);
      }
    }
    return spec;
  }
  describe(job){
    const result=Object.fromEntries(summaryFields.filter(k=>job[k]!==undefined).map(k=>[k,clone(job[k])]));
    result.failures=(job.failures??[]).slice(0,5);result.failures_omitted=Math.max(0,job.failed-result.failures.length);
    result.metrics_note='Logical read/write/observe/trace calls, durations and JSON response bytes at runner boundaries; not token, cost or protocol-wire measurements.';
    result.timing_note='Settling is proven by advancing native server ticks; inputs are applied sequentially, not simultaneously. End-of-tick traces may miss within-tick pulses. The upstream API has no compare-and-set: concurrent edits between a guard read and its write cannot be excluded. The run deadline is checked between bounded bridge calls; a separate 10-second cleanup budget follows, also checked between calls.';
    // State artifacts retain complete failures even when an assertion-rich summary must shrink.
    while(bytes(result)>8000&&result.failures.length){result.failures.pop();result.failures_omitted++;}
    return result;
  }
  start(input){
    if(this.closed)throw new Error('Test runner is closed.');
    if(this.current)throw new Error('A test run is already active. Cancel or finish it first.');
    this.validate(input);
    const release=this.lock?.acquire('circuit_test')??(()=>{});
    try{
      this.reload();
      if(this.jobs.size>=128)throw new Error('Test run history limit reached (128); archive completed artifacts.');
      const spec=this.validate(input),definition=clone(this.circuits.get(spec.circuit_id)),job_id=randomUUID();
      const job={job_id,circuit_id:spec.circuit_id,status:'running',owner_pid:process.pid,started_at:new Date(this.clock()).toISOString(),completed:0,total:spec.cases.length,passed:0,failed:0,failures:[],spec,definition,input_journal:[],restore:{status:'pending'},metrics:{input_reads:0,input_writes:0,circuit_observations:0,trace_operations:0,response_json_bytes:0,poll_sleeps:0},artifact:this.file(job_id,'jsonl'),state_artifact:this.file(job_id)};
      this.record(job,{kind:'start',spec,definition});this.save(job);this.jobs.set(job_id,job);
      const context={job,release,cancelled:false,started:this.clock(),lastTick:null,lastProgress:this.clock(),definitionText:JSON.stringify(definition)};
      this.current=context;
      context.promise=Promise.resolve().then(()=>this.execute(context)).finally(()=>{release();if(this.current===context)this.current=null;});
      // start() deliberately returns before the first network operation. Retain failures for run/status.
      context.promise.catch(()=>{});
      return text(this.describe(job));
    }catch(error){release();throw error;}
  }
  async run(input){const started=parseReading(this.start(input)),context=this.current;await context.promise;return this.status({job_id:started.job_id});}
  status(input={}){
    const {job_id}=testStatusSchema.parse(input);this.reload();
    if(job_id){const job=this.jobs.get(job_id);if(!job)throw new Error('Unknown test job.');return text(this.describe(job));}
    const jobs=[...this.jobs.values()].sort((a,b)=>b.started_at.localeCompare(a.started_at));
    return text({active_job:this.active,jobs:jobs.slice(0,16).map(j=>({job_id:j.job_id,circuit_id:j.circuit_id,status:j.status,completed:j.completed,total:j.total,passed:j.passed,failed:j.failed,started_at:j.started_at})),omitted:Math.max(0,jobs.length-16)});
  }
  cancel(input){
    const {job_id}=testJobRefSchema.parse(input);this.reload();const job=this.jobs.get(job_id);if(!job)throw new Error('Unknown test job.');
    if(terminal.has(job.status))return text({job_id,status:job.status,cancel_requested:false});
    if(this.current?.job.job_id===job_id)this.current.cancelled=true;
    if(this.stateDir)writeFileSync(this.file(job_id,'cancel'),'cancel\n',{mode:0o600});
    else if(this.current?.job.job_id!==job_id)throw new Error('Job cancellation requires its owning process or persistent state.');
    return text({job_id,status:job.status,cancel_requested:true});
  }
  async close(){this.closed=true;if(this.current){this.current.cancelled=true;await this.current.promise;}}
  guard(context,{cleanup=false}={}){
    if(cleanup){if(context.cleanupStarted!==undefined&&this.clock()-context.cleanupStarted>=10000)throw fail('cleanup_timeout','Cleanup budget exhausted; inspect the saved journal and trace before recovery.');return;}
    if(context.cancelled||(this.stateDir&&existsSync(this.file(context.job.job_id,'cancel'))))throw fail('cancelled','Cancellation requested.');
    if(this.clock()-context.started>=context.job.spec.timeout_ms)throw fail('timed_out','Experiment deadline reached.');
    if(JSON.stringify(this.circuits.get(context.job.circuit_id))!==context.definitionText)throw fail('definition_changed','Circuit definition changed during the experiment.');
  }
  acceptTick(context,session,tick){
    if(typeof session!=='string'||!session||!Number.isSafeInteger(tick)||tick<0)throw fail('invalid_read','Missing native session/tick metadata.');
    if(context.job.session_id&&context.job.session_id!==session)throw fail('session_changed','World session changed; no more input writes are allowed.');
    context.job.session_id=session;
    if(context.lastTick!==null&&tick<context.lastTick)throw fail('clock_reset','Native server clock moved backwards.');
    if(context.lastTick===null||tick>context.lastTick)context.lastProgress=this.clock();
    context.lastTick=tick;
  }
  async invoke(context,metric,action,{cleanup=false,onResult=null}={}){
    this.guard(context,{cleanup});context.job.metrics[metric]++;
    const began=this.clock();
    try{const result=await action();context.job.metrics.response_json_bytes+=bytes(result);onResult?.(result);this.guard(context,{cleanup});return result;}
    finally{const duration=Math.max(0,this.clock()-began),timings=context.job.metrics.latency_ms??={};const entry=timings[metric]??={count:0,total:0,max:0};entry.count++;entry.total+=duration;entry.max=Math.max(entry.max,duration);}
  }
  async readInputs(context,{cleanup=false,allowInvalid=false}={}){
    const job=context.job,reading=parseReading(await this.invoke(context,'input_reads',()=>this.bridge.call('world','block_get_states_batch',{dimension:job.definition.dimension,positions:job.spec.inputs.map(i=>i.position),properties:[]}),{cleanup}));
    if(reading.atomic!==true)throw fail('invalid_read','Input read is not atomic.');
    this.acceptTick(context,reading.session_id,reading.server_tick);
    if(!Array.isArray(reading.states)||reading.states.length!==job.spec.inputs.length)throw fail('invalid_read','Input batch is incomplete.');
    const expected=new Map(job.spec.inputs.map(i=>[key(i.position),i])),seen=new Set(),rows=new Map();
    for(const row of reading.states){
      const location=row.position&&key(row.position),input=expected.get(location);
      if(!input||seen.has(location))throw fail('invalid_read','Input batch includes duplicate or unexpected positions.');seen.add(location);
      if(!allowInvalid&&(row.status!=='loaded'||row.id!=='minecraft:lever'||!row.properties||!['true','false',true,false].includes(row.properties.powered)||!['floor','wall','ceiling'].includes(row.properties.face)||!['north','south','east','west'].includes(row.properties.facing)||Object.entries(row.properties).some(([k,v])=>!(/^[a-z0-9_]{1,32}$/.test(k)&&/^[a-z0-9_]{1,32}$/.test(String(v))))))throw fail('invalid_input',`Input ${input.name} is not a loaded vanilla lever with valid state.`);
      rows.set(input.name,{id:row.id,position:clone(row.position),properties:Object.fromEntries(Object.entries(row.properties??{}).map(([k,v])=>[k,String(v)]))});
    }
    return rows;
  }
  ensureUnchanged(context,rows){
    for(const item of context.job.input_journal){
      const row=rows.get(item.name);
      if(structure(row)!==structure(item.original)||row.properties.powered!==item.expected_powered)throw fail('input_conflict',`Input ${item.name} changed outside this run; refusing to overwrite it.`);
    }
  }
  async writeInput(context,item,powered,{cleanup=false}={}){
    const job=context.job,previous=item.expected_powered,desired=String(powered);
    if(previous===desired)return;
    item.pending_powered=desired;this.save(job);this.record(job,{kind:'input_write_pending',name:item.name,previous,desired});
    const result=await this.invoke(context,'input_writes',()=>this.bridge.call('world','block_set_state',{dimension:job.definition.dimension,position:item.original.position,block:{id:'minecraft:lever',properties:{...item.original.properties,powered:desired}},update_flags:3}),{cleanup});
    const answer=result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(result?.isError||!answer||!/^(placed minecraft:lever|no change)$/.test(answer))throw fail('write_failed',`Lever write for ${item.name} was not acknowledged.`);
    item.expected_powered=desired;item.touched=true;delete item.pending_powered;this.save(job);
  }
  async observe(context,expect){
    const reading=parseReading(await this.invoke(context,'circuit_observations',()=>this.circuits.observe({id:context.job.circuit_id,expect})));
    if(reading.atomic!==true)throw fail('invalid_read','Circuit observation is not atomic.');
    this.acceptTick(context,reading.session_id,reading.tick);
    if(context.job.trace)context.job.trace.required_through_tick=reading.tick;
    return reading;
  }
  async settle(context,startTick,expect){
    const target=startTick+context.job.spec.settle_ticks;
    while(true){
      this.guard(context);
      // A pause here only paces requests. The native tick below is the settling evidence.
      const remaining=Math.max(1,target-(context.lastTick??startTick));
      context.job.metrics.poll_sleeps++;await this.sleep(Math.max(this.pollIntervalMs,Math.min(250,remaining*50)));
      const reading=await this.observe(context,expect);
      if(reading.tick>=target)return reading;
      if(this.clock()-context.lastProgress>=this.stallTimeoutMs)throw fail('ticks_stalled','Native server ticks stopped advancing; resume the world and retry.');
    }
  }
  async traceCall(context,args,cleanup=false,onResult=null){return parseReading(await this.invoke(context,'trace_operations',()=>this.circuits.trace(args),{cleanup,onResult:onResult?result=>onResult(parseReading(result)):null}));}
  async finishTrace(context){
    const job=context.job;if(!job.trace?.trace_id)return;
    try{
      await this.traceCall(context,{action:'stop',trace_id:job.trace.trace_id},true);
      let page;
      for(let i=0;i<8;i++){
        page=await this.traceCall(context,{action:'poll',trace_id:job.trace.trace_id,max_entries:512},true);
        job.trace={...job.trace,complete:page.complete,gaps:page.gaps??0,artifact:page.artifact,active:page.active,has_more:page.has_more,last_tick:page.last_tick,end_reason:page.end_reason};
        if(!page.has_more&&!page.active)break;
      }
      if(page?.has_more||page?.active)throw Error('Trace did not fully drain within eight pages.');
      if(page.last_tick<job.trace.required_through_tick){job.trace.complete=false;job.trace.error='Trace ended before the final observed test tick; later execution was not recorded.';}
      await this.traceCall(context,{action:'discard',trace_id:job.trace.trace_id},true);job.trace.discarded=true;
    }catch(error){job.trace.error=cleanError(error);job.trace.complete=false;}
  }
  async restore(context){
    const job=context.job,details=[];
    if(!job.spec.restore_inputs){job.restore={status:'disabled'};return;}
    if(!job.input_journal.length){job.restore={status:'not_needed'};return;}
    const restoreStarted=this.clock();
    for(const item of job.input_journal){
      if(!item.touched&&item.pending_powered===undefined)continue;
      try{
        if(this.clock()-restoreStarted>=10000)throw Error('Restoration cleanup budget exhausted; inspect saved input journal.');
        const rows=await this.readInputs(context,{cleanup:true,allowInvalid:true}),row=rows.get(item.name);
        if(structure(row)!==structure(item.original)||![item.expected_powered,item.pending_powered].includes(row.properties.powered))throw Error('Input changed concurrently; restoration skipped.');
        item.expected_powered=row.properties.powered;delete item.pending_powered;
        await this.writeInput(context,item,item.original.properties.powered,{cleanup:true});
        const after=(await this.readInputs(context,{cleanup:true,allowInvalid:true})).get(item.name);
        if(canonical(after.properties)!==canonical(item.original.properties)||after.id!==item.original.id)throw Error('Restored input did not match original readback.');
        details.push({name:item.name,status:'restored'});
      }catch(error){details.push({name:item.name,status:'skipped',reason:cleanError(error)});}
    }
    job.restore={status:details.some(d=>d.status==='skipped')?'incomplete':'restored',inputs:details};
  }
  async execute(context){
    const job=context.job;
    try{
      this.guard(context);
      const originals=await this.readInputs(context);
      job.input_journal=job.spec.inputs.map(input=>({name:input.name,original:originals.get(input.name),expected_powered:originals.get(input.name).properties.powered,touched:false}));
      this.save(job);this.record(job,{kind:'input_baseline',session_id:job.session_id,tick:context.lastTick,inputs:job.input_journal});
      if(job.spec.trace){
        await this.traceCall(context,{action:'start',id:job.circuit_id,duration_ticks:Math.min(12000,Math.ceil(job.spec.timeout_ms/50)+200)},false,trace=>{
          // Keep recorder identity before a post-response cancellation/deadline check can throw.
          job.trace={trace_id:trace.trace_id,artifact:trace.artifact,complete:trace.complete,required_through_tick:trace.start_tick};this.save(job);
        });
      }
      for(const item of job.spec.cases){
        this.guard(context);const began=this.clock();
        this.ensureUnchanged(context,await this.readInputs(context));
        for(const input of job.input_journal){
          if(input.expected_powered===String(item.inputs[input.name]))continue;
          // Guard each sequential write, including session and orientation, rather than relying on a stale case baseline.
          this.ensureUnchanged(context,await this.readInputs(context));
          await this.writeInput(context,input,item.inputs[input.name]);
        }
        const applied=await this.readInputs(context);this.ensureUnchanged(context,applied);const startTick=context.lastTick;
        const reading=await this.settle(context,startTick,item.expect);
        this.ensureUnchanged(context,await this.readInputs(context));
        const assertions=Object.entries(item.expect).map(([name,expected])=>{
          const actual=(typeof reading.buses?.[name]==='number'?reading.buses[name]:reading.buses?.[name]?.value)??reading.signals?.[name]?.bit??reading.signal_bits?.[name]??null;
          return{name,expected,actual,pass:Number.isInteger(actual)&&actual===expected};
        });
        const unknown=assertions.some(a=>a.actual===null)||(reading.unknown_signals?.length??0)>0||Object.values(reading.signals??{}).some(s=>s.bit===null),passed=!unknown&&assertions.every(a=>a.pass);
        const result={name:item.name,inputs:item.inputs,assertions,pass:passed,unknown,start_tick:startTick,end_tick:reading.tick,settled_ticks:reading.tick-startTick,duration_ms:this.clock()-began};
        this.record(job,{kind:'case',...result,observation:reading});job.completed++;
        if(passed)job.passed++;else{job.failed++;job.failures.push(result);}
        this.save(job);
        if(unknown)throw fail('unknown_output','An asserted output is unavailable; remaining cases were not executed.');
        if(!passed&&job.spec.stop_on_failure)break;
      }
      this.guard(context);job.status=job.failed?'failed':'passed';
    }catch(error){job.status=error.code==='cancelled'?'cancelled':error.code==='timed_out'?'timed_out':'aborted';job.reason=cleanError(error);this.record(job,{kind:'error',code:error.code??'error',reason:job.reason});}
    finally{
      // Cancellation stops new cases, but cleanup still attempts conflict-checked restoration.
      context.cleanupStarted=this.clock();
      try{await this.restore(context);}catch(error){job.restore={status:'incomplete',reason:cleanError(error)};}
      await this.finishTrace(context);
      if(job.status==='passed'&&(job.restore.status==='incomplete'||job.trace?.complete===false)){job.status='aborted';job.reason=job.restore.status==='incomplete'?'Cases passed but input restoration was incomplete.':'Cases passed but the requested trace has incomplete coverage.';}
      job.finished_at=new Date(this.clock()).toISOString();job.duration_ms=this.clock()-context.started;
      this.record(job,{kind:'finish',summary:this.describe(job)});this.save(job);
      if(this.stateDir){try{unlinkSync(this.file(job.job_id,'cancel'));}catch(error){if(error.code!=='ENOENT')throw error;}}
    }
  }
}
