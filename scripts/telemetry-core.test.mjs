import test from 'node:test';
import assert from 'node:assert/strict';
import { compactProjection, DeltaCache } from './telemetry-core.mjs';

const json = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('snapshot, exact numeric changes, unchanged, removals, null and root changes', () => {
  const cache = new DeltaCache();
  assert.equal(cache.sample('world', { power: 1, position: 0.00001, obsolete: true }).kind, 'snapshot');
  const changed = cache.sample('world', { power: 2, position: 0.00002, value: null });
  assert.deepEqual(json(changed), { kind: 'delta', watchId: 'world', set: [
    { path: '/position', value: 0.00002 }, { path: '/power', value: 2 }, { path: '/value', value: null },
  ], remove: ['/obsolete'] });
  assert.equal(cache.sample('world', { value: null, position: 0.00002, power: 2 }).kind, 'unchanged');
  assert.deepEqual(cache.sample('world', null).set, [{ path: '', value: null }]);
  assert.equal(cache.sample('world', null).kind, 'unchanged');
});

test('default projection removes payload aliases recursively but preserves component names', () => {
  const source = { nbt: 'large', components: { huge: true }, nested: { snbt: 'x', block_entity_nbt: 'x',
    blockEntityNbt: 'x', raw_nbt: 'x', component_names: ['power'], componentKeys: ['name'], power: 15 } };
  assert.deepEqual(json(compactProjection(source)), { nested: { componentKeys: ['name'], component_names: ['power'], power: 15 } });
  assert.equal(source.nbt, 'large');
});

test('explicit paths distinguish absent and null and can explicitly request payloads', () => {
  const source = { player: { position: null, facing: { yaw: 12.001 }, nbt: '{test:1}' } };
  assert.deepEqual(json(compactProjection(source, ['player.position', 'player.missing', 'player.facing.yaw', 'player.nbt'])),
    { player: { position: null, nbt: '{test:1}', facing: { yaw: 12.001 } } });
  assert.deepEqual(json(compactProjection(source, ['toString', 'constructor.prototype', 'missing'])), {});
  assert.throws(() => compactProjection(source, ['player..position']), TypeError);
});

test('inventory slot arrays normalize to stable maps, including reorder and removal', () => {
  const cache = new DeltaCache();
  const first = compactProjection({ slots: [{ slot: 2, id: 'redstone', count: 8 }, { slot: 9, id: 'stone', count: 2 }] });
  assert.deepEqual(json(first), { slots: { 2: { slot: 2, id: 'redstone', count: 8 }, 9: { slot: 9, id: 'stone', count: 2 } } });
  cache.sample('inventory', first);
  assert.equal(cache.sample('inventory', compactProjection({ slots: [{ slot: 9, id: 'stone', count: 2 }, { slot: 2, id: 'redstone', count: 8 }] })).kind, 'unchanged');
  const next = cache.sample('inventory', compactProjection({ slots: [{ slot: 2, id: 'redstone', count: 7 }] }));
  assert.deepEqual(json(next.set), [{ path: '/slots/2/count', value: 7 }]);
  assert.deepEqual(next.remove, ['/slots/9']);
  assert.deepEqual(cache.sample('inventory', compactProjection({ slots: [] })).remove, ['/slots/2']);
  assert.deepEqual(json(compactProjection({ slots: [{ slot: 2, components: { kept: true } }] }, ['slots'])),
    { slots: { 2: { slot: 2, components: { kept: true } } } });
});

test('duplicate slot identifiers are retained as arrays, without silently dropping a slot', () => {
  const source = { slots: [{ slot: 2, id: 'a' }, { slot: 2, id: 'b' }] };
  assert.deepEqual(json(compactProjection(source)), source);
});

test('upstream implicit-index inventories retain slot positions and emit a single count delta', () => {
  const cache = new DeltaCache();
  const first = { size: 3, slots: [
    { id: 'minecraft:air', count: 0, componentKeys: [] },
    { id: 'minecraft:redstone', count: 64, componentKeys: ['minecraft:max_stack_size'] },
    { id: 'minecraft:stone', count: 12, componentKeys: [] },
  ] };
  assert.ok(Array.isArray(compactProjection(first).slots));
  cache.sample('slots', compactProjection(first));
  const changed = structuredClone(first);
  changed.slots[1].count = 63;
  assert.deepEqual(json(cache.sample('slots', compactProjection(changed)).set), [{ path: '/slots/1/count', value: 63 }]);
  changed.slots[1] = { id: 'minecraft:air', count: 0, componentKeys: [] };
  const removedItem = cache.sample('slots', compactProjection(changed));
  assert.deepEqual(json(removedItem.set), [
    { path: '/slots/1/componentKeys', value: [] },
    { path: '/slots/1/count', value: 0 },
    { path: '/slots/1/id', value: 'minecraft:air' },
  ]);
  assert.deepEqual(removedItem.remove, []);
});

test('oversize is UTF-8 bounded and retains previous delivered baseline', () => {
  const cache = new DeltaCache();
  cache.sample('w', { value: 'old', retained: 4 });
  const huge = cache.sample('w', { value: '🐢'.repeat(1000), retained: 5 }, { maxBytes: 90 });
  assert.equal(huge.kind, 'oversize');
  assert.ok(bytes(huge) <= 90);
  const retry = cache.sample('w', { value: 'small', retained: 5 });
  assert.deepEqual(json(retry.set), [{ path: '/retained', value: 5 }, { path: '/value', value: 'small' }]);
  const fresh = new DeltaCache();
  assert.equal(fresh.sample('w', '🐢'.repeat(1000), { maxBytes: 20 }).kind, 'oversize');
  assert.equal(fresh.sample('w', 'small').kind, 'snapshot');
  assert.throws(() => fresh.sample('w', 1, { maxBytes: 2 }), RangeError);
});

test('byte budget measures multibyte contents rather than character count', () => {
  const record = { kind: 'snapshot', watchId: 'w', value: '🐢🐢🐢' };
  const cache = new DeltaCache();
  assert.ok(bytes(record) > JSON.stringify(record).length);
  assert.equal(cache.sample('w', record.value, { maxBytes: JSON.stringify(record).length }).kind, 'oversize');
  assert.equal(cache.sample('w', record.value, { maxBytes: bytes(record) }).kind, 'snapshot');
});

test('special keys stay own data properties and RFC6901 pointers escape slash and tilde', () => {
  const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"a/b":{"~key":1}}');
  const projected = compactProjection(source);
  assert.equal(Object.getPrototypeOf(projected), null);
  assert.equal(projected.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(json(compactProjection(source, ['__proto__.polluted', 'constructor.prototype.x'])),
    JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}'));
  const cache = new DeltaCache();
  cache.sample('__proto__', projected);
  const next = compactProjection(JSON.parse('{"a/b":{"~key":2}}'));
  const delta = cache.sample('__proto__', next);
  assert.deepEqual(json(delta.set), [{ path: '/a~1b/~0key', value: 2 }]);
  assert.deepEqual(delta.remove, ['/__proto__', '/constructor']);
  assert.equal({}.polluted, undefined);
});

test('input/returned mutations cannot change the cache; full and selective/global reset work', () => {
  const cache = new DeltaCache();
  const source = { nested: { value: 1 } };
  const first = cache.sample('a', source);
  source.nested.value = 5;
  first.value.nested.value = 6;
  assert.equal(cache.sample('a', { nested: { value: 1 } }).kind, 'unchanged');
  assert.equal(cache.sample('a', { nested: { value: 1 } }, { full: true }).kind, 'snapshot');
  cache.sample('b', 2);
  cache.reset('a');
  assert.equal(cache.sample('a', 1).kind, 'snapshot');
  assert.equal(cache.sample('b', 2).kind, 'unchanged');
  cache.reset();
  assert.equal(cache.sample('b', 2).kind, 'snapshot');
});

test('generic arrays preserve shape and length changes replace their whole value', () => {
  const cache = new DeltaCache();
  cache.sample('a', { xs: [1, 2, 3] });
  assert.deepEqual(json(cache.sample('a', { xs: [1, 3] }).set), [{ path: '/xs', value: [1, 3] }]);
  assert.deepEqual(json(cache.sample('a', { xs: [1, 4] }).set), [{ path: '/xs/1', value: 4 }]);
});

test('invalid data rejects rather than silently losing fields or executing getters', () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked = true; return 1; } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, { x: undefined }, NaN, Infinity, 2n, new Date(), cyclic, [1, , 3], accessor]) {
    assert.throws(() => compactProjection(value), TypeError);
  }
  assert.equal(invoked, false);
});

test('canonical request keys sort dictionaries but retain array order and exact arguments', async () => {
  const {canonicalJson} = await import('./telemetry-core.mjs');
  assert.equal(canonicalJson({b: 1, a: {z: 3, x: 2}}), canonicalJson({a: {x: 2, z: 3}, b: 1}));
  assert.notEqual(canonicalJson({nbt: 1}), canonicalJson({}));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.throws(() => canonicalJson({x: undefined}), TypeError);
  let invoked = false;
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'x', {enumerable: true, get() { invoked = true; }})), TypeError);
  assert.equal(invoked, false);
});
