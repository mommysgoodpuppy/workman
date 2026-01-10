const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "rasterizer",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    exe.root_module.addIncludePath(b.path("sdl3-mingw/include"));
    exe.root_module.addObjectFile(b.path("sdl3-mingw/lib/libSDL3.dll.a"));

    b.installBinFile("sdl3-mingw/bin/SDL3.dll", "SDL3.dll");
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.addPathDir(b.path("sdl3-mingw/bin").getPath(b));
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }
    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run_cmd.step);
}
