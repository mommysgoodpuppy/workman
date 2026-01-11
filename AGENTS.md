# AGENTS

Read these first:
- workmansyntaxguide.md
- workmaninfectionguide.md

Main source code in src/
lsp in lsp/server/src
main compiler in backends/compiler/zig

deno project, any changes made to source code are automatically applied theres no deno cache

CLI quick reference (from `wm --help`):
- `wm` start REPL
- `wm <file.wm>` run a file (default backend: zig)
- `wm <file.wm> --backend js` run with JS backend
- `wm --debug <file.wm>` run and print types/values, dump IR
- `wm --rebuild <file.wm>` run with fresh cache, no incremental compile
- `wm type <file.wm>` type-check only
- `wm type --var-ids <file.wm>` type-check with type var IDs
- `wm err <file.wm>` check for type errors only
- `wm fmt <files...>` format Workman files
- `wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>] [--force] [--debug] [--rebuild]` emit backend modules
- `wm build [--force] [--rebuild] [dir]` build using build.wm
