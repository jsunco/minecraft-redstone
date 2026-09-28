#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE = Object.freeze({minecraft: '26.3', loader: '0.19.5', api: '0.161.0+26.3',
  profileId: 'tinygpu-lab', profileName: 'TinyGPU Lab', versionId: 'fabric-loader-0.19.5-26.3',
  apiSha256: '86f16178a3cecc887a85a4cfe9a79d92fa7341d8f39b5951a4d6ad800ab657a6'});
const scriptDir = dirname(fileURLToPath(import.meta.url));
const markerName = '.tinygpu-setup.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${RELEASE.minecraft}/${RELEASE.loader}/profile/json`;
const apiUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${RELEASE.api}/fabric-api-${RELEASE.api}.jar`;

export function defaultDirectories(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return {minecraftDir: join(home, 'Library', 'Application Support', 'minecraft'), gameDir: join(home, 'Library', 'Application Support', 'minecraft-tinygpu-lab')};
  if (platform === 'win32') { const base = env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'); return {minecraftDir: win32.join(base, '.minecraft'), gameDir: win32.join(base, '.minecraft-tinygpu-lab')}; }
  return {minecraftDir: join(home, '.minecraft'), gameDir: join(home, '.minecraft-tinygpu-lab')};
}
export function optionsFromArgs(argv) {
  const options = {install: false, ...defaultDirectories(),
    bridgeJar: resolve(scriptDir, '../bridge/artifacts/minecraft-fabric-mcp-1.1.0-redstone.1+26.3.jar')};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (seen.has(argv[i])) throw new Error(`Duplicate option: ${argv[i]}`);
    seen.add(argv[i]);
    if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else if (argv[i] === '--install') options.install = true;
    else if (['--minecraft-dir', '--game-dir', '--bridge-jar'].includes(argv[i])) {
      const field = {'--minecraft-dir': 'minecraftDir', '--game-dir': 'gameDir', '--bridge-jar': 'bridgeJar'}[argv[i]];
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Path option requires a value'); options[field] = resolve(value);
    } else throw new Error(`Unknown option ${argv[i]}; use --install, --minecraft-dir, --game-dir, --bridge-jar`);
  }
  if (resolve(options.gameDir) === resolve(options.minecraftDir)) throw new Error('The lab game directory must be separate from the existing Minecraft directory');
  return options;
}
export function launcherRunning() {
  try {
    if (process.platform === 'win32') return /"(?:MinecraftLauncher|Minecraft)\.exe"/i.test(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {encoding: 'utf8'}));
    if (!['darwin', 'linux'].includes(process.platform)) return true;
    return execFileSync('ps', ['-ax', '-o', 'comm='], {encoding: 'utf8'}).split('\n')
      .some(line => /\/Minecraft(?: Launcher)?\.app\/Contents\/MacOS\/launcher$|(?:^|\/)minecraft-launcher$/i.test(line.trim()));
  } catch { return true; } // Unknown process state never authorizes profile publication.
}
export function inspectSetup(options, isLauncherRunning = launcherRunning) {
  if (resolve(options.gameDir) === resolve(options.minecraftDir)) throw new Error('The lab game directory must be separate from the existing Minecraft directory');
  const profilesPath = join(options.minecraftDir, 'launcher_profiles.json');
  if (!existsSync(profilesPath)) throw new Error('Official launcher_profiles.json is missing; open the official launcher once before installation');
  const original = readFileSync(profilesPath, 'utf8'); const document = JSON.parse(original);
  if (!document.profiles || typeof document.profiles !== 'object' || Array.isArray(document.profiles)) throw new Error('Unrecognized launcher profile format');
  const existing = document.profiles[RELEASE.profileId];
  if (existing && (existing.name !== RELEASE.profileName || resolve(existing.gameDir ?? options.minecraftDir) !== resolve(options.gameDir) || existing.lastVersionId !== RELEASE.versionId)) throw new Error('The target profile id is already used by another installation; refusing to overwrite it');
  const sameName = Object.entries(document.profiles).find(([id, p]) => id !== RELEASE.profileId && (p.name === RELEASE.profileName || p.gameDir && resolve(p.gameDir) === resolve(options.gameDir)));
  if (sameName) throw new Error('An existing launcher profile already owns the target name or game directory');
  const markerPath = join(options.gameDir, markerName); let marker = null;
  if (existsSync(options.gameDir)) {
    if (existsSync(markerPath)) {
      try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); }
      catch { throw new Error('The private setup marker is invalid; its contents were not printed'); }
      if (marker.owner !== 'minecraft-redstone-setup' || marker.versionId !== RELEASE.versionId || marker.gameDir !== resolve(options.gameDir)) throw new Error('Existing game directory has an unrelated setup marker');
    } else if (readdirSync(options.gameDir).length > 0) throw new Error('Target game directory is not empty and is not owned by this installer');
  }
  return {profilesPath, original, document, existing: Boolean(existing), marker, launcher_running: isLauncherRunning(),
    game_dir: options.gameDir, version_json: join(options.minecraftDir, 'versions', RELEASE.versionId, `${RELEASE.versionId}.json`),
    bridge_jar: options.bridgeJar, bridge_available: existsSync(options.bridgeJar)};
}
export function addProfile(document, gameDir, now = new Date().toISOString()) {
  if (document.profiles[RELEASE.profileId]) return structuredClone(document);
  return {...structuredClone(document), profiles: {...structuredClone(document.profiles), [RELEASE.profileId]: {
    name: RELEASE.profileName, type: 'custom', created: now, lastVersionId: RELEASE.versionId, gameDir: resolve(gameDir), icon: 'Redstone_Block',
  }}};
}
export function writeNewOrIdentical(path, bytes) {
  if (existsSync(path)) {
    if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error(`Existing file differs; refusing to overwrite: ${path}`);
    return;
  }
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  // Publish a fully written file without overwriting an intervening creation.
  const temporary = `${path}.tmp-${randomUUID()}`;
  try { writeFileSync(temporary, bytes, {flag: 'wx', mode: 0o600}); linkSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function publishProfiles(path, original, updated, backupPath) {
  if (readFileSync(path, 'utf8') !== original) throw new Error('Launcher profiles changed during setup; no profile update was published');
  writeNewOrIdentical(backupPath, original);
  const temporary = `${path}.tinygpu-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, pretty(updated), {flag: 'wx', mode: 0o600});
    if (readFileSync(path, 'utf8') !== original) throw new Error('Launcher profiles changed while writing; no profile update was published');
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function officialDownload(url, maxBuffer = 32 * 1024 * 1024) {
  return execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60', url], {maxBuffer});
}
export async function verifiedAsset(path, url, sha256, download = officialDownload) {
  const bytes = existsSync(path) ? readFileSync(path) : await download(url);
  if (digest(bytes) !== sha256) throw new Error('Fabric API checksum mismatch; existing files were preserved and nothing was installed');
  return bytes;
}
export function validateFabricProfile(bytes) {
  const value = JSON.parse(bytes.toString());
  if (value.id !== RELEASE.versionId || value.inheritsFrom !== RELEASE.minecraft || value.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotClient' || !Array.isArray(value.libraries)) throw new Error('Official Fabric profile does not match the requested Minecraft/loader version');
  return value;
}
function endpointConfig(port, categories, access, token) {
  return {host: '127.0.0.1', port, auth_required: true, bearer_token: token, allow_remote: false, allowed_origins: [],
    rate_limit_rpm: 600, command_timeout_ms: 15000, included_categories: categories, excluded_categories: [], max_access: access, exclude_write_tools: access === 'read'};
}
function preview(options, check) {
  return {mode: options.install ? 'install' : 'preview', profile: RELEASE.profileName, minecraft: RELEASE.minecraft, fabric_loader: RELEASE.loader, fabric_api: RELEASE.api,
    game_directory: options.gameDir, launcher_profiles: check.profilesPath, version_json: check.version_json,
    bridge_jar: options.bridgeJar, bridge_available: check.bridge_available, launcher_running: check.launcher_running,
    profile_already_present: check.existing, existing_profiles_preserved: Object.keys(check.document.profiles).length,
    endpoints: ['http://127.0.0.1:8765/mcp', 'http://127.0.0.1:8766/mcp'], authenticated: true,
    config_directory: join(options.gameDir, 'config', 'minecraft_fabric_mcp'),
    next: options.install ? (check.launcher_running ? 'Isolated files can be staged; quit the launcher and rerun to publish the profile safely.' : 'Install isolated files and add the new profile.') : 'Run with --install to stage files and add the profile. No launch, account action, EULA acceptance, existing world copy, or global mod changes.'};
}
export async function setupMinecraft(options, {download = officialDownload, isLauncherRunning = launcherRunning} = {}) {
  const check = inspectSetup(options, isLauncherRunning); const report = preview(options, check);
  if (!options.install) return report;
  if (!check.bridge_available) throw new Error('Compiled bridge artifact is not available; finish the bridge build before installing');
  const bridgeBytes = readFileSync(options.bridgeJar);
  if (bridgeBytes.length < 1000 || bridgeBytes[0] !== 0x50 || bridgeBytes[1] !== 0x4b) throw new Error('Bridge artifact is not a JAR/ZIP');
  const fabricBytes = existsSync(check.version_json) ? readFileSync(check.version_json) : await download(profileUrl); validateFabricProfile(fabricBytes);
  const apiPath = join(options.gameDir, 'mods', `fabric-api-${RELEASE.api}.jar`);
  const apiBytes = await verifiedAsset(apiPath, apiUrl, RELEASE.apiSha256, download);
  // Every conflicting path is checked before writing any setup file.
  const configDir = join(options.gameDir, 'config', 'minecraft_fabric_mcp');
  const worldPath = join(configDir, 'config.json'); const clientPath = join(configDir, 'client.json');
  const configs = check.marker?.configs ?? {
    world: endpointConfig(8765, ['blocks', 'structures', 'world', 'entities', 'items', 'server', 'players', 'registries'], 'write', randomBytes(32).toString('hex')),
    client: endpointConfig(8766, ['client'], 'read', randomBytes(32).toString('hex')),
  };
  for (const [source, port] of [['world', 8765], ['client', 8766]]) {
    const value = configs[source];
    if (!value || value.host !== '127.0.0.1' || value.port !== port || value.auth_required !== true || value.allow_remote !== false || !/^[a-f0-9]{64}$/.test(value.bearer_token ?? '')) throw new Error('Private setup credentials or endpoint boundaries are invalid; refusing to reuse them');
  }
  if (configs.world.bearer_token === configs.client.bearer_token) throw new Error('World and client credentials must be distinct');
  const marker = check.marker ?? {owner: 'minecraft-redstone-setup', versionId: RELEASE.versionId, gameDir: resolve(options.gameDir), created_at: new Date().toISOString(), configs};
  const files = [
    [check.version_json, existsSync(check.version_json) ? fabricBytes : pretty(validateFabricProfile(fabricBytes))],
    [join(options.gameDir, 'mods', 'minecraft-fabric-mcp-1.1.0-redstone.1+26.3.jar'), bridgeBytes],
    [apiPath, apiBytes],
    [worldPath, pretty(configs.world)], [clientPath, pretty(configs.client)], [join(options.gameDir, markerName), pretty(marker)],
  ];
  for (const [path, bytes] of files) if (existsSync(path) && !readFileSync(path).equals(Buffer.from(bytes))) throw new Error(`Existing file differs; refusing to overwrite: ${path}`);
  // Marker first makes interrupted file staging recognizable and safely resumable.
  writeNewOrIdentical(join(options.gameDir, markerName), pretty(marker));
  for (const [path, bytes] of files) writeNewOrIdentical(path, bytes);
  const runningNow = isLauncherRunning(); let profilePublished = check.existing;
  if (!profilePublished && !runningNow) {
    publishProfiles(check.profilesPath, check.original, addProfile(check.document, options.gameDir), join(options.gameDir, 'setup-backups', `launcher_profiles.before-${digest(check.original).slice(0, 16)}.json`));
    profilePublished = true;
  }
  const reread = JSON.parse(readFileSync(check.profilesPath, 'utf8'));
  if (profilePublished && reread.profiles[RELEASE.profileId]?.gameDir !== resolve(options.gameDir)) throw new Error('Launcher profile verification failed');
  return {...report, files_installed: files.map(([path]) => path), bridge_sha256: digest(bridgeBytes), fabric_api_sha256: digest(apiBytes),
    profile_published: profilePublished, profile_pending: !profilePublished, launcher_running: runningNow, game_launched: false,
    next: profilePublished ? 'Select TinyGPU Lab in the official launcher when ready. Configure the assistant with MINECRAFT_MCP_CONFIG_DIR; no credentials were printed.' : 'Quit Minecraft Launcher, then rerun --install to publish the staged profile. No existing profile was edited.'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = optionsFromArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/setup-minecraft.mjs [--install] [--minecraft-dir DIR] [--game-dir DIR] [--bridge-jar FILE]\nDefault: read-only preview. --install stages the separate lab and publishes its profile only while the launcher is closed.');
    else console.log(pretty(await setupMinecraft(options)));
  }
  catch (error) { console.error(`Minecraft setup: ${error.message}`); process.exitCode = 1; }
}
