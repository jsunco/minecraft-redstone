import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseReading } from './telemetry-service.mjs';

export const BUILD_LIMITS = Object.freeze({blocks: 4096, operations: 128, regions: 32, plans: 128});
const coord = z.number().int().min(-30_000_000).max(30_000_000);
const position = z.object({x: coord, y: coord, z: coord}).strict();
const box = z.object({from: position, to: position}).strict();
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const dimension = z.string().regex(/^minecraft:(overworld|the_nether|the_end)$/);
const block = z.object({
  id: z.string().regex(/^minecraft:[a-z0-9_]+$/),
  properties: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().regex(/^[a-z0-9_-]{1,40}$/)).default({}),
}).strict().refine(value => Object.keys(value.properties).length <= 16, 'At most 16 block-state properties');
const operation = z.discriminatedUnion('op', [
  z.object({op: z.literal('set'), position, block}).strict(),
  z.object({op: z.literal('fill'), box, block}).strict(),
  z.object({op: z.literal('clone'), source_box: box, destination: position}).strict(),
]);
export const buildRegionSchema = z.object({id: identifier, dimension, box, description: z.string().max(160).default('')}).strict();
export const buildPlanSchema = z.object({id: identifier.optional(), region_id: identifier, label: z.string().min(1).max(100), operations: z.array(operation).min(1).max(BUILD_LIMITS.operations)}).strict();
export const buildPlanRefSchema = z.object({plan_id: identifier}).strict();
export const buildUndoSchema = z.object({plan_id: identifier, expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const buildStatusSchema = z.object({offset: z.number().int().min(0).max(BUILD_LIMITS.plans).default(0), limit: z.number().int().min(1).max(32).default(16)}).strict();

// A deliberately small construction palette. No NBT, command blocks, liquids,
// explosives, portals, containers, or entity tools are exposed by this service.
const palette = new Set(('air cave_air void_air dirt grass_block stone smooth_stone cobblestone deepslate glass tinted_glass quartz_block smooth_quartz sandstone bricks obsidian bedrock glowstone sea_lantern redstone_wire redstone_torch redstone_wall_torch redstone_block redstone_lamp repeater comparator lever stone_button polished_blackstone_button oak_button stone_pressure_plate light_weighted_pressure_plate heavy_weighted_pressure_plate piston sticky_piston observer target oak_planks stone_slab smooth_stone_slab quartz_slab').split(' ').map(id => `minecraft:${id}`));
for (const color of 'white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(' ')) {
  for (const material of ['wool', 'concrete', 'stained_glass', 'terracotta']) palette.add(`minecraft:${color}_${material}`);
}
const axes = ['x', 'y', 'z'];
const normalized = value => ({from: Object.fromEntries(axes.map(k => [k, Math.min(value.from[k], value.to[k])])), to: Object.fromEntries(axes.map(k => [k, Math.max(value.from[k], value.to[k])]))});
const volume = value => axes.reduce((n, k) => n * (value.to[k] - value.from[k] + 1), 1);
const inside = (p, b) => axes.every(k => p[k] >= b.from[k] && p[k] <= b.to[k]);
const contains = (outer, inner) => inside(inner.from, outer) && inside(inner.to, outer);
const overlaps = (a, b) => axes.every(k => a.from[k] <= b.to[k] && b.from[k] <= a.to[k]);
const key = p => `${p.x},${p.y},${p.z}`;
const copy = value => structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const fingerprint = states => createHash('sha256').update(JSON.stringify(stable([...states].sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const brief = error => String(error?.message ?? error).slice(0, 250);
function text(value) {
  const output = copy(value);
  // Keep essential status/recovery fields and trim only explicitly counted lists.
  for (const [owner, field, omitted] of [[output, 'operations', 'omitted_operations'],
    [output.verification, 'examples', 'omitted_examples'], [output, 'plans', 'omitted_plans'], [output, 'regions', 'omitted_regions']]) {
    while (owner?.[field]?.length && Buffer.byteLength(JSON.stringify(output)) > 12_000) {
      owner[field].pop(); owner[omitted] = (owner[omitted] ?? 0) + 1;
    }
  }
  return {content: [{type: 'text', text: JSON.stringify(output)}]};
}
function* positions(b) { for (let y = b.from.y; y <= b.to.y; y++) for (let z = b.from.z; z <= b.to.z; z++) for (let x = b.from.x; x <= b.to.x; x++) yield {x, y, z}; }
function bounded(value) {
  const b = normalized(value);
  if (!Number.isSafeInteger(volume(b)) || volume(b) > BUILD_LIMITS.blocks) throw new Error(`Region exceeds ${BUILD_LIMITS.blocks} blocks`);
  return b;
}
function allowed(state) {
  if (!palette.has(state.id)) throw new Error(`Block outside construction palette: ${state.id}`);
}
function operationBox(op) {
  if (op.op === 'set') return {from: op.position, to: op.position};
  if (op.op === 'fill') return op.box;
  return {from: op.destination, to: Object.fromEntries(axes.map(k => [k, op.destination[k] + op.source_box.to[k] - op.source_box.from[k]]))};
}
function normalizedOperations(region, operations) {
  const result = operations.map(op => {
    const next = copy(op);
    if (next.box) next.box = bounded(next.box);
    if (next.source_box) next.source_box = bounded(next.source_box);
    if (next.block) allowed(next.block);
    const target = operationBox(next);
    if (!contains(region.box, target)) throw new Error('Operation leaves the registered region');
    if (next.op === 'clone' && (!contains(region.box, next.source_box) || overlaps(next.source_box, target))) throw new Error('Clone source must be inside the region and must not overlap its destination');
    return next;
  });
  if (result.reduce((n, op) => n + volume(operationBox(op)), 0) > BUILD_LIMITS.blocks) throw new Error('Total operation volume exceeds 4096 blocks, including repeated writes');
  return result;
}
function validatedEntries(entries, region) {
  const parsed = z.array(z.tuple([z.string().max(100), block])).length(volume(region.box)).parse(entries);
  const states = new Map();
  for (const [at, state] of parsed) {
    const parts = at.split(',').map(Number);
    if (parts.length !== 3) throw new Error('Invalid position in saved build journal');
    const p = position.parse({x: parts[0], y: parts[1], z: parts[2]});
    if (key(p) !== at || !inside(p, region.box) || states.has(at)) throw new Error('Saved build journal has duplicate or out-of-bounds positions');
    allowed(state); states.set(at, state);
  }
  return states;
}
function validatedStoredPlan(value, regions) {
  const plan = z.object({id: identifier, region: buildRegionSchema, label: z.string().min(1).max(100),
    operations: z.array(operation).min(1).max(BUILD_LIMITS.operations), session_id: z.string().min(1).max(200).nullable(),
    status: z.enum(['planned', 'applying', 'applied', 'applied_unverified', 'partial', 'rolling_back', 'rolled_back', 'rollback_unverified', 'undoing', 'undone', 'undo_unverified', 'interrupted']),
    before_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), after_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    snapshot: z.string().regex(/^mcredstone:undo\/[a-z0-9_-]{1,128}$/).optional(), before: z.unknown(), expected: z.unknown(),
  }).passthrough().parse(value);
  plan.region.box = bounded(plan.region.box);
  if (JSON.stringify(stable(plan.region)) !== JSON.stringify(stable(regions.get(plan.region.id)))) throw new Error('Saved plan does not match its registered region');
  plan.operations = normalizedOperations(plan.region, plan.operations);
  const before = validatedEntries(plan.before, plan.region); const expected = validatedEntries(plan.expected, plan.region);
  if (fingerprint(before) !== plan.before_fingerprint) throw new Error('Saved plan baseline fingerprint is inconsistent');
  let calculated = before;
  for (const op of plan.operations) calculated = evolve(calculated, op);
  if (fingerprint(expected) !== fingerprint(calculated)) throw new Error('Saved plan expected state is inconsistent');
  plan.before = [...before]; plan.expected = [...expected];
  return plan;
}
function matches(actual, expected) {
  return actual?.id === expected.id && Object.entries(expected.properties).every(([k, v]) => actual.properties[k] === v);
}
function compare(actual, expected) {
  const failures = [];
  let mismatch_count = 0;
  for (const [at, state] of expected) if (!matches(actual.get(at), state)) {
    mismatch_count++;
    if (failures.length < 8) failures.push({position: at, expected: state, observed: actual.get(at)});
  }
  return {matches: mismatch_count === 0, checked_blocks: expected.size, mismatch_count, examples: failures};
}
function evolve(states, op) {
  const next = new Map(states);
  for (const p of positions(operationBox(op))) {
    const state = op.op === 'clone'
      ? states.get(key(Object.fromEntries(axes.map(k => [k, op.source_box.from[k] + p[k] - op.destination[k]]))))
      : op.block;
    if (!state) throw new Error('Clone source is missing from scan');
    allowed(state);
    next.set(key(p), copy(state));
  }
  return next;
}
function executionGroups(operations) {
  const groups = [];
  for (let i = 0; i < operations.length;) {
    const pending = [];
    while (pending.length < 32 && operations[i + pending.length] && operations[i + pending.length].op !== 'clone') pending.push(operations[i + pending.length]);
    const group = pending.length >= 4 ? pending : [operations[i]];
    groups.push(group); i += group.length;
  }
  return groups;
}
function summary(states) {
  const counts = new Map();
  for (const value of states.values()) counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  const all = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {blocks: states.size, non_air: states.size - (counts.get('minecraft:air') ?? 0), materials: all.slice(0, 16).map(([id, count]) => ({id, count})), omitted_materials: Math.max(0, all.length - 16)};
}

export class BuildService {
  constructor(bridge, {stateDir = join(homedir(), '.codex', 'minecraft-redstone', 'build-state'), clock = () => Date.now(), idFactory = randomUUID} = {}) {
    if (!bridge?.call) throw new Error('BuildService requires an injected bridge');
    this.bridge = bridge; this.stateDir = stateDir; this.clock = clock; this.idFactory = idFactory;
    this.regions = new Map(); this.plans = new Map(); this.queue = Promise.resolve();
    if (stateDir) {
      try {
        const saved = JSON.parse(readFileSync(join(stateDir, 'build-state.json'), 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.regions) || !Array.isArray(saved.plans) || saved.regions.length > BUILD_LIMITS.regions || saved.plans.length > BUILD_LIMITS.plans) throw new Error('Invalid build-state journal');
        this.regions = new Map(saved.regions.map(r => { const region = buildRegionSchema.parse(r); region.box = bounded(region.box); return [region.id, region]; }));
        if (this.regions.size !== saved.regions.length) throw new Error('Duplicate region ids in build-state journal');
        this.plans = new Map(saved.plans.map(p => { const plan = validatedStoredPlan(p, this.regions); return [plan.id, plan]; }));
        if (this.plans.size !== saved.plans.length) throw new Error('Duplicate plan ids in build-state journal');
        // Never replay an interrupted mutation. A saved snapshot remains available.
        for (const p of this.plans.values()) if (['applying', 'undoing', 'rolling_back'].includes(p.status)) p.status = 'interrupted';
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  run(action) { const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  persist() {
    if (!this.stateDir) return;
    mkdirSync(this.stateDir, {recursive: true, mode: 0o700});
    const target = join(this.stateDir, 'build-state.json');
    writeFileSync(`${target}.tmp`, JSON.stringify({version: 1, regions: [...this.regions.values()], plans: [...this.plans.values()]}), {mode: 0o600});
    renameSync(`${target}.tmp`, target);
  }
  async identity() {
    const info = parseReading(await this.bridge.call('world', 'server_get_status', {}));
    return typeof info.session_id === 'string' && info.session_id.length > 0 && info.session_id.length <= 200 ? info.session_id : null;
  }
  async checkIdentity(plan) {
    const current = await this.identity();
    if (!current || !plan.session_id) throw new Error('World session identity unavailable. Use the bridge with server_get_status.session_id, then create a fresh plan; writes are disabled until bound.');
    if (current !== plan.session_id) throw new Error('World session changed. Create a fresh plan in this world; the old snapshot is retained for explicit recovery.');
  }
  async scan(region) {
    const values = parseReading(await this.bridge.call('world', 'block_scan_region', {dimension: region.dimension, box: region.box, limit: volume(region.box)}));
    if (!Array.isArray(values) || values.length !== volume(region.box)) throw new Error('Incomplete region scan; expected every block including air');
    const states = new Map();
    for (const row of values) {
      const p = position.parse(row.position);
      if (!inside(p, region.box) || states.has(key(p))) throw new Error('Region scan has duplicate or out-of-bounds coordinates');
      const state = block.parse({id: row.state?.id, properties: row.state?.properties ?? {}});
      states.set(key(p), state);
    }
    return states;
  }
  plan(input) { const {plan_id} = buildPlanRefSchema.parse(input); const plan = this.plans.get(plan_id); if (!plan) throw new Error('Unknown plan'); return plan; }
  describe(plan) {
    return {plan_id: plan.id, label: plan.label, region_id: plan.region.id, dimension: plan.region.dimension, box: plan.region.box,
      status: plan.status, session_bound: Boolean(plan.session_id), operation_count: plan.operations.length, placement_calls: executionGroups(plan.operations).length, max_region_blocks: volume(plan.region.box),
      snapshot: plan.snapshot ?? null, baseline_fingerprint: plan.before_fingerprint, observed_fingerprint: plan.after_fingerprint ?? null,
      ...(plan.error ? {error: plan.error} : {})};
  }
  status(input = {}) {
    const {offset, limit} = buildStatusSchema.parse(input); const plans = [...this.plans.values()].reverse();
    return text({limits: BUILD_LIMITS, regions: [...this.regions.values()].map(r => ({id: r.id, dimension: r.dimension, box: r.box})),
      plans: plans.slice(offset, offset + limit).map(p => ({plan_id: p.id, status: p.status, snapshot: p.snapshot ?? null})),
      total_plans: plans.length, offset, next_offset: offset + limit < plans.length ? offset + limit : null,
      persistence: Boolean(this.stateDir), note: 'Session-bound block/state fingerprints; NBT, entities, scheduled ticks and neighbor effects are not conflict-checked. No game connection is opened by status.'});
  }
  registerRegion(input) { return this.run(async () => {
    const region = buildRegionSchema.parse(input); region.box = bounded(region.box);
    if (this.regions.has(region.id)) {
      if (JSON.stringify(stable(this.regions.get(region.id))) === JSON.stringify(stable(region))) return text({region, volume: volume(region.box), already_registered: true, world_modified: false});
      throw new Error('Region id already registered with different settings; use another id');
    }
    if (this.regions.size >= BUILD_LIMITS.regions) throw new Error('Region limit reached');
    this.regions.set(region.id, region);
    try { this.persist(); } catch (error) { this.regions.delete(region.id); throw error; }
    return text({region, volume: volume(region.box), world_modified: false});
  }); }
  createPlan(input) { return this.run(async () => {
    const parsed = buildPlanSchema.parse(input); const region = this.regions.get(parsed.region_id);
    if (!region) throw new Error('Register the build region first');
    if (this.plans.size >= BUILD_LIMITS.plans) throw new Error('Plan journal limit reached; archive the local journal before starting another session');
    const id = identifier.parse(parsed.id ?? `plan_${this.idFactory()}`);
    if (this.plans.has(id)) throw new Error('Plan id already exists');
    const operations = normalizedOperations(region, parsed.operations);
    const total = operations.reduce((n, op) => n + volume(operationBox(op)), 0);
    if (total > BUILD_LIMITS.blocks) throw new Error('Total operation volume exceeds 4096 blocks, including repeated writes');
    const session_id = await this.identity(); const before = await this.scan(region);
    // A snapshot can restore only the admitted lab palette. Refuse unknown/unsafe
    // pre-existing blocks instead of deleting their NBT or restoring explosives.
    for (const state of before.values()) allowed(state);
    let expected = before;
    for (const op of operations) expected = evolve(expected, op);
    const plan = {id, region: copy(region), label: parsed.label, operations, session_id, status: 'planned',
      created_at: new Date(this.clock()).toISOString(), before: [...before], expected: [...expected], before_fingerprint: fingerprint(before)};
    this.plans.set(id, plan);
    try { this.persist(); } catch (error) { this.plans.delete(id); throw error; }
    return text({...this.describe(plan), planned_write_volume: total, before: summary(before), expected: summary(expected), world_modified: false,
      ...(!session_id ? {limitation: 'Session identity missing; inspect plans freely, but apply requires a fresh plan bound to the updated bridge.'} : {})});
  }); }
  preview(input) { return this.run(async () => {
    const plan = this.plan(input); const current = await this.scan(plan.region); const current_fingerprint = fingerprint(current);
    return text({...this.describe(plan), current_fingerprint, baseline_changed: current_fingerprint !== plan.before_fingerprint,
      current: summary(current), expected: summary(new Map(plan.expected)), operations: plan.operations.slice(0, 16), omitted_operations: Math.max(0, plan.operations.length - 16),
      world_modified: false, note: 'Preview does not refresh the baseline or authorize an overwrite. Create a fresh plan if this region changed.'});
  }); }
  async command(tool, args, expected) {
    const result = await this.bridge.call('world', tool, args);
    const answer = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result?.isError || !answer || !expected.test(answer)) throw new Error(`${tool}: ${brief(answer ?? 'missing acknowledgement')}`);
  }
  async save(plan) {
    const token = String(this.idFactory()).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!token) throw new Error('Invalid snapshot id');
    plan.snapshot = `mcredstone:undo/${token}`;
    await this.command('structure_save_from_world', {name: plan.snapshot, dimension: plan.region.dimension, box: plan.region.box, include_entities: false}, /^saved /);
    const metadata = parseReading(await this.bridge.call('world', 'structure_get_info', {name: plan.snapshot}));
    if (metadata.name !== plan.snapshot || !metadata.onDisk || !axes.every(k => metadata[`size${k.toUpperCase()}`] === plan.region.box.to[k] - plan.region.box.from[k] + 1)) throw new Error('Snapshot was not confirmed on disk with the expected size');
    this.persist();
  }
  async restore(plan) {
    await this.checkIdentity(plan);
    const metadata = parseReading(await this.bridge.call('world', 'structure_get_info', {name: plan.snapshot}));
    if (metadata.name !== plan.snapshot || !metadata.onDisk || !axes.every(k => metadata[`size${k.toUpperCase()}`] === plan.region.box.to[k] - plan.region.box.from[k] + 1)) throw new Error('Saved snapshot is missing or its dimensions changed; restore refused');
    await this.command('structure_load_to_world', {name: plan.snapshot, dimension: plan.region.dimension, origin: plan.region.box.from,
      rotation: 'none', mirror: 'none', include_entities: false, integrity: 1}, /^placed /);
  }
  async execute(region, op) {
    if (op.op === 'set') return this.command('block_set_state', {dimension: region.dimension, position: op.position, block: op.block}, /^(placed |no change$)/);
    if (op.op === 'fill') return this.command('block_fill_region', {dimension: region.dimension, box: op.box, block: op.block, mode: 'replace'}, /^filled \d+ block\(s\)$/);
    return this.command('block_clone_region', {source_dimension: region.dimension, source_box: op.source_box, dest_dimension: region.dimension, destination: op.destination, mode: 'normal'}, /^cloned \d+ block\(s\)$/);
  }
  async executeGroup(region, group) {
    if (group.length === 1) return this.execute(region, group[0]);
    const fills = group.map(op => {
      const b = operationBox(op); const properties = Object.entries(op.block.properties);
      return {from: axes.map(k => b.from[k]), to: axes.map(k => b.to[k]),
        block: op.block.id + (properties.length ? `[${properties.map(([k, v]) => `${k}=${v}`).join(',')}]` : ''), mode: 'replace'};
    });
    const reading = parseReading(await this.bridge.call('world', 'block_fill_batch', {dimension: region.dimension, fills, default_mode: 'replace'}));
    if (reading.fills_applied !== group.length || !Number.isSafeInteger(reading.blocks_changed) || reading.blocks_changed < 0) throw new Error('Batch did not acknowledge every planned fill');
  }
  apply(input) { return this.run(async () => {
    const plan = this.plan(input);
    if (plan.status !== 'planned') throw new Error(`Plan is ${plan.status}; an apply is never replayed`);
    await this.checkIdentity(plan);
    const before = await this.scan(plan.region);
    if (fingerprint(before) !== plan.before_fingerprint) throw new Error('Build region changed after planning; create a fresh plan before applying');
    await this.save(plan);
    await this.checkIdentity(plan);
    if (fingerprint(await this.scan(plan.region)) !== plan.before_fingerprint) throw new Error('Build region changed while saving its snapshot; no block operation was started');
    plan.status = 'applying'; plan.completed_operations = 0; this.persist();
    const candidates = new Map([...before].map(([at, state]) => [at, [state]]));
    let evolving = before;
    try {
      for (const group of executionGroups(plan.operations)) {
        await this.checkIdentity(plan);
        for (const op of group) {
          evolving = evolve(evolving, op);
          for (const p of positions(operationBox(op))) candidates.get(key(p)).push(evolving.get(key(p)));
        }
        await this.executeGroup(plan.region, group);
        plan.completed_operations += group.length; this.persist();
      }
      const after = await this.scan(plan.region); plan.after_fingerprint = fingerprint(after);
      const verification = compare(after, new Map(plan.expected));
      plan.status = verification.matches ? 'applied' : 'applied_unverified'; plan.verification = verification; this.persist();
      return text({...this.describe(plan), completed_operations: plan.completed_operations, verification, observed: summary(after),
        note: 'Readback checks block IDs and requested states, not circuit behavior or timing.'});
    } catch (error) {
      plan.error = brief(error); plan.status = 'partial'; this.persist();
      let rollback;
      try {
        await this.checkIdentity(plan);
        const current = await this.scan(plan.region); const current_fingerprint = fingerprint(current);
        plan.after_fingerprint = current_fingerprint;
        const unexpected = [...current].filter(([at, state]) => !candidates.get(at).some(candidate => matches(state, candidate)));
        if (unexpected.length) {
          plan.undo_requires_fingerprint = true;
          rollback = {status: 'conflict', unexpected_blocks: unexpected.length, note: 'Unexpected edits or dynamic state changes; no automatic restore attempted. Inspect, then undo using the exact current fingerprint if restoration is intended.'};
        } else {
          if (fingerprint(await this.scan(plan.region)) !== current_fingerprint) throw new Error('World changed during rollback check');
          plan.status = 'rolling_back'; this.persist(); await this.restore(plan);
          const restored = await this.scan(plan.region); const verified = fingerprint(restored) === plan.before_fingerprint;
          plan.after_fingerprint = fingerprint(restored); plan.status = verified ? 'rolled_back' : 'rollback_unverified';
          rollback = {status: plan.status, verified};
        }
      } catch (rollbackError) { plan.status = 'partial'; rollback = {status: 'unavailable', error: brief(rollbackError)}; }
      this.persist();
      return {isError: true, ...text({...this.describe(plan), completed_operations: plan.completed_operations, rollback})};
    }
  }); }
  verify(input) { return this.run(async () => {
    const plan = this.plan(input); await this.checkIdentity(plan);
    const current = await this.scan(plan.region); const current_fingerprint = fingerprint(current);
    const expected = new Map(['undone', 'rolled_back'].includes(plan.status) ? plan.before : plan.expected);
    return text({...this.describe(plan), current_fingerprint, changed_since_last_observation: plan.after_fingerprint ? current_fingerprint !== plan.after_fingerprint : null,
      verification: compare(current, expected), observed: summary(current), note: 'Verification does not change the undo baseline. Simulation dynamics may change block properties.'});
  }); }
  undo(input) { return this.run(async () => {
    const parsed = buildUndoSchema.parse(input); const plan = this.plan({plan_id: parsed.plan_id});
    if (!plan.snapshot || !['applied', 'applied_unverified', 'partial', 'interrupted', 'rollback_unverified', 'undo_unverified'].includes(plan.status)) throw new Error('This plan has no applied snapshot eligible for undo');
    await this.checkIdentity(plan);
    const current = await this.scan(plan.region); const current_fingerprint = fingerprint(current);
    const expected = parsed.expected_fingerprint ?? (plan.undo_requires_fingerprint ? null : plan.after_fingerprint);
    if (!expected || current_fingerprint !== expected) return text({...this.describe(plan), status: 'undo_conflict', current_fingerprint, expected_fingerprint: expected ?? null,
      world_modified: false, note: 'Inspect the region. To intentionally restore this snapshot over these observed changes, pass this exact current_fingerprint as expected_fingerprint.'});
    // Persist the undo start before mutation. Interrupted restores are never replayed.
    plan.status = 'undoing'; this.persist();
    try {
      await this.restore(plan);
      const after = await this.scan(plan.region); plan.after_fingerprint = fingerprint(after);
      const verified = plan.after_fingerprint === plan.before_fingerprint;
      plan.status = verified ? 'undone' : 'undo_unverified'; this.persist();
      return text({...this.describe(plan), restored: verified, verification: compare(after, new Map(plan.before))});
    } catch (error) {
      plan.status = 'partial'; plan.undo_requires_fingerprint = true; plan.error = `Undo failed: ${brief(error)}`;
      try { plan.after_fingerprint = fingerprint(await this.scan(plan.region)); } catch { plan.after_fingerprint = null; }
      this.persist(); return {isError: true, ...text(this.describe(plan))};
    }
  }); }
}
