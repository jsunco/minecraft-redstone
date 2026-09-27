# Minecraft Redstone for Codex

A personal Codex plugin for inspecting and building vanilla-redstone computers in Minecraft Java. It connects to [Minecraft Java Fabric MCP Server](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server) and adds an optional compact telemetry adapter that sends state changes instead of repeated full readings or screenshots.

## Current state

- Codex plugin and compact telemetry adapter implemented; 24 automated tests pass.
- Optional **data**, **hybrid**, and **disabled** modes; disabled by default.
- Game-side bridge installation and live Minecraft verification are pending.
- An independently moving observer camera and fuller inventory coverage are requirements still awaiting implementation.
- Actual context/token savings have not been measured against a live game.

The finished computer uses vanilla blocks and real redstone. Helper mods are development tools; the completed circuit must also work in an unmodified Minecraft profile.

## Local setup

Requires Node.js 22 or newer. Clone this private repository using an authorized GitHub account, then run from its root:

```sh
npm ci --ignore-scripts
npm run configure:local
npm test
```

The setup command generates `.mcp.json` with the checkout's absolute path and the current Node executable. That machine-specific file is excluded from Git. `.mcp.example.json` documents the template. Rerun setup after moving the checkout or changing Node installations. Setup restores the documented localhost endpoint defaults; preserve any intentional custom ports before rerunning it.

Register this directory in a Codex personal marketplace using Codex's plugin-creator workflow. Install the plugin, then open a new Codex chat to pick up its tools. The manifest is `.codex-plugin/plugin.json`; skills live in `skills/`.

## Minecraft connection

Install matching Fabric Loader, Fabric API and the separate upstream bridge mod for a supported game version, then launch Minecraft and open the project world. The upstream mod is MIT licensed and is not bundled here.

| Connection | Purpose |
|---|---|
| `http://127.0.0.1:8765/mcp` | World, blocks, inventory and player tools |
| `http://127.0.0.1:8766/mcp` | Current client view and perception |
| Local stdio process | Optional compact telemetry adapter |

Keep game endpoints on localhost. No hosted service or separate API key is needed. Upstream's `players` category is disabled by default; enable it while retaining other required categories when configuring broader player inspection.

Compatibility checked on 2026-09-27: upstream v1.1.0 publishes targets for 1.21.11, 26.1.1, 26.1.2 and **26.2**. No verified **26.3** target was found. Recheck [releases](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/releases/tag/v1.1.0) and the [build matrix](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/settings.gradle.kts) before choosing versions. Preserve existing saves; do not open a newer-version world in an older game.

Once connected, verify runtime/player status, inspect an empty test region, then test a small lever/dust/lamp circuit while the game ticks. A successful placement command is not proof of settled or correct redstone behavior.

## Compact observation

See [TELEMETRY.md](TELEMETRY.md) for configuration, selected watches, cached field/slot deltas, byte limits, resynchronization, screenshots and tests.

State comes directly from the game APIs, so F3 does not need to be visible. Hybrid mode permits reduced screenshots on explicit request. Current screenshots are from the local player client; they do not provide an independent observer. The plugin preserves the user's character, camera and open GUI.

## Requirements and limitations

[Access requirements](docs/ACCESS_REQUIREMENTS.md) specify independent observation, inventory coverage and integration acceptance tests. The project does not yet provide a separate camera, reliable per-tick waveform recorder or an atomic world snapshot. Ordinary polling can miss short pulses.

This repository contains the plugin source, tests and documentation. Minecraft saves, dependencies, machine-specific configuration and GitHub credentials are excluded.

References: [upstream tools](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/docs/tools.md), [bridge configuration](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/docs/configuration.md), [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp).
