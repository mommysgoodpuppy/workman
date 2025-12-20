const std = @import("std");

pub const FuncValue = struct {
    func: *const anyopaque,
    env: ?*anyopaque,
};

pub const DataValue = struct {
    tag: []const u8,
    type_name: []const u8,
    fields: []Value,
};

pub const Value = union(enum) {
    Unit,
    Int: i64,
    Bool: bool,
    String: []const u8,
    Tuple: []Value,
    Record: *std.StringHashMap(Value),
    Data: DataValue,
    Func: FuncValue,
};

pub const FnPtr = *const fn (env: ?*anyopaque, args: []const Value) Value;

pub const RecordField = struct {
    name: []const u8,
    value: Value,
};

var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);

pub fn allocator() std.mem.Allocator {
    return arena.allocator();
}

fn rawAllocator() std.mem.Allocator {
    return std.heap.page_allocator;
}

pub fn allocEnv(comptime T: type, value: T) *anyopaque {
    const ptr = allocator().create(T) catch @panic("oom");
    ptr.* = value;
    return @ptrCast(ptr);
}

pub fn allocValue() *Value {
    return allocator().create(Value) catch @panic("oom");
}

pub fn makeUnit() Value {
    return .{ .Unit = {} };
}

pub fn makeInt(value: i64) Value {
    return .{ .Int = value };
}

pub fn makeBool(value: bool) Value {
    return .{ .Bool = value };
}

pub fn makeString(value: []const u8) Value {
    return .{ .String = value };
}

pub fn makeTuple(values: []const Value) Value {
    const buf = allocator().alloc(Value, values.len) catch @panic("oom");
    std.mem.copyForwards(Value, buf, values);
    return .{ .Tuple = buf };
}

pub fn tupleGet(value: Value, index: usize) Value {
    const tuple = expectTuple(value);
    if (index >= tuple.len) {
        @panic("tuple index out of bounds");
    }
    return tuple[index];
}

pub fn isTuple(value: Value, len: usize) bool {
    return switch (value) {
        .Tuple => |tuple| tuple.len == len,
        else => false,
    };
}

pub fn makeRecord(fields: []const RecordField) Value {
    var map = std.StringHashMap(Value).init(allocator());
    for (fields) |field| {
        map.put(field.name, field.value) catch @panic("oom");
    }
    const ptr = allocator().create(std.StringHashMap(Value)) catch @panic("oom");
    ptr.* = map;
    return .{ .Record = ptr };
}

pub fn recordGet(value: Value, field: []const u8) Value {
    const map = expectRecord(value);
    if (map.get(field)) |stored| {
        return stored;
    }
    @panic("missing record field");
}

pub fn makeData(
    type_name: []const u8,
    tag: []const u8,
    fields: []const Value,
) Value {
    const buf = allocator().alloc(Value, fields.len) catch @panic("oom");
    std.mem.copyForwards(Value, buf, fields);
    return .{ .Data = .{ .tag = tag, .type_name = type_name, .fields = buf } };
}

pub fn dataField(value: Value, index: usize) Value {
    const data = expectData(value);
    if (index >= data.fields.len) {
        @panic("data field index out of bounds");
    }
    return data.fields[index];
}

pub fn isData(value: Value, type_name: []const u8, tag: []const u8) bool {
    return switch (value) {
        .Data => |data| std.mem.eql(u8, data.type_name, type_name) and
            std.mem.eql(u8, data.tag, tag),
        else => false,
    };
}

pub fn call(func_value: Value, args: []const Value) Value {
    const func = expectFunc(func_value);
    const fn_ptr: FnPtr = @ptrCast(func.func);
    return fn_ptr(func.env, args);
}

pub fn expectBool(value: Value) bool {
    return switch (value) {
        .Bool => |v| v,
        else => @panic("expected bool"),
    };
}

pub fn intAdd(a: Value, b: Value) Value {
    return makeInt(expectInt(a) + expectInt(b));
}

pub fn intSub(a: Value, b: Value) Value {
    return makeInt(expectInt(a) - expectInt(b));
}

pub fn intMul(a: Value, b: Value) Value {
    return makeInt(expectInt(a) * expectInt(b));
}

pub fn intDiv(a: Value, b: Value) Value {
    return makeInt(@divTrunc(expectInt(a), expectInt(b)));
}

pub fn intEq(a: Value, b: Value) Value {
    return makeBool(expectInt(a) == expectInt(b));
}

pub fn intNe(a: Value, b: Value) Value {
    return makeBool(expectInt(a) != expectInt(b));
}

pub fn intLt(a: Value, b: Value) Value {
    return makeBool(expectInt(a) < expectInt(b));
}

pub fn intLe(a: Value, b: Value) Value {
    return makeBool(expectInt(a) <= expectInt(b));
}

pub fn intGt(a: Value, b: Value) Value {
    return makeBool(expectInt(a) > expectInt(b));
}

pub fn intGe(a: Value, b: Value) Value {
    return makeBool(expectInt(a) >= expectInt(b));
}

pub fn intCmp(a: Value, b: Value) Value {
    const left = expectInt(a);
    const right = expectInt(b);
    if (left < right) return makeInt(-1);
    if (left > right) return makeInt(1);
    return makeInt(0);
}

pub fn boolAnd(a: Value, b: Value) Value {
    return makeBool(expectBool(a) and expectBool(b));
}

pub fn boolOr(a: Value, b: Value) Value {
    return makeBool(expectBool(a) or expectBool(b));
}

pub fn boolNot(a: Value) Value {
    return makeBool(!expectBool(a));
}

pub fn stringLength(a: Value) Value {
    return makeInt(@as(i64, @intCast(expectString(a).len)));
}

pub fn stringSlice(value: Value, start: Value, end: Value) Value {
    const s = expectString(value);
    const start_index = @as(usize, @intCast(expectInt(start)));
    const end_index = @as(usize, @intCast(expectInt(end)));
    if (start_index > end_index or end_index > s.len) {
        @panic("string slice out of bounds");
    }
    return makeString(s[start_index..end_index]);
}

pub fn nativePrintValue(value: Value) Value {
    std.debug.print("{s}\n", .{formatValue(value)});
    return makeUnit();
}

pub fn valueEquals(a: Value, b: Value) bool {
    return switch (a) {
        .Unit => switch (b) {
            .Unit => true,
            else => false,
        },
        .Int => |v| switch (b) {
            .Int => |w| v == w,
            else => false,
        },
        .Bool => |v| switch (b) {
            .Bool => |w| v == w,
            else => false,
        },
        .String => |v| switch (b) {
            .String => |w| std.mem.eql(u8, v, w),
            else => false,
        },
        .Tuple => |v| switch (b) {
            .Tuple => |w| tupleEquals(v, w),
            else => false,
        },
        .Data => |v| switch (b) {
            .Data => |w| dataEquals(v, w),
            else => false,
        },
        .Record => |v| switch (b) {
            .Record => |w| v == w,
            else => false,
        },
        .Func => |v| switch (b) {
            .Func => |w| v.func == w.func and v.env == w.env,
            else => false,
        },
    };
}

pub fn nonExhaustiveMatch(_: Value) Value {
    @panic("non-exhaustive match");
}

pub fn makeFunc(func: FnPtr, env: ?*anyopaque) Value {
    return .{ .Func = .{ .func = @ptrCast(func), .env = env } };
}

fn nativeBinary(op: *const fn (Value, Value) Value, env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    return op(args[0], args[1]);
}

fn nativeUnary(op: *const fn (Value) Value, env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    return op(args[0]);
}

fn nativeAddImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeBinary(intAdd, env, args);
}

fn nativeSubImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeBinary(intSub, env, args);
}

fn nativeMulImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeBinary(intMul, env, args);
}

fn nativeDivImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeBinary(intDiv, env, args);
}

fn nativeCmpIntImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const left = expectInt(args[0]);
    const right = expectInt(args[1]);
    if (left < right) return makeData("Ordering", "LT", &[_]Value{});
    if (left > right) return makeData("Ordering", "GT", &[_]Value{});
    return makeData("Ordering", "EQ", &[_]Value{});
}

fn nativeCharEqImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeBinary(intEq, env, args);
}

fn nativePrintImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeUnary(nativePrintValue, env, args);
}

fn nativeStringFromLiteralImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    return switch (args[0]) {
        .String => |v| makeString(v),
        else => @panic("expected string literal"),
    };
}

fn nativeStrFromLiteralImpl(env: ?*anyopaque, args: []const Value) Value {
    const str = nativeStringFromLiteralImpl(env, args);
    return nativeStringToListImpl(env, &[_]Value{str});
}

fn nativeStrLengthImpl(env: ?*anyopaque, args: []const Value) Value {
    return nativeUnary(stringLength, env, args);
}

fn nativeStrCharAtImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const s = expectString(args[0]);
    const index = @as(usize, @intCast(expectInt(args[1])));
    if (index >= s.len) {
        @panic("string index out of bounds");
    }
    return makeInt(@as(i64, @intCast(s[index])));
}

fn nativeStrSliceImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    return stringSlice(args[0], args[1], args[2]);
}

fn nativeStringToListImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const s = expectString(args[0]);
    var list = makeData("List", "Empty", &[_]Value{});
    var index: usize = s.len;
    while (index > 0) : (index -= 1) {
        const ch = s[index - 1];
        list = makeData("List", "Link", &[_]Value{ makeInt(@as(i64, @intCast(ch))), list });
    }
    return list;
}

fn nativeListToStringImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    var buffer = std.ArrayList(u8).empty;
    var current = args[0];
    while (true) {
        switch (current) {
            .Data => |data| {
                if (!std.mem.eql(u8, data.type_name, "List")) {
                    @panic("expected List in nativeListToString");
                }
                if (std.mem.eql(u8, data.tag, "Empty")) {
                    break;
                }
                if (!std.mem.eql(u8, data.tag, "Link")) {
                    @panic("expected Link constructor in nativeListToString");
                }
                if (data.fields.len != 2) {
                    @panic("expected Link with 2 fields");
                }
                const code = expectInt(data.fields[0]);
                if (code < 0 or code > 255) {
                    @panic("char code out of range");
                }
                buffer.append(allocator(), @as(u8, @intCast(code))) catch @panic("oom");
                current = data.fields[1];
            },
            else => @panic("expected List value"),
        }
    }
    const slice = buffer.toOwnedSlice(allocator()) catch @panic("oom");
    return makeString(slice);
}

fn nativeAllocImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const len = @as(usize, @intCast(expectInt(args[0])));
    const slice = rawAllocator().alloc(u8, len) catch @panic("oom");
    const addr = @as(i64, @intCast(@intFromPtr(slice.ptr)));
    return makeInt(addr);
}

fn nativeFreeImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const addr = @as(usize, @intCast(expectInt(args[0])));
    const len = @as(usize, @intCast(expectInt(args[1])));
    const ptr: [*]u8 = @ptrFromInt(addr);
    rawAllocator().free(ptr[0..len]);
    return makeUnit();
}

fn nativeReadImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const addr = @as(usize, @intCast(expectInt(args[0])));
    const index = @as(usize, @intCast(expectInt(args[1])));
    const ptr: [*]u8 = @ptrFromInt(addr);
    return makeInt(@as(i64, @intCast(ptr[index])));
}

fn nativeWriteImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const addr = @as(usize, @intCast(expectInt(args[0])));
    const index = @as(usize, @intCast(expectInt(args[1])));
    const value = expectInt(args[2]);
    if (value < 0 or value > 255) {
        @panic("byte value out of range");
    }
    const ptr: [*]u8 = @ptrFromInt(addr);
    ptr[index] = @as(u8, @intCast(value));
    return makeUnit();
}

fn nativeMemcpyImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const dst = @as(usize, @intCast(expectInt(args[0])));
    const src = @as(usize, @intCast(expectInt(args[1])));
    const len = @as(usize, @intCast(expectInt(args[2])));
    const dst_ptr: [*]u8 = @ptrFromInt(dst);
    const src_ptr: [*]u8 = @ptrFromInt(src);
    std.mem.copyForwards(u8, dst_ptr[0..len], src_ptr[0..len]);
    return makeUnit();
}

pub const nativeAdd = makeFunc(nativeAddImpl, null);
pub const nativeSub = makeFunc(nativeSubImpl, null);
pub const nativeMul = makeFunc(nativeMulImpl, null);
pub const nativeDiv = makeFunc(nativeDivImpl, null);
pub const nativeCmpInt = makeFunc(nativeCmpIntImpl, null);
pub const nativeCharEq = makeFunc(nativeCharEqImpl, null);
pub const nativePrint = makeFunc(nativePrintImpl, null);
pub const nativeStringFromLiteral = makeFunc(nativeStringFromLiteralImpl, null);
pub const nativeStrFromLiteral = makeFunc(nativeStrFromLiteralImpl, null);
pub const nativeStrLength = makeFunc(nativeStrLengthImpl, null);
pub const nativeStrCharAt = makeFunc(nativeStrCharAtImpl, null);
pub const nativeStrSlice = makeFunc(nativeStrSliceImpl, null);
pub const nativeStringToList = makeFunc(nativeStringToListImpl, null);
pub const nativeListToString = makeFunc(nativeListToStringImpl, null);
pub const nativeAlloc = makeFunc(nativeAllocImpl, null);
pub const nativeFree = makeFunc(nativeFreeImpl, null);
pub const nativeRead = makeFunc(nativeReadImpl, null);
pub const nativeWrite = makeFunc(nativeWriteImpl, null);
pub const nativeMemcpy = makeFunc(nativeMemcpyImpl, null);

fn expectInt(value: Value) i64 {
    return switch (value) {
        .Int => |v| v,
        else => @panic("expected int"),
    };
}

fn expectString(value: Value) []const u8 {
    return switch (value) {
        .String => |v| v,
        else => @panic("expected string"),
    };
}

fn expectTuple(value: Value) []Value {
    return switch (value) {
        .Tuple => |v| v,
        else => @panic("expected tuple"),
    };
}

fn expectRecord(value: Value) *std.StringHashMap(Value) {
    return switch (value) {
        .Record => |v| v,
        else => @panic("expected record"),
    };
}

fn expectData(value: Value) DataValue {
    return switch (value) {
        .Data => |v| v,
        else => @panic("expected data"),
    };
}

fn expectFunc(value: Value) FuncValue {
    return switch (value) {
        .Func => |v| v,
        else => @panic("expected function"),
    };
}

fn tupleEquals(a: []Value, b: []Value) bool {
    if (a.len != b.len) return false;
    var i: usize = 0;
    while (i < a.len) : (i += 1) {
        if (!valueEquals(a[i], b[i])) return false;
    }
    return true;
}

fn dataEquals(a: DataValue, b: DataValue) bool {
    if (!std.mem.eql(u8, a.tag, b.tag)) return false;
    if (!std.mem.eql(u8, a.type_name, b.type_name)) return false;
    return tupleEquals(a.fields, b.fields);
}

fn formatValue(value: Value) []const u8 {
    return switch (value) {
        .Unit => "unit",
        .Int => |v| std.fmt.allocPrint(allocator(), "{d}", .{v}) catch "oom",
        .Bool => |v| if (v) "true" else "false",
        .String => |v| v,
        .Tuple => "tuple",
        .Record => "record",
        .Data => |v| v.tag,
        .Func => "function",
    };
}
