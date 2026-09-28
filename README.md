# minecraft redstone

i started this while working on a minecraft version of [adam majmudar's tiny-gpu](https://github.com/adam-maj/tiny-gpu). i wanted codex to help build and debug the redstone without sending it a full screenshot every turn.

the bridge exposes blocks, inventories and player state through mcp. a local adapter sends selected fields and changes, with screenshots when needed. it also adds named signals and buses, tick recordings, local test runs, and build previews with backups and undo. a separate spectator controller is included.

[![the four-bit adder in minecraft](docs/assets/adder-overview.png)](https://jsun.ai/minecraft-mcp/)

[the demo and recording](https://jsun.ai/minecraft-mcp/) · [arithmetic case study](docs/ADDER_CASE_STUDY.md) · [tick traces](docs/TIMING_CASE_STUDY.md) · [what this adds](docs/COMPARISON.md)

## running it

you'll need node 22+, minecraft java 26.3 and java 25.

```sh
git clone https://github.com/jsunco/minecraft-redstone.git
cd minecraft-redstone
npm ci --ignore-scripts
npm test
```

then [build the fabric bridge](bridge/README.md) and follow the [setup notes](docs/MINECRAFT_SETUP.md). [test runner](docs/TEST_RUNNER.md), [architecture](docs/ARCHITECTURE.md) and [tool docs](docs/CIRCUIT_TOOLS.md) cover the rest.

built on [chapmanjw's fabric mcp server](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server). its mit license and pinned source are in [bridge/](bridge/).
