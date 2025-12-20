export const HELP_TEXT = `
?? Workman - A functional programming language

Usage:
  wm                    Start interactive REPL
  wm <file.wm>          Run a Workman file
  wm --debug <file.wm>  Run a file and print types/values
  wm type <file.wm>     Type-check a file (skip evaluation)
  wm err <file.wm>      Check for type errors only
  wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>]
                        Emit backend modules for the given entry
  wm fmt <files...>     Format Workman files
  wm --help             Show this help message

Examples:
  wm                    # Start REPL for interactive development
  wm main.wm            # Run main.wm without extra debug output
  wm --debug main.wm    # Run main.wm and show types + values
  wm type main.wm       # Only type-check main.wm
  wm err main.wm        # Check main.wm for type errors only
  wm fmt .              # Format all .wm files recursively
  wm compile main.wm    # Emit Zig modules into ./dist
  wm compile main.wm --backend js
                        # Emit JS modules into ./dist

REPL Commands:
  :help                 Show REPL-specific commands
  :quit                 Exit the REPL
  :load <file>          Load and evaluate a file
  :clear                Clear accumulated context
  :env                  Show all defined bindings
  :type <id>            Show type of an identifier
`;
