import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AdminService} from './admin-service.mjs';
import {ProjectLock} from './project-lock.mjs';

const session='11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const state=mkdtempSync(join(tmpdir(),'mc-admin-'));
  t.after(()=>rmSync(state,{recursive:true,force:true}));
  const calls=[], status={session_id:session,world_name:'Lab',target_tps:20};
  const bridge={async call(source,tool,args) {calls.push({source,tool,args});return{structuredContent:tool==='server_tick_status'?{...status}:{ok:true}};}};
  const lock=new ProjectLock(state),service=new AdminService(bridge,{stateDir:join(state,'admin'),lock});
  return{state,calls,status,bridge,lock,service};
}
const request={action:'tick',operation:'rate',rate:100,expected_session:session,expected_world:'Lab'};
test('tick writes use server console, explicit identity and shared writer lock',async t=>{
  const f=fixture(t),release=f.lock.acquire('build');
  await assert.rejects(f.service.run(request),/busy/);assert.equal(f.calls.length,0);release();
  await f.service.run(request);
  assert.deepEqual(f.calls.at(-1),{source:'world',tool:'server_tick_control',args:{expected_session:session,rate:100,action:'rate'}});
  assert.equal(f.lock.readOwner(),null);
  assert.deepEqual(readFileSync(join(f.state,'admin','commands.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x).phase),['requested','returned']);
});
test('wrong world or session and mixed tick arguments are rejected before mutation',async t=>{
  const f=fixture(t);
  for(const input of [{...request,expected_world:'Other'},{...request,expected_session:'22222222-2222-4222-8222-222222222222'},{...request,ticks:10},{...request,operation:'unfreeze'}]) await assert.rejects(f.service.run(input));
  assert.ok(f.calls.every(c=>c.tool==='server_tick_status'));
});
test('command text passes intact; failures are journaled without retry and release lock',async t=>{
  const f=fixture(t);const real=f.bridge.call.bind(f.bridge);
  f.bridge.call=async(...args)=>{const r=await real(...args);if(args[1]==='server_admin_command')throw Error('connection ended after dispatch');return r;};
  const input={action:'command',expected_session:session,expected_world:'Lab',command:'data get block 0 64 0'};
  await assert.rejects(f.service.run(input),/ended/);
  assert.equal(f.calls.filter(c=>c.tool==='server_admin_command').length,1);
  assert.equal(f.calls.at(-1).args.command,input.command);assert.equal(f.lock.readOwner(),null);
  assert.match(readFileSync(join(f.state,'admin','commands.jsonl'),'utf8'),/unknown_or_failed/);
});
test('status remains read-only even during a build and cannot sneak command arguments',async t=>{
  const f=fixture(t),release=f.lock.acquire('build');
  const result=JSON.parse((await f.service.run({action:'status'})).content[0].text);
  assert.equal(result.world_name,'Lab');assert.equal(f.lock.readOwner().label,'build');release();
  await assert.rejects(f.service.run({action:'status',command:'tick rate 100'}));
});

function lifecycleFixture(t,{action='quit',polls=['accepted','completed'],active=false,dispatchError=false,wrongId=false,badFinal=false}={}) {
  const f=fixture(t);let time=0,dispatched=false,index=0;
  const request={action,expected_session_id:action==='quit'?session:'none',expected_world:action==='quit'?'Lab':'',...(action==='quit'?{}:{world_name:'New Lab'})};
  const op={operation_id:'33333333-3333-4333-8333-333333333333',action,destination:request.world_name??'',expected_session_id:request.expected_session_id,expected_world:request.expected_world,status:'accepted'};
  f.service.clock=()=>time;f.service.sleep=async ms=>{time+=ms;};f.service.lifecycleTimeoutMs=700;
  f.bridge.call=async(source,tool,args)=>{
    f.calls.push({source,tool,args});
    if(tool==='server_tick_status')return{structuredContent:{...f.status,active_recorders:active}};
    if(tool==='client_lifecycle_status'){
      if(!dispatched)return{structuredContent:{session_id:request.expected_session_id,world_name:request.expected_world,in_game:action==='quit'}};
      const status=polls[Math.min(index++,polls.length-1)];
      const operation={...op,status,...(wrongId?{operation_id:'44444444-4444-4444-8444-444444444444'}:{}),...(status==='completed'&&action!=='quit'?{new_session_id:session}:{})};
      return{structuredContent:status==='completed'?{session_id:action==='quit'?'none':session,world_name:badFinal?'wrong':action==='quit'?'':'New Lab',in_game:action!=='quit',operation}:{session_id:request.expected_session_id,world_name:request.expected_world,in_game:action==='quit',operation}};
    }
    assert.equal(tool,'client_world_'+action);dispatched=true;
    if(dispatchError)throw Error('lost acknowledgement after dispatch');
    return{structuredContent:{...op}};
  };
  return{...f,request,op};
}
test('lifecycle retains shared lease through matching terminal status',async t=>{
  const f=lifecycleFixture(t),original=f.bridge.call;
  f.bridge.call=async(...args)=>{
    assert.equal(f.lock.readOwner()?.label,'client:quit');
    assert.throws(()=>f.lock.acquire('competing build'),/busy/);
    return original(...args);
  };
  const r=JSON.parse((await f.service.client(f.request)).content[0].text);
  assert.equal(r.success,true);assert.equal(r.operation.status,'completed');assert.equal(f.lock.readOwner(),null);
  assert.equal(f.calls.filter(c=>c.tool==='client_world_quit').length,1);
});
test('quit refuses active recorder before dispatch and releases admission lock',async t=>{
  const f=lifecycleFixture(t,{active:true});
  await assert.rejects(f.service.client(f.request),/active native recorders/);
  assert.ok(f.calls.every(c=>!c.tool.startsWith('client_world_')));assert.equal(f.lock.readOwner(),null);
});
test('timeout keeps writer lock and permits read-only status',async t=>{
  const f=lifecycleFixture(t,{polls:['accepted']});
  await assert.rejects(f.service.client(f.request),/Writer lock retained/);
  assert.equal(f.lock.readOwner()?.label,'client:quit');assert.throws(()=>f.lock.acquire('build'),/busy/);
  assert.equal(JSON.parse((await f.service.client({action:'status'})).content[0].text).operation.status,'accepted');
  assert.match(readFileSync(join(f.state,'admin','commands.jsonl'),'utf8'),/lifecycle_lock_retained/);
});
test('lost dispatch acknowledgement is never retried and keeps the lock',async t=>{
  const f=lifecycleFixture(t,{dispatchError:true});
  await assert.rejects(f.service.client(f.request),/Writer lock retained/);
  assert.equal(f.calls.filter(c=>c.tool==='client_world_quit').length,1);assert.ok(f.lock.readOwner());
});
test('changed operation ID cannot release the lifecycle lock',async t=>{
  const f=lifecycleFixture(t,{wrongId:true});
  await assert.rejects(f.service.client(f.request),/identity changed/);assert.ok(f.lock.readOwner());
});
test('native terminal failure is returned explicitly and releases the lease',async t=>{
  const f=lifecycleFixture(t,{polls:['failed']});
  const r=JSON.parse((await f.service.client(f.request)).content[0].text);
  assert.equal(r.success,false);assert.equal(r.operation.status,'failed');assert.equal(f.lock.readOwner(),null);
});
test('completed receipt must agree with actual loaded destination or title',async t=>{
  for(const action of ['quit','create','open']){
    const f=lifecycleFixture(t,{action,polls:['completed'],badFinal:true});
    await assert.rejects(f.service.client(f.request),/actual client world state/);assert.ok(f.lock.readOwner());
  }
});
test('create and open require a matching loaded new-session receipt',async t=>{
  for(const action of ['create','open']){
    const f=lifecycleFixture(t,{action,polls:['loading','completed']});
    const r=JSON.parse((await f.service.client(f.request)).content[0].text);
    assert.equal(r.success,true);assert.equal(r.world_name,'New Lab');assert.equal(f.lock.readOwner(),null);
    assert.ok(!f.calls.some(c=>c.tool==='server_tick_status'));
  }
});
test('identity mismatch and expired admission do not dispatch or strand a lock',async t=>{
  const f=lifecycleFixture(t);await assert.rejects(f.service.client({...f.request,expected_world:'Other'}),/changed before/);
  assert.equal(f.lock.readOwner(),null);assert.ok(!f.calls.some(c=>c.tool==='client_world_quit'));
  const g=lifecycleFixture(t);let reads=0;g.service.clock=()=>reads++===0?0:1000;
  await assert.rejects(g.service.client(g.request),/before dispatch/);assert.equal(g.lock.readOwner(),null);
});
test('failed lifecycle status polling after dispatch retains lock',async t=>{
  const f=lifecycleFixture(t),original=f.bridge.call;let dispatched=false;
  f.bridge.call=async(...args)=>{if(args[1]==='client_lifecycle_status'&&dispatched)throw Error('client busy');const r=await original(...args);if(args[1]==='client_world_quit')dispatched=true;return r;};
  await assert.rejects(f.service.client(f.request),/Writer lock retained/);assert.ok(f.lock.readOwner());
});
