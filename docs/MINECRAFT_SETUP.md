# Separate TinyGPU Lab installation

The helper adds a new **TinyGPU Lab** installation to the official Minecraft
Launcher. It targets Minecraft Java 26.3, Fabric Loader 0.19.5, Fabric API
0.161.0+26.3, and the locally built redstone bridge JAR. Java 25 is required by
this Minecraft/bridge version; the official launcher manages the normal game
runtime. No account, EULA, game launch, world creation, or world migration occurs.

```sh
node scripts/setup-minecraft.mjs
node scripts/setup-minecraft.mjs --install
```

The default is a read-only local preview. Installation downloads the profile
from `meta.fabricmc.net` and Fabric API from `maven.fabricmc.net`, using normal
HTTPS verification. The API download must match its pinned SHA-256. The source
bridge JAR must already exist in `bridge/artifacts/` after a successful native
build. Downloading dependencies does not launch Minecraft. Reruns reuse validated
local profile metadata and checksum-verified API bytes, so publishing an already
staged installation works offline. A corrupt cached artifact is preserved and
reported instead of silently replaced. Both helpers accept `--help` and reject
unknown, repeated, or incomplete options.

Default macOS locations:

- Existing launcher: `~/Library/Application Support/minecraft/launcher_profiles.json`
- Separate game directory: `~/Library/Application Support/minecraft-tinygpu-lab`
- Separate mods and configuration live only in that new game directory.
- A new Fabric version JSON is added under the launcher's `versions/` directory.
  Existing version files are never overwritten with different contents.

Linux defaults use `~/.minecraft` and `~/.minecraft-tinygpu-lab`; Windows defaults
use `%APPDATA%\.minecraft` and `%APPDATA%\.minecraft-tinygpu-lab`. Those path choices
are covered by automated tests. Installation and launcher behavior on Linux and
Windows have not been verified live. If process discovery fails, profile
publication remains pending rather than assuming the launcher is closed.

Override paths with `--minecraft-dir`, `--game-dir`, and `--bridge-jar`. Every
path argument must be supplied separately. The lab game directory cannot equal
the current Minecraft directory. A pre-existing nonempty directory without this
installer's marker is refused. This prevents accidental adoption of an existing
world or installation. Repeating a successful install is idempotent; changed
existing target files are refused rather than overwritten.

The helper preserves every launcher JSON field and existing profile. It adds
only profile ID `tinygpu-lab`, retains the existing default/selected profile,
backs up the exact original JSON under the lab's `setup-backups/` using a name
derived from its content hash, and publishes
the updated JSON with an atomic rename after checking for intervening edits.
It does not overwrite the global `mods/` directory or copy old worlds.

**Quit Minecraft Launcher before publishing the profile.** A running launcher
may retain stale profile data and overwrite external edits on exit. If it is
running, `--install` can stage the isolated files but leaves the profile pending.
Quit the launcher normally and rerun the same command. The helper never kills a
process or silently bypasses this check.

## Local bridge connections

The server endpoint binds only `127.0.0.1:8765`; the inspection client binds only
`127.0.0.1:8766`. Both require independently generated bearer tokens, reject browser
Origin headers by default, and disable remote bindings. Tokens remain in local
0600 configuration files and the private setup marker; the helper never prints
them. The configuration directory is:

```text
<game directory>/config/minecraft_fabric_mcp/
  config.json  # world endpoint
  client.json  # client inspection endpoint
```

Set `MINECRAFT_MCP_CONFIG_DIR` to that directory for the assistant bridge's
credential loading. The local configuration helper records that path without
copying tokens:

```sh
npm run configure:local -- --project "/path/to/learning-project" \
  --game-dir "$HOME/Library/Application Support/minecraft-tinygpu-lab"
```

The runner reads `config.json` for the world endpoint and `client.json` for the
user's client. Reconfiguration retains the existing project and credential paths
when those options are omitted, preserves unrelated MCP settings, and checks
that the project directory and local endpoint configurations are valid before
writing. An identical rerun makes no file change. Token validation errors never
print credential contents.

For a separately configured observer, add `--observer-config "/path/to/client.json"`;
that file must describe its loopback endpoint on port 8767. Only its path is
recorded. `--direct-tools` cannot be combined with managed game credentials,
including a previously saved `--game-dir`; direct authenticated endpoints need
their own local authorization configuration.
World categories enable blocks, structures, world reads,
entities, items, server, players, and registries with maximum access `write`.
The client is read-only. Arbitrary scripting tools and admin access are not
enabled by this setup. The local rate cap is 600 requests/minute to support
bounded construction and telemetry batches; the services still bound their own
polling and operation sizes.

The bridge adds observation and construction tools. The project machine still
uses vanilla blocks and redstone for computation. A successful installation
does not establish that either MCP endpoint is live or that a Minecraft circuit
has been built or tested. Those checks follow after the user launches the new
profile and enters its world.

## Setup checkpoint, 2026-09-27

The TinyGPU Lab profile was published and launched on macOS after the remaining
launcher process was closed. A new Creative, Superflat world with commands was
created by the user. Both authenticated bridge endpoints connected successfully;
world/player/inventory reads and a real vanilla-redstone OR circuit passed basic
live checks. Existing worlds were not copied or modified. See the current
[verification record](VERIFICATION.md) for coverage and remaining checks.

The separate rendered observer still requires another connected client. Keep the
pause menu closed during test runs; singleplayer can pause even though bridge
requests continue to return data. The runner rejects stalled server ticks.

## Recovery

If interrupted, rerun the helper; a marker identifies its own partially staged
directory. No mutations are automatically retried against Minecraft itself.
The exact launcher backup is available under `setup-backups/`. To retire the
installation, remove only its profile through the launcher, preserve any wanted
lab worlds, and archive the separate game directory. Never replace the live
launcher JSON wholesale with the old backup after other profile changes.

Official sources:

- [Fabric profile metadata](https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json)
- [Fabric API Maven directory](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.161.0+26.3/)
