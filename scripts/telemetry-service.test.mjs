import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { TelemetryService, parseReading, Bridge } from './telemetry-service.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const decoded = r => JSON.parse(r.content[0].text);
class FakeBridge {
  constructor() { this.calls = []; this.value = {position: {x: 0, y: 64, z: 0}, properties: {power: 0}}; }
  async call(source, tool, args) {
    this.calls.push({source, tool, args});
    if (this.error) throw new Error(this.error);
    if (tool === 'view_capture') return {content: [{type: 'image', mimeType: 'image/png', data: 'YQ=='}]};
    return {content: [{type: 'text', text: JSON.stringify(this.value)}]};
  }
  async close() {}
  async schema(source, tool) { return {name: tool, inputSchema: {type: 'object'}}; }
}
const watches = [{id: 'player', source: 'client', tool: 'client_status', fields: ['position']}];
function setup() {
  let now = 100000; const bridge = new FakeBridge(); const service = new TelemetryService(bridge, () => now);
  return {bridge, service, advance: (ms = 10000) => { now += ms; }};
}

test('disabled mode has zero world reads; data mode cannot capture screenshots', async () => {
  const {service, bridge} = setup();
  assert.equal(decoded(await service.poll()).mode, 'disabled');
  await service.view(); assert.equal(bridge.calls.length, 0);
  await service.configure({mode: 'data', watches});
  await service.view(); assert.equal(bridge.calls.length, 0);
});

test('TOON upstream object/tabular/expanded forms decode with strict lengths', () => {
  const parse = text => parseReading({content: [{type: 'text', text}]});
  assert.deepEqual(parse('position:\n  x: 1.25\n  y: 64\n  z: -2'), {position: {x: 1.25, y: 64, z: -2}});
  assert.deepEqual(parse('slots[2]{id,count}:\n  "minecraft:stone",64\n  "minecraft:air",0'),
    {slots: [{id: 'minecraft:stone', count: 64}, {id: 'minecraft:air', count: 0}]});
  assert.deepEqual(parse('items[1]:\n  - slot: 0\n    item:\n      id: "minecraft:lever"'), {items: [{slot: 0, item: {id: 'minecraft:lever'}}]});
  assert.throws(() => parse('slots[2]{id,count}:\n  stone,1'));
  assert.throws(() => parse('not connected'));
  assert.throws(() => parseReading({isError: true, content: [{type: 'text', text: 'missing player'}]}));
});

test('successive polls yield snapshot, unchanged, exact delta; full resync restores baseline', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', watches});
  assert.equal(decoded(await service.poll()).samples[0].kind, 'snapshot');
  assert.equal(decoded(await service.poll()).kind, 'rate_limited');
  advance(); assert.equal(decoded(await service.poll()).samples[0].kind, 'unchanged');
  bridge.value.position.x = 0.03125;
  advance(); const change = decoded(await service.poll());
  assert.equal(change.samples[0].kind, 'delta');
  assert.match(JSON.stringify(change), /0\.03125/);
  advance(); assert.equal(decoded(await service.poll({full: true})).samples[0].kind, 'snapshot');
  advance(60001); assert.equal(decoded(await service.poll()).resync, true);
});

test('failed reads are unavailable, not unchanged or stale; recovery gets full snapshot', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', watches}); await service.poll();
  bridge.error = 'world disconnected'; advance();
  assert.equal(decoded(await service.poll()).samples[0].kind, 'unavailable');
  bridge.error = null; advance();
  assert.equal(decoded(await service.poll()).samples[0].kind, 'snapshot');
});

test('argument validation blocks mutations, duplicate IDs and large region scans', async () => {
  const {service, bridge} = setup();
  await assert.rejects(service.configure({mode: 'data', watches: [{...watches[0], tool: 'entity_teleport'}]}));
  await assert.rejects(service.configure({mode: 'data', watches: [...watches, ...watches]}));
  await assert.rejects(service.configure({mode: 'data', watches: [{id:'scan',source:'world',tool:'block_scan_summary',arguments:{box:{from:{x:0,y:0,z:0},to:{x:1000,y:1000,z:1000}}}}]}));
  assert.equal(bridge.calls.length, 0);
});

test('total text output is capped and an oversize snapshot can be retried safely', async () => {
  const {service, bridge, advance} = setup();
  bridge.value = {position: {very_long: '界'.repeat(10000)}};
  await service.configure({mode: 'data', watches, max_text_bytes: 2048});
  const result = await service.poll();
  assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
  assert.equal(decoded(result).samples[0].kind, 'oversize');
  bridge.value = {position: {x: 1}}; advance();
  assert.equal(decoded(await service.poll()).samples[0].kind, 'snapshot');
});

test('hybrid screenshots are explicit, reduced, cooldown-limited and preserve GUI', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'hybrid', watches}); await service.poll();
  assert.equal(bridge.calls.filter(x => x.tool === 'view_capture').length, 0);
  const result = await service.view(); assert.equal(result.content[1].type, 'image');
  assert.deepEqual(bridge.calls.at(-1).args, {downscale: 4, close_screen: false});
  await service.view(); assert.equal(bridge.calls.filter(x => x.tool === 'view_capture').length, 1);
  advance(30000); await service.view(); assert.equal(bridge.calls.filter(x => x.tool === 'view_capture').length, 2);
  await service.configure({mode: 'disabled'}); await service.poll();
  assert.equal(bridge.calls.filter(x => x.tool === 'view_capture').length, 2);
});

test('real MCP stdio handshake, schemas, validation and default-disabled poll', async () => {
  const transport = new StdioClientTransport({command: process.execPath,
    args: [fileURLToPath(new URL('./telemetry-server.mjs', import.meta.url))], stderr: 'pipe'});
  const client = new Client({name: 'telemetry-test', version: '1.0.0'});
  try {
    await client.connect(transport);
    const listed = await client.listTools(); assert.equal(listed.tools.length, 5);
    const status = decoded(await client.callTool({name: 'telemetry_status', arguments: {}}));
    assert.equal(status.mode, 'disabled');
    assert.equal(decoded(await client.callTool({name: 'telemetry_poll', arguments: {}})).mode, 'disabled');
    const invalid = await client.callTool({name: 'telemetry_configure', arguments: {mode: 'bad'}});
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});


test('MCP HTTP bridge negotiates a session and decodes real TOON-shaped replies', async () => {
  const seen = [];
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); seen.push(message);
    if (!Object.hasOwn(message, 'id')) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === 'initialize') result = {protocolVersion: '2025-06-18', capabilities: {tools:{}}, serverInfo:{name:'fixture',version:'1'}};
    else if (message.method === 'tools/list') result = {tools:[{name:'client_status',inputSchema:{type:'object'}}]};
    else if (message.method === 'tools/call') result = {content:[{type:'text',text:'position:\n  x: 7.25\n  y: 64\n  z: 2'}]};
    else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0', id:message.id, result}));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  const bridge = new Bridge({client:url,world:url});
  try {
    assert.equal((await bridge.schema('client','client_status')).name, 'client_status');
    assert.equal(parseReading(await bridge.call('client','client_status',{})).position.x, 7.25);
    assert.equal(seen.filter(m=>m.method==='initialize').length, 1);
  } finally { await bridge.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
});

test('unknown field selection is unavailable and per-endpoint polling is bounded', async () => {
  const {service} = setup();
  await service.configure({mode:'data', min_poll_ms:500, watches:[{...watches[0], fields:['unknown']}]});
  assert.equal(service.config.min_poll_ms, 1500);
  assert.equal(decoded(await service.poll()).samples[0].kind,'unavailable');
});


test('eight small watches fit the minimum budget; oversize watches keep identities', async () => {
  const {service, bridge, advance} = setup();
  const eight = Array.from({length:8},(_,i)=>({id:'watch'+i,source:'client',tool:'client_status'}));
  bridge.value = {a:1};
  await service.configure({mode:'data',max_text_bytes:2048,watches:eight});
  const small = decoded(await service.poll());
  assert.equal(small.samples.filter(s=>s.kind==='snapshot').length,8);
  assert.ok(Buffer.byteLength(JSON.stringify(small))<=2048);
  bridge.value = {a:'x'.repeat(10000)}; advance(12000);
  const big = decoded(await service.poll());
  assert.equal(big.samples.length,8);
  assert.deepEqual(big.samples.map(s=>s.watchId),eight.map(w=>w.id));
  assert.ok(big.samples.every(s=>s.kind==='oversize'));
});


test('structuredContent uses the same size/type guard and schema failures reset connection', async () => {
  assert.throws(()=>parseReading({structuredContent:null}));
  assert.throws(()=>parseReading({structuredContent:{x:'a'.repeat(2000001)}}));
  const bridge = new Bridge(); let closed = false;
  bridge.clients.set('client',{listTools:async()=>{throw new Error('closed')},close:async()=>{closed=true}});
  await assert.rejects(bridge.schema('client','client_status'));
  assert.equal(closed,true); assert.equal(bridge.clients.has('client'),false);
});
