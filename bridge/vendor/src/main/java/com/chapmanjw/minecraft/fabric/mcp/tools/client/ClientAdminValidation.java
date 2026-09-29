package com.chapmanjw.minecraft.fabric.mcp.tools.client;

import java.nio.file.*;
import java.io.IOException;
import java.util.Objects;

/** Pure guards shared by the native lifecycle and offline tests. */
public final class ClientAdminValidation {
    private ClientAdminValidation() {}
    public static String worldName(String name) {
        if (name == null || !name.matches("[A-Za-z0-9][A-Za-z0-9 _-]{0,63}") || !name.equals(name.strip()))
            throw new IllegalArgumentException("World name must be 1..64 ASCII letters/digits/spaces/_/- without surrounding whitespace");
        return name;
    }
    public static void expected(String expectedSession,String expectedWorld,String session,String world) {
        if (!Objects.equals(expectedSession,session) || !Objects.equals(expectedWorld,world))
            throw new IllegalStateException("Expected client session/save does not match; inspect lifecycle status");
    }
    public static void optionBounds(Integer render,Integer simulation,Integer fps) {
        if (render != null && (render<2 || render>32)) throw new IllegalArgumentException("render_distance must be 2..32");
        if (simulation != null && (simulation<5 || simulation>32)) throw new IllegalArgumentException("simulation_distance must be 5..32");
        if (fps != null && (fps<10 || fps>260 || fps%10!=0)) throw new IllegalArgumentException("max_fps must be 10..260 in steps of 10");
    }
    public static Path destination(Path base,String name,boolean create) throws IOException {
        worldName(name);
        Path root=base.toAbsolutePath().normalize();
        if (!Files.isDirectory(root,LinkOption.NOFOLLOW_LINKS) || !root.toRealPath().equals(root))
            throw new IllegalStateException("Save root must be an existing real directory without symlink components");
        Path dest=root.resolve(name);
        if (create) {
            if (Files.exists(dest,LinkOption.NOFOLLOW_LINKS)) throw new IllegalStateException("Destination already exists; never overwrite a save");
        } else if (!Files.isDirectory(dest,LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(dest)
                || !Files.isRegularFile(dest.resolve("level.dat"),LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalStateException("Expected existing non-symlink save with level.dat");
        }
        return dest;
    }
}
