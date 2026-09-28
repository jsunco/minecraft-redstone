#!/usr/bin/env node
/**
 * Deterministic MOCK payload benchmark. Does not contact Minecraft or measure tokens.
 * Run: node scripts/telemetry-benchmark.mjs
 * The backoff case intentionally observes less frequently; deferred samples must
 * never be read as proof that nothing changed between observations.
 */
import { TelemetryService } from './telemetry-service.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const decode = result => JSON.parse(result.content[0].text);
const watches = [
  {id: 'position', source: 'client', tool: 'client_status', fields: ['player.position']},
  {id: 'screen', source: 'client', tool: 'client_status', fields: ['screen']},
  {id: 'inventory', source: 'world', tool: 'player_get_inventory'},
  {id: 'output', source: 'world', tool: 'block_get_state', arguments: {dimension: 'minecraft:overworld', pos: {x: 3, y: 64, z: 2}}},
];
const fixture = tool => {
  if (tool === 'client_status') return {player: {position: {x: 4.25, y: 65, z: -2.5}, name: 'fixture-player'},
    screen: {type: 'none'}, resource_details: 'fixture detail '.repeat(200)};
  if (tool === 'player_get_inventory') return {slots: Array.from({length: 9}, (_,slot) => ({slot,
    id: slot % 2 ? 'minecraft:redstone' : 'minecraft:stone', count: 64,
    components: {fixture: 'nonessential inventory payload '.repeat(60)}}))};
  return {id: 'minecraft:redstone_wire', properties: {power: 0, north: 'side', south: 'side', east: 'none', west: 'none'}};
};
const reply = tool => ({content: [{type: 'text', text: JSON.stringify(fixture(tool))}]});
const polls = 25;
const intervalMs = 5000;
const directPayloadBytes = Array.from({length: polls}, () => watches.reduce((sum, w) => sum + bytes(reply(w.tool)), 0)).reduce((a,b) => a+b, 0);
const cases = [];
for (const backoff of [false, true]) {
  let now = 0;
  const bridge = {call: async (_source, tool) => reply(tool), close: async () => {}};
  const service = new TelemetryService(bridge, () => now);
  await service.configure({mode: 'data', watches, no_change_backoff: backoff});
  const kinds = {};
  for (let index = 0; index < polls; index++) {
    now = index * intervalMs;
    const result = decode(await service.poll());
    for (const sample of result.samples) kinds[sample.kind] = (kinds[sample.kind] ?? 0) + 1;
  }
  cases.push({name: backoff ? 'compact_with_no_change_backoff' : 'compact_every_poll',
    measurements: service.metrics, sample_kinds: kinds,
    delivered_payload_reduction_percent: Number((100 * (1 - service.metrics.delivered_text_bytes / directPayloadBytes)).toFixed(2)),
    upstream_read_reduction_percent: Number((100 * (1 - service.metrics.upstream_reads / (watches.length * polls))).toFixed(2)),
    observation_semantics: backoff
      ? 'Fewer fresh observations; explicit deferred responses report their age. Does not provide equal temporal coverage to raw polling.'
      : 'All watches read each poll; identical requests share one observation. Separate requests are not atomic.'});
}
console.log(JSON.stringify({benchmark: 'synthetic-mock-v1',
  environment: 'Injected JavaScript fixtures and deterministic clock; no Minecraft bridge or screenshots',
  workload: {polls, interval_ms: intervalMs, elapsed_simulated_ms: (polls - 1) * intervalMs,
    watches: watches.length, unique_requests_per_poll: 3, changes: 0,
    fixture: 'Two projected views of the same client read, 9 inventory slots with bulky components, one redstone output block'},
  baseline: {name: 'raw_repeated_MCP_payloads', upstream_reads: watches.length * polls, delivered_payload_bytes: directPayloadBytes},
  cases, limitations: [
    'UTF-8 JSON payload bytes only; not measured model tokens, monetary cost or live performance.',
    'Inventory component omission and selected fields intentionally deliver less detail than raw readings.',
    'Payload sizes and savings depend on real bridge output and chosen fields.',
    'Backoff can delay change detection and cannot capture transient redstone pulses.',
  ]}, null, 2));
