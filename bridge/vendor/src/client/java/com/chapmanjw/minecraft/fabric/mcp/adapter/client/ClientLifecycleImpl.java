package com.chapmanjw.minecraft.fabric.mcp.adapter.client;

import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import net.minecraft.client.Minecraft;
import net.minecraft.client.OptionInstance;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorPresets;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelResource;
import com.chapmanjw.minecraft.fabric.mcp.redstone.NativeTelemetry;
import com.chapmanjw.minecraft.fabric.mcp.runtime.MinecraftMainThreadExecutor;
import com.chapmanjw.minecraft.fabric.mcp.tools.client.ClientAdminValidation;

/** Minecraft 26.3 client-thread lifecycle. Async operations never represent accepted as completed. */
final class ClientLifecycleImpl {
    private final MinecraftMainThreadExecutor executor;
    private final ObjectMapper mapper;
    private final AtomicReference<ObjectNode> operation=new AtomicReference<>();
    ClientLifecycleImpl(MinecraftMainThreadExecutor executor,ObjectMapper mapper) { this.executor=executor; this.mapper=mapper; }
    private <T> T onClient(Supplier<T> task) {
        try { return executor.submitBlocking(task,10000); }
        catch (Exception e) { throw new IllegalStateException("Client task failed",e); }
    }
    private String session(Minecraft mc) {
        var s=mc.getSingleplayerServer();
        if (s==null) return mc.level==null?"none":"remote";
        String id=NativeTelemetry.sessionFor(s);
        return id==null?"unavailable":id;
    }
    private String world(Minecraft mc) {
        var s=mc.getSingleplayerServer();
        return s==null?"":s.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize().getFileName().toString();
    }
    private void guard(Minecraft mc,String expectedSession,String expectedWorld) {
        if (mc.level!=null && mc.getSingleplayerServer()==null) throw new IllegalStateException("Remote multiplayer lifecycle is unsupported");
        if (session(mc).equals("unavailable")) throw new IllegalStateException("Integrated helper session unavailable");
        ClientAdminValidation.expected(expectedSession,expectedWorld,session(mc),world(mc));
    }
    private ObjectNode options(Minecraft mc) {
        var n=mapper.createObjectNode();
        n.put("render_distance",mc.options.renderDistance().get());
        n.put("simulation_distance",mc.options.simulationDistance().get());
        n.put("max_fps",mc.options.framerateLimit().get());
        n.put("pause_on_lost_focus",mc.options.pauseOnLostFocus);
        return n;
    }
    JsonNode status() { return onClient(() -> {
        var mc=Minecraft.getInstance(); var n=mapper.createObjectNode();
        n.put("session_id",session(mc)); n.put("world_name",world(mc));
        n.put("in_game",mc.level!=null && mc.player!=null); n.set("options",options(mc));
        n.put("screen",mc.gui.screen()==null?"none":mc.gui.screen().getClass().getSimpleName());
        var op=operation.get();
        if (op!=null) {
            var copy=op.deepCopy();
            if (copy.path("status").asText().equals("loading") && mc.level!=null && mc.player!=null
                && world(mc).equals(copy.path("destination").asText()) && !session(mc).equals("unavailable")) {
                copy.put("status","completed"); copy.put("new_session_id",session(mc)); operation.compareAndSet(op,copy);
            }
            n.set("operation",copy);
        }
        return n;
    }); }
    private static void validateNative(OptionInstance<Integer> option,Integer value) {
        if (value!=null && option.values().validateValue(value).filter(value::equals).isEmpty())
            throw new IllegalArgumentException("Value rejected by this client's native option range");
    }
    JsonNode updateOptions(String expectedSession,String expectedWorld,Integer render,Integer simulation,Integer fps) {
        ClientAdminValidation.optionBounds(render,simulation,fps);
        return onClient(() -> {
            var mc=Minecraft.getInstance(); guard(mc,expectedSession,expectedWorld);
            var op=operation.get(); if (op!=null && !terminal(op)) throw new IllegalStateException("Lifecycle operation pending");
            validateNative(mc.options.renderDistance(),render); validateNative(mc.options.simulationDistance(),simulation); validateNative(mc.options.framerateLimit(),fps);
            var n=mapper.createObjectNode(); n.set("before",options(mc));
            if (render!=null) mc.options.renderDistance().set(render);
            if (simulation!=null) mc.options.simulationDistance().set(simulation);
            if (fps!=null) mc.options.framerateLimit().set(fps);
            mc.options.save(); n.set("after",options(mc)); n.put("session_id",session(mc)); n.put("world_name",world(mc));
            return n;
        });
    }
    private static boolean terminal(ObjectNode n) { String s=n.path("status").asText(); return s.equals("completed") || s.equals("failed"); }
    private void failOperation(ObjectNode op,Throwable error,boolean indeterminate) {
        var failed=op.deepCopy(); failed.put("status",indeterminate?"indeterminate":"failed");
        failed.put("error",error.getMessage()==null?error.getClass().getSimpleName():error.getMessage()); operation.set(failed);
    }
    private void quit(ObjectNode op,Minecraft mc,String expectedSession,String expectedWorld) {
        var server=mc.getSingleplayerServer();
        if(server==null)throw new IllegalStateException("No integrated world to save and quit");
        // Do not block the client thread waiting on the server. The server-thread lease both
        // checks existing watches and seals new recorder admission until shutdown or rollback.
        server.submit(() -> NativeTelemetry.acquireQuitLease(server,expectedSession)).whenComplete((release,error) -> {
            if(error!=null) { failOperation(op,error,false); return; }
            executor.submit(() -> {
                boolean disconnectStarted=false;
                try {
                    guard(mc,expectedSession,expectedWorld);
                    if(mc.getSingleplayerServer()!=server)throw new IllegalStateException("Integrated server changed before quit");
                    disconnectStarted=true;
                    mc.disconnectWithSavingScreen(); mc.gui.setScreen(new TitleScreen());
                    var done=op.deepCopy(); done.put("status","completed"); operation.set(done);
                } catch(Throwable failure) {
                    if(disconnectStarted) failOperation(op,failure,true);
                    else server.submit(() -> { release.run(); return null; }).whenComplete((ignored,releaseError) ->
                        failOperation(op,releaseError==null?failure:releaseError,releaseError!=null));
                }
                return null;
            }).whenComplete((ignored,dispatchError) -> {
                if(dispatchError!=null) server.submit(() -> { release.run(); return null; }).whenComplete((unused,releaseError) ->
                    failOperation(op,releaseError==null?dispatchError:releaseError,releaseError!=null));
            });
        });
    }
    JsonNode lifecycle(String action,String expectedSession,String expectedWorld,String destination) {
        if (!action.equals("quit")) ClientAdminValidation.worldName(destination);
        ObjectNode prior=operation.get();
        if (prior!=null && !terminal(prior)) throw new IllegalStateException("Lifecycle operation pending; inspect status");
        var op=mapper.createObjectNode(); op.put("operation_id",UUID.randomUUID().toString()); op.put("action",action); op.put("destination",destination); op.put("status","accepted");
        op.put("expected_session_id",expectedSession); op.put("expected_world",expectedWorld);
        if (!operation.compareAndSet(prior,op)) throw new IllegalStateException("Concurrent lifecycle request");
        executor.submit(() -> {
            var mc=Minecraft.getInstance(); guard(mc,expectedSession,expectedWorld);
            if (action.equals("quit")) {
                quit(op,mc,expectedSession,expectedWorld);
            } else {
                if (mc.level!=null || mc.getSingleplayerServer()!=null) throw new IllegalStateException("Save and quit to title before creating/opening another world");
                if (!(mc.gui.screen() instanceof TitleScreen)) throw new IllegalStateException("World creation/open requires the actual title screen, not another pending client flow");
                boolean create=action.equals("create");
                if (!create && !action.equals("open")) throw new IllegalArgumentException("Unknown lifecycle action");
                try {
                    var dest=ClientAdminValidation.destination(mc.getLevelSource().getBaseDir(),destination,create);
                    if (create) Files.createDirectory(dest); // Atomic exclusive reservation; failed creations are never overwritten.
                } catch (java.io.IOException e) { throw new IllegalStateException("Unable to reserve/check save",e); }
                var loading=op.deepCopy(); loading.put("status","loading"); operation.set(loading);
                if (create) {
                    var settings=new LevelSettings(destination,GameType.CREATIVE,
                        new LevelSettings.DifficultySettings(Difficulty.PEACEFUL,false,false),true,WorldDataConfiguration.DEFAULT);
                    mc.createWorldOpenFlows().createFreshLevel(destination,settings,new WorldOptions(WorldOptions.randomSeed(),false,false),
                        registries -> WorldPresets.createNormalWorldDimensions(registries).replaceOverworldGenerator(registries,
                            new FlatLevelSource(registries.lookupOrThrow(Registries.FLAT_LEVEL_GENERATOR_PRESET)
                                .getOrThrow(FlatLevelGeneratorPresets.THE_VOID).value().settings())),new TitleScreen());
                } else mc.createWorldOpenFlows().openWorld(destination,() -> mc.gui.setScreen(new TitleScreen()));
            }
            return null;
        }).whenComplete((ignored,error) -> {
            if (error!=null) failOperation(op,error,false);
        });
        return op.deepCopy();
    }
}
