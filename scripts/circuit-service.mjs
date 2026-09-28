import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReading } from './telemetry-service.mjs';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
const position = z.object({x:z.number().int().min(-29999984).max(29999984),y:z.number().int().min(-2048).max(4096),z:z.number().int().min(-29999984).max(29999984)}).strict();
export const circuitSchema = z.object({id,dimension:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/),description:z.string().max(500).default(''),
  signals:z.array(z.object({name:id,position,property:z.enum(['power','powered','lit','open','triggered']),active_value:z.string().max(32).optional()}).strict()).min(1).max(64),
  buses:z.array(z.object({name:id,bits:z.array(id).min(1).max(32)}).strict()).max(16).default([]),
}).strict();
export const circuitObserveSchema = z.object({id,expect:z.record(id,z.number().int().min(0).max(4294967295)).optional()}).strict();
export const circuitTraceSchema = z.object({action:z.enum(['start','poll','stop','discard','status']),id:id.optional(),trace_id:z.string().uuid().optional(),duration_ticks:z.number().int().min(1).max(12000).default(200),max_entries:z.number().int().min(1).max(512).default(128)}).strict();
const rowSchema=z.object({position,status:z.string().min(1).max(64),properties:z.record(z.string(),z.union([z.string().max(256),z.boolean(),z.number().finite()])).default({}),id:z.string().max(256).optional(),index:z.number().int().min(0).max(511).optional()});
const reply = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const key = p => `${p.x},${p.y},${p.z}`;
const own=(value,name)=>Object.hasOwn(value,name);
const integer=(value)=>Number.isSafeInteger(value)&&value>=0;
const payloadBytes=value=>Buffer.byteLength(JSON.stringify(value));
const MAX_REPLY_BYTES=12000;

function definitionFrom(input) {
  const definition=circuitSchema.parse(input),names=new Set();
  for(const signal of definition.signals){if(names.has(signal.name))throw new Error('Duplicate signal name');names.add(signal.name);}
  for(const bus of definition.buses){if(names.has(bus.name))throw new Error('Duplicate bus/signal name');if(bus.bits.some(bit=>!definition.signals.some(s=>s.name===bit))||new Set(bus.bits).size!==bus.bits.length)throw new Error('Bus requires distinct registered signal names');names.add(bus.name);}
  return definition;
}
function validatedRows(definition, rows, complete=false) {
  if(!Array.isArray(rows))throw new Error('Native states must be an array.');
  const expected=new Set(definition.signals.map(s=>key(s.position))),seen=new Set();
  const result=rows.map(raw=>{
    const row=rowSchema.parse(raw),location=key(row.position);
    if(!expected.has(location)||seen.has(location))throw new Error('Native states contain duplicate or unrequested positions.');
    seen.add(location);return row;
  });
  if(complete&&seen.size!==expected.size)throw new Error('Recorder baseline/recovery requires all registered positions.');
  return result;
}
const unknownNames=decoded=>Object.entries(decoded.signals).filter(([,s])=>s.bit===null).map(([name])=>name);
const summarized=decoded=>({signal_bits:Object.fromEntries(Object.entries(decoded.signals).map(([name,s])=>[name,s.bit])),buses:Object.fromEntries(Object.entries(decoded.buses).map(([name,b])=>[name,b.value])),unknown_signals:unknownNames(decoded)});

// Large pages retain their complete native payload in the trace JSONL artifact.
// Trim only presentation, with explicit omission counts; never truncate the baseline.
function boundedReply(value) {
  if(payloadBytes(value)<=MAX_REPLY_BYTES)return reply(value);
  const compact=structuredClone(value);
  compact.summary_compacted=true;
  if(compact.current)compact.current=summarized(compact.current);
  if(compact.initial)compact.initial=summarized(compact.initial);
  if(compact.signals){const summary=summarized(compact);delete compact.signals;delete compact.buses;Object.assign(compact,summary);}
  while(compact.samples?.length&&payloadBytes(compact)>MAX_REPLY_BYTES){compact.samples.pop();compact.samples_omitted=(compact.samples_omitted??0)+1;}
  if(payloadBytes(compact)>MAX_REPLY_BYTES)throw new Error('Circuit summary exceeds 12 KB; use a smaller circuit. Detailed trace data remains in its artifact.');
  return reply(compact);
}

export function decodeCircuit(definition, rows) {
  const byPosition = new Map(rows.map(r=>[key(r.position),r]));
  const signals = Object.create(null), buses = Object.create(null);
  for (const signal of definition.signals) {
    const row=byPosition.get(key(signal.position)), raw=row?.properties?.[signal.property];
    let bit=null;
    if (row?.status==='loaded' && raw!==undefined) {
      if (signal.active_value!==undefined) bit=String(raw)===signal.active_value?1:0;
      else if (signal.property==='power') {if(/^\d+$/.test(String(raw))&&Number(raw)<=15)bit=Number(raw)>0?1:0;}
      else if (raw==='true'||raw===true) bit=1;
      else if (raw==='false'||raw===false) bit=0;
    }
    signals[signal.name]={bit,raw:raw??null,status:row?.status??'missing',...(bit===null?{unknown:true}:{})};
  }
  for (const bus of definition.buses) {
    const bits=bus.bits.map(name=>signals[name]?.bit??null);
    buses[bus.name]={value:bits.includes(null)?null:bits.reduce((v,b,i)=>v+b*2**i,0),bits_lsb_first:bits};
  }
  return {signals,buses};
}

/** Named signal reads and finite server-tick recordings. Never writes world blocks. */
export class CircuitService {
  constructor(bridge,{stateDir=null}={}) {
    this.bridge=bridge;this.stateDir=stateDir;this.definitions=Object.create(null);this.traces=Object.create(null);this.queue=Promise.resolve();
    if (stateDir) {
      mkdirSync(stateDir,{recursive:true,mode:0o700});
      try {
        const saved=JSON.parse(readFileSync(join(stateDir,'circuits.json'),'utf8'));
        if(!saved||typeof saved!=='object'||Object.keys(saved.definitions??{}).length>64||Object.keys(saved.traces??{}).length>128)throw new Error('Invalid saved metadata');
        for(const [name,input]of Object.entries(saved.definitions??{})){const definition=definitionFrom(input);if(name!==definition.id)throw new Error('Circuit identity mismatch');this.definitions[name]=definition;}
        for(const [name,trace]of Object.entries(saved.traces??{})){
          z.string().uuid().parse(name);if(trace.trace_id!==name||!integer(trace.cursor)||!integer(trace.last_tick)||!integer(trace.gaps)||!integer(trace.transitions)||typeof trace.active!=='boolean'||typeof trace.complete!=='boolean')throw new Error('Invalid saved trace');
          z.string().uuid().parse(trace.watch_id);z.string().uuid().parse(trace.session_id);
          trace.definition=definitionFrom(trace.definition);trace.rows=validatedRows(trace.definition,trace.rows,true);this.traces[name]=trace;
        }
      } catch(error) {if(error.code!=='ENOENT') throw new Error('Circuit state cannot be read; preserve and repair circuits.json.');}
    }
  }
  save() {
    if(!this.stateDir)return;
    const target=join(this.stateDir,'circuits.json'),temporary=`${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary,JSON.stringify({definitions:this.definitions,traces:this.traces}),{mode:0o600});renameSync(temporary,target);
  }
  get(id) {if(!own(this.definitions,id))throw new Error('Unknown circuit. Register named signals first.');return this.definitions[id];}
  register(input) {
    const definition=definitionFrom(input);
    if(!own(this.definitions,definition.id)&&Object.keys(this.definitions).length>=64)throw new Error('Circuit limit reached (64).');
    const previous=this.definitions[definition.id];this.definitions[definition.id]=definition;
    try{this.save();}catch(error){if(previous)this.definitions[definition.id]=previous;else delete this.definitions[definition.id];throw error;}
    return reply({registered:definition.id,signals:definition.signals.length,buses:definition.buses.map(b=>({name:b.name,width:b.bits.length})),bit_order:'least significant first'});
  }
  positions(definition) {return [...new Map(definition.signals.map(s=>[key(s.position),s.position])).values()];}
  async observe(input) {
    const args=circuitObserveSchema.parse(input),definition=this.get(args.id);
    for(const [name,expected]of Object.entries(args.expect??{})){
      const signal=definition.signals.find(s=>s.name===name),bus=definition.buses.find(b=>b.name===name);
      if(!signal&&!bus)throw new Error(`Unknown asserted signal/bus: ${name}`);
      if(expected>(bus?2**bus.bits.length-1:1))throw new Error(`Expected value exceeds width of ${name}`);
    }
    const reading=parseReading(await this.bridge.call('world','block_get_states_batch',{dimension:definition.dimension,positions:this.positions(definition),properties:[...new Set(definition.signals.map(s=>s.property))]}));
    if(reading.atomic!==true||typeof reading.session_id!=='string'||!reading.session_id||!integer(reading.server_tick))throw new Error('Native atomic batch unavailable; ordinary polls cannot substitute for same-tick observations.');
    const decoded=decodeCircuit(definition,validatedRows(definition,reading.states));
    const assertions=Object.entries(args.expect??{}).map(([name,expected])=>{const actual=decoded.buses[name]?.value??decoded.signals[name]?.bit??null;return{name,expected,actual,pass:actual!==null&&actual===expected};});
    return boundedReply({id:args.id,session_id:reading.session_id,tick:reading.server_tick,phase:reading.phase,atomic:true,...decoded,...(assertions.length?{assertions,pass:assertions.every(a=>a.pass)}:{})});
  }
  artifact(trace) {return this.stateDir?join(this.stateDir,`${trace.trace_id}.jsonl`):null;}
  record(trace,event) {if(this.stateDir)appendFileSync(this.artifact(trace),JSON.stringify(event)+'\n',{mode:0o600});}
  async trace(input) {
    const args=circuitTraceSchema.parse(input),task=this.queue.then(()=>this.traceOnce(args));
    this.queue=task.catch(()=>{});return task;
  }
  invalidateSession(trace,received) {
    trace.active=false;trace.complete=false;trace.end_reason='session_changed';trace.invalidated=true;
    this.record(trace,{kind:'session_changed',expected:trace.session_id,received});this.save();
  }
  async nativeTraceCall(trace,tool,args) {
    try{return parseReading(await this.bridge.call('world',tool,args));}
    catch(error){
      // A restarted server rejects the old watch before it can return session metadata.
      // Only a separately verified new session invalidates history; a network failure does not.
      let status;
      try{status=parseReading(await this.bridge.call('world','server_get_status',{}));}catch{}
      if(z.string().uuid().safeParse(status?.session_id).success&&status.session_id!==trace.session_id){
        this.invalidateSession(trace,status.session_id);throw new Error('World session changed; trace cannot be continued.');
      }
      throw error;
    }
  }
  ensureSession(trace,reading) {
    if(!z.string().uuid().safeParse(reading.session_id).success)throw new Error('Invalid native recorder session metadata.');
    if(reading.session_id!==trace.session_id){
      this.invalidateSession(trace,reading.session_id);
      throw new Error('World session changed; trace cannot be continued.');
    }
    if(reading.watch_id!==trace.watch_id)throw new Error('Native recorder identity mismatch.');
  }
  async traceOnce(args) {
    if(args.action==='status'){
      const all=Object.values(this.traces);
      return boundedReply({circuits:Object.values(this.definitions).map(d=>({id:d.id,signals:d.signals.length,buses:d.buses.length})),traces:all.slice(-32).map(t=>({trace_id:t.trace_id,circuit:t.definition.id,active:t.active,last_tick:t.last_tick,complete:t.complete,end_reason:t.end_reason,discarded:t.discarded??false})),traces_omitted:Math.max(0,all.length-32),artifact:this.stateDir?join(this.stateDir,'circuits.json'):null});
    }
    if(args.action==='start') {
      if(!args.id)throw new Error('Start requires circuit id.');
      if(Object.keys(this.traces).length>=128)throw new Error('Trace metadata limit reached; archive the local project trace state before recording more.');
      const definition=structuredClone(this.get(args.id));
      const reading=parseReading(await this.bridge.call('world','block_watch_start',{dimension:definition.dimension,positions:this.positions(definition),properties:[...new Set(definition.signals.map(s=>s.property))],duration_ticks:args.duration_ticks,buffer_capacity:1024}));
      z.string().uuid().parse(reading.watch_id);z.string().uuid().parse(reading.session_id);
      if(!integer(reading.next_seq)||reading.next_seq!==0||!integer(reading.started_tick)||reading.active!==true)throw new Error('Invalid native watch response');
      const rows=validatedRows(definition,reading.initial_states,true),decoded=decodeCircuit(definition,rows);
      const trace={trace_id:randomUUID(),watch_id:reading.watch_id,session_id:reading.session_id,definition,rows,cursor:reading.next_seq,last_tick:reading.started_tick,active:true,drained:false,complete:unknownNames(decoded).length===0,gaps:0,transitions:0};
      this.record(trace,{kind:'start',...reading,definition});this.traces[trace.trace_id]=trace;this.save();
      return boundedReply({trace_id:trace.trace_id,circuit:definition.id,start_tick:trace.last_tick,duration_ticks:args.duration_ticks,sampling_phase:reading.sampling_phase,initial:decoded,complete:trace.complete,artifact:this.artifact(trace),limitation:'End-of-tick samples can miss changes occurring entirely within a tick.'});
    }
    const trace=this.traces[args.trace_id];if(!trace)throw new Error('Unknown trace_id');
    if(trace.invalidated)throw new Error('World session changed; start a new trace.');
    if(trace.discarded)return boundedReply({trace_id:trace.trace_id,active:false,discarded:true,complete:trace.complete,last_tick:trace.last_tick,has_more:false,current:decodeCircuit(trace.definition,trace.rows),artifact:this.artifact(trace)});
    if(args.action==='discard'){
      if(trace.active||!trace.drained)throw new Error('Stop or finish the trace, then poll until inactive and fully drained before discarding.');
      if(!this.stateDir)throw new Error('Persistent trace artifacts are required before discarding native evidence.');
      const result=await this.nativeTraceCall(trace,'block_watch_stop',{watch_id:trace.watch_id,discard:true});this.ensureSession(trace,result);
      if(result.discarded!==true||result.active!==false)throw new Error('Native recorder did not confirm discard.');
      this.record(trace,{kind:'discard',...result});trace.discarded=true;this.save();
      return reply({trace_id:trace.trace_id,active:false,discarded:true,artifact:this.artifact(trace),local_history:'preserved'});
    }
    if(args.action==='stop') {
      const result=await this.nativeTraceCall(trace,'block_watch_stop',{watch_id:trace.watch_id,discard:false});
      this.ensureSession(trace,result);
      if(result.active!==false)throw new Error('Native recorder did not confirm stop.');
      trace.active=false;trace.drained=false;trace.end_reason=result.end_reason;this.record(trace,{kind:'stop',...result});this.save();return reply({trace_id:trace.trace_id,active:false,pending_samples:'Poll to retrieve final buffered samples.'});
    }
    const reading=await this.nativeTraceCall(trace,'block_watch_poll',{watch_id:trace.watch_id,after_seq:trace.cursor,max_entries:args.max_entries});
    this.ensureSession(trace,reading);
    if(!integer(reading.next_seq)||!integer(reading.latest_seq)||reading.next_seq<trace.cursor||reading.next_seq>reading.latest_seq||typeof reading.active!=='boolean'||typeof reading.gap!=='boolean'||!Array.isArray(reading.entries)||reading.entries.length>args.max_entries||!integer(reading.last_sample_tick)||!integer(reading.dropped_total))throw new Error('Invalid native recorder page metadata.');
    // Stage the entire page. A bad later entry must never partially advance a baseline.
    const next=structuredClone(trace),samples=[];let changed=0,uncertain=0;
    if(reading.gap) {
      if(reading.entries.length||reading.next_seq!==reading.latest_seq||!integer(reading.recovery_tick)||reading.recovery_tick<trace.last_tick||reading.recovery_tick!==reading.last_sample_tick)throw new Error('Invalid recorder recovery page.');
      next.rows=validatedRows(next.definition,reading.recovery_states,true);next.last_tick=reading.recovery_tick;next.complete=false;next.gaps++;
    } else {
      let cursor=trace.cursor,lastTick=trace.last_tick;
      for(const entry of reading.entries) {
        if(!integer(entry.seq)||entry.seq!==cursor+1||!integer(entry.tick)||entry.tick<lastTick||entry.tick>reading.last_sample_tick||!integer(entry.missed_ticks))throw new Error('Invalid recorder sequence or tick order.');
        cursor=entry.seq;lastTick=entry.tick;
        if(entry.missed_ticks>0){next.complete=false;next.gaps++;}
        const before=decodeCircuit(next.definition,next.rows),merged=new Map(next.rows.map(r=>[key(r.position),r]));
        for(const row of validatedRows(next.definition,entry.states))merged.set(key(row.position),row);
        next.rows=[...merged.values()];
        const after=decodeCircuit(next.definition,next.rows),edges=Object.create(null);
        for(const [name,state]of Object.entries(after.signals))if(state.bit!==before.signals[name].bit){
          const from=before.signals[name].bit,to=state.bit,known=from!==null&&to!==null&&entry.missed_ticks===0;
          edges[name]={from,to,...(known?{}:{unknown:true})};if(known)changed++;else uncertain++;
        }
        if(unknownNames(after).length||unknownNames(before).length)next.complete=false;
        next.last_tick=entry.tick;
        if(samples.length<12)samples.push({tick:entry.tick,edges,buses:Object.fromEntries(Object.entries(after.buses).map(([name,b])=>[name,b.value]))});
      }
      if(cursor!==reading.next_seq)throw new Error('Recorder cursor does not match delivered entries.');
      if(reading.next_seq===reading.latest_seq){if(reading.last_sample_tick<next.last_tick)throw new Error('Recorder clock moved backwards.');next.last_tick=reading.last_sample_tick;}
    }
    next.cursor=reading.next_seq;next.active=reading.active;next.drained=!reading.active&&reading.next_seq===reading.latest_seq;next.end_reason=reading.end_reason;next.transitions+=changed;
    if(reading.end_reason==='clock_reset')next.complete=false;
    this.record(next,{kind:'poll',...reading});this.traces[next.trace_id]=next;
    try{this.save();}catch(error){this.traces[next.trace_id]=trace;throw error;}
    return boundedReply({trace_id:next.trace_id,active:next.active,end_reason:reading.end_reason,next_seq:next.cursor,latest_seq:reading.latest_seq,has_more:next.cursor<reading.latest_seq,last_tick:next.last_tick,complete:next.complete,gaps:next.gaps,dropped_total:reading.dropped_total,transitions_this_poll:changed,transitions_total:next.transitions,uncertain_changes_this_poll:uncertain,samples,samples_omitted:Math.max(0,reading.entries.length-samples.length),current:decodeCircuit(next.definition,next.rows),artifact:this.artifact(next),...(reading.gap?{warning:'Buffer overflow: recovered current state. Missing transitions are unknown.'}:{})});
  }
}
