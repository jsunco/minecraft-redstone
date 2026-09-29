#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelemetryService, configSchema, pollSchema, viewSchema, schemaSchema, checkSchema } from './telemetry-service.mjs';
import { BuildService, buildRegionSchema, buildPlanSchema, buildPlanRefSchema, buildUndoSchema, buildStatusSchema } from './build-service.mjs';
import { ObserverService, observerSchema } from './observer-service.mjs';
import { CircuitService, circuitSchema, circuitObserveSchema, circuitTraceSchema } from './circuit-service.mjs';

import { TestRunnerService, testRunSchema } from './test-runner-service.mjs';
import { ProjectLock } from './project-lock.mjs';
import { AdminService, adminToolSchema, clientToolSchema } from './admin-service.mjs';

export const circuitTestSchema = z.object({action: z.enum(['validate', 'start', 'status', 'cancel']), spec: testRunSchema.optional(), job_id: z.string().uuid().optional()}).strict();
const reply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});

// Factories reload journals under the shared writer lock. A second CLI or MCP
// process must never overwrite changes with an old in-memory journal.
export function createMinecraftServer({bridge, projectDir = process.env.MINECRAFT_PROJECT_DIR || process.cwd(), runnerOptions = {}} = {}) {
const service = new TelemetryService(bridge);
const state = join(resolve(projectDir), '.minecraft-assistant');
const lock = new ProjectLock(state);
const buildService = () => new BuildService(service.bridge, {stateDir:join(state,'build')});
const circuitService = () => new CircuitService(service.bridge, {stateDir:join(state,'circuits')});
const circuits = Object.fromEntries(['get','observe','trace','register'].map(method => [method, (...args) => circuitService()[method](...args)]));
const builds = Object.fromEntries(['registerRegion','createPlan','preview','apply','verify','undo','status'].map(method => [method, (...args) => buildService()[method](...args)]));
const runner = new TestRunnerService(service.bridge, circuits, {...runnerOptions, stateDir:join(state,'tests'), lock});
const observer = new ObserverService(service.bridge);
const admin = new AdminService(service.bridge,{stateDir:join(state,'admin'),lock});
const server = new McpServer({name: 'minecraft-redstone-assistant', version: '0.2.0'});
// Serialize calls so two polls cannot race the delta baseline or screenshot cooldown.
let queue = Promise.resolve();
const writingTools = new Set(['telemetry_configure','build_region','build_plan','build_preview','build_apply','build_verify','build_undo','circuit_register']);
function register(name, description, schema, action, readOnly = true, immediate = false) {
  server.registerTool(name, {description, inputSchema: schema,
    annotations: {readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false}}, args => {
    const invoke = () => {
      const writes = writingTools.has(name) || name === 'circuit_trace' && args.action !== 'status' || name === 'observer_control' && args.action === 'move';
      return writes ? lock.withLock(name, () => action(args)) : action(args);
    };
    const task = (immediate ? Promise.resolve().then(invoke) : queue.then(invoke)).catch(error => ({isError: true, content: [{type: 'text', text: String(error.message).slice(0, 300)}]}));
    if (!immediate) queue = task.then(() => {}); return task;
  });
}
register('connection_check', 'Check local game bridge connectivity and available read tools; reports missing capabilities. Does not prove a world is loaded.', checkSchema, args => service.check(args));
register('admin_control', 'Authenticated native console and tick controls, without player chat/camera. Read status first; writes require matching expected_session and expected_world, share the construction writer lock, and are journaled. command has full console authority and is not automatically undoable. Requires the updated admin-enabled helper.', adminToolSchema, args=>admin.run(args),false);
register('client_control', 'Authenticated client options and world lifecycle. Read status first; exact current session/save required. Create/open only at title, quit saves the existing world. Creation uses a separate vanilla Void Creative world and refuses overwrite. Poll status after asynchronous lifecycle receipts; receipt alone is not completion.', clientToolSchema, args=>admin.client(args),false);
register('telemetry_status', 'Compact mode and payload-byte counters. No game connection.', z.object({}).strict(), () => service.status());
register('telemetry_configure', 'Opt in: data sends compact state deltas; hybrid also permits explicitly requested images; disabled stops reads. Set at most 8 named read-only watches. Every configure resets baselines.', configSchema, args => service.configure(args));
register('telemetry_source_schema', 'Inspect the live argument schema for one supported read-only world/client tool before configuring a watch.', schemaSchema, args => service.schema(args));
register('telemetry_poll', 'Read configured watches once. Return changes since prior delivered sample, with timestamps and bounded bytes. full=true resyncs after context loss. Not a per-tick recorder; unchanged never means no transient pulse occurred.', pollSchema, args => service.poll(args));
register('telemetry_view', 'Hybrid only: one reduced screenshot on demand, GUI unchanged, 30s cooldown. Uses current local client, not a separate observer.', viewSchema, args => service.view(args));
register('build_region', 'Register a bounded project lab (at most 4096 blocks). No game writes. Use an inspected, agreed area.', buildRegionSchema, args=>builds.registerRegion(args));
register('build_plan', 'Read the lab and prepare bounded vanilla set/fill/clone operations, material counts and expected state. No game writes.', buildPlanSchema, args=>builds.createPlan(args));
register('build_preview', 'Review a saved plan and detect changes since planning. Does not refresh or overwrite its baseline.', buildPlanRefSchema, args=>builds.preview(args));
register('build_apply', 'Apply a prepared plan after session/conflict checks and verified structure backup. Read back states; partial failures attempt safe rollback.', buildPlanRefSchema, args=>builds.apply(args),false);
register('build_verify', 'Read back a plan and compare IDs/properties. Does not establish circuit timing or computation correctness.', buildPlanRefSchema, args=>builds.verify(args));
register('build_undo', 'Restore the saved structure for an applied plan. Refuses changed regions unless exact observed fingerprint is supplied intentionally.', buildUndoSchema, args=>builds.undo(args),false);
register('build_status', 'Recover registered labs and saved plan summaries from project state; no game read.', buildStatusSchema, args=>builds.status(args));
register('circuit_register', 'Name up to 64 redstone signals and 16 buses. Bus bits are least-significant first. Saves project definitions without game changes.', circuitSchema,args=>circuits.register(args));
register('circuit_observe', 'Read all named signals in one server task. Decode buses and optionally assert expected values. Unavailable properties remain unknown.', circuitObserveSchema,args=>circuits.observe(args));
register('circuit_trace', 'Start/poll/stop finite end-of-server-tick recordings; discard fully archived inactive recorders, or list local summaries. Returns compact changes and saves full traces locally. Reports gaps explicitly.', circuitTraceSchema,args=>circuits.trace(args));
register('observer_control', 'Attach/status/move/capture/detach a distinct spectator client on port 8767. Requires explicit user and observer UUIDs. Never substitutes the user camera. Move changes only the attached observer.',observerSchema,args=>observer.run(args),false);
register('circuit_test', 'Run complete finite redstone experiments locally. validate checks a spec without game writes; start returns a job id immediately; status returns bounded results and measured calls/bytes; cancel requests input restoration. Inputs must be existing levers. Full evidence stays in local JSONL.', circuitTestSchema, async args => {
  if (['validate', 'start'].includes(args.action)) {
    if (!args.spec || args.job_id) throw new Error('validate/start requires spec and no job_id.');
    if (args.action === 'validate') {const spec = runner.validate(args.spec); return reply({valid:true, circuit_id:spec.circuit_id, cases:spec.cases.length, inputs:spec.inputs.length});}
    return runner.start(args.spec);
  }
  if (args.spec) throw new Error('status/cancel does not accept spec.');
  if (args.action === 'cancel') {if (!args.job_id) throw new Error('cancel requires job_id.'); return runner.cancel({job_id:args.job_id});}
  return runner.status(args.job_id ? {job_id:args.job_id} : {});
}, false, true);
let closing;
const close = () => closing ??= (async () => {await runner.close(); await service.bridge.close(); await server.close();})();
// A disconnected MCP client must not leave a background writer running.
server.server.onclose = () => {void close().catch(() => {});};
return {server, service, runner, lock, close};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createMinecraftServer();
  await app.server.connect(new StdioServerTransport());
  let closing = false;
  const close = async () => {if (closing) return; closing = true; await app.close(); process.exit(0);};
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
