import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseCliArgs, readSpec, resolveCliConfig, runCli } from './circuit-test-cli.mjs';
import { ProjectLock } from './project-lock.mjs';
import { CircuitService } from './circuit-service.mjs';
import { TestRunnerService } from './test-runner-service.mjs';
import { createMinecraftServer } from './telemetry-server.mjs';

const unpack = value => JSON.parse(value.content[0].text);
const position = {x:0,y:64,z:0}, output = {x:1,y:64,z:0};
const definition = {id:'lamp',dimension:'minecraft:overworld',signals:[{name:'light',position:output,property:'lit'}],buses:[]};
const spec = {circuit_id:'lamp',inputs:[{name:'switch',position}],settle_ticks:1,cases:[{name:'off',inputs:{switch:false},expect:{light:0}},{name:'on',inputs:{switch:true},expect:{light:1}}]};
const reply = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
function fixture(t) {const root=mkdtempSync(join(tmpdir(),'redstone-cli-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root;}
class Game {
  constructor(){this.powered=false;this.tick=0;this.freeze=false;this.writes=0;}
  async call(source,tool,args){
    if(tool==='block_get_states_batch') return reply({session_id:'58d11b11-5b70-4a1f-b63c-2f25d57162f8',server_tick:this.freeze?this.tick:++this.tick,atomic:true,states:args.positions.map(p=>({position:p,status:'loaded',id:p.x===0?'minecraft:lever':'minecraft:redstone_lamp',properties:p.x===0?{powered:String(this.powered),face:'floor',facing:'north'}:{lit:String(this.powered)}}))});
    if(tool==='block_set_state'){this.writes++;this.powered=args.block.properties.powered==='true';return {content:[{type:'text',text:'placed minecraft:lever'}]};}
    throw new Error(`Unexpected fixture tool ${tool}`);
  }
  async close(){}
}
function seed(root,game){const state=join(root,'.minecraft-assistant');const circuits=new CircuitService(game,{stateDir:join(state,'circuits')});circuits.register(definition);return{state,circuits};}
function factory(game){return config=>{const state=join(config.project,'.minecraft-assistant');const fresh=()=>new CircuitService(game,{stateDir:join(state,'circuits')});const circuits=Object.fromEntries(['get','observe','trace'].map(name=>[name,(...args)=>fresh()[name](...args)]));const runner=new TestRunnerService(game,circuits,{stateDir:join(state,'tests'),lock:new ProjectLock(state),pollIntervalMs:1,stallTimeoutMs:100});return{runner,close:()=>runner.close()};};}

test('CLI enforces bounded JSON, explicit commands, and path-only credential options', t=>{
  const root=fixture(t),file=join(root,'spec.json');writeFileSync(file,JSON.stringify(spec));
  assert.equal(readSpec(file).cases.length,2);
  assert.equal(parseCliArgs(['run','--spec',file]).spec,file);
  for(const args of [['run'],['cancel'],['run','--spec',file,'--token','secret'],['status','--spec',file],['status','--job','bad'],['status','--project',root,'--project',root]])assert.throws(()=>parseCliArgs(args));
  writeFileSync(file,' '.repeat(128*1024+1));assert.throws(()=>readSpec(file),/128 KiB/);
  writeFileSync(file,Buffer.from([0xff]));assert.throws(()=>readSpec(file),/UTF-8 JSON/);
});

test('CLI settings prefer explicit paths then environment; secrets never copied from plugin config', t=>{
  const root=fixture(t);writeFileSync(join(root,'.mcp.json'),JSON.stringify({mcpServers:{minecraft_telemetry:{env:{MINECRAFT_PROJECT_DIR:root,MINECRAFT_MCP_CONFIG_DIR:'/saved',SECRET:'do-not-copy'}}}}));
  assert.deepEqual(resolveCliConfig({}, {root,env:{}}),{project:root,configDir:'/saved'});
  assert.deepEqual(resolveCliConfig({configDir:'/explicit'}, {root,env:{MINECRAFT_PROJECT_DIR:'/project',MINECRAFT_MCP_CONFIG_DIR:'/env'}}),{project:'/project',configDir:'/explicit'});
});

test('shared writer lock rejects overlapping processes/instances and releases after failed work', async t=>{
  const root=fixture(t),first=new ProjectLock(root),second=new ProjectLock(root),release=first.acquire('test');
  assert.throws(()=>second.acquire(),/busy/);release();release();
  await assert.rejects(second.withLock('error',async()=>{throw Error('expected');}),/expected/);
  const again=first.acquire();again();
  mkdirSync(first.path);assert.throws(()=>first.acquire(),/busy/);rmSync(first.path,{recursive:true});
});

test('CLI executes the real engine, reports compact results, and restores changed input', async t=>{
  const root=fixture(t),game=new Game();seed(root,game);const file=join(root,'spec.json');writeFileSync(file,JSON.stringify(spec));let output='',error='';
  const code=await runCli(['run','--spec',file,'--project',root],{root,env:{},runtimeFactory:factory(game),stdout:text=>output+=text,stderr:text=>error+=text});
  const result=JSON.parse(output);assert.equal(code,0,error);assert.equal(result.status,'passed');assert.equal(result.completed,2);assert.equal(game.powered,false);assert.ok(game.writes>=2);assert.ok(result.metrics.response_json_bytes>0);assert.ok(Buffer.byteLength(output)<=8001);
  let summary='';assert.equal(await runCli(['status','--project',root,'--job',result.job_id],{root,env:{},runtimeFactory:factory(game),stdout:text=>summary+=text}),0);assert.equal(JSON.parse(summary).status,'passed');
});

test('CLI validation makes no world calls and failing experiments return exit code 2', async t=>{
  const root=fixture(t),game=new Game();seed(root,game);const file=join(root,'spec.json');writeFileSync(file,JSON.stringify({...spec,cases:[{name:'wrong',inputs:{switch:false},expect:{light:1}}]}));let output='';
  assert.equal(await runCli(['validate','--spec',file,'--project',root],{root,env:{},runtimeFactory:factory(game),stdout:text=>output+=text}),0);assert.equal(game.tick,0);assert.equal(game.writes,0);
  output='';assert.equal(await runCli(['run','--spec',file,'--project',root],{root,env:{},runtimeFactory:factory(game),stdout:text=>output+=text}),2);assert.equal(JSON.parse(output).status,'failed');
});

test('CLI SIGINT cancels engine, waits for cleanup and releases the project lock', async t=>{
  const root=fixture(t),game=new Game();game.freeze=true;const {state}=seed(root,game),signals=new EventEmitter(),file=join(root,'spec.json');writeFileSync(file,JSON.stringify(spec));let output='';
  const run=runCli(['run','--spec',file,'--project',root],{root,env:{},signals,runtimeFactory:factory(game),stdout:text=>output+=text});
  setImmediate(()=>signals.emit('SIGINT'));
  assert.equal(await run,130);assert.equal(JSON.parse(output).status,'cancelled');const release=new ProjectLock(state).acquire();release();assert.equal(signals.listenerCount('SIGINT'),0);
});

test('MCP starts a background experiment; status/cancel remain available and mutations cannot race it', async t=>{
  const root=fixture(t),game=new Game();game.freeze=true;seed(root,game);
  const app=createMinecraftServer({bridge:game,projectDir:root,runnerOptions:{pollIntervalMs:5,stallTimeoutMs:1000}});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const client=new Client({name:'runner-test',version:'1'});
  await app.server.connect(serverTransport);await client.connect(clientTransport);
  try{
    const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='circuit_test'));
    const started=unpack(await client.callTool({name:'circuit_test',arguments:{action:'start',spec}}));assert.equal(started.status,'running');
    const status=unpack(await client.callTool({name:'circuit_test',arguments:{action:'status',job_id:started.job_id}}));assert.equal(status.status,'running');
    const blocked=await client.callTool({name:'circuit_register',arguments:definition});assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/busy/);
    const reconfigure=await client.callTool({name:'telemetry_configure',arguments:{mode:'disabled'}});assert.equal(reconfigure.isError,true);assert.match(reconfigure.content[0].text,/busy/);
    const cancelled=unpack(await client.callTool({name:'circuit_test',arguments:{action:'cancel',job_id:started.job_id}}));assert.equal(cancelled.cancel_requested,true);
    await app.runner.close();assert.equal(unpack(await client.callTool({name:'circuit_test',arguments:{action:'status',job_id:started.job_id}})).status,'cancelled');
  }finally{await client.close();await app.close();}
});


test('MCP disconnection cancels the background job and releases its writer lock', async t=>{
  const root=fixture(t),game=new Game();game.freeze=true;const {state}=seed(root,game);
  const app=createMinecraftServer({bridge:game,projectDir:root,runnerOptions:{pollIntervalMs:1,stallTimeoutMs:1000}});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const client=new Client({name:'disconnect-test',version:'1'});
  await app.server.connect(serverTransport);await client.connect(clientTransport);
  const started=unpack(await client.callTool({name:'circuit_test',arguments:{action:'start',spec}}));
  await client.close();await app.close();
  assert.equal(unpack(app.runner.status({job_id:started.job_id})).status,'cancelled');
  const release=new ProjectLock(state).acquire();release();
});


test('CLI status/close in another facade never cancels the active owner', async t=>{
  const root=fixture(t),game=new Game();game.freeze=true;seed(root,game);
  const owner=factory(game)({project:root});
  const started=unpack(owner.runner.start(spec));
  let output='';
  assert.equal(await runCli(['status','--project',root,'--job',started.job_id],{root,env:{},runtimeFactory:factory(game),stdout:text=>output+=text}),0);
  assert.equal(JSON.parse(output).status,'running');
  assert.equal(owner.runner.active,started.job_id);
  assert.equal(owner.runner.current.cancelled,false);
  await owner.close();
});
