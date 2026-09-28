import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildService, buildPlanSchema } from './build-service.mjs';

const decoded = r => JSON.parse(r.content[0].text);
const response = value => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]});
const pos = (x, y = 64, z = 0) => ({x, y, z});
const box = (x0, x1) => ({from: pos(x0), to: pos(x1)});
const state = (id, properties = {}) => ({id: `minecraft:${id}`, properties});
const key = p => `${p.x},${p.y},${p.z}`;
function* cells(b) { for (let x = b.from.x; x <= b.to.x; x++) for (let y = b.from.y; y <= b.to.y; y++) for (let z = b.from.z; z <= b.to.z; z++) yield {x, y, z}; }
class FakeBridge {
  constructor() { this.calls = []; this.world = new Map(); this.saved = new Map(); this.session = 'session-a'; this.setCount = 0; }
  at(p) { return structuredClone(this.world.get(key(p)) ?? state('air')); }
  put(p, value) { this.world.set(key(p), structuredClone(value)); }
  async call(source, tool, args) {
    this.calls.push({source, tool, args: structuredClone(args)});
    const override = await this.intercept?.(tool, args);
    if (override) return override;
    switch (tool) {
      case 'server_get_status': return response(this.session ? {session_id: this.session} : {version: 'test'});
      case 'block_scan_region': {
        const rows = [...cells(args.box)].map(position => ({position, state: this.at(position)}));
        return response(this.scanTransform ? this.scanTransform(rows) : rows.slice(0, args.limit));
      }
      case 'structure_save_from_world':
        this.saved.set(args.name, {box: structuredClone(args.box), states: [...cells(args.box)].map(p => [p, this.at(p)])});
        return response(`saved ${args.name}`);
      case 'structure_get_info': {
        const s = this.saved.get(args.name); return response({name: args.name, onDisk: true,
          sizeX: s.box.to.x - s.box.from.x + 1, sizeY: s.box.to.y - s.box.from.y + 1, sizeZ: s.box.to.z - s.box.from.z + 1});
      }
      case 'structure_load_to_world':
        for (const [p, value] of this.saved.get(args.name).states) this.put(p, value);
        return response(`placed ${args.name}`);
      case 'block_set_state': this.setCount++; this.put(args.position, args.block); return response(`placed ${args.block.id}`);
      case 'block_fill_region': for (const p of cells(args.box)) this.put(p, args.block); return response(`filled ${[...cells(args.box)].length} block(s)`);
      case 'block_fill_batch': {
        let changed = 0;
        for (const fill of args.fills) {
          const [id, properties] = fill.block.replace(/\]$/, '').split('[');
          const value = {id, properties: Object.fromEntries(properties ? properties.split(',').map(p => p.split('=')) : [])};
          const b = {from: {x: fill.from[0], y: fill.from[1], z: fill.from[2]}, to: {x: fill.to[0], y: fill.to[1], z: fill.to[2]}};
          for (const p of cells(b)) { this.put(p, value); changed++; }
        }
        return response({fills_applied: args.fills.length, blocks_changed: changed});
      }
      case 'block_clone_region': {
        const source = [...cells(args.source_box)].map(p => [p, this.at(p)]);
        for (const [p, value] of source) this.put({x: args.destination.x + p.x - args.source_box.from.x,
          y: args.destination.y + p.y - args.source_box.from.y, z: args.destination.z + p.z - args.source_box.from.z}, value);
        return response(`cloned ${source.length} block(s)`);
      }
      default: throw new Error(`Unexpected upstream tool ${tool}`);
    }
  }
}
const writes = bridge => bridge.calls.filter(c => ['block_set_state', 'block_fill_region', 'block_fill_batch', 'block_clone_region', 'structure_load_to_world'].includes(c.tool));
async function setup(options = {}) {
  const bridge = new FakeBridge(); let next = 0;
  const service = new BuildService(bridge, {stateDir: null, idFactory: () => `id-${++next}`, ...options});
  await service.registerRegion({id: 'lab', dimension: 'minecraft:overworld', box: box(0, 7)});
  return {service, bridge};
}
const set = (x, id = 'stone', properties = {}) => ({op: 'set', position: pos(x), block: state(id, properties)});
async function plan(service, operations = [set(0)], id = 'test') {
  return decoded(await service.createPlan({id, region_id: 'lab', label: 'test module', operations}));
}

test('registration is local; planning and preview read without saving structures or placing blocks', async () => {
  const {service, bridge} = await setup(); assert.equal(bridge.calls.length, 0);
  const made = await plan(service); assert.equal(made.session_bound, true);
  const preview = decoded(await service.preview({plan_id: 'test'}));
  assert.equal(preview.baseline_changed, false); assert.equal(preview.operations.length, 1);
  assert.ok(bridge.calls.every(c => ['server_get_status', 'block_scan_region'].includes(c.tool)));
  assert.equal(bridge.calls.find(c => c.tool === 'block_scan_region').args.limit, 8);
});

test('validated upstream set/fill/clone calls save a disk snapshot before writes and support verified undo', async () => {
  const {service, bridge} = await setup();
  await plan(service, [{op: 'fill', box: box(0, 1), block: state('stone')}, set(2, 'lever', {powered: 'false'}),
    {op: 'clone', source_box: box(0, 1), destination: pos(4)}]);
  const applied = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(applied.status, 'applied'); assert.equal(applied.verification.matches, true);
  const saveIndex = bridge.calls.findIndex(c => c.tool === 'structure_save_from_world');
  const metadataIndex = bridge.calls.findIndex(c => c.tool === 'structure_get_info');
  const firstWrite = bridge.calls.findIndex(c => c.tool === 'block_fill_region');
  assert.ok(saveIndex < metadataIndex && metadataIndex < firstWrite);
  assert.deepEqual(bridge.calls[firstWrite].args, {dimension: 'minecraft:overworld', box: box(0, 1), block: state('stone'), mode: 'replace'});
  assert.deepEqual(bridge.calls.find(c => c.tool === 'block_clone_region').args, {
    source_dimension: 'minecraft:overworld', source_box: box(0, 1), dest_dimension: 'minecraft:overworld', destination: pos(4), mode: 'normal'});
  assert.equal(decoded(await service.verify({plan_id: 'test'})).verification.matches, true);
  const undone = decoded(await service.undo({plan_id: 'test'})); assert.equal(undone.restored, true);
  assert.equal(bridge.at(pos(4)).id, 'minecraft:air');
  assert.deepEqual(bridge.calls.find(c => c.tool === 'structure_load_to_world').args, {
    name: applied.snapshot, dimension: 'minecraft:overworld', origin: pos(0), rotation: 'none', mirror: 'none', include_entities: false, integrity: 1});
});

test('bounds, overlap, dangerous blocks, NBT and arbitrary commands are rejected before a game call', async () => {
  const {service, bridge} = await setup();
  for (const operations of [[set(99)], [set(0, 'tnt')], [{op: 'clone', source_box: box(0, 2), destination: pos(1)}],
    [{op: 'fill', box: box(0, 5000), block: state('stone')}], [{op: 'set', position: pos(0), block: {...state('stone'), nbt: '{}'}}],
    [{op: 'command', command: '/kill @a'}]]) await assert.rejects(plan(service, operations));
  await assert.rejects(service.registerRegion({id: 'huge', dimension: 'minecraft:overworld', box: box(0, 4096)}));
  assert.equal(bridge.calls.length, 0);
  assert.equal(buildPlanSchema.safeParse({region_id: 'lab', label: 'x', operations: [set(0)], force: true}).success, false);
});

test('incomplete and duplicate scan coverage fail before any mutation', async () => {
  const {service, bridge} = await setup(); bridge.scanTransform = rows => rows.slice(1);
  await assert.rejects(plan(service), /Incomplete/);
  bridge.scanTransform = rows => rows.map((r, i) => i === 0 ? rows[1] : r);
  await assert.rejects(plan(service), /duplicate/); assert.equal(writes(bridge).length, 0);
});

test('unknown pre-existing blocks cannot be captured for later unsafe restoration', async () => {
  const {service, bridge} = await setup(); bridge.put(pos(7), state('command_block'));
  await assert.rejects(plan(service), /palette/); assert.equal(bridge.saved.size, 0);
});

test('snapshot false acknowledgement or absent on-disk metadata aborts all block operations', async () => {
  for (const failure of ['save', 'metadata']) {
    const {service, bridge} = await setup(); await plan(service);
    bridge.intercept = async tool => {
      if (failure === 'save' && tool === 'structure_save_from_world') return response('failed');
      if (failure === 'metadata' && tool === 'structure_get_info') return response({name: 'wrong', onDisk: false});
    };
    await assert.rejects(service.apply({plan_id: 'test'})); assert.equal(writes(bridge).length, 0);
  }
});

test('edits after planning or during snapshot capture never get overwritten', async () => {
  for (const duringSave of [false, true]) {
    const {service, bridge} = await setup(); await plan(service);
    if (duringSave) bridge.intercept = async tool => { if (tool === 'structure_save_from_world') bridge.put(pos(7), state('glass')); };
    else bridge.put(pos(7), state('glass'));
    await assert.rejects(service.apply({plan_id: 'test'}), /changed/); assert.equal(writes(bridge).length, 0);
  }
});

test('session identity is mandatory for writes and a different live session cannot apply or undo a saved plan', async () => {
  const {service, bridge} = await setup(); bridge.session = null;
  assert.equal((await plan(service)).session_bound, false);
  await assert.rejects(service.apply({plan_id: 'test'}), /identity unavailable/);
  bridge.session = 'session-a'; await plan(service, [set(0)], 'second');
  bridge.session = 'session-b'; await assert.rejects(service.apply({plan_id: 'second'}), /session changed/);
  bridge.session = 'session-a'; await service.apply({plan_id: 'second'});
  bridge.session = 'session-b'; await assert.rejects(service.undo({plan_id: 'second'}), /session changed/);
  assert.equal(writes(bridge).length, 1);
});

test('partial mutation followed by a tool failure rolls back from the saved structure and verifies restoration', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0), {op: 'fill', box: box(1, 2), block: state('glass')}]);
  bridge.intercept = async (tool, args) => {
    if (tool === 'block_fill_region') { bridge.put(pos(1), args.block); throw new Error('connection dropped midway through fill'); }
  };
  const result = await service.apply({plan_id: 'test'}); const data = decoded(result);
  assert.equal(result.isError, true); assert.equal(data.completed_operations, 1);
  assert.equal(data.status, 'rolled_back'); assert.equal(data.rollback.verified, true);
  assert.equal(bridge.at(pos(0)).id, 'minecraft:air'); assert.equal(bridge.at(pos(1)).id, 'minecraft:air');
  await assert.rejects(service.apply({plan_id: 'test'}), /never replayed/);
});

test('partial failure with an unrelated edit reports a conflict instead of auto-restoring over it', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0), set(1)]);
  bridge.intercept = async (tool, args) => {
    if (tool === 'block_set_state' && args.position.x === 1) { bridge.put(pos(7), state('glass')); throw new Error('failed'); }
  };
  const data = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(data.status, 'partial'); assert.equal(data.rollback.status, 'conflict');
  assert.equal(bridge.calls.filter(c => c.tool === 'structure_load_to_world').length, 0);
  assert.equal(bridge.at(pos(7)).id, 'minecraft:glass');
  const conflict = decoded(await service.undo({plan_id: 'test'}));
  assert.equal(conflict.status, 'undo_conflict');
  assert.equal(decoded(await service.undo({plan_id: 'test', expected_fingerprint: conflict.current_fingerprint})).restored, true);
});

test('block-state changes and same-material spatial swaps are undo conflicts; exact observed fingerprint can resolve intentionally', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0, 'stone'), set(1, 'glass'), set(2, 'lever', {powered: 'false'})]);
  await service.apply({plan_id: 'test'});
  bridge.put(pos(0), state('glass')); bridge.put(pos(1), state('stone')); bridge.put(pos(2), state('lever', {powered: 'true'}));
  const conflict = decoded(await service.undo({plan_id: 'test'})); assert.equal(conflict.status, 'undo_conflict');
  const inspection = decoded(await service.verify({plan_id: 'test'})); assert.equal(inspection.verification.mismatch_count, 3);
  assert.equal(decoded(await service.undo({plan_id: 'test'})).status, 'undo_conflict'); // verify must not refresh the guard.
  const undone = decoded(await service.undo({plan_id: 'test', expected_fingerprint: conflict.current_fingerprint}));
  assert.equal(undone.status, 'undone');
});

test('mismatched readback is applied_unverified, not falsely successful or automatically erased', async () => {
  const {service, bridge} = await setup(); await plan(service);
  bridge.intercept = async tool => tool === 'block_set_state' ? response('placed minecraft:stone') : undefined;
  const result = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(result.status, 'applied_unverified'); assert.equal(result.verification.mismatch_count, 1);
  assert.equal(bridge.calls.some(c => c.tool === 'structure_load_to_world'), false);
});

test('four or more adjacent placements use one schema-correct batch and retain readback verification', async () => {
  const {service, bridge} = await setup();
  const made = await plan(service, [set(0), set(1), set(2, 'lever', {powered: 'false'}), set(3)]);
  assert.equal(made.placement_calls, 1);
  assert.equal(decoded(await service.apply({plan_id: 'test'})).status, 'applied');
  const batches = bridge.calls.filter(c => c.tool === 'block_fill_batch'); assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].args.fills[2], {from: [2, 64, 0], to: [2, 64, 0], block: 'minecraft:lever[powered=false]', mode: 'replace'});
  assert.equal(writes(bridge).length, 1);
});

test('partial batch acknowledgement rolls back partial writes without counting unacknowledged operations', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0), set(1), set(2), set(3)]);
  bridge.intercept = async tool => {
    if (tool === 'block_fill_batch') { bridge.put(pos(0), state('stone')); return response({fills_applied: 1, blocks_changed: 1}); }
  };
  const result = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(result.status, 'rolled_back'); assert.equal(result.completed_operations, 0);
  assert.equal(bridge.at(pos(0)).id, 'minecraft:air');
});

test('large inspectable plans produce bounded previews with explicit omitted counts', async () => {
  const {service} = await setup();
  const properties = Object.fromEntries(Array.from({length: 16}, (_, i) => [`property_${i}`, 'a'.repeat(40)]));
  await plan(service, Array.from({length: 128}, () => set(0, 'stone', properties)));
  const result = await service.preview({plan_id: 'test'}); const value = decoded(result);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 12_000);
  assert.equal(value.operations.length + value.omitted_operations, 128);
});

test('unavailable rollback retains snapshot and partial evidence for recovery', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0), set(1)]);
  bridge.intercept = async (tool, args) => {
    if (tool === 'block_set_state' && args.position.x === 1) throw new Error('failed write');
    if (tool === 'structure_load_to_world') throw new Error('failed restore');
  };
  const result = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(result.status, 'partial'); assert.equal(result.rollback.status, 'unavailable'); assert.ok(result.snapshot);
  assert.equal(bridge.at(pos(0)).id, 'minecraft:stone');
});

test('concurrent apply requests serialize and never double-apply', async () => {
  const {service, bridge} = await setup(); await plan(service);
  const results = await Promise.allSettled([service.apply({plan_id: 'test'}), service.apply({plan_id: 'test'})]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(bridge.setCount, 1);
});

test('a bridge reconnect to a new session midway through apply never writes the remaining operations', async () => {
  const {service, bridge} = await setup(); await plan(service, [set(0), set(1)]);
  bridge.intercept = async (tool, args) => {
    if (tool === 'block_set_state' && args.position.x === 0) bridge.session = 'new-session';
  };
  const result = decoded(await service.apply({plan_id: 'test'}));
  assert.equal(result.status, 'partial'); assert.equal(result.rollback.status, 'unavailable');
  assert.equal(bridge.setCount, 1); assert.equal(bridge.at(pos(1)).id, 'minecraft:air');
});

test('an externally replaced oversized snapshot cannot escape the region on undo', async () => {
  const {service, bridge} = await setup(); await plan(service); await service.apply({plan_id: 'test'});
  bridge.intercept = async tool => tool === 'structure_get_info' ? response({name: 'mcredstone:undo/id-1', onDisk: true, sizeX: 100, sizeY: 100, sizeZ: 100}) : undefined;
  const undo = await service.undo({plan_id: 'test'});
  assert.equal(undo.isError, true); assert.match(decoded(undo).error, /dimensions changed/);
  assert.equal(bridge.calls.filter(c => c.tool === 'structure_load_to_world').length, 0);
});

test('persistent journals preserve snapshots and never replay an interrupted mutation on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'redstone-build-'));
  try {
    const {service, bridge} = await setup({stateDir: dir}); await plan(service); await service.apply({plan_id: 'test'});
    const file = join(dir, 'build-state.json'); const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.plans[0].status = 'applying'; writeFileSync(file, JSON.stringify(disk));
    const callsBefore = bridge.calls.length;
    const resumed = new BuildService(bridge, {stateDir: dir});
    assert.equal(bridge.calls.length, callsBefore);
    const status = decoded(resumed.status()); assert.equal(status.plans[0].status, 'interrupted'); assert.ok(status.plans[0].snapshot);
    await assert.rejects(resumed.apply({plan_id: 'test'}), /never replayed/);
    const inspected = decoded(await resumed.verify({plan_id: 'test'}));
    assert.equal(decoded(await resumed.undo({plan_id: 'test', expected_fingerprint: inspected.current_fingerprint})).restored, true);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
