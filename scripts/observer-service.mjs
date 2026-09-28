import { z } from 'zod';
import { parseReading } from './telemetry-service.mjs';
const point = z.object({x:z.number().finite().min(-29999984).max(29999984),y:z.number().finite().min(-2048).max(4096),z:z.number().finite().min(-29999984).max(29999984)}).strict();
export const observerSchema = z.object({
  action:z.enum(['attach','status','move','capture','detach']),
  user_uuid:z.string().uuid().optional(), observer_uuid:z.string().uuid().optional(),
  dimension:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(),
  position:point.optional(), facing:point.optional(),
  downscale:z.number().int().min(2).max(8).default(4),
}).strict();
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const near=(a,b,tolerance=0.2)=>a&&b&&['x','y','z'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=tolerance);
const compactObserver=value=>Object.fromEntries(['player_uuid','dimension','pos','yaw','pitch'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
const sameAngle=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(((a-b+540)%360)-180)<=0.2;

/** Controls only an explicitly attached, distinct spectator client on port 8767. */
export class ObserverService {
  constructor(bridge, {clock=()=>Date.now()}={}) {this.bridge=bridge;this.clock=clock;this.attachment=null;this.lastCapture=-Infinity;this.expectedPose=null;this.queue=Promise.resolve();}
  async inspect(binding=this.attachment) {
    if (!binding) throw new Error('Attach a separate observer client first; the user camera is never substituted.');
    const [user,observer]=await Promise.all(['client','observer'].map(async source=>parseReading(await this.bridge.call(source,'client_status',{}))));
    if (!user.in_game||!observer.in_game) throw new Error('Both user and observer clients must be in game.');
    if (user.player_uuid!==binding.user_uuid || observer.player_uuid!==binding.observer_uuid || user.player_uuid===observer.player_uuid) {
      throw new Error('Player identity mismatch: requires native player_uuid and a distinct observer.');
    }
    const [live,userLive]=await Promise.all([binding.observer_uuid,binding.user_uuid].map(async uuid=>parseReading(await this.bridge.call('world','player_get_info',{uuid}))));
    if (live.uuid!==binding.observer_uuid || live.gameMode!=='spectator') throw new Error('Observer must be an online spectator; the service never changes player game modes.');
    if (live.dimensionId!==observer.dimension || !near(live.position,observer.pos,2)) throw new Error('Observer client/server state does not match; cannot verify shared-world viewpoint.');
    if(userLive.uuid!==binding.user_uuid||userLive.dimensionId!==user.dimension||!near(userLive.position,user.pos,2))throw new Error('User client/server state does not match; cannot verify the selected world.');
    return {user,observer,live};
  }
  async run(input) {
    const args=observerSchema.parse(input),task=this.queue.then(()=>this.runOnce(args));
    this.queue=task.catch(()=>{});return task;
  }
  async runOnce(args) {
    if (args.action==='detach') {this.attachment=null;this.expectedPose=null;return reply({attached:false});}
    if (args.action==='attach') {
      if (!args.user_uuid||!args.observer_uuid||args.user_uuid===args.observer_uuid) throw new Error('Provide two distinct player UUIDs.');
      const binding={user_uuid:args.user_uuid,observer_uuid:args.observer_uuid};
      const inspected=await this.inspect(binding);
      this.attachment=binding;this.expectedPose=null;
      return reply({attached:true,...binding,observer:compactObserver(inspected.observer)});
    }
    if (args.action==='status'&&!this.attachment) return reply({attached:false,requires:'Separate rendered spectator client with client MCP on localhost:8767. No second client is launched automatically.'});
    if(args.action==='capture'&&this.attachment&&this.clock()-this.lastCapture<30000)return reply({kind:'rate_limited',retry_after_ms:30000-(this.clock()-this.lastCapture)});
    const {observer,live}=await this.inspect();
    if (args.action==='status') return reply({attached:true,observer:compactObserver(observer),expected_pose:this.expectedPose});
    if (args.action==='move') {
      if (!args.position||!args.dimension) throw new Error('Move requires dimension and position.');
      const request={uuid:this.attachment.observer_uuid,dimension:args.dimension,position:args.position};
      if (args.facing) request.facing=args.facing;
      this.expectedPose={dimension:args.dimension,position:args.position};
      const result=await this.bridge.call('world','entity_teleport',request);
      if (result.isError || result.content?.[0]?.text!=='teleported') throw new Error('Observer teleport failed or unrecognized result.');
      const verified=parseReading(await this.bridge.call('world','player_get_info',{uuid:this.attachment.observer_uuid}));
      if (verified.uuid!==this.attachment.observer_uuid||verified.gameMode!=='spectator'||verified.dimensionId!==args.dimension||!near(verified.position,args.position)) throw new Error('Observer movement could not be verified.');
      return reply({moved:true,observer_uuid:this.attachment.observer_uuid,position:verified.position,dimension:verified.dimensionId,user_controls:'untouched',render_ready:'Check observer_capture after the client has received chunks.'});
    }
    if (args.action==='capture') {
      if (this.expectedPose&&(observer.dimension!==this.expectedPose.dimension||!near(observer.pos,this.expectedPose.position))) throw new Error('Observer client has not reached the requested pose yet; no stale image returned.');
      if (this.clock()-this.lastCapture<30000) return reply({kind:'rate_limited',retry_after_ms:30000-(this.clock()-this.lastCapture)});
      const result=await this.bridge.call('observer','view_capture',{downscale:args.downscale,close_screen:false});
      const images=result.content?.filter(c=>c.type==='image')??[];
      if (result.isError||images.length!==1||Buffer.byteLength(images[0].data,'base64')>512000) throw new Error('Observer image unavailable/too large; increase downscale.');
      const after=parseReading(await this.bridge.call('observer','client_status',{}));
      if(!after.in_game||after.player_uuid!==this.attachment.observer_uuid||after.dimension!==observer.dimension||!near(after.pos,observer.pos)||!sameAngle(after.yaw,observer.yaw)||!sameAngle(after.pitch,observer.pitch))throw new Error('Observer identity or pose changed during capture; image withheld.');
      this.lastCapture=this.clock();
      return {content:[{type:'text',text:JSON.stringify({viewpoint:'independent_observer',observer_uuid:this.attachment.observer_uuid,dimension:live.dimensionId,position:observer.pos,yaw:observer.yaw,pitch:observer.pitch,captured_at:new Date(this.clock()).toISOString(),chunk_completeness:'not established by a screenshot'})},images[0]]};
    }
  }
}
