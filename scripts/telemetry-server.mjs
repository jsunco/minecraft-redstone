#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TelemetryService, configSchema, pollSchema, viewSchema, schemaSchema } from './telemetry-service.mjs';

const service = new TelemetryService();
const server = new McpServer({name: 'minecraft-compact-telemetry', version: '0.1.0'});
// Serialize calls so two polls cannot race the delta baseline or screenshot cooldown.
let queue = Promise.resolve();
function register(name, description, schema, action) {
  server.registerTool(name, {description, inputSchema: schema,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}}, args => {
    const task = queue.then(() => action(args)).catch(error => ({isError: true, content: [{type: 'text', text: String(error.message).slice(0, 300)}]}));
    queue = task.then(() => {}); return task;
  });
}
register('telemetry_status', 'Compact mode and payload-byte counters. No game connection.', z.object({}).strict(), () => service.status());
register('telemetry_configure', 'Opt in: data sends compact state deltas; hybrid also permits explicitly requested images; disabled stops reads. Set at most 8 named read-only watches. Every configure resets baselines.', configSchema, args => service.configure(args));
register('telemetry_source_schema', 'Inspect the live argument schema for one supported read-only world/client tool before configuring a watch.', schemaSchema, args => service.schema(args));
register('telemetry_poll', 'Read configured watches once. Return changes since prior delivered sample, with timestamps and bounded bytes. full=true resyncs after context loss. Not a per-tick recorder; unchanged never means no transient pulse occurred.', pollSchema, args => service.poll(args));
register('telemetry_view', 'Hybrid only: one reduced screenshot on demand, GUI unchanged, 30s cooldown. Uses current local client, not a separate observer.', viewSchema, args => service.view(args));
await server.connect(new StdioServerTransport());
process.on('SIGTERM', async () => { await service.bridge.close(); await server.close(); process.exit(0); });
process.on('SIGINT', async () => { await service.bridge.close(); await server.close(); process.exit(0); });
