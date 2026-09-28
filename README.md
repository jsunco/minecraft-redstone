# Minecraft Redstone for Codex

A local assistant toolkit for building and understanding vanilla redstone computers. Structured game data is the normal observation path; reduced images are requested when useful. The finished computer must compute with real redstone and work without helper mods.

Includes a Minecraft **26.3** Fabric bridge fork, compact Codex MCP service, construction plans with backups/undo, named signal/bus inspection, finite tick recordings, and a controller for a separate spectator client. Built on [chapmanjw's MIT-licensed Fabric MCP server](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server); provenance is in [bridge](bridge/).

[Architecture](docs/ARCHITECTURE.md) · [Setup](docs/MINECRAFT_SETUP.md) · [Verification](docs/VERIFICATION.md)

## Implemented capabilities

| Area | Behavior |
|---|---|
| Efficient observation | Selected fields, cached deltas, shared identical reads, per-watch cadence, optional backoff, on-demand inventories, bounded concurrency and explicit freshness |
| Building | Register a lab, preview set/fill/clone plans, verify a disk backup, apply, read back, and undo with conflict checks |
| Circuits | Name signals and little-endian buses; read in one server task; preserve unknown/unloaded values; compare expected outputs |
| Timing | Record at the end of server ticks, retain changes in bounded buffers, poll by cursor, report gaps and save detailed local traces |
| Continuity | Project-local definitions, plans, snapshot references and trace artifacts survive Codex process restart |
| Independent movement | Control an explicitly attached **separate spectator client** on port 8767; identity checks separate it from the user's player |

Source compilation and automated tests are distinct from live verification. The runtime and independent rendered observer have **not yet passed in-game acceptance checks**. Observer control requires a separate authenticated rendered client already connected as a spectator; it does not create one, supply a second account, change authentication, or implement a single-client offscreen renderer.

## Setup

Requires Node.js 22+, Minecraft Java 26.3, Java 25, and the matching Fabric Loader/API. Build the native bridge using [the bridge instructions](bridge/README.md), then follow [Minecraft setup](docs/MINECRAFT_SETUP.md) to stage a separate **TinyGPU Lab** installation. Quit the launcher before publishing its new profile.

From the repository root, configure the assistant for that installation:

```sh
npm ci --ignore-scripts
npm run configure:local -- --project "/path/to/learning-project" \
  --game-dir "$HOME/Library/Application Support/minecraft-tinygpu-lab"
npm test
```

The generated, ignored `.mcp.json` points to this checkout and stores project state under `<project>/.minecraft-assistant/`. `--game-dir` records the configuration directory; the runner reads bearer tokens from its local `config.json` and `client.json` without copying them into the plugin configuration. Rerun after moving the checkout or changing Node. Install through Codex's personal plugin marketplace, then start a new Codex chat to pick up updated tools.

The default exposes **17 assistant tools**. For a custom connection setup, `--direct-tools` also exposes the much larger upstream world/client catalog. It cannot be combined with `--game-dir`; authenticated direct endpoints need their own local authorization configuration. Hiding unused schemas reduces catalog size; it does not erase existing conversation context.

Existing worlds are not migrated automatically. Never open a newer save in an older version. The prepared endpoints bind only to loopback and require separate world/client bearer tokens; keep those local credential files out of Git.

| Local endpoint | Purpose |
|---|---|
| `127.0.0.1:8765/mcp` | Server world, blocks, inventories and player data |
| `127.0.0.1:8766/mcp` | User's rendered client/status |
| `127.0.0.1:8767/mcp` | Optional separate spectator client |
| stdio | Codex assistant service; no listening port or hosted service |

## Working loop

1. Run `connection_check`, inspect schemas, and enable `data` or `hybrid` telemetry with a few watches. Discovery does not establish that the intended world is open.
2. Read the project's lesson/progress. Explain a component and ask the learner to predict its behavior.
3. Register the agreed lab, then use `build_plan`, `build_preview`, and `build_apply`. Writes require a backup and matching session. See [build tools](docs/BUILD_TOOLS.md).
4. Register signals/buses, then use `circuit_observe` or a finite `circuit_trace`. Placement/readback does not prove computation. See [circuit tools](docs/CIRCUIT_TOOLS.md).
5. Request a small image for orientation or visual verification. Preserve user camera/GUI. See [observer setup](docs/OBSERVER.md).
6. Record observations and learning evidence. After context loss, request a full telemetry resync and recover build/trace summaries.

## Efficiency evidence

The reproducible synthetic benchmark (`npm run benchmark`) compared 25 observations of four fixture watches. Compact observation at the same coverage delivered **13,264 versus 603,325 JSON bytes** (97.8% fewer) and used **75 versus 100 mocked upstream reads**. With backoff it used 24 reads at reduced temporal coverage. Deferred freshness metadata increased text relative to the every-poll compact case.

These are fixture bytes and mock calls, **not measured live-game tokens, prices, quota or latency savings**. Tick recordings preserve inter-poll changes without repeatedly invoking the model, but end-of-tick sampling can miss changes entirely within a tick. Details: [TELEMETRY.md](TELEMETRY.md).

## Boundaries

Assistant construction uses bounded vanilla regions; direct upstream tools are broader when enabled. Concurrent player edits and redstone dynamics may cause conflicts. No operation is an atomic world transaction. Batch inspection does not silently generate unloaded chunks.

Credentials, local config, profiles, saves, recordings, dependencies and compiled artifacts are excluded from Git. See [access requirements](docs/ACCESS_REQUIREMENTS.md) for outstanding acceptance checks.
