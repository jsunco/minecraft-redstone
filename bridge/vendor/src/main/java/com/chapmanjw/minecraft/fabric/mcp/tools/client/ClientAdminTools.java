package com.chapmanjw.minecraft.fabric.mcp.tools.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.chapmanjw.minecraft.fabric.mcp.adapter.ClientAccess;
import com.chapmanjw.minecraft.fabric.mcp.protocol.*;
import com.chapmanjw.minecraft.fabric.mcp.tools.BaseTool;
import com.chapmanjw.minecraft.fabric.mcp.tools.annotations.McpTool;
import com.chapmanjw.minecraft.fabric.mcp.redstone.AdminTools;

/** Explicit authenticated admin controls. No chat, aiming, teleportation or implicit world switch. */
public final class ClientAdminTools {
    private ClientAdminTools() {}
    private static ClientAccess client(ToolContext c) {
        AdminTools.requireAuthenticatedAdmin(c);
        if (c.client() == null) throw new IllegalStateException("Requires rendered client endpoint");
        return c.client();
    }
    private static Schemas.ObjectSchema expected() {
        return Schemas.object()
            .required("expected_session_id", Schemas.string("Exact helper session, or 'none' at title"))
            .required("expected_world", Schemas.string("Exact save-directory name, or empty at title"));
    }
    @McpTool(name="client_lifecycle_status", description="Read client options, exact integrated save/session and latest asynchronous lifecycle operation. Admin authentication required.", admin=true, minMinecraftVersion="26.3")
    public static final class Status extends BaseTool {
        public Status() { super("client_lifecycle_status"); }
        public JsonNode inputSchema() { return Schemas.object().build(); }
        public ToolResult execute(JsonNode a, ToolContext c) { return okToon(client(c).lifecycleStatus()); }
    }
    @McpTool(name="client_options_update", description="Set bounded render/simulation distances and FPS through Minecraft options, then save. Requires exact current session/save; does not move camera or affect forceload pins.", admin=true, minMinecraftVersion="26.3")
    public static final class Options extends BaseTool {
        public Options() { super("client_options_update"); }
        public JsonNode inputSchema() { return expected()
            .optional("render_distance", Schemas.integerBetween("Chunks, also constrained by native option range",2,32))
            .optional("simulation_distance", Schemas.integerBetween("Chunks, native normal minimum 5",5,32))
            .optional("max_fps", Schemas.integerBetween("Native frame cap, multiples of 10",10,260)).build(); }
        public ToolResult execute(JsonNode a, ToolContext c) {
            var r=reader(a); var cl=client(c);
            return okToon(cl.updateOptions(r.requireString("expected_session_id"),r.requireString("expected_world"),
                a.has("render_distance")?r.requireInt("render_distance"):null,
                a.has("simulation_distance")?r.requireInt("simulation_distance"):null,
                a.has("max_fps")?r.requireInt("max_fps"):null));
        }
    }
    private abstract static class Lifecycle extends BaseTool {
        private final String action;
        Lifecycle(String name,String action) { super(name); this.action=action; }
        public JsonNode inputSchema() { var s=expected(); if (!action.equals("quit")) s.required("world_name",Schemas.string("Exact safe save directory, no path separators; creation refuses existing paths")); return s.build(); }
        public ToolResult execute(JsonNode a,ToolContext c) {
            var r=reader(a); return okToon(client(c).worldLifecycle(action,r.requireString("expected_session_id"),
                r.requireString("expected_world"),action.equals("quit")?"":r.requireString("world_name")));
        }
    }
    @McpTool(name="client_world_create",description="At title only, create a NEW separate Creative/Peaceful commands-enabled native The Void world, including vanilla spawn platform. Never overwrites. Returns operation receipt; poll lifecycle status for loaded world.",admin=true,minMinecraftVersion="26.3")
    public static final class Create extends Lifecycle { public Create(){super("client_world_create","create");} }
    @McpTool(name="client_world_open",description="At title only, open the explicitly named existing save through Minecraft's normal version/backup checks. Poll lifecycle status; any confirmation screen remains visible.",admin=true,minMinecraftVersion="26.3")
    public static final class Open extends Lifecycle { public Open(){super("client_world_open","open");} }
    @McpTool(name="client_world_quit",description="Gracefully save the exact current integrated world, wait for server shutdown, and return to title. Does not terminate Minecraft or delete any world. Caller must stop its writers first.",admin=true,minMinecraftVersion="26.3")
    public static final class Quit extends Lifecycle { public Quit(){super("client_world_quit","quit");} }
}
