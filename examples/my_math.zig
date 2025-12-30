const root = @import("root");
const runtime = root.runtime;
const Value = runtime.Value;
const makeFunc = runtime.makeFunc;
const expectInt = runtime.expectInt;
const makeInt = runtime.makeInt;

fn addImpl(env: ?*anyopaque, args: []const Value) Value {
    _ = env;
    const a = expectInt(args[0]);
    const b = expectInt(args[1]);
    return makeInt(a + b);
}

pub const add = makeFunc(addImpl, null);
