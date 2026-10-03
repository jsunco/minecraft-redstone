# setup

Requires Node 22+, Java 25 and Minecraft Java 26.3. The separate TinyGPU Lab profile uses Fabric Loader 0.19.5 and Fabric API 0.161.0+26.3. Existing profiles, mods and worlds are preserved. Live setup has been checked on macOS only.

```sh
# set JAVA_HOME to a JDK 25 installation first
./bridge/build.sh
node scripts/setup-minecraft.mjs            # preview
node scripts/setup-minecraft.mjs --install
```

Quit Minecraft Launcher before `--install` publishes the profile. If publication is pending, close the launcher and rerun. Installation does not accept the EULA, launch the game or create a world. Launch TinyGPU Lab yourself, enter a Creative world with commands enabled, and keep simulation unpaused during tests.

The macOS game directory is `~/Library/Application Support/minecraft-tinygpu-lab`. Linux defaults to `~/.minecraft-tinygpu-lab`; Windows to `%APPDATA%\.minecraft-tinygpu-lab`. Use `--minecraft-dir`, `--game-dir` or `--bridge-jar` to override paths; `--help` lists options. The lab directory must differ from the normal game directory.

## connect

```sh
npm run configure:local -- --project "/path/to/project" \
  --game-dir "$HOME/Library/Application Support/minecraft-tinygpu-lab"
```

This generates `.mcp.json` with local paths, not tokens. `MINECRAFT_MCP_CONFIG_DIR` can point directly to `<game directory>/config/minecraft_fabric_mcp/`, containing `config.json` and `client.json`. Keep these files private.

The world endpoint uses authenticated loopback port 8765; the user client uses 8766. Setup enables world writes and client reads. [Console and lifecycle controls](COMMAND_CENTRE.md) additionally need `max_access: "admin"` on the relevant endpoint. Use `connection_check` after loading the world; tool discovery alone does not prove a world is running.

## optional spectator

Independent vision needs a distinct, authenticated spectator already connected to the same world. Configure its own `client.json` for `127.0.0.1:8767`, `allow_remote: false`, `auth_required: true` and a separate private token. Set `MINECRAFT_OBSERVER_CONFIG` to that file, or pass `--observer-config "/path/to/client.json"` to `configure:local`.

Call `observer_control` with:

```json
{"action":"attach","user_uuid":"<user UUID>","observer_uuid":"<distinct spectator UUID>"}
```

Then use `move`, `capture`, `status` or `detach`; reattach after restart. The controller checks identity and pose. It does not create a second client or move the user as a fallback. Independent rendered vision remains unverified live.

## recovery

Rerun interrupted setup to resume its marked staging directory. Preserve changed or corrupt files for inspection. Launcher backups are under the lab's `setup-backups/`; never replace the current launcher JSON wholesale after other profile changes. To retire the lab, remove only its profile and preserve wanted saves.

Runtime state lives under the project's ignored `.minecraft-assistant/`. Recover [builds](BUILD_TOOLS.md), [tests](TEST_RUNNER.md) and [lifecycle operations](COMMAND_CENTRE.md) through their journals, without replaying uncertain writes. Readable blocks may not be ticking: ensure the entire active circuit is simulated and preserve its required `forceload` pins.
