import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge,bridgeHeaders} from './telemetry-service.mjs';

const tokens={world:'fixture-world-secret-123456',client:'fixture-client-secret-123456',observer:'fixture-observer-secret-123456'};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'minecraft-auth-'));
 const paths={world:join(dir,'config.json'),client:join(dir,'client.json'),observer:join(dir,'observer.json')};
 for(const source of Object.keys(paths))writeFileSync(paths[source],JSON.stringify({auth_required:true,bearer_token:tokens[source]}),{mode:0o600});
 return{dir,paths,env:{MINECRAFT_MCP_CONFIG_DIR:dir,MINECRAFT_OBSERVER_CONFIG:paths.observer},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('credential headers are source-specific and observer never inherits the player client token',()=>{
 const f=fixture();try{
  for(const source of ['world','client','observer'])assert.deepEqual(bridgeHeaders(source,f.env),{Authorization:`Bearer ${tokens[source]}`});
  assert.deepEqual(bridgeHeaders('observer',{MINECRAFT_MCP_CONFIG_DIR:f.dir}),{});
  assert.deepEqual(bridgeHeaders('world',{}),{});
  writeFileSync(f.paths.client,JSON.stringify({auth_required:false,bearer_token:tokens.client}));assert.deepEqual(bridgeHeaders('client',f.env),{});
 }finally{f.cleanup();}
});

test('configured missing, malformed or invalid credentials fail closed without exposing token contents',()=>{
 const f=fixture();try{
  const invalid=[null,{},[],{auth_required:'false',bearer_token:tokens.world},{auth_required:true},{auth_required:true,bearer_token:'short'},
   {auth_required:true,bearer_token:tokens.world+'\r\nX-Leak: value'}];
  for(const config of invalid){writeFileSync(f.paths.world,JSON.stringify(config));assert.throws(()=>bridgeHeaders('world',f.env),error=>/credential/.test(error.message)&&!error.message.includes(tokens.world));}
  writeFileSync(f.paths.world,`{"bearer_token":"${tokens.world}",BAD`);
  assert.throws(()=>bridgeHeaders('world',f.env),error=>!error.message.includes(tokens.world)&&/unavailable or invalid/.test(error.message));
  writeFileSync(f.paths.world,JSON.stringify({auth_required:true,bearer_token:tokens.world,padding:'x'.repeat(65536)}));
  assert.throws(()=>bridgeHeaders('world',f.env),/unavailable or invalid/);
  rmSync(f.paths.world);assert.throws(()=>bridgeHeaders('world',f.env),/unavailable or invalid/);
 }finally{f.cleanup();}
});

test('missing configured credentials prevent transport creation and game calls',async()=>{
 const f=fixture();let transports=0,connections=0;
 try{
  rmSync(f.paths.world);
  const bridge=new Bridge(undefined,{headersProvider:source=>bridgeHeaders(source,f.env),transportFactory:()=>{transports++;return{};},clientFactory:()=>({connect:async()=>{connections++;},close:async()=>{}})});
  await assert.rejects(bridge.call('world','server_get_status',{}),error=>/credential/.test(error.message)&&!Object.values(tokens).some(token=>error.message.includes(token)));
  assert.equal(transports,0);assert.equal(connections,0);assert.equal(bridge.clients.size,0);await bridge.close();
 }finally{f.cleanup();}
});

test('real MCP transport sends each token only as its endpoint Authorization header',async()=>{
 const f=fixture(),seen=[];
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  seen.push({url:req.url,authorization:req.headers.authorization,body});
  const message=JSON.parse(body);
  if(!Object.hasOwn(message,'id')){res.writeHead(202);res.end();return;}
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(message.method==='tools/call')result={content:[{type:'text',text:'{"ready":true}'}]};
  else{res.writeHead(400);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const bridge=new Bridge(Object.fromEntries(Object.keys(tokens).map(source=>[source,`${base}/${source}`])),{headersProvider:source=>bridgeHeaders(source,f.env)});
 try{
  for(const source of Object.keys(tokens)){
   const result=await bridge.call(source,source==='world'?'server_get_status':'client_status',{});
   assert.ok(!Object.values(tokens).some(token=>JSON.stringify(result).includes(token)));
  }
  for(const request of seen){const source=request.url.slice(1);assert.equal(request.authorization,`Bearer ${tokens[source]}`);assert.ok(!Object.values(tokens).some(token=>request.body.includes(token)||request.url.includes(token)));}
  assert.equal(seen.filter(r=>JSON.parse(r.body).method==='tools/call').length,3);
 }finally{await bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test('invalid bearer header bytes are rejected generically before transport can echo a secret',async()=>{
 const f=fixture();let transports=0;
 try{
  for(const suffix of ['\u0000suffix','\tvalue',' value','é','界','"']){
   const secret=tokens.world+suffix;writeFileSync(f.paths.world,JSON.stringify({auth_required:true,bearer_token:secret}));
   const bridge=new Bridge(undefined,{headersProvider:source=>bridgeHeaders(source,f.env),transportFactory:()=>{transports++;throw new Error('must not build transport');},clientFactory:()=>({connect:async()=>{},close:async()=>{}})});
   await assert.rejects(bridge.get('world'),error=>error.message==='Local bridge credential is missing or invalid.'&&!error.message.includes(tokens.world));
  }
  assert.equal(transports,0);
 }finally{f.cleanup();}
});
