#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, join } from 'node:path';
import { TelemetryService, configSchema, pollSchema, viewSchema, schemaSchema, checkSchema } from './telemetry-service.mjs';
import { BuildService, buildRegionSchema, buildPlanSchema, buildPlanRefSchema, buildUndoSchema, buildStatusSchema } from './build-service.mjs';
import { ObserverService, observerSchema } from './observer-service.mjs';
import { CircuitService, circuitSchema, circuitObserveSchema, circuitTraceSchema } from './circuit-service.mjs';

const service = new TelemetryService();
const state = join(resolve(process.env.MINECRAFT_PROJECT_DIR || process.cwd()), '.minecraft-assistant');
const builds = new BuildService(service.bridge, {stateDir:join(state,'build')});
const circuits = new CircuitService(service.bridge, {stateDir:join(state,'circuits')});
const observer = new ObserverService(service.bridge);
const server = new McpServer({name: 'minecraft-redstone-assistant', version: '0.2.0'});
// Serialize calls so two polls cannot race the delta baseline or screenshot cooldown.
let queue = Promise.resolve();
function register(name, description, schema, action, readOnly = true) {
  server.registerTool(name, {description, inputSchema: schema,
    annotations: {readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false}}, args => {
    const task = queue.then(() => action(args)).catch(error => ({isError: true, content: [{type: 'text', text: String(error.message).slice(0, 300)}]}));
    queue = task.then(() => {}); return task;
  });
}
register('connection_check', 'Check local game bridge connectivity and available read tools; reports missing capabilities. Does not prove a world is loaded.', checkSchema, args => service.check(args));
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
register('circuit_trace', 'Start/poll/stop finite end-of-server-tick recordings, or list saved circuit/trace summaries. Returns compact changes, saves full trace locally. Reports overflow explicitly.', circuitTraceSchema,args=>circuits.trace(args));
register('observer_control', 'Attach/status/move/capture/detach a distinct spectator client on port 8767. Requires explicit user and observer UUIDs. Never substitutes the user camera. Move changes only the attached observer.',observerSchema,args=>observer.run(args),false);
await server.connect(new StdioServerTransport());
process.on('SIGTERM', async () => { await service.bridge.close(); await server.close(); process.exit(0); });
process.on('SIGINT', async () => { await service.bridge.close(); await server.close(); process.exit(0); });
