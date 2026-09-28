import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureLocal, parseConfigureArgs } from './configure-local.mjs';

async function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'redstone-config-')); const gameDir = join(root, 'game');
  const configDir = join(gameDir, 'config', 'minecraft_fabric_mcp'); mkdirSync(configDir, {recursive: true});
  const template = {mcpServers: {minecraft_world: {type: 'http', url: 'http://127.0.0.1:8765/mcp'}, minecraft_client: {type: 'http', url: 'http://127.0.0.1:8766/mcp'}, minecraft_telemetry: {type: 'stdio', command: 'node', args: []}}};
  writeFileSync(join(root, '.mcp.example.json'), JSON.stringify(template));
  for (const [file, port] of [['config.json', 8765], ['client.json', 8766]]) writeFileSync(join(configDir, file), JSON.stringify({host: '127.0.0.1', port, allow_remote: false, auth_required: true, bearer_token: 'private_token_1234567890'}));
  try { await action({root, gameDir, configDir, target: join(root, '.mcp.json'), dependencies: {root, cwd: root, node: '/test/node'}}); }
  finally { rmSync(root, {recursive: true, force: true}); }
}
test('CLI rejects typo, duplicate and missing-value options', () => {
  assert.throws(() => parseConfigureArgs(['--game-dri', '/tmp/game']), /Unknown/);
  assert.throws(() => parseConfigureArgs(['--project', '/tmp/a', '--project', '/tmp/b']), /Duplicate/);
  assert.throws(() => parseConfigureArgs(['--project', '--direct-tools']), /requires/);
  assert.deepEqual(parseConfigureArgs(['--help']), {help: true});
});
test('reruns retain project and credential paths and are idempotent without copying bearer tokens', () => fixture(async ({root, gameDir, configDir, target, dependencies}) => {
  const first = await configureLocal({project: root, gameDir}, dependencies); assert.equal(first.changed, true);
  const before = readFileSync(target, 'utf8'); assert.ok(!before.includes('private_token'));
  assert.equal((await configureLocal({}, {...dependencies, cwd: '/unrelated/path'})).changed, false);
  assert.equal(readFileSync(target, 'utf8'), before);
  assert.equal(JSON.parse(before).mcpServers.minecraft_telemetry.env.MINECRAFT_MCP_CONFIG_DIR, configDir);
}));
test('configuration preserves unrelated servers and top-level settings', () => fixture(async ({target, dependencies}) => {
  const other = {command: 'my-own-server', args: ['preserve']};
  writeFileSync(target, JSON.stringify({custom: {keep: true}, mcpServers: {other}}));
  await configureLocal({}, dependencies); const result = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(result.custom, {keep: true}); assert.deepEqual(result.mcpServers.other, other);
}));
test('invalid token characters and malformed private JSON produce generic errors without modifying configuration', () => fixture(async ({gameDir, configDir, target, dependencies}) => {
  for (const token of ['never_print_🔒_token', 'never print spaced token', 'never\r\nprint token']) {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({host: '127.0.0.1', port: 8765, allow_remote: false, auth_required: true, bearer_token: token}));
    await assert.rejects(configureLocal({gameDir}, dependencies), error => !error.message.includes(token) && /invalid/.test(error.message));
    assert.equal(existsSync(target), false);
  }
  writeFileSync(join(configDir, 'config.json'), '{"bearer_token":"never_print_this" invalid');
  await assert.rejects(configureLocal({gameDir}, dependencies), error => !error.message.includes('never_print_this') && /invalid/.test(error.message));
}));
test('missing project and incorrect endpoint refuse configuration; existing managed auth prevents direct tools', () => fixture(async ({gameDir, configDir, target, dependencies}) => {
  await assert.rejects(configureLocal({project: '/this/project/does/not/exist'}, dependencies), /does not exist/);
  await configureLocal({gameDir}, dependencies); const before = readFileSync(target, 'utf8');
  await assert.rejects(configureLocal({directTools: true}, dependencies), /compact tools/);
  const endpoint = JSON.parse(readFileSync(join(configDir, 'client.json'), 'utf8')); endpoint.port = 9999;
  writeFileSync(join(configDir, 'client.json'), JSON.stringify(endpoint));
  await assert.rejects(configureLocal({}, dependencies), /8766/);
  assert.equal(readFileSync(target, 'utf8'), before);
}));
test('observer configuration validates its own endpoint and persists only the file path', () => fixture(async ({root, target, dependencies}) => {
  const observer = join(root, 'observer.json');
  writeFileSync(observer, JSON.stringify({host: '127.0.0.1', port: 8767, allow_remote: false, auth_required: true, bearer_token: 'observer_private_token'}));
  await configureLocal({observerConfig: observer}, dependencies);
  const output = readFileSync(target, 'utf8'); assert.ok(!output.includes('observer_private_token'));
  assert.equal(JSON.parse(output).mcpServers.minecraft_telemetry.env.MINECRAFT_OBSERVER_CONFIG, observer);
}));
