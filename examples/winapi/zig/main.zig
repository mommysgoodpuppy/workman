const c = @cImport({
    @cInclude("winapi.h");
});

const std = @import("std");

pub fn main() !void {
    var sys_info: c.SYSTEM_INFO = undefined;
    c.GetSystemInfo(&sys_info);

    const heap = c.GetProcessHeap();
    const bytes: usize = 256;
    const buffer = c.HeapAlloc(heap, 0, bytes);
    if (buffer != null) {
        _ = c.HeapFree(heap, 0, buffer);
    }

    var name_buf: [256]c.WCHAR = undefined;
    var name_len: c.DWORD = name_buf.len;
    const got_name = c.GetComputerNameW(&name_buf, &name_len);

    std.debug.print("System info: processors={d}, page_size={d}\n", .{
        sys_info.dwNumberOfProcessors,
        sys_info.dwPageSize,
    });
    std.debug.print("Computer name: ok={d}, length={d}\n", .{
        got_name, 
        name_len 
    });
}
