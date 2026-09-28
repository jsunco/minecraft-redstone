import test from 'node:test';import assert from 'node:assert/strict';
import {ObserverService} from './observer-service.mjs';
const user='11111111-1111-4111-8111-111111111111', observer='22222222-2222-4222-8222-222222222222';
const pose={x:0,y:64,z:0};const structured=value=>({structuredContent:value,content:[]});
function fixture(){
 const calls=[];const client={in_game:true,player_uuid:observer,dimension:'minecraft:overworld',pos:{...pose},yaw:0,pitch:0};
 const userClient={in_game:true,player_uuid:user,dimension:'minecraft:overworld',pos:{...pose},yaw:0,pitch:0};
 const live={uuid:observer,gameMode:'spectator',dimensionId:'minecraft:overworld',position:{...pose}};
 const bridge={async call(source,tool,args){calls.push({source,tool,args});
 if(tool==='client_status')return structured(structuredClone(source==='client'?userClient:client));
 if(tool==='player_get_info')return structured(args.uuid===user?{uuid:user,dimensionId:'minecraft:overworld',position:{...pose}}:live);
 if(tool==='entity_teleport'){live.position={...args.position};return {content:[{type:'text',text:'teleported'}]};}
 if(tool==='view_capture')return {content:[{type:'image',mimeType:'image/png',data:'YQ=='}]};throw Error(tool);}};
 return {calls,client,userClient,live,bridge,service:new ObserverService(bridge)};
}
test('observer refuses user identity and non-spectator avatar before writes',async()=>{
 const {service,calls,live}=fixture();await assert.rejects(service.run({action:'attach',user_uuid:user,observer_uuid:user}));
 live.gameMode='creative';await assert.rejects(service.run({action:'attach',user_uuid:user,observer_uuid:observer}));
 assert.ok(!calls.some(c=>c.tool==='entity_teleport'));
});
test('movement targets only the observer and stale client frames are refused',async()=>{
 const {service,calls,client}=fixture();await service.run({action:'attach',user_uuid:user,observer_uuid:observer});
 await service.run({action:'move',dimension:'minecraft:overworld',position:{x:10,y:64,z:0}});
 assert.equal(calls.find(c=>c.tool==='entity_teleport').args.uuid,observer);
 await assert.rejects(service.run({action:'capture'}),/not reached|does not match/);
 client.pos.x=10;const result=await service.run({action:'capture'});assert.equal(result.content[1].type,'image');
 assert.deepEqual(calls.findLast(c=>c.tool==='view_capture'),{source:'observer',tool:'view_capture',args:{downscale:4,close_screen:false}});
 const count=calls.filter(c=>c.tool==='view_capture').length;await service.run({action:'capture'});assert.equal(calls.filter(c=>c.tool==='view_capture').length,count);
});
test('changed client identity fails closed and detach does not mutate world',async()=>{
 const {service,calls,client}=fixture();await service.run({action:'attach',user_uuid:user,observer_uuid:observer});
 client.player_uuid=user;await assert.rejects(service.run({action:'move',dimension:'minecraft:overworld',position:pose}),/identity/);
 await service.run({action:'detach'});assert.ok(!calls.some(c=>c.tool==='entity_teleport'));
 assert.equal(JSON.parse((await service.run({action:'status'})).content[0].text).attached,false);
});

test('user connected to a different world or location cannot attach an observer',async()=>{
 const {service,userClient,calls}=fixture();userClient.dimension='minecraft:the_nether';
 await assert.rejects(service.run({action:'attach',user_uuid:user,observer_uuid:observer}),/User client\/server/);
 assert.equal(service.attachment,null);assert.ok(!calls.some(c=>c.tool==='entity_teleport'));
});
test('identity or orientation changes during screenshot capture withhold the frame',async()=>{
 const {service,bridge,client}=fixture();await service.run({action:'attach',user_uuid:user,observer_uuid:observer});
 const original=bridge.call.bind(bridge);
 bridge.call=async(...args)=>{const result=await original(...args);if(args[1]==='view_capture')client.yaw=90;return result;};
 await assert.rejects(service.run({action:'capture'}),/changed during capture/);
 assert.equal(service.lastCapture,-Infinity);
});
test('overlapping captures serialize so only one image is requested during cooldown',async()=>{
 const {service,calls}=fixture();await service.run({action:'attach',user_uuid:user,observer_uuid:observer});
 const [first,second]=await Promise.all([service.run({action:'capture'}),service.run({action:'capture'})]);
 assert.equal(first.content[1].type,'image');assert.equal(JSON.parse(second.content[0].text).kind,'rate_limited');
 assert.equal(calls.filter(c=>c.tool==='view_capture').length,1);
});
