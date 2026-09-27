import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decode } from '@toon-format/toon';
import { z } from 'zod';
import { compactProjection, DeltaCache } from './telemetry-core.mjs';

export const READS = {
  client: ['client_status', 'sense_crosshair', 'sense_raycast', 'sense_screen'],
  world: ['server_get_status', 'player_get_info', 'player_get_inventory', 'inventory_get',
    'block_get_state', 'block_scan_summary', 'level_get_info', 'level_get_biome_at', 'entity_get'],
};
const sources = z.enum(['client', 'world']);
const watch = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), source: sources,
  tool: z.string().max(64), arguments: z.record(z.string(), z.unknown()).default({}),
  fields: z.array(z.string().min(1).max(100)).max(32).default([]),
}).strict();
export const configSchema = z.object({
  mode: z.enum(['disabled', 'data', 'hybrid']),
  watches: z.array(watch).max(8).default([]),
  max_text_bytes: z.number().int().min(2048).max(16000).default(8000),
  min_poll_ms: z.number().int().min(500).max(60000).default(5000),
}).strict();
export const pollSchema = z.object({full: z.boolean().default(false)}).strict();
export const viewSchema = z.object({downscale: z.number().int().min(2).max(8).default(4)}).strict();
export const schemaSchema = z.object({source: sources, tool: z.string().max(64)}).strict();
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const brief = error => String(error?.message ?? error).slice(0, 220);
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});

export function parseReading(result) {
  if (result.isError) throw new Error(result.content?.find(x => x.type === 'text')?.text ?? 'Upstream tool error');
  if (result.structuredContent !== undefined) {
    const value = result.structuredContent;
    if (value === null || typeof value !== 'object' || bytes(value) > 2_000_000) throw new Error('Structured reading unavailable or too large; narrow the watch');
    return value;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0].type !== 'text') {
    throw new Error('Expected one structured text reading, not image or mixed content');
  }
  const input = result.content[0].text;
  if (Buffer.byteLength(input) > 2_000_000) throw new Error('Upstream reading too large; narrow the watch');
  let value;
  try { value = JSON.parse(input); } catch { value = decode(input, {strict: true}); }
  if (value === null || typeof value !== 'object') throw new Error('Expected object/array reading; not treating plain text as state');
  return value;
}

// Fixed loopback endpoints. This service exposes no arbitrary HTTP proxy or game writes.
export class Bridge {
  constructor(urls = {world: 'http://127.0.0.1:8765/mcp', client: 'http://127.0.0.1:8766/mcp'}) {
    this.urls = urls; this.clients = new Map();
  }
  async get(source) {
    if (!this.clients.has(source)) {
      const client = new Client({name: 'minecraft-compact-telemetry', version: '0.1.0'});
      const transport = new StreamableHTTPClientTransport(new URL(this.urls[source]));
      client.onerror = () => {}; // Caller receives compact errors; never dump world data to stdout.
      try {
        await client.connect(transport, {timeout: 5000});
        this.clients.set(source, client);
      } catch (error) { await client.close().catch(() => {}); throw error; }
    }
    return this.clients.get(source);
  }
  async call(source, name, args) {
    try { return await (await this.get(source)).callTool({name, arguments: args}, undefined, {timeout: name === 'view_capture' ? 15000 : 5000}); }
    catch (error) { await this.drop(source); throw error; }
  }
  async schema(source, name) {
    try {
    const client = await this.get(source);
    let cursor;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? {cursor} : {}, {timeout: 5000});
      const tool = result.tools.find(t => t.name === name);
      if (tool) return {name, inputSchema: tool.inputSchema};
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw new Error('Tool unavailable; check bridge version and enabled categories');
    } catch (error) { await this.drop(source); throw error; }
  }
  async drop(source) { const client = this.clients.get(source); this.clients.delete(source); await client?.close().catch(() => {}); }
  async close() { await Promise.all([...this.clients.keys()].map(source => this.drop(source))); }
}

export class TelemetryService {
  constructor(bridge = new Bridge(), clock = () => Date.now()) {
    this.bridge = bridge; this.clock = clock; this.cache = new DeltaCache();
    this.config = configSchema.parse({mode: 'disabled'}); this.sequence = 0;
    this.lastPoll = -Infinity; this.lastFull = -Infinity; this.lastView = -Infinity;
    this.metrics = {source_payload_bytes: 0, delivered_text_bytes: 0, screenshots: 0};
  }
  status() { return text({mode: this.config.mode, watches: this.config.watches.map(w => w.id),
    max_text_bytes: this.config.max_text_bytes, min_poll_ms: this.config.min_poll_ms,
    metrics: this.metrics, note: 'Pull-based samples, not a tick trace. Default projection omits NBT/components; select fields explicitly for details. Counters measure poll payload bytes, not tokens.'}); }
  async configure(input) {
    const config = configSchema.parse(input);
    const ids = new Set();
    for (const w of config.watches) {
      if (!READS[w.source].includes(w.tool)) throw new Error('Watch must use an allowed read-only tool');
      if (ids.has(w.id)) throw new Error('Duplicate watch id');
      ids.add(w.id);
      if (bytes(w.arguments) > 4096) throw new Error('Watch arguments exceed 4096 bytes');
      // Full details remain in the direct bridge. This mode forbids expensive broad scans.
      if (w.tool === 'block_scan_summary') {
        const box = w.arguments.box;
        const from = ['x', 'y', 'z'].map(k => box?.from?.[k]);
        const to = ['x', 'y', 'z'].map(k => box?.to?.[k]);
        if (![...from, ...to].every(Number.isSafeInteger)) throw new Error('Summary box needs from/to objects with integer x/y/z');
        const volume = from.reduce((n, v, i) => n * (Math.abs(to[i] - v) + 1), 1);
        if (volume > 4096) throw new Error('Compact summaries are capped at 4096 blocks; use a smaller region');
      }
    }
    const endpointCalls = ['world', 'client'].map(source => config.watches.filter(w => w.source === source).length);
    config.min_poll_ms = Math.max(config.min_poll_ms, ...endpointCalls.map(count => count * 1500));
    this.config = config; this.cache.reset(); this.lastPoll = -Infinity; this.lastFull = -Infinity;
    await this.bridge.close();
    return this.status();
  }
  async schema(input) {
    const {source, tool} = schemaSchema.parse(input);
    if (!READS[source].includes(tool)) throw new Error('Tool is outside compact read-only scope');
    const result = await this.bridge.schema(source, tool);
    return text(bytes(result) <= 8000 ? result : {error: 'Schema exceeds compact limit; inspect the direct bridge tool'});
  }
  async poll(input = {}) {
    const {full} = pollSchema.parse(input);
    if (this.config.mode === 'disabled') return text({mode: 'disabled', hint: 'Opt in with telemetry_configure. No game reads performed.'});
    const started = this.clock();
    if (started - this.lastPoll < this.config.min_poll_ms) return text({kind: 'rate_limited', retry_after_ms: this.config.min_poll_ms - (started - this.lastPoll)});
    this.lastPoll = started;
    const resync = full || started - this.lastFull >= 60_000;
    if (resync) this.cache.reset();
    const cap = Math.floor((this.config.max_text_bytes - 350) / Math.max(1, this.config.watches.length)) - 110;
    const samples = []; let failed = false;
    for (const w of this.config.watches) {
      try {
        const result = await this.bridge.call(w.source, w.tool, w.arguments);
        this.metrics.source_payload_bytes += bytes(result);
        const projected = compactProjection(parseReading(result), w.fields);
        if (w.fields.length && Object.keys(projected).length === 0) throw new Error('None of the selected fields exist; inspect the live schema/reading');
        const sample = this.cache.sample(w.id, projected, {maxBytes: cap});
        samples.push({observed_at: new Date(this.clock()).toISOString(), ...sample, watchId: w.id});
      } catch (error) {
        failed = true;
        samples.push({watchId: w.id, kind: 'unavailable', error: brief(error)});
      }
    }
    if (failed) { this.cache.reset(); this.lastFull = -Infinity; }
    else if (resync) this.lastFull = started;
    const previous = this.sequence++;
    let output = {sequence: this.sequence, previous_sequence: previous, resync,
      sampled_at: new Date(started).toISOString(), atomic: false, samples};
    if (bytes(output) > this.config.max_text_bytes) {
      this.cache.reset(); this.lastFull = -Infinity;
      output = {sequence: this.sequence, kind: 'oversize', hint: 'Reduce watches or selected fields; baseline reset.'};
    }
    this.metrics.delivered_text_bytes += bytes(output);
    return text(output);
  }
  async view(input = {}) {
    const {downscale} = viewSchema.parse(input);
    if (this.config.mode !== 'hybrid') return text({error: 'Screenshots require hybrid mode. Data mode never captures images.'});
    if (this.clock() - this.lastView < 30_000) return text({error: 'Screenshot cooldown: wait 30 seconds between captures.'});
    const result = await this.bridge.call('client', 'view_capture', {downscale, close_screen: false});
    if (result.isError) throw new Error(brief(result.content?.[0]?.text ?? 'Capture failed'));
    const images = result.content?.filter(c => c.type === 'image') ?? [];
    if (images.length !== 1 || Buffer.byteLength(images[0].data, 'base64') > 512_000) {
      throw new Error('Image missing or over 512 KB; increase downscale. Nothing sent to model.');
    }
    this.lastView = this.clock(); this.metrics.screenshots++;
    return {content: [{type: 'text', text: 'Current local client view, NOT an independent observer. GUI preserved.'}, images[0]]};
  }
}
