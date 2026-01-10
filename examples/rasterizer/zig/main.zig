const std = @import("std");
const c = @cImport({
    @cInclude("SDL3/SDL.h");
});



pub fn main() void {
    const version = c.SDL_GetVersion();
    const major = @divFloor(version, 1000000);
    const minor = @divFloor(@mod(version, 1000000), 1000);
    const patch = @mod(version, 1000);

    std.debug.print("SDL3 version: {}.{}.{}\n", .{ major, minor, patch });
}
