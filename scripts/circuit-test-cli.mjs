#!/usr/bin/env node
import { openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge, bridgeHeaders } from './telemetry-service.mjs';
import { CircuitService } from './circuit-service.mjs';
import { TestRunnerService } from './test-runner-service.mjs';
import { ProjectLock } from './project-lock.mjs';

export const CLI_HELP = `Run a whole redstone experiment without a model round trip for each input.

  node scripts/circuit-test-cli.mjs validate --spec experiment.json
  node scripts/circuit-test-cli.mjs run --spec experiment.json
  node scripts/circuit-test-cli.mjs status [--job UUID]
  node scripts/circuit-test-cli.mjs cancel --job UUID

Options:
  --project DIR      Project containing .minecraft-assistant circuit definitions.
  --config-dir DIR   Minecraft bridge config directory (tokens are read locally).
  --spec FILE        UTF-8 JSON experiment, at most 128 KiB. Required for run/validate.
  --job UUID         Job returned by MCP start or recorded by a CLI run.
  --help            Show this help.

Defaults come from MINECRAFT_PROJECT_DIR / MINECRAFT_MCP_CONFIG_DIR, then this
plugin's local .mcp.json. No credentials are accepted on the command line.
Run stays in the foreground; use another terminal for status/cancel. Ctrl-C
requests cancellation, waits for safe input restoration, then exits.
Exit codes: 0 = success, 2 = failed/incomplete experiment, 1 = setup/usage error,
130 = interrupted. Results are compact JSON; full evidence stays in the project.
See docs/TEST_RUNNER.md for lever setup, tick timing, and limitations.\n`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));

export function parseCliArgs(argv) {
  const result = {}, seen = new Set();
  const options = {'--project':'project', '--config-dir':'configDir', '--spec':'spec', '--job':'job'};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {result.help = true; continue;}
    if (!arg.startsWith('-') && !result.command) {result.command = arg; continue;}
    if (!options[arg]) throw new Error('Unknown command-line option. Use --help.');
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value.`);
    result[options[arg]] = arg === '--job' ? value : resolve(value);
  }
  if (result.help) return result;
  if (!['run','validate','status','cancel'].includes(result.command)) throw new Error('Choose run, validate, status, or cancel. Use --help.');
  if (['run','validate'].includes(result.command)) {
    if (!result.spec || result.job) throw new Error('run/validate requires --spec and does not accept --job.');
  } else {
    if (result.spec) throw new Error('status/cancel does not accept --spec.');
    if (result.command === 'cancel' && !result.job) throw new Error('cancel requires --job.');
  }
  if (result.job && !uuid.test(result.job)) throw new Error('--job must be a UUID.');
  return result;
}

export function readSpec(path) {
  const fd = openSync(path, 'r'), limit = 128 * 1024, buffer = Buffer.alloc(limit + 1);
  let used = 0;
  try {while (used < buffer.length) {const count = readSync(fd, buffer, used, buffer.length - used, null); if (!count) break; used += count;}}
  finally {closeSync(fd);}
  if (used > limit) throw new Error('Experiment exceeds 128 KiB; split it into smaller runs.');
  try {return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0,used)));}
  catch {throw new Error('Experiment must be valid UTF-8 JSON. Contents were not printed.');}
}

export function resolveCliConfig(options, {env = process.env, root = pluginRoot} = {}) {
  let saved = {};
  const path = join(root, '.mcp.json');
  if (existsSync(path)) {
    try {const raw = readFileSync(path, 'utf8'); if (Buffer.byteLength(raw) > 65536) throw new Error(); saved = JSON.parse(raw)?.mcpServers?.minecraft_telemetry?.env ?? {};}
    catch {throw new Error('Local plugin configuration is invalid. Run configure:local to repair it.');}
  }
  const project = options.project ?? env.MINECRAFT_PROJECT_DIR ?? saved.MINECRAFT_PROJECT_DIR ?? process.cwd();
  const configDir = options.configDir ?? env.MINECRAFT_MCP_CONFIG_DIR ?? saved.MINECRAFT_MCP_CONFIG_DIR;
  if (typeof project !== 'string' || configDir !== undefined && typeof configDir !== 'string') throw new Error('Local project/config paths must be strings.');
  return {project:resolve(project), ...(configDir ? {configDir:resolve(configDir)} : {})};
}

export function createCliRuntime(config) {
  const state = join(config.project, '.minecraft-assistant');
  const bridge = new Bridge(undefined, {headersProvider: source => bridgeHeaders(source, config.configDir ? {MINECRAFT_MCP_CONFIG_DIR:config.configDir} : {})});
  const fresh = () => new CircuitService(bridge, {stateDir:join(state,'circuits')});
  const circuits = Object.fromEntries(['get','observe','trace'].map(method => [method, (...args) => fresh()[method](...args)]));
  const runner = new TestRunnerService(bridge, circuits, {stateDir:join(state,'tests'), lock:new ProjectLock(state)});
  return {runner, async close() {await runner.close(); await bridge.close();}};
}
const unpack = result => JSON.parse(result.content.find(item => item.type === 'text').text);

export async function runCli(argv, {stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text), env = process.env, root = pluginRoot, runtimeFactory = createCliRuntime, signals = process} = {}) {
  let runtime, interrupted = false;
  const interrupt = () => {interrupted = true; if (runtime) void runtime.runner.close().catch(() => {});};
  try {
    const options = parseCliArgs(argv);
    if (options.help) {stdout(CLI_HELP); return 0;}
    const config = resolveCliConfig(options, {env,root});
    const spec = options.spec ? readSpec(options.spec) : null;
    runtime = runtimeFactory(config);
    signals.on('SIGINT',interrupt); signals.on('SIGTERM',interrupt);
    let result;
    if (options.command === 'validate') {
      const value = runtime.runner.validate(spec);
      result = {valid:true, circuit_id:value.circuit_id, cases:value.cases.length, inputs:value.inputs.length};
    } else if (options.command === 'run') result = unpack(await runtime.runner.run(spec));
    else result = unpack(await runtime.runner[options.command](options.job ? {job_id:options.job} : {}));
    stdout(`${JSON.stringify(result)}\n`);
    if (interrupted) return 130;
    return options.command === 'run' && result.status !== 'passed' ? 2 : 0;
  } catch (error) {stderr(`${String(error.message).slice(0,300)}\n`); return interrupted ? 130 : 1;}
  finally {signals.off('SIGINT',interrupt); signals.off('SIGTERM',interrupt); if (runtime) {try {await runtime.close();} catch {stderr('Runner cleanup did not finish; inspect the saved job and input journal.\n'); return 1;}}}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
