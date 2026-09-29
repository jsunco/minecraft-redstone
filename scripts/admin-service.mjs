import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseReading } from './telemetry-service.mjs';

const guard = {expected_session:z.string().uuid(), expected_world:z.string().min(1).max(200)};
// MCP advertises object schemas; the discriminated unions below enforce each action.
export const adminToolSchema=z.object({action:z.enum(['status','command','tick']),expected_session:guard.expected_session.optional(),expected_world:guard.expected_world.optional(),command:z.string().max(8192).optional(),dimension:z.string().optional(),operation:z.enum(['rate','freeze','unfreeze','step','step_stop','sprint','sprint_stop']).optional(),rate:z.number().min(1).max(10000).optional(),ticks:z.number().int().min(1).max(1000000).optional()}).strict();
export const adminSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('status')}).strict(),
  z.object({action:z.literal('command'), ...guard, command:z.string().min(1).max(8192).refine(v=>!/[\r\n\0]/.test(v),'Use one command.'), dimension:z.string().optional()}).strict(),
  z.object({action:z.literal('tick'), ...guard, operation:z.enum(['rate','freeze','unfreeze','step','step_stop','sprint','sprint_stop']), rate:z.number().min(1).max(10000).optional(), ticks:z.number().int().min(1).max(1000000).optional()}).strict()
]);
const clientGuard={expected_session_id:z.union([z.string().uuid(),z.literal('none')]),expected_world:z.string().max(200)};
const worldName=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/);
export const clientToolSchema=z.object({action:z.enum(['status','options','create','open','quit']),expected_session_id:clientGuard.expected_session_id.optional(),expected_world:clientGuard.expected_world.optional(),world_name:worldName.optional(),render_distance:z.number().int().min(2).max(32).optional(),simulation_distance:z.number().int().min(5).max(32).optional(),max_fps:z.number().int().min(10).max(260).multipleOf(10).optional()}).strict();
export const clientControlSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('status')}).strict(),
  z.object({action:z.literal('options'),...clientGuard,render_distance:z.number().int().min(2).max(32).optional(),simulation_distance:z.number().int().min(5).max(32).optional(),max_fps:z.number().int().min(10).max(260).multipleOf(10).optional()}).strict(),
  z.object({action:z.literal('create'),...clientGuard,world_name:worldName}).strict(),
  z.object({action:z.literal('open'),...clientGuard,world_name:worldName}).strict(),
  z.object({action:z.literal('quit'),...clientGuard}).strict()
]);
const reply = value => ({content:[{type:'text',text:JSON.stringify(value)}]});

/** Native console access. The shared writer lock excludes builds and experiments. */
export class AdminService {
  constructor(bridge,{stateDir,lock,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),lifecycleTimeoutMs=120000}) {
    this.bridge=bridge;this.stateDir=stateDir;this.lock=lock;this.clock=clock;this.sleep=sleep;
    if(!Number.isFinite(lifecycleTimeoutMs)||lifecycleTimeoutMs<=0||lifecycleTimeoutMs>300000)throw new Error('Lifecycle timeout must be positive and at most 300 seconds.');
    this.lifecycleTimeoutMs=lifecycleTimeoutMs;
  }
  journal(value) {
    mkdirSync(this.stateDir,{recursive:true,mode:0o700});
    appendFileSync(join(this.stateDir,'commands.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600});
  }
  async client(input) {
    const {action,...args}=clientControlSchema.parse(input);
    const tools={status:'client_lifecycle_status',options:'client_options_update',create:'client_world_create',open:'client_world_open',quit:'client_world_quit'};
    if(action==='status') return reply(parseReading(await this.bridge.call('client',tools[action],args)));
    if(['create','open','quit'].includes(action))return this.lifecycle(input,action,args,tools[action]);
    return this.lock.withLock('client:'+action,async()=>{
      this.journal({phase:'requested',client_request:input});
      try {
        const result=parseReading(await this.bridge.call('client',tools[action],args));
        this.journal({phase:'returned',client_request:input,result});return reply(result);
      }catch(error){this.journal({phase:'unknown_or_failed',client_request:input,error:String(error.message).slice(0,500)});throw error;}
    });
  }
  async lifecycle(input,action,args,tool) {
    const release=this.lock.acquire('client:'+action),owner=this.lock.readOwner();
    let dispatched=false,terminal=false,operationId=null,beforeOperationId=null;
    const deadline=this.clock()+this.lifecycleTimeoutMs;
    try {
      const before=parseReading(await this.bridge.call('client','client_lifecycle_status',{}));
      if(before.session_id!==args.expected_session_id||before.world_name!==args.expected_world)throw new Error('Client session/save changed before lifecycle dispatch.');
      beforeOperationId=before.operation?.operation_id??null;
      if(action==='quit') {
        const server=parseReading(await this.bridge.call('world','server_tick_status',{}));
        if(server.session_id!==args.expected_session_id||server.active_recorders!==false)throw new Error('Quit requires matching server session and no active native recorders.');
      }
      if(this.clock()>=deadline)throw new Error('Lifecycle admission deadline expired before dispatch.');
      this.journal({phase:'requested',client_request:input,lock_owner:owner,before_operation_id:beforeOperationId});
      dispatched=true;
      const accepted=parseReading(await this.bridge.call('client',tool,args));
      operationId=z.string().uuid().parse(accepted.operation_id);
      if(operationId===beforeOperationId)throw new Error('Lifecycle returned the previous operation identifier.');
      const verify=op=>{
        if(!op||op.operation_id!==operationId||op.action!==action||op.destination!==(args.world_name??'')
          ||op.expected_session_id!==args.expected_session_id||op.expected_world!==args.expected_world
          ||!['accepted','loading','completed','failed'].includes(op.status))throw new Error('Lifecycle operation identity changed or its receipt is malformed.');
      };
      verify(accepted);
      this.journal({phase:'accepted',client_request:input,lock_owner:owner,result:accepted});
      while(this.clock()<deadline) {
        const state=parseReading(await this.bridge.call('client','client_lifecycle_status',{}));
        verify(state.operation);
        if(['completed','failed'].includes(state.operation.status)) {
          if(state.operation.status==='completed' && (action==='quit'
            ?state.session_id!=='none'||state.world_name!==''||state.in_game!==false
            :state.world_name!==args.world_name||state.in_game!==true||!z.string().uuid().safeParse(state.session_id).success||state.operation.new_session_id!==state.session_id))
            throw new Error('Completed lifecycle receipt disagrees with actual client world state.');
          terminal=true;
          const result={...state,success:state.operation.status==='completed'};
          this.journal({phase:'terminal',client_request:input,lock_owner:owner,result});
          return reply(result);
        }
        await this.sleep(Math.min(250,Math.max(1,deadline-this.clock())));
      }
      throw new Error('Lifecycle completion timed out; it may still be running.');
    } catch(error) {
      this.journal({phase:terminal?'terminal_journal_failed':dispatched?'lifecycle_lock_retained':'failed_before_dispatch',client_request:input,
        lock_owner:owner,operation_id:operationId,before_operation_id:beforeOperationId,error:String(error.message).slice(0,500)});
      if(dispatched&&!terminal)throw new Error(`${error.message} Writer lock retained for explicit inspection; do not replay the lifecycle request. Read client status and commands.jsonl.`);
      throw error;
    } finally {
      if(!dispatched||terminal)release();
    }
  }
  async run(input) {
    const args=adminSchema.parse(input);
    if(args.action==='status') return reply(parseReading(await this.bridge.call('world','server_tick_status',{})));
    return this.lock.withLock('admin:'+args.action,async()=>{
      const before=parseReading(await this.bridge.call('world','server_tick_status',{}));
      if(before.session_id!==args.expected_session || before.world_name!==args.expected_world) throw new Error('World/session changed; read admin status and inspect the intended world before retrying.');
      if(args.action==='tick' && ((args.operation==='rate')!==('rate' in args) || (['step','sprint'].includes(args.operation))!==('ticks' in args))) throw new Error('rate needs only rate; step/sprint need only ticks; other operations take neither.');
      const {action,expected_world,operation,...native}=args;
      if(action==='tick') native.action=operation;
      this.journal({phase:'requested',request:args,before});
      try {
        const result=parseReading(await this.bridge.call('world',action==='command'?'server_admin_command':'server_tick_control',native));
        this.journal({phase:'returned',request:args,result});
        return reply(result);
      } catch(error) {
        // A transport failure can occur after execution. Never retry automatically.
        this.journal({phase:'unknown_or_failed',request:args,error:String(error.message).slice(0,500)});
        throw error;
      }
    });
  }
}
