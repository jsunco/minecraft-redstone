#!/usr/bin/env node
/** Read-only live measurement. No block writes, screenshots, or remote uploads. */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, parseReading } from './telemetry-service.mjs';
import { DeltaCache, canonicalJson } from './telemetry-core.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const round = value => Number(value.toFixed(3));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointKey = point => `${point.x},${point.y},${point.z}`;
const validPoint = point => record(point) && Object.keys(point).length === 3 &&
  ['x', 'y', 'z'].every(axis => Number.isInteger(point[axis])) &&
  Math.abs(point.x) <= 30_000_000 && Math.abs(point.z) <= 30_000_000 && Math.abs(point.y) <= 2048;

export function validateWorkload(input) {
  if (!record(input) || Object.keys(input).some(key => !['dimension', 'positions', 'rounds', 'warmup_rounds'].includes(key))) throw new Error('Invalid benchmark workload fields.');
  const {dimension = 'minecraft:overworld', positions, rounds = 20, warmup_rounds = 2} = input;
  if (!/^minecraft:(overworld|the_nether|the_end)$/.test(dimension)) throw new Error('Benchmark requires a vanilla dimension.');
  if (!Array.isArray(positions) || positions.length < 1 || positions.length > 64 || !positions.every(validPoint) || new Set(positions.map(pointKey)).size !== positions.length) throw new Error('Benchmark requires 1..64 distinct integer block positions.');
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 50 || !Number.isInteger(warmup_rounds) || warmup_rounds < 1 || warmup_rounds > 5) throw new Error('Benchmark requires 2..50 rounds and 1..5 warmup rounds.');
  return {dimension, positions: structuredClone(positions), rounds, warmup_rounds};
}

export function latencySummary(samples) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid latency samples.');
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {samples: samples.length, min_ms: round(sorted[0]), p50_ms: round(quantile(0.5)),
    p95_ms: round(quantile(0.95)), max_ms: round(sorted.at(-1)), mean_ms: round(samples.reduce((a, b) => a + b, 0) / samples.length)};
}

function selectedState(value, {individual = false} = {}) {
  if (!record(value) || typeof value.id !== 'string' || !record(value.properties) ||
      Object.values(value.properties).some(property => typeof property !== 'string')) throw new Error('Invalid live block reading.');
  const properties = {...value.properties};
  // The vendored generic reader uses Java enum.toString(); the native reader
  // uses Minecraft's serialized valueName(). Live lever reads exposed FLOOR
  // versus floor. Normalize only this known equivalence, never arbitrary text.
  if (individual && value.id === 'minecraft:lever' && ['FLOOR', 'WALL', 'CEILING'].includes(properties.face)) properties.face = properties.face.toLowerCase();
  return {id: value.id, properties};
}

/** Returns aggregate metrics only. World identifiers/state never leave this function. */
export async function runLiveBenchmark(bridge, input, {now = () => performance.now(), sleep = delay} = {}) {
  const workload = validateWorkload(input);
  const {dimension, positions, rounds, warmup_rounds: warmups} = workload;
  let session, lastTick = -1, firstTick;
  const start = now();
  let nextRequest = -Infinity;
  const call = async (tool, args) => {
    const wait = nextRequest - now(); if (wait > 0) await sleep(wait);
    const started = now(); nextRequest = started + 125; // At most 480/minute, below the installed 600/minute cap.
    const response = await bridge.call('world', tool, args);
    return {response, elapsed: now() - started};
  };
  const batch = async () => {
    const started = now();
    const {response, elapsed} = await call('block_get_states_batch', {dimension, positions});
    const value = parseReading(response);
    if (value.atomic !== true || value.phase !== 'server_task' || value.dimension !== dimension ||
        typeof value.session_id !== 'string' || !value.session_id || !Number.isSafeInteger(value.server_tick) || value.server_tick < 0 || value.server_tick < lastTick ||
        !Array.isArray(value.states) || value.states.length !== positions.length) throw new Error('Invalid or non-atomic live batch.');
    if (session && value.session_id !== session) throw new Error('World session changed during measurement.');
    session = value.session_id; lastTick = value.server_tick; firstTick ??= lastTick;
    const states = value.states.map((state, index) => {
      if (state.index !== index || !validPoint(state.position) || pointKey(state.position) !== pointKey(positions[index]) || state.status !== 'loaded') throw new Error('Benchmark positions must remain loaded and ordered.');
      return selectedState(state);
    });
    return {elapsed, wallElapsed: now() - started, durations: [elapsed], bytes: bytes(response), states, tick: lastTick};
  };
  const individual = async () => {
    const started = now(); let payloadBytes = 0; const states = [], durations = [];
    for (const position of positions) {
      const {response, elapsed} = await call('block_get_state', {dimension, position}); durations.push(elapsed);
      payloadBytes += bytes(response);
      const state = parseReading(response);
      if (!validPoint(state.position) || pointKey(state.position) !== pointKey(position)) throw new Error('Invalid live single-block coordinates.');
      states.push(selectedState(state, {individual: true}));
    }
    return {elapsed: durations.reduce((a, b) => a + b, 0), wallElapsed: now() - started, durations, bytes: payloadBytes, states};
  };
  // Warm up both paths including the initial connection; excluded from results.
  for (let i = 0; i < warmups; i++) { await batch(); await individual(); }
  const timings = {individual: [], batch: []};
  const wallTimings = {individual: [], batch: []}, requestTimings = {individual: [], batch: []};
  const payloads = {individual: 0, batch: 0};
  const delta = new DeltaCache(); let fullBytes = 0, deltaBytes = 0, matching = 0;
  const kinds = {};
  const measuredStart = now();
  const measuredStartTick = lastTick;
  for (let i = 0; i < rounds; i++) {
    // Alternate order to reduce simple drift/order bias. These are never same-tick paired reads.
    const values = i % 2 ? {batch: await batch(), individual: await individual()} : {individual: await individual(), batch: await batch()};
    for (const key of ['individual', 'batch']) {
      timings[key].push(values[key].elapsed); wallTimings[key].push(values[key].wallElapsed);
      requestTimings[key].push(...values[key].durations); payloads[key] += values[key].bytes;
    }
    if (canonicalJson(values.individual.states) === canonicalJson(values.batch.states)) matching++;
    const tick = values.batch.tick - firstTick;
    const full = {tick, kind: 'snapshot', watchId: 'blocks', value: values.batch.states};
    const compact = {tick, ...delta.sample('blocks', values.batch.states, {maxBytes: 1_000_000})};
    if (compact.kind === 'oversize') throw new Error('Benchmark selected-state payload is too large.');
    fullBytes += bytes(full); deltaBytes += bytes(compact); kinds[compact.kind] = (kinds[compact.kind] ?? 0) + 1;
  }
  // A final batch verifies the session after a possible last individual run.
  const final = await batch();
  const measuredMs = now() - measuredStart;
  if (final.tick <= measuredStartTick) throw new Error('Minecraft ticks did not advance; unpause the world before measuring.');
  const single = latencySummary(timings.individual), batched = latencySummary(timings.batch);
  return {
    benchmark: 'live-read-only-v1', observed_at: new Date().toISOString(),
    workload: {blocks_per_round: positions.length, rounds_per_path: rounds, warmup_rounds_per_path: warmups, order: 'alternating paired paths', persistent_connection: true, min_request_interval_ms: 125},
    latency: {measurement: 'Sum of upstream call wall times per block workload; intentional rate-limit waits excluded.',
      sequential_individual: single, atomic_batch: batched, median_speedup: batched.p50_ms > 0 ? round(single.p50_ms / batched.p50_ms) : null},
    per_request_latency: {sequential_individual: latencySummary(requestTimings.individual), atomic_batch: latencySummary(requestTimings.batch)},
    workload_wall_latency_including_rate_limit_waits: {sequential_individual: latencySummary(wallTimings.individual), atomic_batch: latencySummary(wallTimings.batch)},
    measured_requests: {individual: rounds * positions.length, batch: rounds},
    overhead_requests: {individual_warmup: warmups * positions.length, batch_warmup_and_final: warmups + 1},
    response_object_json_bytes: {sequential_individual: payloads.individual, atomic_batch: payloads.batch},
    selected_state_encoding: {same_batch_samples: rounds, repeated_full_bytes: fullBytes, exact_delta_bytes: deltaBytes,
      reduction_percent: round(100 * (1 - deltaBytes / fullBytes)), sample_kinds: kinds},
    observations: {paired_selected_states_equal: matching, paired_selected_states_different: rounds - matching,
      server_ticks_elapsed: final.tick - measuredStartTick, measured_elapsed_including_final_probe_ms: round(measuredMs), total_elapsed_ms: round(now() - start)},
    comparison_normalization: 'Only vanilla lever face Java enum names FLOOR/WALL/CEILING from individual reads map to serialized floor/wall/ceiling. Raw byte totals remain unchanged; all other state values compare exactly.',
    limitations: [
      'Live localhost MCP reads only; no comparison to a CLI, binary socket, screenshots, or model turnaround.',
      'Individual reads span separate server tasks; batch reads are atomic within one task. Paired paths sample different times.',
      'Latency includes server scheduling and tool work; it does not isolate MCP or network overhead.',
      'Requests start at least 125ms apart. Per-workload active latency sums call durations; the separately reported full wall latency also includes intentional rate-limit waits.',
      'Response-object JSON bytes exclude HTTP headers and framing. Individual reads include light, hardness and possible NBT that the batch omits.',
      'Selected-state full versus deltas encodes the exact same batch samples with the same tick marker; this is local serialization, not a measured assistant response.',
      'UTF-8 bytes are not model tokens, money, quota, or observed end-to-end context savings. An unchanged scene may yield unusually large reductions.',
      'No transport replacement or performance superiority beyond this workload is established.',
    ],
  };
}

export function parseArguments(argv) {
  const result = {}; const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error('Duplicate benchmark option.'); seen.add(flag);
    if (flag === '--help' || flag === '-h') result.help = true;
    else if (['--workload', '--output'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[flag.slice(2)] = resolve(argv[++i]);
    else throw new Error('Use --workload FILE [--output NEW_FILE].');
  }
  if (!result.help && !result.workload) throw new Error('A private workload JSON file is required.');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bridge = new Bridge();
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) console.log('Usage: node scripts/live-benchmark.mjs --workload PRIVATE_JSON [--output NEW_FILE]\nWorkload: {"dimension":"minecraft:overworld","positions":[{"x":0,"y":64,"z":0}],"rounds":20,"warmup_rounds":2}\nReads only loaded blocks. Reports anonymous aggregates; never writes blocks or changes player controls. Output files are created exclusively with mode 0600.');
    else {
      const raw = readFileSync(args.workload, 'utf8'); if (Buffer.byteLength(raw) > 32768) throw new Error('Workload file too large.');
      const result = await runLiveBenchmark(bridge, JSON.parse(raw)); const report = `${JSON.stringify(result, null, 2)}\n`;
      if (args.output) writeFileSync(args.output, report, {flag: 'wx', mode: 0o600});
      console.log(report);
    }
  } catch { console.error('Live benchmark failed; check the workload, loaded world, unpaused ticks, and local bridge configuration. No raw world or credential data was printed.'); process.exitCode = 1; }
  finally { await bridge.close(); }
}
