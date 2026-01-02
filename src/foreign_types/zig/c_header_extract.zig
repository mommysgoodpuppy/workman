const std = @import("std");

const c = @cImport({
    @cInclude("{{HEADER}}");
});

const symbols = [_][]const u8{
{{SYMBOLS}}
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var types = std.ArrayList(u8).empty;
    defer types.deinit(allocator);
    var fns = std.ArrayList(u8).empty;
    defer fns.deinit(allocator);
    var values = std.ArrayList(u8).empty;
    defer values.deinit(allocator);

    try writeJsonArray(allocator, &types, symbols[0..], emitType);
    try writeJsonArray(allocator, &fns, symbols[0..], emitFn);
    try writeJsonArray(allocator, &values, symbols[0..], emitValue);

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(std.Options.debug_io, &stdout_buffer);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll("{\"types\":");
    try stdout.writeAll(types.items);
    try stdout.writeAll(",\"fns\":");
    try stdout.writeAll(fns.items);
    try stdout.writeAll(",\"values\":");
    try stdout.writeAll(values.items);
    try stdout.writeAll("}");
    try stdout.flush();
}

fn writeJsonArray(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime names: []const []const u8,
    comptime emitFnFn: fn (std.mem.Allocator, *std.ArrayList(u8), comptime []const u8) anyerror!bool,
) !void {
    try list.append(allocator, '[');
    var first = true;
    inline for (names) |name| {
        const start_len = list.items.len;
        const wrote = try emitFnFn(allocator, list, name);
        if (wrote) {
            if (!first) {
                try list.insert(allocator, start_len, ',');
            } else {
                first = false;
            }
        }
    }
    try list.append(allocator, ']');
}

fn emitType(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
) !bool {
    const field = @field(c, name);
    if (@TypeOf(field) != type) {
        return false;
    }
    const T = field;
    const info = @typeInfo(T);
    switch (info) {
        .@"struct" => {
            try writeStruct(allocator, list, name, T);
            return true;
        },
        .@"enum" => {
            try writeEnum(allocator, list, name, T);
            return true;
        },
        else => {
            return false;
        },
    }
}

fn emitFn(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
) !bool {
    const field = @field(c, name);
    if (@TypeOf(field) == type) {
        return false;
    }
    const T = @TypeOf(field);
    const info = @typeInfo(T);
    if (info == .@"fn") {
        try writeFn(allocator, list, name, T);
        return true;
    }
    if (info == .pointer) {
        const child = info.pointer.child;
        if (@typeInfo(child) == .@"fn") {
            try writeFn(allocator, list, name, child);
            return true;
        }
    }
    return false;
}

fn emitValue(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
) !bool {
    const field = @field(c, name);
    if (@TypeOf(field) == type) {
        return false;
    }
    const T = @TypeOf(field);
    const info = @typeInfo(T);
    if (info == .@"fn") return false;
    if (info == .pointer and @typeInfo(info.pointer.child) == .@"fn") return false;
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "name");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, name);
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "type");
    try list.append(allocator, ':');
    try writeTypeDesc(allocator, list, T);
    try list.append(allocator, '}');
    return true;
}

fn writeStruct(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
    comptime T: type,
) !void {
    const info = @typeInfo(T).@"struct";
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "kind");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, "struct");
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "name");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, name);
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "fields");
    try list.append(allocator, ':');
    try list.append(allocator, '[');
    var first = true;
    inline for (info.fields) |field| {
        if (!first) try list.append(allocator, ',');
        first = false;
        try list.append(allocator, '{');
        try writeJsonString(allocator, list, "name");
        try list.append(allocator, ':');
        try writeJsonString(allocator, list, field.name);
        try list.append(allocator, ',');
        try writeJsonString(allocator, list, "type");
        try list.append(allocator, ':');
        try writeTypeDesc(allocator, list, field.type);
        try list.append(allocator, '}');
    }
    try list.append(allocator, ']');
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "opaque");
    try list.append(allocator, ':');
    if (info.fields.len == 0) {
        try list.appendSlice(allocator, "true");
    } else {
        try list.appendSlice(allocator, "false");
    }
    try list.append(allocator, '}');
}

fn writeEnum(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
    comptime T: type,
) !void {
    const info = @typeInfo(T).@"enum";
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "kind");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, "enum");
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "name");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, name);
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "tags");
    try list.append(allocator, ':');
    try list.append(allocator, '[');
    var first = true;
    inline for (info.fields) |field| {
        if (!first) try list.append(allocator, ',');
        first = false;
        try writeJsonString(allocator, list, field.name);
    }
    try list.append(allocator, ']');
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "backing");
    try list.append(allocator, ':');
    try writeTypeDesc(allocator, list, info.tag_type);
    try list.append(allocator, '}');
}

fn writeFn(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime name: []const u8,
    comptime T: type,
) !void {
    const info = @typeInfo(T).@"fn";
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "name");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, name);
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "params");
    try list.append(allocator, ':');
    try list.append(allocator, '[');
    var first = true;
    inline for (info.params) |param| {
        if (!first) try list.append(allocator, ',');
        first = false;
        if (param.type) |param_type| {
            try writeTypeDesc(allocator, list, param_type);
        } else {
            try writeUnknownTypeDesc(allocator, list);
        }
    }
    try list.append(allocator, ']');
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "return");
    try list.append(allocator, ':');
    if (info.return_type) |ret| {
        try writeTypeDesc(allocator, list, ret);
    } else {
        try list.appendSlice(allocator, "null");
    }
    try list.append(allocator, '}');
}

fn writeTypeDesc(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime T: type,
) !void {
    const name = @typeName(T);
    const info = @typeInfo(T);
    switch (info) {
        .bool => {
            try writeTypeTag(allocator, list, "bool");
        },
        .void => {
            try writeTypeTag(allocator, list, "void");
        },
        .int => |int_info| {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "int");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "bits");
            try list.append(allocator, ':');
            try writeInt(allocator, list, int_info.bits);
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "signed");
            try list.append(allocator, ':');
            if (int_info.signedness == .signed) {
                try list.appendSlice(allocator, "true");
            } else {
                try list.appendSlice(allocator, "false");
            }
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "name");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, name);
            try list.append(allocator, '}');
        },
        .float => |float_info| {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "float");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "bits");
            try list.append(allocator, ':');
            try writeInt(allocator, list, float_info.bits);
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "name");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, name);
            try list.append(allocator, '}');
        },
        .pointer => |ptr_info| {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "pointer");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "child");
            try list.append(allocator, ':');
            try writeTypeDesc(allocator, list, ptr_info.child);
            try list.append(allocator, '}');
        },
        .optional => |opt_info| {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "optional");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "child");
            try list.append(allocator, ':');
            try writeTypeDesc(allocator, list, opt_info.child);
            try list.append(allocator, '}');
        },
        .array => |array_info| {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "array");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "child");
            try list.append(allocator, ':');
            try writeTypeDesc(allocator, list, array_info.child);
            try list.append(allocator, '}');
        },
        .@"struct", .@"enum" => {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "named");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "name");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, name);
            try list.append(allocator, '}');
        },
        else => {
            try list.append(allocator, '{');
            try writeJsonString(allocator, list, "kind");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, "unknown");
            try list.append(allocator, ',');
            try writeJsonString(allocator, list, "name");
            try list.append(allocator, ':');
            try writeJsonString(allocator, list, name);
            try list.append(allocator, '}');
        },
    }
}

fn writeTypeTag(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    comptime tag: []const u8,
) !void {
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "kind");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, tag);
    try list.append(allocator, '}');
}

fn writeUnknownTypeDesc(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
) !void {
    try list.append(allocator, '{');
    try writeJsonString(allocator, list, "kind");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, "unknown");
    try list.append(allocator, ',');
    try writeJsonString(allocator, list, "name");
    try list.append(allocator, ':');
    try writeJsonString(allocator, list, "unknown");
    try list.append(allocator, '}');
}

fn writeJsonString(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    value: []const u8,
) !void {
    try list.append(allocator, '"');
    for (value) |ch| {
        switch (ch) {
            '"' => try list.appendSlice(allocator, "\\\""),
            '\\' => try list.appendSlice(allocator, "\\\\"),
            '\n' => try list.appendSlice(allocator, "\\n"),
            '\r' => try list.appendSlice(allocator, "\\r"),
            '\t' => try list.appendSlice(allocator, "\\t"),
            else => try list.append(allocator, ch),
        }
    }
    try list.append(allocator, '"');
}

fn writeInt(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    value: usize,
) !void {
    var buffer: [32]u8 = undefined;
    const slice = try std.fmt.bufPrint(&buffer, "{}", .{value});
    try list.appendSlice(allocator, slice);
}
