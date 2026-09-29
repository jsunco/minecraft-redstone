package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.ArrayList;
import java.util.List;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
//? if mc_gte_26 {
import net.minecraft.server.permissions.LevelBasedPermissionSet;
//?}

/** Uses the vanilla command execution context, including execute/function commands, without a player actor. */
final class VanillaAdminBackend implements AdminControl.Backend {
    private final MinecraftServer server;
    private final ObjectMapper mapper;
    VanillaAdminBackend(MinecraftServer server, ObjectMapper mapper) { this.server = server; this.mapper = mapper; }
    private ServerLevel level(String dimension) {
        ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.parse(dimension)));
        if (level == null) throw new IllegalArgumentException("Unknown dimension: " + dimension);
        return level;
    }
    @Override public ObjectNode status(String dimension) {
        ServerLevel level = level(dimension);
        var manager = server.tickRateManager();
        ObjectNode out = mapper.createObjectNode();
        out.put("world_name", server.getWorldData().getLevelName());
        out.put("minecraft_version", server.getServerVersion());
        out.put("dimension", dimension); out.put("server_tick", server.getTickCount());
        out.put("world_game_time", level.getGameTime());
        out.put("tick_rate", manager.tickrate()); out.put("milliseconds_per_tick", manager.millisecondsPerTick());
        out.put("frozen", manager.isFrozen()); out.put("stepping", manager.isSteppingForward());
        out.put("step_ticks_remaining", manager.frozenTicksToRun());
        out.put("sprinting", manager.isSprinting()); out.put("runs_normally", manager.runsNormally());
        return out;
    }
    @Override public AdminControl.Result execute(String command, String dimension) {
        Capture capture = new Capture();
        CommandSourceStack source = server.createCommandSourceStack().withSource(capture).withLevel(level(dimension));
        // Integrated-server defaults are not console-owner permission. Grant it only at this opt-in admin boundary.
        //? if mc_gte_26 {
        source = source.withPermission(LevelBasedPermissionSet.OWNER);
        //?} else {
        /*source = source.withPermission(4);
        *///?}
        source = source.withCallback(capture::result);
        try {
            var parsed = server.getCommands().getDispatcher().parse(command, source);
            Commands.validateParseResults(parsed);
            server.getCommands().performCommand(parsed, command);
        } catch (Exception error) {
            capture.error(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
        return capture.finish();
    }
    /** Bounded feedback retains failure evidence even for commands with very large output. */
    static final class Capture implements CommandSource {
        private static final int MAX_MESSAGES = 128, MAX_CHARACTERS = 32768;
        private final List<String> feedback = new ArrayList<>(), errors = new ArrayList<>();
        private int characters, callbackCount;
        private long result;
        private boolean failed, truncated, failureMessagePending;
        @Override public void sendSystemMessage(Component message) { message(message.getString()); }
        void message(String message) {
            if (failureMessagePending) { failureMessagePending = false; error(message); }
            if (feedback.size() >= MAX_MESSAGES || characters >= MAX_CHARACTERS) { truncated = true; return; }
            int remaining = MAX_CHARACTERS - characters;
            String kept = message.substring(0, Math.min(message.length(), remaining));
            truncated |= kept.length() < message.length(); characters += kept.length(); feedback.add(kept);
        }
        void result(boolean success, int value) { callbackCount++; failed |= !success; result += value; }
        void error(String message) {
            failed = true;
            if (errors.size() < MAX_MESSAGES) errors.add(message.substring(0, Math.min(message.length(), 2048)));
            else truncated = true;
        }
        AdminControl.Result finish() {
            if (failed && errors.isEmpty()) errors.add("Vanilla command reported failure; see feedback");
            if (callbackCount == 0 && errors.isEmpty()) errors.add("No synchronous vanilla result callback; completion is unconfirmed");
            return new AdminControl.Result(!failed && callbackCount > 0, callbackCount, result,
                    List.copyOf(feedback), List.copyOf(errors), truncated);
        }
        @Override public boolean acceptsSuccess() { return true; }
        // Vanilla sendFailure consults this immediately before emitting its component. performCommand
        // may catch an exception and use that path without invoking the result callback at all.
        @Override public boolean acceptsFailure() { failed = true; failureMessagePending = true; return true; }
        @Override public boolean shouldInformAdmins() { return false; }
    }
}
