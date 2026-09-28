import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { decode } from '@toon-format/toon';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, compactProjection, DeltaCache } from './telemetry-core.mjs';

export const READS = {
  client: ['client_status', 'sense_crosshair', 'sense_raycast', 'sense_screen'],
  world: ['server_get_status', 'player_get_info', 'player_get_inventory', 'player_get_inventory_views', 'inventory_get',
    'block_get_state', 'block_get_states_batch', 'block_scan_summary', 'level_get_info', 'level_get_biome_at', 'entity_get'],
};
const sources = z.enum(['client', 'world']);
const watchId = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
const watch = z.object({
  id: watchId, source: sources,
  tool: z.string().max(64), arguments: z.record(z.string(), z.unknown()).default({}),
  fields: z.array(z.string().min(1).max(100)).max(32).default([]),
  interval_ms: z.number().int().min(500).max(3_600_000).optional(),
  on_demand: z.boolean().default(false),
}).strict();
export const configSchema = z.object({
  mode: z.enum(['disabled', 'data', 'hybrid']),
  watches: z.array(watch).max(8).default([]),
  max_text_bytes: z.number().int().min(2048).max(16000).default(8000),
  min_poll_ms: z.number().int().min(500).max(60000).default(5000),
  max_concurrency: z.number().int().min(1).max(4).default(2),
  no_change_backoff: z.boolean().default(true),
  max_backoff_ms: z.number().int().min(500).max(3_600_000).default(60000),
}).strict();
export const pollSchema = z.object({
  full: z.boolean().default(false),
  watch_ids: z.array(watchId).min(1).max(8).optional(),
}).strict();
export const viewSchema = z.object({downscale: z.number().int().min(2).max(8).default(4)}).strict();
export const schemaSchema = z.object({source: sources, tool: z.string().max(64), refresh: z.boolean().default(false)}).strict();
export const checkSchema = z.object({
  sources: z.array(sources).min(1).max(2).default(['client', 'world']),
  refresh: z.boolean().default(true),
}).strict();
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const brief = error => String(error?.message ?? error).slice(0, 220);
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const iso = timestamp => new Date(timestamp).toISOString();
const requestKey = w => canonicalJson([w.source, w.tool, w.arguments]);

async function mapBounded(items, limit, action) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await action(items[current]);
    }
  }));
  return output;
}

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

export function bridgeHeaders(source, env=process.env) {
  const path=source==='observer'?env.MINECRAFT_OBSERVER_CONFIG:
    env.MINECRAFT_MCP_CONFIG_DIR?join(env.MINECRAFT_MCP_CONFIG_DIR,source==='world'?'config.json':'client.json'):null;
  if(!path)return {};
  let config;
  try {const raw=readFileSync(path,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error();config=JSON.parse(raw);}
  catch {throw new Error('Local bridge credential configuration is unavailable or invalid.');}
  if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.auth_required!=='boolean')throw new Error('Local bridge credential configuration is unavailable or invalid.');
  if(!config.auth_required)return {};
  // Reject invalid header bytes here: fetch errors can otherwise echo the entire secret.
  if(typeof config.bearer_token!=='string'||config.bearer_token.length<16||!/^[A-Za-z0-9._~+/-]+=*$/.test(config.bearer_token))throw new Error('Local bridge credential is missing or invalid.');
  return {Authorization:`Bearer ${config.bearer_token}`};
}

// Fixed loopback defaults. No arbitrary HTTP proxy is exposed by the service.
export class Bridge {
  constructor(urls = {world: 'http://127.0.0.1:8765/mcp', client: 'http://127.0.0.1:8766/mcp', observer: 'http://127.0.0.1:8767/mcp'},
    {clock = () => Date.now(), schemaTtlMs = 60_000,
      clientFactory = () => new Client({name: 'minecraft-redstone-assistant', version: '0.2.0'}),
      transportFactory = (url, headers) => new StreamableHTTPClientTransport(new URL(url), {requestInit:{headers}}),
      headersProvider = source => bridgeHeaders(source)} = {}) {
    this.urls = urls; this.clients = new Map(); this.pending = new Map();
    this.clock = clock; this.schemaTtlMs = schemaTtlMs;
    this.clientFactory = clientFactory; this.transportFactory = transportFactory;
    this.headersProvider = headersProvider;
    this.catalogs = new Map(); this.catalogReads = new Map(); this.epochs = new Map();
    this.generations = new Map();
  }
  async get(source) {
    if (this.clients.has(source)) return this.clients.get(source);
    if (this.pending.has(source)) return this.pending.get(source);
    const generation = this.generations.get(source) ?? 0;
    const pending = (async () => {
      const client = this.clientFactory();
      client.onerror = () => {}; // Errors reach the caller; never dump world data to stdout.
      client.setNotificationHandler?.(ToolListChangedNotificationSchema, () => {
        if ((this.generations.get(source) ?? 0) === generation) this.invalidateSchema(source);
      });
      try {
        await client.connect(this.transportFactory(this.urls[source],this.headersProvider(source)), {timeout: 5000});
        if ((this.generations.get(source) ?? 0) !== generation) throw new Error('Connection invalidated while connecting; retry');
        this.clients.set(source, client);
        return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })();
    this.pending.set(source, pending);
    try { return await pending; }
    finally { if (this.pending.get(source) === pending) this.pending.delete(source); }
  }
  invalidateSchema(source) {
    this.epochs.set(source, (this.epochs.get(source) ?? 0) + 1);
    this.catalogs.delete(source); this.catalogReads.delete(source);
  }
  async call(source, name, args) {
    const generation = this.generations.get(source) ?? 0;
    let client;
    try {
      client = await this.get(source);
      return await client.callTool({name, arguments: args}, undefined, {timeout: name === 'view_capture' ? 15000 : 5000});
    } catch (error) {
      if ((this.generations.get(source) ?? 0) === generation && (!client || this.clients.get(source) === client)) await this.drop(source);
      throw error;
    }
  }
  async catalog(source, {refresh = false} = {}) {
    if (refresh) this.invalidateSchema(source);
    const cached = this.catalogs.get(source);
    if (cached && this.clock() - cached.observedAt < this.schemaTtlMs) {
      return {...cached, cached: true};
    }
    const epoch = this.epochs.get(source) ?? 0;
    const generation = this.generations.get(source) ?? 0;
    if (this.catalogReads.has(source)) return this.catalogReads.get(source);
    const pending = (async () => {
      let client;
      try {
        client = await this.get(source);
        const tools = new Map(); let cursor;
        for (let page = 0; page < 8; page++) {
          const result = await client.listTools(cursor ? {cursor} : {}, {timeout: 5000});
          for (const tool of result.tools) tools.set(tool.name, tool);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (cursor) throw new Error('Tool catalog exceeds 8 pages; inspect the direct bridge');
        if ((this.epochs.get(source) ?? 0) !== epoch) throw new Error('Tool catalog changed during discovery; retry');
        const catalog = {tools, observedAt: this.clock(), server: client.getServerVersion?.()};
        this.catalogs.set(source, catalog);
        return {...catalog, cached: false};
      } catch (error) {
        // An invalidated read must not close a replacement connection or erase
        // the successful catalog produced by a newer refresh.
        if ((this.epochs.get(source) ?? 0) === epoch && (this.generations.get(source) ?? 0) === generation &&
            (!client || this.clients.get(source) === client)) await this.drop(source);
        throw error;
      }
    })();
    this.catalogReads.set(source, pending);
    try { return await pending; }
    finally { if (this.catalogReads.get(source) === pending) this.catalogReads.delete(source); }
  }
  async schema(source, name, options = {}) {
    const catalog = await this.catalog(source, options);
    const tool = catalog.tools.get(name);
    if (!tool) throw new Error('Tool unavailable; check bridge version and enabled categories, or refresh schema');
    return {name, inputSchema: structuredClone(tool.inputSchema),
      observed_at: iso(catalog.observedAt), age_ms: Math.max(0, this.clock() - catalog.observedAt), cached: catalog.cached};
  }
  async capabilities(source, options = {}) {
    const catalog = await this.catalog(source, options);
    const wanted = [...READS[source], ...(source === 'client' ? ['view_capture'] : [])];
    return {connected: true, connection_checked: !catalog.cached, server: catalog.server, observed_at: iso(catalog.observedAt),
      age_ms: Math.max(0, this.clock() - catalog.observedAt), cached: catalog.cached,
      available: wanted.filter(name => catalog.tools.has(name)), missing: wanted.filter(name => !catalog.tools.has(name))};
  }
  async drop(source) {
    this.generations.set(source, (this.generations.get(source) ?? 0) + 1);
    this.invalidateSchema(source);
    const client = this.clients.get(source); this.clients.delete(source);
    const pending = this.pending.get(source); this.pending.delete(source);
    await client?.close().catch(() => {});
    await pending?.catch(() => {});
  }
  async close() { await Promise.all([...new Set([...this.clients.keys(), ...this.pending.keys()])].map(source => this.drop(source))); }
}

export class TelemetryService {
  constructor(bridge = new Bridge(), clock = () => Date.now()) {
    this.bridge = bridge; this.clock = clock; this.cache = new DeltaCache();
    this.config = configSchema.parse({mode: 'disabled'}); this.sequence = 0;
    this.lastPoll = -Infinity; this.lastFull = -Infinity; this.lastView = -Infinity;
    this.states = new Map(); this.queue = Promise.resolve();
    this.metrics = {source_payload_bytes: 0, delivered_text_bytes: 0, screenshots: 0,
      upstream_reads: 0, deduplicated_reads: 0, deferred_watches: 0, failed_watches: 0};
  }
  // Enforce ordering even for direct users that bypass the serialized MCP server.
  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  status() {
    const now = this.clock();
    return text({mode: this.config.mode, watches: this.config.watches.map(w => w.id),
      max_text_bytes: this.config.max_text_bytes, min_poll_ms: this.config.min_poll_ms,
      max_concurrency: this.config.max_concurrency, no_change_backoff: this.config.no_change_backoff,
      watch_status: this.config.watches.map(w => {
        const state = this.states.get(w.id);
        return {id: w.id, on_demand: w.on_demand, interval_ms: this.interval(w),
          last_kind: state?.lastKind ?? 'unobserved',
          ...(state?.observedAt === undefined ? {} : {last_observed_at: iso(state.observedAt), age_ms: Math.max(0, now - state.observedAt)}),
          ...(w.on_demand ? {} : {due_in_ms: Math.max(0, (state?.nextDue ?? now) - now)})};
      }),
      metrics: {...this.metrics}, note: 'Pull samples, not tick traces. Deferred means no fresh read; age is time since the last successful observation. Default projection omits NBT/components. Counters measure poll bytes, not tokens.'});
  }
  interval(w) { return Math.max(this.config.min_poll_ms, w.interval_ms ?? this.config.min_poll_ms); }
  async configure(input) {
    const config = configSchema.parse(input);
    const ids = new Set();
    for (const w of config.watches) {
      if (!READS[w.source].includes(w.tool)) throw new Error('Watch must use an allowed read-only tool');
      if (ids.has(w.id)) throw new Error('Duplicate watch id');
      ids.add(w.id);
      const argumentLimit = w.tool === 'block_get_states_batch' ? 32768 : 4096;
      if (Buffer.byteLength(canonicalJson(w.arguments)) > argumentLimit) throw new Error(`Watch arguments exceed ${argumentLimit} bytes`);
      if (w.tool === 'block_get_states_batch') {
        const positions = w.arguments.positions;
        if (!Array.isArray(positions) || positions.length === 0 || positions.length > 512 ||
            positions.some(position => !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position?.[axis])))) {
          throw new Error('Block batch requires 1 to 512 positions with integer x/y/z');
        }
      }
      if (w.tool === 'block_scan_summary') {
        const box = w.arguments.box;
        const from = ['x', 'y', 'z'].map(k => box?.from?.[k]);
        const to = ['x', 'y', 'z'].map(k => box?.to?.[k]);
        if (![...from, ...to].every(Number.isSafeInteger)) throw new Error('Summary box needs from/to objects with integer x/y/z');
        const volume = from.reduce((n, v, i) => n * (Math.abs(to[i] - v) + 1), 1);
        if (volume > 4096) throw new Error('Compact summaries are capped at 4096 blocks; use a smaller region');
      }
    }
    // Identical requests cost one read regardless of differing field projections.
    const endpointCalls = ['world', 'client'].map(source => new Set(config.watches.filter(w => w.source === source).map(requestKey)).size);
    config.min_poll_ms = Math.max(config.min_poll_ms, ...endpointCalls.map(count => count * 1500));
    return this.serial(async () => {
      this.config = config; this.cache.reset(); this.states.clear(); this.lastPoll = -Infinity; this.lastFull = -Infinity;
      if (config.mode === 'disabled') await this.bridge.close();
      return this.status();
    });
  }
  async schema(input) {
    const {source, tool, refresh} = schemaSchema.parse(input);
    if (!READS[source].includes(tool)) throw new Error('Tool is outside compact read-only scope');
    const result = await this.bridge.schema(source, tool, {refresh});
    return text(bytes(result) <= 8000 ? result : {error: 'Schema exceeds compact limit; inspect the direct bridge tool'});
  }
  async check(input = {}) {
    const {sources, refresh} = checkSchema.parse(input);
    const connections = await Promise.all([...new Set(sources)].map(async source => {
      try { return {source, ...await this.bridge.capabilities(source, {refresh})}; }
      catch (error) { return {source, connected: false, error: brief(error)}; }
    }));
    return text({connections, game_reads: 0, note: 'Connection/tool discovery only; does not verify a loaded world, player, or tool execution.'});
  }
  async poll(input = {}) { const request = pollSchema.parse(input); return this.serial(() => this.pollOnce(request)); }
  async pollOnce({full, watch_ids}) {
    if (this.config.mode === 'disabled') return text({mode: 'disabled', hint: 'Opt in with telemetry_configure. No game reads performed.'});
    const chosen = watch_ids ? new Set(watch_ids) : null;
    if (chosen && [...chosen].some(id => !this.config.watches.some(w => w.id === id))) throw new Error('Unknown watch id');
    const started = this.clock();
    if (started - this.lastPoll < this.config.min_poll_ms) return text({kind: 'rate_limited', retry_after_ms: this.config.min_poll_ms - (started - this.lastPoll)});
    this.lastPoll = started;
    const scope = this.config.watches.filter(w => !chosen || chosen.has(w.id));
    const due = scope.filter(w => full || chosen || (!w.on_demand && started >= (this.states.get(w.id)?.nextDue ?? -Infinity)));
    const groups = new Map();
    for (const w of due) {
      const key = requestKey(w);
      if (!groups.has(key)) groups.set(key, {key, watch: w});
    }
    this.metrics.deduplicated_reads += due.length - groups.size;
    this.metrics.deferred_watches += scope.length - due.length;
    const readings = new Map(await mapBounded([...groups.values()], this.config.max_concurrency, async ({key, watch: w}) => {
      this.metrics.upstream_reads++;
      try {
        const result = await this.bridge.call(w.source, w.tool, w.arguments);
        this.metrics.source_payload_bytes += bytes(result);
        return [key, {value: parseReading(result), observedAt: this.clock()}];
      } catch (error) { return [key, {error}]; }
    }));
    const cap = Math.max(20, Math.floor((this.config.max_text_bytes - 420) / Math.max(1, scope.length)) - 110);
    const samples = []; const resynced = []; const dueIds = new Set(due.map(w => w.id));
    let resync = false;
    for (const w of scope) {
      const state = this.states.get(w.id) ?? {lastFull: -Infinity, unchanged: 0};
      if (!dueIds.has(w.id)) {
        samples.push({watchId: w.id, kind: 'deferred', reason: w.on_demand ? 'on_demand' : 'cadence',
          ...(state.observedAt === undefined ? {} : {last_observed_at: iso(state.observedAt), age_ms: Math.max(0, started - state.observedAt)}),
          ...(w.on_demand ? {} : {retry_after_ms: Math.max(0, state.nextDue - started)})});
        continue;
      }
      const reading = readings.get(requestKey(w));
      const needsFull = full || started - state.lastFull >= 60_000;
      resync ||= needsFull;
      try {
        if (reading.error) throw reading.error;
        const projected = compactProjection(reading.value, w.fields);
        if (w.fields.length && Object.keys(projected).length === 0) throw new Error('None of the selected fields exist; inspect the live schema/reading');
        const sample = this.cache.sample(w.id, projected, {full: needsFull, maxBytes: cap});
        samples.push({observed_at: iso(reading.observedAt), ...sample, watchId: w.id});
        state.observedAt = reading.observedAt;
        state.lastKind = sample.kind;
        if (sample.kind === 'snapshot') { state.lastFull = started; resynced.push(w.id); }
        else if (needsFull) state.lastFull = -Infinity; // A full resync that did not fit remains pending.
        state.unchanged = sample.kind === 'unchanged' ? state.unchanged + 1 : 0;
        const interval = this.interval(w);
        const delay = this.config.no_change_backoff && state.unchanged
          ? Math.max(interval, Math.min(this.config.max_backoff_ms, interval * 2 ** Math.min(state.unchanged, 20))) : interval;
        state.nextDue = reading.observedAt + delay;
      } catch (error) {
        this.metrics.failed_watches++;
        this.cache.reset(w.id); state.lastFull = -Infinity; state.unchanged = 0;
        state.lastKind = 'unavailable'; state.nextDue = this.clock() + this.interval(w);
        samples.push({watchId: w.id, kind: 'unavailable', error: brief(error)});
      }
      this.states.set(w.id, state);
    }
    const previous = this.sequence++;
    let output = {sequence: this.sequence, previous_sequence: previous, resync,
      sampled_at: iso(started), atomic: false, samples};
    if (full) output.resync_scope = scope.map(w => w.id);
    if (bytes(output) > this.config.max_text_bytes) {
      // None of these updates were delivered, so only this response's watches lose baselines.
      for (const w of due) {
        this.cache.reset(w.id);
        const state = this.states.get(w.id);
        state.lastFull = -Infinity; state.nextDue = started; state.lastKind = 'undelivered';
      }
      output = {sequence: this.sequence, previous_sequence: previous, kind: 'oversize',
        hint: 'Reduce watches or selected fields; sampled-watch baselines reset.'};
    } else if (scope.length === this.config.watches.length && resynced.length === scope.length) this.lastFull = started;
    this.metrics.delivered_text_bytes += bytes(output);
    return text(output);
  }
  async view(input = {}) { const request = viewSchema.parse(input); return this.serial(() => this.viewOnce(request)); }
  async viewOnce({downscale}) {
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
