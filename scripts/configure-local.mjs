#!/usr/bin/env node
// Generate machine-specific MCP paths locally; this file contains no credentials.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const template = JSON.parse(await readFile(join(root, '.mcp.example.json'), 'utf8'));
template.mcpServers.minecraft_telemetry.command = process.execPath;
template.mcpServers.minecraft_telemetry.args = [join(root, 'scripts', 'telemetry-server.mjs')];
const target = join(root, '.mcp.json');
const temporary = `${target}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, {mode: 0o600});
await rename(temporary, target);
console.log('Generated local .mcp.json. This file is intentionally excluded from Git.');
