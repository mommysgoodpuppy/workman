const std = @import("std");
const c = @cImport({
    @cInclude("SDL3/SDL.h");
});

pub fn main() !u8 {
    const version = c.SDL_GetVersion();
    const major = @divFloor(version, 1000000);
    const minor = @divFloor(@mod(version, 1000000), 1000);
    const patch = @mod(version, 1000);

    std.debug.print("SDL3 version: {}.{}.{}\n", .{ major, minor, patch });

    const screenWidth = 800;
    const screenHeight = 600;

    if (c.SDL_Init(c.SDL_INIT_VIDEO) != true) {
        std.debug.print("SDL_Init failed: {s}\n", .{c.SDL_GetError()});
        return 1;
    }

    const window = c.SDL_CreateWindow(
        "SDL3 window",
        screenWidth, screenHeight,
        0
    );

    if (window == null) {
        std.debug.print("SDL_CreateWindow failed: {s}\n", .{c.SDL_GetError()});
        c.SDL_Quit();
        return 1;
    }

    var event: c.SDL_Event = undefined;
    var running = true;

    while (running) {
        while (c.SDL_PollEvent(&event) != true) {
            if (event.type == c.SDL_EVENT_QUIT) {
                running = false;
            }
        }
        c.SDL_Delay(16);
    }

    c.SDL_DestroyWindow(window);
    c.SDL_Quit();
    return 0;
}
