import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProfile, inspectSetup, optionsFromArgs, publishProfiles, RELEASE, setupMinecraft, validateFabricProfile, writeNewOrIdentical } from './setup-minecraft.mjs';

function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'tinygpu-setup-'));
  const minecraftDir = join(root, 'minecraft'); mkdirSync(minecraftDir);
  const document = {profiles: {existing: {name: 'My world', type: 'custom', lastVersionId: '1.21.11', unknown: [1, 2]}}, settings: {enableAdvanced: true}, selectedProfile: 'existing', unknown: {preserve: true}};
  const profilesPath = join(minecraftDir, 'launcher_profiles.json'); writeFileSync(profilesPath, JSON.stringify(document));
  const options = {minecraftDir, gameDir: join(root, 'lab'), bridgeJar: join(root, 'bridge.jar'), install: false};
  return Promise.resolve().then(() => action({root, document, profilesPath, options})).finally(() => rmSync(root, {recursive: true, force: true}));
}

test('default is preview and argument parser refuses unknown flags and shared game directories', () => {
  assert.equal(optionsFromArgs([]).install, false);
  assert.throws(() => optionsFromArgs(['--force']));
  assert.throws(() => optionsFromArgs(['--game-dir']));
  assert.throws(() => optionsFromArgs(['--minecraft-dir', '/tmp/same', '--game-dir', '/tmp/same']));
});

test('profile insertion preserves every existing profile, unknown field and selected default', () => fixture(({document, options}) => {
  const updated = addProfile(document, options.gameDir, '2026-09-27T00:00:00Z');
  assert.deepEqual(updated.profiles.existing, document.profiles.existing);
  assert.deepEqual(updated.settings, document.settings); assert.deepEqual(updated.unknown, document.unknown);
  assert.equal(updated.selectedProfile, 'existing'); assert.equal(Object.keys(document.profiles).length, 1);
  assert.equal(updated.profiles[RELEASE.profileId].gameDir, options.gameDir);
}));

test('preview does not download, create the game directory or alter launcher JSON', () => fixture(async ({options, profilesPath}) => {
  const before = readFileSync(profilesPath, 'utf8');
  const preview = await setupMinecraft(options, {isLauncherRunning: () => true, download: () => { throw new Error('Preview must not download'); }});
  assert.equal(preview.mode, 'preview'); assert.equal(preview.launcher_running, true);
  assert.equal(existsSync(options.gameDir), false); assert.equal(readFileSync(profilesPath, 'utf8'), before);
}));

test('an existing unowned game directory or conflicting launcher profile is refused', () => fixture(({options, profilesPath, document}) => {
  mkdirSync(options.gameDir); writeFileSync(join(options.gameDir, 'important-world'), 'preserve');
  assert.throws(() => inspectSetup(options, () => false), /not empty/);
  rmSync(options.gameDir, {recursive: true});
  document.profiles[RELEASE.profileId] = {name: 'Other project'}; writeFileSync(profilesPath, JSON.stringify(document));
  assert.throws(() => inspectSetup(options, () => false), /refusing to overwrite/);
}));

test('profile publication is backed up and refuses intervening launcher edits', () => fixture(({options, document, profilesPath, root}) => {
  const original = readFileSync(profilesPath, 'utf8'); const backup = join(root, 'backup.json');
  writeFileSync(profilesPath, JSON.stringify({...document, concurrent: true}));
  assert.throws(() => publishProfiles(profilesPath, original, addProfile(document, options.gameDir), backup), /changed/);
  assert.equal(existsSync(backup), false);
  writeFileSync(profilesPath, original);
  publishProfiles(profilesPath, original, addProfile(document, options.gameDir), backup);
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(profilesPath, 'utf8')).profiles.existing, document.profiles.existing);
}));

test('existing different artifacts are never overwritten, while identical writes are idempotent', () => fixture(({root}) => {
  const file = join(root, 'artifact'); writeNewOrIdentical(file, 'first'); writeNewOrIdentical(file, 'first');
  assert.throws(() => writeNewOrIdentical(file, 'different'), /refusing to overwrite/);
  assert.equal(readFileSync(file, 'utf8'), 'first');
}));

test('Fabric loader metadata must match game version, loader id and entry point', () => {
  const good = {id: RELEASE.versionId, inheritsFrom: RELEASE.minecraft, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: []};
  assert.equal(validateFabricProfile(Buffer.from(JSON.stringify(good))).id, RELEASE.versionId);
  assert.throws(() => validateFabricProfile(Buffer.from(JSON.stringify({...good, inheritsFrom: '1.21.11'}))));
  assert.throws(() => validateFabricProfile(Buffer.from(JSON.stringify({...good, mainClass: 'unexpected.Main'}))));
});
