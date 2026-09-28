#!/usr/bin/env node
// Generate machine-specific MCP paths locally; this file contains no credentials.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const template = JSON.parse(await readFile(join(root, '.mcp.example.json'), 'utf8'));
const args=process.argv.slice(2);
const projectIndex=args.indexOf('--project');
if(projectIndex>=0 && (!args[projectIndex+1] || args[projectIndex+1].startsWith('--'))) throw new Error('--project requires a directory');
const project=resolve(projectIndex>=0 ? args[projectIndex+1] : process.cwd());
const gameIndex=args.indexOf('--game-dir');
if(gameIndex>=0 && (!args[gameIndex+1] || args[gameIndex+1].startsWith('--'))) throw new Error('--game-dir requires a directory');
if(!args.includes('--direct-tools')) {
  delete template.mcpServers.minecraft_world;
  delete template.mcpServers.minecraft_client;
}
template.mcpServers.minecraft_telemetry.command = process.execPath;
template.mcpServers.minecraft_telemetry.args = [join(root, 'scripts', 'telemetry-server.mjs')];
template.mcpServers.minecraft_telemetry.env = {MINECRAFT_PROJECT_DIR:project};
if(gameIndex>=0) {
  if(args.includes('--direct-tools')) throw new Error('Authenticated game setup uses compact tools. Configure direct endpoint authorization separately without committing credentials.');
  template.mcpServers.minecraft_telemetry.env.MINECRAFT_MCP_CONFIG_DIR=join(resolve(args[gameIndex+1]),'config','minecraft_fabric_mcp');
}
const target = join(root, '.mcp.json');
const temporary = `${target}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, {mode: 0o600});
await rename(temporary, target);
console.log(`Generated local .mcp.json (${args.includes('--direct-tools')?'full upstream catalog':'compact assistant catalog'}). Project state: ${project}/.minecraft-assistant. Configuration is excluded from Git.`);
