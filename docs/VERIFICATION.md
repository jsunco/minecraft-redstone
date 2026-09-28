# Verification record — 2026-09-27

## Completed

- `npm test`: **110 tests passed** after the polish pass. Includes actual MCP SDK stdio negotiation and local HTTP authentication, plus simulated world/circuit/observer responses, construction failure recovery, persistence, schema caching and bounded output.
- Minecraft 26.3: server and client source compile; **449 Java tests passed**. These use controlled adapter/world seams, not a running Minecraft world.
- Subsequent native review added two regression cases and passed **11/11 focused native/recorder tests**. The runtime source and JAR are unchanged. A full Gradle rerun stalled fetching dependencies, so 449 remains the previous full-suite result; the focused run used JDK 25, JUnit Console and the installed 26.3 libraries.
- Four actual Java TOON encoder outputs decoded exactly through the JavaScript decoder: block batch, empty poll, nested changed/unloaded rows and numeric inventory slot maps.
- Native JAR SHA-256: `6242e9577c1f446fa7fb83f23c52a128107913fd173e25c171d6e04e58037557`.
- Codex plugin and skill validators passed. Installed MCP runner exposes exactly **17 tools**; build apply/undo and observer control have write annotations. Default telemetry is disabled.
- Isolated game files were installed with authenticated loopback endpoints. Fabric API checksum is verified by the setup script. Existing launcher profiles and game worlds were preserved.
- `npm run benchmark` reproduces 13,264 compact versus 603,325 raw JSON bytes at equal synthetic polling coverage. Backoff separately reduces mocked reads with reduced observation frequency.

## Not established

- Live Minecraft bridge initialization, actual world/player/inventory reads, server-tick capture and structure restoration.
- Real redstone computation, timing correctness, or any learner milestone.
- A separately connected rendered observer or proof of independent control in the running game.
- Actual model tokens, quota, cost or live latency savings.
- Other Minecraft target versions, upstream formatting/checkstyle tasks, or GameTest execution.

The launcher profile publication was deferred while another launcher instance held cached settings. After normal launcher shutdown, rerun the idempotent setup command, select TinyGPU Lab, and complete the acceptance sequence in [ACCESS_REQUIREMENTS.md](ACCESS_REQUIREMENTS.md).

Generated profiles, private credentials, world saves, build caches, recordings and compiled JARs are excluded from the repository. The source and pinned rebuild path are retained; Gradle caches live outside the plugin tree.

The polish pass also verifies malformed-credential rejection without leaking values, stale connection/schema race handling, snapshot fallback for oversized deltas, retryable trace persistence, observer angle wrapping, preserved setup credentials, offline setup resume, atomic file writes, and validated/paginated build recovery. The inherited generic-event listener retention limitation is documented in [bridge/README.md](../bridge/README.md); the compact state/trace paths do not rely on those listeners.
