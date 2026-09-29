package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;

/** Per-server observer and explicit admin facade. All instance methods run on the server thread. */
public final class NativeTelemetry {
    private static volatile NativeTelemetry active;
    public record Point(int x, int y, int z) {}
    private record Watch(String dimension, List<Point> positions, Set<String> properties, TickRecorder recorder) {}
    @FunctionalInterface
    interface StateReader { List<TickRecorder.State> read(String dimension, List<Point> positions, Set<String> properties); }
    private final java.util.function.LongSupplier clock;
    private final Runnable threadCheck;
    private final StateReader stateReader;
    private final ObjectMapper mapper;
    private MinecraftServer server;
    private final String sessionId = UUID.randomUUID().toString();
    private final Map<String, Watch> watches = new LinkedHashMap<>();
    private Object quitLease;
    private boolean closed;

    public NativeTelemetry(MinecraftServer server, ObjectMapper mapper) {
        this(mapper, () -> server.getTickCount(), () -> {
            if (!server.isSameThread()) throw new IllegalStateException("Native telemetry requires Minecraft server thread");
        }, (dimension, positions, properties) -> readWorld(server, dimension, positions, properties));
        this.server = server;
        active = this;
    }
    NativeTelemetry(ObjectMapper mapper, java.util.function.LongSupplier clock, Runnable threadCheck, StateReader stateReader) {
        this.mapper = mapper; this.clock = clock; this.threadCheck = threadCheck; this.stateReader = stateReader;
    }
    private void checkThread() { threadCheck.run(); }
    public String sessionId() { return sessionId; }
    /** Exact server identity lookup for client lifecycle guards; never adopts another server's session. */
    public static String sessionFor(MinecraftServer server) {
        NativeTelemetry current = active;
        return current != null && server != null && current.server == server ? current.sessionId : null;
    }
    /**
     * Seal recorder admission before a client-thread disconnect is scheduled. Acquisition and
     * release both run on this exact server's thread; release is only for a failed disconnect.
     */
    public static Runnable acquireQuitLease(MinecraftServer server, String expectedSession) {
        NativeTelemetry current = active;
        if (server == null || current == null || current.server != server)
            throw new IllegalStateException("Native telemetry does not belong to the requested server");
        return current.acquireQuitLease(expectedSession);
    }
    Runnable acquireQuitLease(String expectedSession) {
        checkThread();
        if (!sessionId.equals(expectedSession)) throw new IllegalStateException("Native telemetry session changed");
        if (closed || quitLease != null) throw new IllegalStateException("Server quit is already in progress");
        if (watches.values().stream().anyMatch(w -> w.recorder().active()))
            throw new IllegalStateException("Cannot quit while a native recorder is active");
        Object token = new Object();
        quitLease = token;
        return () -> {
            checkThread();
            // A delayed or duplicate release must not reopen a closed server or a later lease.
            if (!closed && quitLease == token) quitLease = null;
        };
    }
    private long tick() { return clock.getAsLong(); }
    private ObjectNode envelope() {
        ObjectNode out = mapper.createObjectNode();
        out.put("session_id", sessionId); out.put("server_tick", tick()); return out;
    }
    private List<TickRecorder.State> read(String dimension, List<Point> positions, Set<String> properties) {
        checkThread();
        return stateReader.read(dimension, positions, properties);
    }
    private static List<TickRecorder.State> readWorld(MinecraftServer server, String dimension, List<Point> positions, Set<String> properties) {
        ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.parse(dimension)));
        List<TickRecorder.State> result = new ArrayList<>();
        for (Point point : positions) {
            if (level == null) { result.add(new TickRecorder.State("unknown_dimension", null, Map.of())); continue; }
            BlockPos pos = new BlockPos(point.x(), point.y(), point.z());
            if (level.isOutsideBuildHeight(pos)) {
                result.add(new TickRecorder.State("outside_build_height", null, Map.of())); continue;
            }
            if (!level.hasChunk(point.x() >> 4, point.z() >> 4)) {
                result.add(new TickRecorder.State("unloaded", null, Map.of())); continue;
            }
            BlockState state = level.getBlockState(pos);
            Map<String, String> props = new LinkedHashMap<>();
            //? if mc_gte_26 {
            state.getValues().forEach(v -> {
                String key = v.property().getName();
                if (properties.isEmpty() || properties.contains(key)) props.put(key, v.valueName());
            });
            //?} else {
            /*state.getValues().forEach((property, value) -> {
                String key = property.getName();
                if (properties.isEmpty() || properties.contains(key)) props.put(key, value.toString());
            });
            *///?}
            String id = level.registryAccess().lookupOrThrow(Registries.BLOCK).getKey(state.getBlock()).toString();
            result.add(new TickRecorder.State("loaded", id, props));
        }
        return List.copyOf(result);
    }
    private ObjectNode stateRow(int index, Point point, TickRecorder.State state) {
        ObjectNode row = mapper.createObjectNode(); row.put("index", index); row.set("position", mapper.valueToTree(point)); row.put("status", state.status());
        if (state.id() != null) row.put("id", state.id());
        ObjectNode props = row.putObject("properties"); state.properties().forEach(props::put); return row;
    }
    private ArrayNode rows(List<TickRecorder.State> states, List<Point> positions) {
        ArrayNode rows = mapper.createArrayNode();
        for (int i = 0; i < states.size(); i++) rows.add(stateRow(i, positions.get(i), states.get(i))); return rows;
    }
    public ObjectNode batch(String dimension, List<Point> positions, Set<String> properties) {
        checkThread();
        if (positions.isEmpty() || positions.size() > 512) throw new IllegalArgumentException("1..512 positions required");
        ObjectNode out = envelope(); out.put("dimension", dimension); out.put("atomic", true);
        out.put("phase", "server_task"); out.set("positions", mapper.valueToTree(positions));
        out.set("states", rows(read(dimension, positions, properties), positions)); return out;
    }
    public ObjectNode start(String dimension, List<Point> positions, Set<String> properties, int duration, int capacity) {
        checkThread();
        if (closed || quitLease != null) throw new IllegalStateException("Recorder admission is closed while server quits");
        if (watches.size() >= 8) throw new IllegalStateException("Recorder limit 8 reached; discard a completed recorder");
        if (positions.isEmpty() || positions.size() > 64) throw new IllegalArgumentException("1..64 positions required");
        if (duration < 1 || duration > 12000) throw new IllegalArgumentException("duration_ticks must be 1..12000");
        if (capacity < 16 || capacity > 4096) throw new IllegalArgumentException("buffer_capacity must be 16..4096");
        int used = watches.values().stream().filter(w -> w.recorder().active()).mapToInt(w -> w.positions().size()).sum();
        if (used + positions.size() > 256) throw new IllegalStateException("Active watched position limit 256 reached");
        List<TickRecorder.State> initial = read(dimension, positions, properties);
        TickRecorder recorder = new TickRecorder(initial, tick(), duration, capacity);
        String id = UUID.randomUUID().toString();
        watches.put(id, new Watch(dimension, List.copyOf(positions), Set.copyOf(properties), recorder));
        ObjectNode out = metadata(id, watches.get(id)); out.put("next_seq", 0);
        out.set("positions", mapper.valueToTree(positions)); out.set("initial_states", rows(initial, positions));
        out.put("initial_phase", "server_task"); out.put("sampling_phase", "end_server_tick"); return out;
    }
    public void onEndTick() {
        checkThread();
        for (Watch watch : watches.values()) {
            if (watch.recorder().active()) watch.recorder().sample(tick(), read(watch.dimension(), watch.positions(), watch.properties()));
        }
    }
    private Watch require(String id) {
        Watch w = watches.get(id);
        if (w == null) throw new IllegalArgumentException("Unknown watch_id; recorder belongs to another session or was discarded");
        return w;
    }
    private ObjectNode metadata(String id, Watch watch) {
        ObjectNode out = envelope(); TickRecorder r = watch.recorder();
        out.put("watch_id", id); out.put("dimension", watch.dimension()); out.put("active", r.active());
        out.put("started_tick", r.startedTick()); out.put("last_sample_tick", r.lastTick()); out.put("duration_ticks", r.durationTicks());
        out.put("point_count", watch.positions().size());
        if (r.endReason() != null) out.put("end_reason", r.endReason()); return out;
    }
    public ObjectNode poll(String id, long after, int max) {
        checkThread(); Watch watch = require(id); TickRecorder.Page page = watch.recorder().poll(after, max);
        ObjectNode out = metadata(id, watch);
        out.put("next_seq", page.nextSeq()); out.put("latest_seq", page.latestSeq()); out.put("oldest_seq", page.oldestSeq());
        out.put("dropped_total", page.droppedTotal()); out.put("gap", page.gap());
        ArrayNode events = out.putArray("entries");
        for (TickRecorder.Entry entry : page.entries()) {
            ObjectNode e = events.addObject(); e.put("seq", entry.seq()); e.put("tick", entry.tick());
            e.put("missed_ticks", entry.missedTicks());
            ArrayNode changed = e.putArray("states");
            entry.changes().entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(c -> changed.add(stateRow(c.getKey(), watch.positions().get(c.getKey()), c.getValue())));
        }
        if (page.gap()) { out.set("recovery_states", rows(page.recoveryStates(), watch.positions())); out.put("recovery_tick", watch.recorder().lastTick()); }
        return out;
    }
    public ObjectNode stop(String id, boolean discard) {
        checkThread(); Watch watch = require(id); watch.recorder().stop("stopped");
        ObjectNode out = metadata(id, watch); out.put("discarded", discard); if (discard) watches.remove(id); return out;
    }
    public ObjectNode list() {
        checkThread(); ObjectNode out = envelope(); ArrayNode items = out.putArray("watches");
        watches.forEach((id, watch) -> items.add(metadata(id, watch))); return out;
    }
    public ObjectNode inventory(UUID uuid, boolean includeComponents) {
        checkThread();
        if (server == null) throw new IllegalStateException("Live server required for inventory views");
        ObjectNode out = NativeInventory.read(server, mapper, uuid, includeComponents);
        out.put("session_id",sessionId); out.put("server_tick",tick()); out.put("atomic",true); return out;
    }
    private AdminControl admin() {
        checkThread();
        if (server == null) throw new IllegalStateException("Live server required for admin control");
        return new AdminControl(mapper, sessionId, threadCheck,
                () -> watches.values().stream().anyMatch(w -> w.recorder().active()),
                new VanillaAdminBackend(server, mapper));
    }
    public ObjectNode adminStatus() { return admin().status(); }
    public ObjectNode adminCommand(String expected, String command, String dimension) { return admin().command(expected, command, dimension); }
    public ObjectNode adminTick(String expected, String action, Double rate, Integer ticks) { return admin().tickControl(expected, action, rate, ticks); }
    public void close() { checkThread(); closed = true; quitLease = null; watches.clear(); if (active == this) active = null; }
}
