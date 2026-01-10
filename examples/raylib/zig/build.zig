const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.graph.host;
    const optimize = b.standardOptimizeOption(.{});

    // Compile raylib C sources
    const raylib = b.addLibrary(.{
        .linkage = .static,
        .name = "raylib",
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    const raylib_sources = [_][]const u8{
        "rcore.c",
        "rshapes.c",
        "rtextures.c",
        "rtext.c",
        "rmodels.c",
        "utils.c",
        "raudio.c",
        "rglfw.c",
    };

    raylib.root_module.addCSourceFiles(.{
        .root = b.path("raylib-src/src"),
        .files = &raylib_sources,
        .flags = &.{"-DPLATFORM_DESKTOP_GLFW"},
    });

    raylib.root_module.addIncludePath(b.path("raylib-src/src"));
    raylib.root_module.addIncludePath(b.path("raylib-src/src/external/glfw/include"));

    // Link system libraries required by raylib on Windows
    raylib.root_module.linkSystemLibrary("opengl32", .{});
    raylib.root_module.linkSystemLibrary("gdi32", .{});
    raylib.root_module.linkSystemLibrary("winmm", .{});
    raylib.root_module.linkSystemLibrary("user32", .{});
    raylib.root_module.linkSystemLibrary("shell32", .{});

    // Build the executable
    const exe = b.addExecutable(.{
        .name = "raylibtest",
        .root_module = b.createModule(.{
            .root_source_file = b.path("raylibtest.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    exe.root_module.addIncludePath(b.path("raylib-src/src"));
    exe.root_module.linkLibrary(raylib);

    b.installArtifact(exe);
}
