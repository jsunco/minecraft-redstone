package com.chapmanjw.minecraft.fabric.mcp.redstone;

import com.fasterxml.jackson.databind.JsonNode;
import com.chapmanjw.minecraft.fabric.mcp.compat.ToolAccess;
import com.chapmanjw.minecraft.fabric.mcp.protocol.Schemas;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ToolContext;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ToolResult;
import com.chapmanjw.minecraft.fabric.mcp.tools.BaseTool;
import com.chapmanjw.minecraft.fabric.mcp.tools.annotations.McpTool;

/** Authenticated, explicitly enabled server administration. Never impersonates a player. */
public final class AdminTools {
    private AdminTools() {}
    public static void requireAuthenticatedAdmin(ToolContext context) {
        var config = context.config();
        if (config.effectiveMaxAccess() != ToolAccess.ADMIN || !config.authRequired()
                || config.bearerToken() == null || config.bearerToken().isBlank())
            throw new IllegalStateException("Admin control requires max_access=admin and authenticated bearer access");
    }
    private static NativeTelemetry nativeFor(ToolContext context) {
        if (context.nativeTelemetry() == null) throw new IllegalStateException("Live server admin control unavailable");
        return context.nativeTelemetry();
    }
    @McpTool(name="server_admin_command", description="Execute one explicit vanilla command as permission-level-4 console. Requires authenticated admin access and expected session; no active native recorders. Returns actual feedback and callback result. Arbitrary command side effects are not rolled back.", admin=true)
    public static final class Command extends BaseTool {
        public Command() { super("server_admin_command"); }
        public JsonNode inputSchema() { return Schemas.object().required("expected_session",Schemas.string()).required("command",Schemas.string("One command, optional leading slash; max 32768 characters")).optional("dimension",Schemas.string("Defaults to minecraft:overworld")).build(); }
        public ToolResult execute(JsonNode args, ToolContext context) {
            requireAuthenticatedAdmin(context); var reader = reader(args);
            String expected = reader.requireString("expected_session"), command = reader.requireString("command");
            String dimension = reader.optString("dimension", "minecraft:overworld");
            return onMainThread(context, ignored -> okToon(nativeFor(context).adminCommand(expected, command, dimension)));
        }
    }
    @McpTool(name="server_tick_status", description="Read actual tick manager state, world name, server session and separate server/world clocks. Target tick rate is not measured achieved TPS.", readOnly=true, admin=true)
    public static final class Status extends BaseTool {
        public Status() { super("server_tick_status"); }
        public JsonNode inputSchema() { return Schemas.object().build(); }
        public ToolResult execute(JsonNode args, ToolContext context) {
            requireAuthenticatedAdmin(context);
            return onMainThread(context, ignored -> okToon(nativeFor(context).adminStatus()));
        }
    }
    @McpTool(name="server_tick_control", description="Run vanilla tick rate/freeze/unfreeze/step/sprint controls as authenticated console. Requires matching session and no active native recorders; returns tick state before/after. Step/sprint completion is asynchronous.", admin=true)
    public static final class Tick extends BaseTool {
        public Tick() { super("server_tick_control"); }
        public JsonNode inputSchema() { return Schemas.object().required("expected_session",Schemas.string()).required("action",Schemas.enumOf("Tick operation", "rate","freeze","unfreeze","step","step_stop","sprint","sprint_stop")).optional("rate",Schemas.number("Finite 1..10000 target TPS; rate action only")).optional("ticks",Schemas.integerBetween("Explicit duration for step/sprint",1,AdminControl.MAX_TICKS)).build(); }
        public ToolResult execute(JsonNode args, ToolContext context) {
            requireAuthenticatedAdmin(context); var reader = reader(args);
            String expected = reader.requireString("expected_session"), action = reader.requireString("action");
            Double rate = args.has("rate") ? reader.requireDouble("rate") : null;
            Integer ticks = args.has("ticks") ? reader.requireInt("ticks") : null;
            return onMainThread(context, ignored -> okToon(nativeFor(context).adminTick(expected, action, rate, ticks)));
        }
    }
}
