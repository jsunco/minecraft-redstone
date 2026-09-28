#!/usr/bin/env node
// Generate local paths without copying game credentials into plugin configuration.
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
export const CONFIGURE_HELP = 'Usage: node scripts/configure-local.mjs [--project DIR] [--game-dir DIR] [--observer-config FILE] [--direct-tools]\nOmitted project and credential paths retain existing local settings. --direct-tools cannot use managed game credentials.';

export function parseConfigureArgs(args) {
  const result = {}; const seen = new Set();
  const paths = {'--project': 'project', '--game-dir': 'gameDir', '--observer-config': 'observerConfig'};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--help' || flag === '-h') result.help = true;
    else if (flag === '--direct-tools') result.directTools = true;
    else if (paths[flag]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
      result[paths[flag]] = resolve(value);
    } else throw new Error(`Unknown option: ${flag}. Use --help for supported options.`);
  }
  return result;
}
async function jsonFile(path, {optional = false, privateFile = false} = {}) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw new Error(privateFile ? 'Game credential configuration is unavailable.' : `Cannot read configuration: ${path}`); }
  if (Buffer.byteLength(raw) > (privateFile ? 65536 : 1_000_000)) throw new Error('Configuration file is too large');
  try { return {raw, value: JSON.parse(raw)}; }
  catch { throw new Error(privateFile ? 'Game credential configuration is invalid; contents were not printed.' : `Invalid JSON configuration: ${path}`); }
}
async function checkEndpoint(path, port) {
  const {value} = await jsonFile(path, {privateFile: true});
  if (!value || typeof value !== 'object' || value.host !== '127.0.0.1' || value.port !== port || value.allow_remote !== false || typeof value.auth_required !== 'boolean') throw new Error(`Game endpoint must use 127.0.0.1:${port} with remote binding disabled.`);
  if (value.auth_required && (typeof value.bearer_token !== 'string' || value.bearer_token.length < 16 || !/^[A-Za-z0-9._~+/-]+=*$/.test(value.bearer_token))) throw new Error('Game endpoint bearer token is missing or invalid; contents were not printed.');
}
export async function configureLocal(options = {}, {root = defaultRoot, cwd = process.cwd(), node = process.execPath} = {}) {
  const target = join(root, '.mcp.json');
  const loaded = await jsonFile(target, {optional: true}); const existing = loaded?.value ?? {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || existing.mcpServers && (typeof existing.mcpServers !== 'object' || Array.isArray(existing.mcpServers))) throw new Error('Existing MCP configuration has an invalid shape');
  const template = (await jsonFile(join(root, '.mcp.example.json'))).value;
  const previousEnv = existing.mcpServers?.minecraft_telemetry?.env ?? {};
  const project = resolve(options.project ?? previousEnv.MINECRAFT_PROJECT_DIR ?? cwd);
  if (!(await stat(project).catch(() => null))?.isDirectory()) throw new Error('Project directory does not exist; check --project before configuring');
  const configDir = options.gameDir ? join(resolve(options.gameDir), 'config', 'minecraft_fabric_mcp') : previousEnv.MINECRAFT_MCP_CONFIG_DIR;
  const observerConfig = options.observerConfig ?? previousEnv.MINECRAFT_OBSERVER_CONFIG;
  if (options.directTools && configDir) throw new Error('Authenticated game setup uses compact tools. Configure direct endpoint authorization separately without committing credentials.');
  if (configDir) { await checkEndpoint(join(configDir, 'config.json'), 8765); await checkEndpoint(join(configDir, 'client.json'), 8766); }
  if (observerConfig) await checkEndpoint(observerConfig, 8767);
  const env = {...previousEnv, MINECRAFT_PROJECT_DIR: project};
  if (configDir) env.MINECRAFT_MCP_CONFIG_DIR = configDir;
  if (observerConfig) env.MINECRAFT_OBSERVER_CONFIG = observerConfig;
  const servers = {...existing.mcpServers, minecraft_telemetry: {...template.mcpServers.minecraft_telemetry,
    command: node, args: [join(root, 'scripts', 'telemetry-server.mjs')], env}};
  for (const name of ['minecraft_world', 'minecraft_client']) {
    if (options.directTools) servers[name] = existing.mcpServers?.[name] ?? template.mcpServers[name];
    else delete servers[name];
  }
  const output = `${JSON.stringify({...existing, mcpServers: servers}, null, 2)}\n`;
  if (loaded?.raw === output) return {changed: false, catalog: options.directTools ? 'direct' : 'compact', project_state: join(project, '.minecraft-assistant')};
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, output, {flag: 'wx', mode: 0o600});
    const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== (loaded?.raw ?? null)) throw new Error('Local MCP configuration changed while configuring; rerun without overwriting the other edit');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return {changed: true, catalog: options.directTools ? 'direct' : 'compact', project_state: join(project, '.minecraft-assistant')};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseConfigureArgs(process.argv.slice(2));
    if (options.help) console.log(CONFIGURE_HELP);
    else {
      const result = await configureLocal(options);
      console.log(`${result.changed ? 'Updated' : 'Already configured'} local .mcp.json (${result.catalog} catalog). Project state: ${result.project_state}. Credentials remain in local game configuration.`);
    }
  } catch (error) { console.error(`Local configuration: ${error.message}`); process.exitCode = 1; }
}
