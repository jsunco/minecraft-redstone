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
    const listed = await client.listTools();
    for (const name of ['telemetry_status', 'telemetry_configure', 'telemetry_source_schema', 'telemetry_poll', 'telemetry_view']) {
      assert.ok(listed.tools.some(tool => tool.name === name), `Missing tool ${name}`);
    }
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

function pending() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

test('equivalent requests share one reading while different projections keep independent baselines', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', min_poll_ms: 500, watches: [
    {...watches[0], arguments: {b: 2, a: 1}},
    {...watches[0], id: 'power', arguments: {a: 1, b: 2}, fields: ['properties.power']},
  ]});
  assert.equal(service.config.min_poll_ms, 1500);
  const first = decoded(await service.poll());
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual(first.samples.map(s => s.kind), ['snapshot', 'snapshot']);
  assert.equal(first.samples[0].observed_at, first.samples[1].observed_at);
  bridge.value.properties.power = 7; advance();
  const next = decoded(await service.poll());
  assert.deepEqual(next.samples.map(s => s.kind), ['unchanged', 'delta']);
  assert.equal(service.metrics.upstream_reads, 2);
  assert.equal(service.metrics.deduplicated_reads, 2);
});

test('cadence and no-change backoff explicitly defer rather than report cached values as fresh', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', min_poll_ms: 1500, max_backoff_ms: 12000,
    watches: [{...watches[0], interval_ms: 3000}]});
  await service.poll();
  advance(1500); const early = decoded(await service.poll()).samples[0];
  assert.equal(early.kind, 'deferred'); assert.equal(early.age_ms, 1500);
  assert.equal(early.observed_at, undefined); assert.equal(early.value, undefined);
  advance(1500); assert.equal(decoded(await service.poll()).samples[0].kind, 'unchanged');
  advance(3000); assert.equal(decoded(await service.poll()).samples[0].retry_after_ms, 3000);
  assert.equal(bridge.calls.length, 2);
  advance(3000); assert.equal(decoded(await service.poll()).samples[0].kind, 'unchanged');
  advance(3000); assert.equal(decoded(await service.poll()).samples[0].retry_after_ms, 9000);
  advance(1500); const forced = decoded(await service.poll({watch_ids: ['player']}));
  assert.equal(forced.samples[0].kind, 'unchanged'); assert.equal(bridge.calls.length, 4);
});

test('on-demand watches read only when selected or a full resync requests them', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', watches: [{...watches[0], on_demand: true}]});
  const idle = decoded(await service.poll());
  assert.equal(idle.samples[0].kind, 'deferred'); assert.equal(idle.samples[0].reason, 'on_demand');
  assert.equal(bridge.calls.length, 0);
  advance(); assert.equal(decoded(await service.poll({watch_ids: ['player']})).samples[0].kind, 'snapshot');
  advance(70000); assert.equal(decoded(await service.poll()).samples[0].kind, 'deferred');
  assert.equal(bridge.calls.length, 1);
  advance(); const full = decoded(await service.poll({full: true}));
  assert.equal(full.samples[0].kind, 'snapshot'); assert.deepEqual(full.resync_scope, ['player']);
  await assert.rejects(service.poll({watch_ids: ['missing']}), /Unknown watch/);
});

test('full resync overrides cadence and backoff; scoped resync leaves other baselines intact', async () => {
  const {service, advance} = setup();
  await service.configure({mode: 'data', watches: [watches[0], {...watches[0], id: 'second', interval_ms: 60000}]});
  await service.poll(); advance();
  const scoped = decoded(await service.poll({watch_ids: ['player'], full: true}));
  assert.deepEqual(scoped.resync_scope, ['player']); assert.equal(scoped.samples.length, 1);
  advance(); const other = decoded(await service.poll({watch_ids: ['second']}));
  assert.equal(other.samples[0].kind, 'unchanged');
  advance(); const all = decoded(await service.poll({full: true}));
  assert.deepEqual(all.samples.map(s => s.kind), ['snapshot', 'snapshot']);
});

test('failed watch or invalid projection does not reset the healthy baseline', async () => {
  const {service, bridge, advance} = setup();
  const original = bridge.call.bind(bridge);
  let fail = false;
  bridge.call = async (source, tool, args) => {
    if (fail && args.bad) throw new Error('only this target failed');
    return original(source, tool, args);
  };
  await service.configure({mode: 'data', watches: [watches[0], {...watches[0], id: 'bad', arguments: {bad: true}}]});
  await service.poll(); fail = true; advance();
  assert.deepEqual(decoded(await service.poll()).samples.map(s => s.kind), ['unchanged', 'unavailable']);
  fail = false; bridge.value.position.x = 2; advance();
  assert.deepEqual(decoded(await service.poll()).samples.map(s => s.kind), ['delta', 'snapshot']);
  await service.configure({mode: 'data', watches: [watches[0], {...watches[0], id: 'bad', fields: ['absent']}]});
  await service.poll(); advance();
  assert.deepEqual(decoded(await service.poll()).samples.map(s => s.kind), ['unchanged', 'unavailable']);
});

test('reads use bounded concurrency, commit in configured order and service serializes overlapping polls', async () => {
  const {service, bridge, advance} = setup();
  const gates = [pending(), pending(), pending()]; let active = 0; let maximum = 0; let started = 0;
  const starts = [pending(), pending(), pending()];
  bridge.call = async (source, tool, args) => {
    const index = args.index; active++; maximum = Math.max(maximum, active); started++; starts[index].resolve();
    await gates[index].promise; active--;
    return {structuredContent: {value: index}};
  };
  await service.configure({mode: 'data', max_concurrency: 2, watches: [0, 1, 2].map(index =>
    ({id: `w${index}`, source: 'client', tool: 'client_status', arguments: {index}}))});
  const first = service.poll(); await starts[1].promise;
  assert.equal(started, 2); assert.equal(maximum, 2);
  advance(); const second = service.poll(); // Queues behind the entire first sample/commit.
  gates[1].resolve(); await starts[2].promise; assert.equal(started, 3);
  gates[2].resolve(); gates[0].resolve();
  const result = decoded(await first);
  assert.deepEqual(result.samples.map(s => s.watchId), ['w0', 'w1', 'w2']);
  assert.deepEqual(result.samples.map(s => s.value.value), [0, 1, 2]);
  const next = decoded(await second);
  assert.equal(next.previous_sequence, result.sequence);
  assert.ok(next.samples.every(s => s.kind === 'deferred'));
  assert.equal(started, 3); assert.equal(maximum, 2);
});

test('an oversized requested resync stays pending until a new full baseline fits', async () => {
  const {service, bridge, advance} = setup();
  await service.configure({mode: 'data', max_text_bytes: 2048, watches});
  await service.poll(); advance(); bridge.value.position = {x: 'x'.repeat(10000)};
  assert.equal(decoded(await service.poll({full: true})).samples[0].kind, 'oversize');
  bridge.value.position = {x: 3}; advance();
  assert.equal(decoded(await service.poll()).samples[0].kind, 'snapshot');
});

test('schema catalog shares connect/discovery, reports cache age and invalidates by refresh/TTL/notification/drop', async () => {
  let now = 0; let connects = 0; let lists = 0; let handler;
  const clients = [];
  const bridge = new Bridge(undefined, {clock: () => now, schemaTtlMs: 1000,
    transportFactory: () => ({}), clientFactory: () => {
      const client = {connect: async () => { connects++; }, close: async () => {},
        setNotificationHandler: (schema, callback) => { handler = callback; },
        listTools: async () => { lists++; return {tools: [
          {name: 'client_status', inputSchema: {type: 'object'}},
          {name: 'sense_crosshair', inputSchema: {type: 'object'}},
        ]}; }};
      clients.push(client); return client;
    }});
  await Promise.all([bridge.schema('client', 'client_status'), bridge.schema('client', 'sense_crosshair')]);
  assert.equal(connects, 1); assert.equal(lists, 1);
  now = 200; const cached = await bridge.schema('client', 'client_status');
  assert.equal(cached.cached, true); assert.equal(cached.age_ms, 200);
  cached.inputSchema.type = 'poison';
  assert.equal((await bridge.schema('client', 'client_status')).inputSchema.type, 'object');
  await bridge.schema('client', 'client_status', {refresh: true}); assert.equal(lists, 2);
  now = 1200; await bridge.schema('client', 'client_status'); assert.equal(lists, 3);
  handler(); await bridge.schema('client', 'client_status'); assert.equal(lists, 4);
  await bridge.drop('client'); await bridge.schema('client', 'client_status');
  assert.equal(connects, 2); assert.equal(lists, 5); await bridge.close();
});

test('failed fresh schema lookup cannot silently fall back to an expired cached schema', async () => {
  let now = 0; let fail = false; let closed = 0;
  const bridge = new Bridge(undefined, {clock: () => now, schemaTtlMs: 1000});
  bridge.clients.set('client', {close: async () => { closed++; }, listTools: async () => {
    if (fail) throw new Error('offline');
    return {tools: [{name: 'client_status', inputSchema: {type: 'object'}}]};
  }});
  await bridge.schema('client', 'client_status'); now = 1000; fail = true;
  await assert.rejects(bridge.schema('client', 'client_status'), /offline/);
  assert.equal(closed, 1); assert.equal(bridge.catalogs.has('client'), false);
});

test('capability check refreshes connection/tool discovery without game calls or observer auto-connect', async () => {
  const {service, bridge} = setup(); const checked = [];
  bridge.capabilities = async (source, {refresh}) => {
    checked.push({source, refresh});
    if (source === 'world') throw new Error('bridge absent');
    return {connected: true, available: ['client_status'], missing: ['sense_screen']};
  };
  const result = decoded(await service.check());
  assert.deepEqual(checked, [{source: 'client', refresh: true}, {source: 'world', refresh: true}]);
  assert.equal(result.connections[0].connected, true); assert.equal(result.connections[1].connected, false);
  assert.equal(result.game_reads, 0); assert.equal(bridge.calls.length, 0);
});

test('batch read scope validates integer positions and permits the native 512-target limit', async () => {
  const {service} = setup();
  const batch = {id: 'blocks', source: 'world', tool: 'block_get_states_batch',
    arguments: {dimension: 'minecraft:overworld', positions: Array.from({length: 512}, (_,x) => ({x, y: 64, z: 0}))}};
  await service.configure({mode: 'data', watches: [batch]});
  assert.equal(service.config.watches[0].arguments.positions.length, 512);
  batch.arguments.positions.push({x: 512, y: 64, z: 0});
  await assert.rejects(service.configure({mode: 'data', watches: [batch]}), /1 to 512/);
});

test('schema discovery invalidated while in flight cannot repopulate a stale catalog', async () => {
  const began = pending(); const released = pending();
  const bridge = new Bridge();
  bridge.clients.set('client', {close: async () => {}, listTools: async () => {
    began.resolve(); await released.promise;
    return {tools: [{name: 'client_status', inputSchema: {type: 'object'}}]};
  }});
  const lookup = bridge.schema('client', 'client_status');
  await began.promise; bridge.invalidateSchema('client'); released.resolve();
  await assert.rejects(lookup, /changed during discovery/);
  assert.equal(bridge.catalogs.has('client'), false);
});

test('reconfiguration waits for an in-flight poll, then forces the new configuration baseline', async () => {
  const {service, bridge} = setup();
  const began = pending(); const released = pending();
  bridge.call = async () => { began.resolve(); await released.promise; return {structuredContent: {position: {x: 1}}}; };
  await service.configure({mode: 'data', watches});
  const first = service.poll(); await began.promise;
  const configured = service.configure({mode: 'data', watches: [{...watches[0], id: 'new'}]});
  released.resolve(); assert.equal(decoded(await first).samples[0].watchId, 'player'); await configured;
  assert.equal(decoded(await service.poll()).samples[0].watchId, 'new');
  assert.equal(service.states.has('player'), false);
});

test('schema discovery survives active reconfiguration, while disabled mode closes connections', async () => {
  const {service, bridge} = setup(); let closed = 0;
  bridge.close = async () => { closed++; };
  await service.configure({mode: 'data', watches});
  await service.configure({mode: 'hybrid', watches});
  assert.equal(closed, 0);
  await service.configure({mode: 'disabled'}); assert.equal(closed, 1);
});

test('a stale schema discovery cannot close the client or erase a newer refreshed catalog', async () => {
  const began = pending(); const release = pending(); let lists = 0; let closed = 0;
  const bridge = new Bridge();
  const client = {close: async () => { closed++; }, listTools: async () => {
    const version = ++lists;
    if (version === 1) { began.resolve(); await release.promise; }
    return {tools: [{name: 'client_status', inputSchema: {type: 'object', title: `version-${version}`}}]};
  }};
  bridge.clients.set('client', client);
  const stale = bridge.schema('client', 'client_status'); await began.promise;
  const refreshed = await bridge.schema('client', 'client_status', {refresh: true});
  assert.equal(refreshed.inputSchema.title, 'version-2');
  release.resolve(); await assert.rejects(stale, /changed during discovery/);
  assert.equal(bridge.clients.get('client'), client); assert.equal(closed, 0);
  const retained = await bridge.schema('client', 'client_status');
  assert.equal(retained.cached, true); assert.equal(retained.inputSchema.title, 'version-2'); assert.equal(lists, 2);
  await bridge.close();
});

test('a failed invalidated connection cannot tear down its replacement', async () => {
  const began = pending(); const release = pending(); const clients = []; const closed = [];
  const bridge = new Bridge(undefined, {headersProvider: () => ({}), transportFactory: () => ({}), clientFactory: () => {
    const index = clients.length;
    const client = {connect: async () => { if (index === 0) { began.resolve(); await release.promise; } },
      close: async () => { closed.push(index); }, callTool: async () => ({structuredContent: {ready: true}})};
    clients.push(client); return client;
  }});
  const invalidated = bridge.call('client', 'client_status', {}); await began.promise;
  const dropping = bridge.drop('client');
  const replacement = await bridge.get('client');
  release.resolve(); await assert.rejects(invalidated, /invalidated while connecting/); await dropping;
  assert.equal(bridge.clients.get('client'), replacement); assert.deepEqual(closed, [0]);
  assert.equal(parseReading(await bridge.call('client', 'client_status', {})).ready, true);
  await bridge.close();
});
