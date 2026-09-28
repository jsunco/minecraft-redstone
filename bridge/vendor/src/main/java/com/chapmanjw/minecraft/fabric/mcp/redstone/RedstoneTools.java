package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import com.fasterxml.jackson.databind.JsonNode;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ArgumentReader;
import com.chapmanjw.minecraft.fabric.mcp.protocol.Schemas;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ToolContext;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ToolResult;
import com.chapmanjw.minecraft.fabric.mcp.tools.BaseTool;
import com.chapmanjw.minecraft.fabric.mcp.tools.annotations.McpTool;

/** Native bounded observation tools. Recorder writes affect observer memory only. */
public final class RedstoneTools {
    private RedstoneTools() {}
    private static NativeTelemetry nativeFor(ToolContext c) {
        if (c.nativeTelemetry() == null) throw new IllegalStateException("Native telemetry unavailable on this endpoint");
        return c.nativeTelemetry();
    }
    private static JsonNode pointsSchema() {
        return Schemas.arrayOf("Ordered block coordinates, no chunk loading", Schemas.object().required("x", Schemas.integer("X coordinate")).required("y", Schemas.integer("Y coordinate")).required("z", Schemas.integer("Z coordinate")).build());
    }
    private static JsonNode propertiesSchema() {
        return Schemas.arrayOf("Optional state-property names; empty means all. Up to 16 names.", Schemas.string());
    }
    private static List<NativeTelemetry.Point> points(ArgumentReader reader, int max) {
        JsonNode items = reader.requireArray("positions");
        if (items.isEmpty() || items.size() > max) throw new IllegalArgumentException("positions requires 1.." + max + " entries");
        List<NativeTelemetry.Point> result = new ArrayList<>();
        for (JsonNode item : items) {
            ArgumentReader r = new ArgumentReader("position", item);
            int x = r.requireInt("x"), y = r.requireInt("y"), z = r.requireInt("z");
            if (Math.abs((long) x) > 30000000 || Math.abs((long) z) > 30000000) throw new IllegalArgumentException("Position outside world coordinate limits");
            result.add(new NativeTelemetry.Point(x, y, z));
        }
        return List.copyOf(result);
    }
    private static Set<String> properties(ArgumentReader reader) {
        JsonNode value = reader.raw().get("properties");
        if (value == null) return Set.of();
        if (!value.isArray() || value.size() > 16) throw new IllegalArgumentException("properties must be an array of up to 16 names");
        Set<String> result = new LinkedHashSet<>();
        for (JsonNode item : value) {
            if (!item.isTextual() || !item.asText().matches("[a-z_]{1,64}")) throw new IllegalArgumentException("Invalid property name");
            result.add(item.asText());
        }
        return Set.copyOf(result);
    }
    @McpTool(name="block_get_states_batch", description="Read up to 512 block states in one server task. Same-tick, no NBT, no chunk loads; explicit unloaded statuses.", readOnly=true)
    public static final class Batch extends BaseTool {
        public Batch() { super("block_get_states_batch"); }
        public JsonNode inputSchema() { return Schemas.object().required("dimension", Schemas.string()).required("positions", pointsSchema()).optional("properties", propertiesSchema()).build(); }
        public ToolResult execute(JsonNode args, ToolContext c) {
            var r = reader(args); String dim = r.requireString("dimension"); var pos = points(r,512); var props = properties(r);
            return onMainThread(c, ignored -> okToon(nativeFor(c).batch(dim,pos,props)));
        }
    }
    @McpTool(name="block_watch_start", description="Arm bounded end-of-server-tick recording for 1..64 blocks, at most 8 recorders/256 active points; no chunk loading or world writes. duration_ticks 1..12000.", readOnly=true)
    public static final class Start extends BaseTool {
        public Start() { super("block_watch_start"); }
        public JsonNode inputSchema() { return Schemas.object().required("dimension", Schemas.string()).required("positions", pointsSchema()).optional("properties", propertiesSchema()).optional("duration_ticks", Schemas.integerBetween("Duration in server ticks; default 200",1,12000)).optional("buffer_capacity", Schemas.integerBetween("Transition entries retained; default 1024",16,4096)).build(); }
        public ToolResult execute(JsonNode args, ToolContext c) {
            var r = reader(args); String dim = r.requireString("dimension"); var pos = points(r,64); var props = properties(r);
            int duration = r.optInt("duration_ticks",200), capacity = r.optInt("buffer_capacity",1024);
            return onMainThread(c, ignored -> okToon(nativeFor(c).start(dim,pos,props,duration,capacity)));
        }
    }
    @McpTool(name="block_watch_poll", description="Read recorder transitions after a non-destructive sequence cursor. A gap returns current recovery_states instead of incomplete deltas. No within-tick pulse guarantee.", readOnly=true)
    public static final class Poll extends BaseTool {
        public Poll() { super("block_watch_poll"); }
        public JsonNode inputSchema() { return Schemas.object().required("watch_id", Schemas.string()).optional("after_seq", Schemas.integer("Last acknowledged sequence; default 0")).optional("max_entries", Schemas.integerBetween("Maximum transition entries; default 128",1,512)).build(); }
        public ToolResult execute(JsonNode args, ToolContext c) {
            var r = reader(args); String id = r.requireString("watch_id"); long after = r.optLong("after_seq",0); int max = r.optInt("max_entries",128);
            return onMainThread(c, ignored -> okToon(nativeFor(c).poll(id,after,max)));
        }
    }
    @McpTool(name="block_watch_stop", description="Stop a recorder; retain its samples unless discard=true frees it. Does not alter any Minecraft block.", readOnly=true)
    public static final class Stop extends BaseTool {
        public Stop() { super("block_watch_stop"); }
        public JsonNode inputSchema() { return Schemas.object().required("watch_id", Schemas.string()).optional("discard", Schemas.bool("Discard the retained log; default false")).build(); }
        public ToolResult execute(JsonNode args, ToolContext c) {
            var r = reader(args); String id = r.requireString("watch_id"); boolean discard = r.optBoolean("discard",false);
            return onMainThread(c, ignored -> okToon(nativeFor(c).stop(id,discard)));
        }
    }
    @McpTool(name="block_watch_list", description="List this server session's retained/active recorders.", readOnly=true)
    public static final class ListWatches extends BaseTool {
        public ListWatches() { super("block_watch_list"); }
        public JsonNode inputSchema() { return Schemas.object().build(); }
        public ToolResult execute(JsonNode args, ToolContext c) { return onMainThread(c, ignored -> okToon(nativeFor(c).list())); }
    }
    @McpTool(name="player_get_inventory_views", description="Read one online player's main slots, selected hotbar slot, ender chest, armor and hand equipment in one server task. Empty slots explicit. Optional component names only, never NBT/component payloads.", readOnly=true)
    public static final class InventoryViews extends BaseTool {
        public InventoryViews() { super("player_get_inventory_views"); }
        public JsonNode inputSchema() { return Schemas.object().required("uuid", Schemas.string("Player UUID")).optional("include_component_names",Schemas.bool("Include item component names; default false")).build(); }
        public ToolResult execute(JsonNode args, ToolContext c) {
            var r=reader(args); var uuid=java.util.UUID.fromString(r.requireString("uuid")); boolean components=r.optBoolean("include_component_names",false);
            return onMainThread(c, ignored -> okToon(nativeFor(c).inventory(uuid,components)));
        }
    }

}
