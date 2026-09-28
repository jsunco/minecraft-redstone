import test from 'node:test';
import assert from 'node:assert/strict';
import { latencySummary, parseArguments, runLiveBenchmark, validateWorkload } from './live-benchmark.mjs';

const positions = [{x: 12345, y: 64, z: 67890}, {x: 12346, y: 64, z: 67890}];
const workload = {dimension: 'minecraft:overworld', positions, rounds: 4, warmup_rounds: 1};
function fixture({changing = false, paused = false, changedSession = false, unloaded = false, wrongPosition = false, singleFace = null} = {}) {
  let time = 0, batches = 0; const calls = [];
  const state = () => ({id: singleFace ? 'minecraft:lever' : 'minecraft:secret_fixture', properties: {powered: changing ? String(batches % 2 === 0) : 'false', ...(singleFace ? {face: 'floor'} : {})}});
  return {calls, now: () => time, sleep: async ms => {time += ms;}, bridge: {call: async (source, tool, args) => {
    calls.push({source, tool, args, started: time}); time += 10;
    if (tool === 'block_get_states_batch') {
      batches++;
      return {structuredContent: {session_id: changedSession && batches > 3 ? 'different-secret' : 'private-session-secret',
        dimension: args.dimension, server_tick: paused ? 100 : 100 + batches, atomic: true, phase: 'server_task',
        states: args.positions.map((position, index) => ({index, position, status: unloaded ? 'unloaded' : 'loaded', ...state()}))}};
    }
    assert.equal(tool, 'block_get_state');
    const single = state(); if (singleFace) single.properties.face = singleFace;
    return {structuredContent: {...single, position: wrongPosition ? {x: 0, y: 0, z: 0} : args.position, lightLevel: 0, hardness: 0}};
  }}};
}

test('read-only paired live benchmark counts requests and reports no raw world identities', async () => {
  const f = fixture(); const result = await runLiveBenchmark(f.bridge, workload, {now: f.now, sleep: f.sleep});
  assert.deepEqual(result.measured_requests, {individual: 8, batch: 4});
  assert.equal(result.latency.sequential_individual.p50_ms, 20);
  assert.equal(result.latency.atomic_batch.p50_ms, 10);
  assert.equal(result.latency.median_speedup, 2);
  assert.deepEqual(result.selected_state_encoding.sample_kinds, {snapshot: 1, unchanged: 3});
  assert.equal(result.observations.paired_selected_states_equal, 4);
  assert.ok(result.selected_state_encoding.exact_delta_bytes < result.selected_state_encoding.repeated_full_bytes);
  assert.equal(f.calls.length, 16);
  assert.ok(f.calls.slice(1).every((call, index) => call.started - f.calls[index].started >= 125));
  assert.ok(f.calls.every(call => call.source === 'world' && ['block_get_state', 'block_get_states_batch'].includes(call.tool)));
  const serialized = JSON.stringify(result);
  for (const secret of ['12345', '67890', 'private-session-secret', 'secret_fixture']) assert.ok(!serialized.includes(secret));
});

test('changing states are counted without being called an atomic match or omitted', async () => {
  const f = fixture({changing: true}); const result = await runLiveBenchmark(f.bridge, workload, {now: f.now, sleep: f.sleep});
  assert.ok(result.observations.paired_selected_states_different > 0);
  assert.equal(result.selected_state_encoding.sample_kinds.delta, 3);
});

test('known Java lever enum spellings compare semantically without hiding different states', async () => {
  for (const [singleFace, expectedEqual] of [['FLOOR', 4], ['WALL', 0], ['unknown', 0]]) {
    const f = fixture({singleFace}), result = await runLiveBenchmark(f.bridge, workload, {now: f.now, sleep: f.sleep});
    assert.equal(result.observations.paired_selected_states_equal, expectedEqual);
    assert.match(result.comparison_normalization, /Raw byte totals remain unchanged/);
  }
});

test('unloaded blocks, inconsistent coordinates, paused ticks, and changed session reject results', async () => {
  for (const scenario of [{unloaded: true}, {wrongPosition: true}, {paused: true}, {changedSession: true}]) {
    const f = fixture(scenario);
    await assert.rejects(runLiveBenchmark(f.bridge, workload, {now: f.now, sleep: f.sleep}));
  }
});

test('bounded workload validation rejects malformed positions and options before contacting bridge', async () => {
  for (const patch of [{positions: []}, {positions: [positions[0], positions[0]]}, {positions: [{x: 0.5, y: 0, z: 0}]},
    {positions: [{x: 30_000_001, y: 0, z: 0}]}, {rounds: 51}, {warmup_rounds: 0}, {dimension: 'mod:custom'}, {token: 'secret'}]) {
    const f = fixture(); await assert.rejects(runLiveBenchmark(f.bridge, {...workload, ...patch}, {now: f.now, sleep: f.sleep})); assert.equal(f.calls.length, 0);
  }
  assert.equal(validateWorkload({positions}).rounds, 20);
});

test('quantiles and CLI arguments are deterministic and bounded', () => {
  assert.deepEqual(latencySummary([50, 10, 40, 20, 30]), {samples: 5, min_ms: 10, p50_ms: 30, p95_ms: 50, max_ms: 50, mean_ms: 30});
  assert.throws(() => latencySummary([])); assert.throws(() => latencySummary([NaN]));
  assert.equal(parseArguments(['--help']).help, true);
  assert.throws(() => parseArguments([])); assert.throws(() => parseArguments(['--workload', 'one', '--workload', 'two']));
});
