#!/usr/bin/env -S deno run --allow-read

import { lex } from "../src/lexer.ts";
import { ParseError, parseSurfaceProgram } from "../src/parser.ts";
import { InferError, inferProgram } from "../src/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import { evaluateProgram } from "../src/eval.ts";
import { formatRuntimeValue } from "../src/value_printer.ts";
import type { TypeScheme } from "../src/types.ts";
import type { RuntimeValue } from "../src/value.ts";
import { loadModuleGraph, ModuleLoaderError } from "../src/module_loader.ts";
import { cloneTypeScheme } from "../src/types.ts";
import { resolve } from "std/path/mod.ts";

interface ReplContext {
  accumulatedSource: string;
  accumulatedTypes: Map<string, string>;
  accumulatedValues: Map<string, string>;
  multilineBuffer: string[];
  isMultiline: boolean;
  preludeEnv: Map<string, TypeScheme>;
  preludeAdtEnv: Map<string, import("../src/types.ts").TypeInfo>;
  preludeBindings: Map<string, RuntimeValue>;
}

class Repl {
  private context: ReplContext;

  constructor() {
    this.context = {
      accumulatedSource: "",
      accumulatedTypes: new Map(),
      accumulatedValues: new Map(),
      multilineBuffer: [],
      isMultiline: false,
      preludeEnv: new Map(),
      preludeAdtEnv: new Map(),
      preludeBindings: new Map(),
    };
  }

  async start() {
    console.log("🗿 Workman REPL v1.0");
    console.log("Run 'wm --help' to see CLI usage (wm <file.wm>, wm fmt, etc.)\n");
    console.log("Type :help for REPL commands, :quit to exit");
    

    // Load prelude
    await this.loadPrelude();

    while (true) {
      try {
        const prompt = this.context.isMultiline ? ".. " : "wm> ";
        const input = await this.readLine(prompt);

        if (!input) continue;

        if (this.handleCommand(input.trim())) {
          continue;
        }

        if (this.context.isMultiline) {
          this.handleMultiline(input);
          continue;
        }

        // Check if input has unclosed brackets
        if (this.hasUnclosedBrackets(input)) {
          this.context.isMultiline = true;
          this.context.multilineBuffer = [input];
          continue;
        }

        await this.evaluateInput(input);
      } catch (error) {
        if (error instanceof Error && error.message.includes("EOF")) {
          console.log("\nGoodbye!");
          break;
        }
        console.error(`Error: ${error}`);
      }
    }
  }

  private handleCommand(input: string): boolean {
    if (!input.startsWith(":")) return false;

    const [cmd, ...args] = input.slice(1).split(" ");

    switch (cmd.toLowerCase()) {
      case "quit":
      case "exit":
        console.log("Goodbye!");
        Deno.exit(0);
        break;

      case "help":
        this.showHelp();
        break;

      case "load":
        if (args.length > 0) {
          this.loadFile(args.join(" "));
        } else {
          console.log("Usage: :load <file.wm>");
        }
        break;

      case "clear":
        this.clearContext();
        break;

      case "env":
        this.showEnvironment();
        break;

      case "type":
        if (args.length > 0) {
          this.showType(args[0]);
        } else {
          console.log("Usage: :type <identifier>");
        }
        break;

      case "multiline":
        this.context.isMultiline = true;
        this.context.multilineBuffer = [];
        console.log("Entering multiline mode. Type :end to finish.");
        break;

      case "end":
        if (this.context.isMultiline) {
          const code = this.context.multilineBuffer.join("\n");
          this.context.isMultiline = false;
          this.context.multilineBuffer = [];
          this.evaluateInput(code);
        } else {
          console.log("Not in multiline mode");
        }
        break;

      default:
        console.log(`Unknown command: :${cmd}. Type :help for available commands.`);
    }

    return true;
  }

  private handleMultiline(input: string) {
    if (input.trim() === ":end") {
      const code = this.context.multilineBuffer.join("\n");
      this.context.isMultiline = false;
      this.context.multilineBuffer = [];
      this.evaluateInput(code);
    } else {
      this.context.multilineBuffer.push(input);
      
      // Check if all brackets are now closed
      const fullCode = this.context.multilineBuffer.join("\n");
      if (!this.hasUnclosedBrackets(fullCode)) {
        this.context.isMultiline = false;
        const code = this.context.multilineBuffer.slice();
        this.context.multilineBuffer = [];
        this.evaluateInput(code.join("\n"));
      }
    }
  }

  private hasUnclosedBrackets(input: string): boolean {
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      switch (char) {
        case '{':
          braceCount++;
          break;
        case '}':
          braceCount--;
          break;
        case '(':
          parenCount++;
          break;
        case ')':
          parenCount--;
          break;
        case '[':
          bracketCount++;
          break;
        case ']':
          bracketCount--;
          break;
      }
    }

    return braceCount > 0 || parenCount > 0 || bracketCount > 0;
  }

  private async evaluateInput(input: string) {
    if (!input.trim()) return;

    try {
      // Create a complete program by combining accumulated source with new input
      const fullSource = this.context.accumulatedSource 
        ? this.context.accumulatedSource + "\n" + input 
        : input;

      const tokens = lex(fullSource);
      const program = parseSurfaceProgram(tokens);
      const inference = inferProgram(program, {
        initialEnv: this.context.preludeEnv,
        initialAdtEnv: this.context.preludeAdtEnv,
      });

      // Update accumulated types
      for (const { name, scheme } of inference.summaries) {
        const typeStr = formatScheme(scheme);
        this.context.accumulatedTypes.set(name, typeStr);
      }

      // Evaluate the program
      const runtimeLogs: string[] = [];
      const evaluation = evaluateProgram(program, {
        sourceName: "repl",
        initialBindings: this.context.preludeBindings,
        onPrint: (text: string) => {
          runtimeLogs.push(text);
          console.log(text);
        },
      });

      // Update accumulated values
      for (const { name, value } of evaluation.summaries) {
        const valueStr = formatRuntimeValue(value);
        this.context.accumulatedValues.set(name, valueStr);
      }

      // Show results
      let hasOutput = false;

      // Show new bindings with inline type annotations
      const newBindings = inference.summaries.filter(
        ({ name }) => !this.context.accumulatedSource.includes(`let ${name}`) ||
          input.includes(`let ${name}`)
      );

      for (const { name, scheme } of newBindings) {
        const typeStr = formatScheme(scheme);
        const value = evaluation.summaries.find(s => s.name === name)?.value;
        if (value) {
          const valueStr = formatRuntimeValue(value);
          console.log(`let ${name}: ${typeStr} = ${valueStr}`);
        } else {
          console.log(`let ${name}: ${typeStr}`);
        }
        hasOutput = true;
      }

      // Show runtime logs
      if (runtimeLogs.length > 0) {
        hasOutput = true;
      }

      if (!hasOutput && !input.trim().startsWith("type") && !input.trim().startsWith("let")) {
        // For expressions, evaluate and show result
        const exprResult = this.evaluateExpression(input);
        if (exprResult) {
          console.log(`- : ${exprResult.type} = ${exprResult.value}`);
        }
      }

      // Update accumulated source
      this.context.accumulatedSource = fullSource;

    } catch (error) {
      if (error instanceof ParseError || error instanceof InferError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error(`Runtime error: ${error.message}`);
      } else {
        console.error(`Unknown error: ${error}`);
      }
    }
  }

  private evaluateExpression(input: string): { type: string; value: string } | null {
    // For now, handle simple expressions by wrapping them in a let binding
    try {
      const wrappedSource = this.context.accumulatedSource + "\nlet _repl_result = {" + input + "}";
      const tokens = lex(wrappedSource);
      const program = parseSurfaceProgram(tokens);
      const inference = inferProgram(program, {
        initialEnv: this.context.preludeEnv,
        initialAdtEnv: this.context.preludeAdtEnv,
      });
      const evaluation = evaluateProgram(program, {
        initialBindings: this.context.preludeBindings,
      });

      const resultType = inference.summaries.find(s => s.name === "_repl_result");
      const resultValue = evaluation.summaries.find(s => s.name === "_repl_result");

      if (resultType && resultValue) {
        return {
          type: formatScheme(resultType.scheme),
          value: formatRuntimeValue(resultValue.value)
        };
      }
    } catch {
      // Ignore errors for expression evaluation
    }
    return null;
  }

  private showHelp() {
    console.log(`
Workman REPL Commands:
  :help       - Show this help message
  :quit       - Exit the REPL
  :load <f>   - Load and evaluate a .wm file
  :clear      - Clear the accumulated context
  :env        - Show all defined bindings
  :type <id>  - Show the type of an identifier
  :multiline  - Enter multiline mode (or just use unclosed braces)
  :end        - Finish multiline input

Examples:
  > let x = 42
  > let y = add(x, 8)
  > print(y)
  > type Status = Empty | NonEmpty
  > let f = (x) => {
  ..   add(x, 1)
  .. }
`);
  }

  private clearContext() {
    this.context.accumulatedSource = "";
    this.context.accumulatedTypes.clear();
    this.context.accumulatedValues.clear();
    console.log("Context cleared");
  }

  private showEnvironment() {
    if (this.context.accumulatedTypes.size === 0) {
      console.log("(no bindings)");
      return;
    }

    console.log("\nDefined bindings:");
    for (const [name, type] of this.context.accumulatedTypes) {
      const value = this.context.accumulatedValues.get(name);
      if (value) {
        console.log(`${name} : ${type} = ${value}`);
      } else {
        console.log(`${name} : ${type}`);
      }
    }
  }

  private showType(identifier: string) {
    const type = this.context.accumulatedTypes.get(identifier);
    if (type) {
      const value = this.context.accumulatedValues.get(identifier);
      if (value) {
        console.log(`${identifier}: ${type} = ${value}`);
      } else {
        console.log(`${identifier}: ${type}`);
      }
    } else {
      console.log(`Identifier '${identifier}' not found`);
    }
  }

  private loadFile(filePath: string) {
    try {
      const source = Deno.readTextFileSync(filePath);
      console.log(`Loading ${filePath}...`);
      this.evaluateInput(source);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`File not found: ${filePath}`);
      } else if (error instanceof Error) {
        console.error(`Failed to load file: ${error.message}`);
      } else {
        console.error(`Failed to load file: ${error}`);
      }
    }
  }

  private async readLine(prompt: string): Promise<string> {
    const buf = new Uint8Array(1024);
    await Deno.stdout.write(new TextEncoder().encode(prompt));
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      throw new Error("EOF");
    }
    return new TextDecoder().decode(buf.subarray(0, n)).trimEnd();
  }

  private async loadPrelude() {
    try {
      const preludePath = resolve("std/prelude.wm");
      const graph = await loadModuleGraph(preludePath, {
        stdRoots: [resolve("std")],
        preludeModule: undefined, // Don't load prelude into prelude
      });

      // Process all modules in dependency order
      const moduleSummaries = new Map<string, {
        exports: {
          values: Map<string, TypeScheme>;
          types: Map<string, import("../src/types.ts").TypeInfo>;
        };
        runtime: Map<string, RuntimeValue>;
      }>();

      for (const path of graph.order) {
        const node = graph.nodes.get(path);
        if (!node) continue;

        // Build initial environment from imports
        const initialEnv = new Map<string, TypeScheme>();
        const initialAdtEnv = new Map<string, import("../src/types.ts").TypeInfo>();
        const initialBindings = new Map<string, RuntimeValue>();

        // Apply imports from dependencies
        for (const importRecord of node.imports) {
          const provider = moduleSummaries.get(importRecord.sourcePath);
          if (provider) {
            for (const spec of importRecord.specifiers) {
              const valueExport = provider.exports.values.get(spec.imported);
              if (valueExport) {
                initialEnv.set(spec.local, cloneTypeScheme(valueExport));
                const runtimeValue = provider.runtime.get(spec.imported);
                if (runtimeValue) {
                  initialBindings.set(spec.local, runtimeValue);
                }
              }
              const typeExport = provider.exports.types.get(spec.imported);
              if (typeExport) {
                initialAdtEnv.set(spec.imported, typeExport);
              }
            }
          }
        }

        // Infer and evaluate this module
        const inference = inferProgram(node.program, {
          initialEnv,
          initialAdtEnv,
        });
        
        const evaluation = evaluateProgram(node.program, {
          initialBindings,
        });

        // Collect exports
        const exportedValues = new Map<string, TypeScheme>();
        const exportedTypes = new Map<string, import("../src/types.ts").TypeInfo>();
        const exportedRuntime = new Map<string, RuntimeValue>();

        for (const name of node.exportedValueNames) {
          const scheme = inference.env.get(name);
          if (scheme) {
            exportedValues.set(name, cloneTypeScheme(scheme));
          }
          const value = evaluation.env.bindings.get(name);
          if (value) {
            exportedRuntime.set(name, value);
          }
        }

        for (const typeName of node.exportedTypeNames) {
          const info = inference.adtEnv.get(typeName);
          if (info) {
            exportedTypes.set(typeName, info);
            // Also export constructors
            for (const ctor of info.constructors) {
              const scheme = inference.env.get(ctor.name);
              if (scheme) {
                exportedValues.set(ctor.name, cloneTypeScheme(scheme));
              }
              const value = evaluation.env.bindings.get(ctor.name);
              if (value) {
                exportedRuntime.set(ctor.name, value);
              }
            }
          }
        }

        moduleSummaries.set(path, {
          exports: { values: exportedValues, types: exportedTypes },
          runtime: exportedRuntime,
        });
      }

      // Get the prelude module's exports
      const preludeSummary = moduleSummaries.get(graph.entry);
      if (preludeSummary) {
        this.context.preludeEnv = preludeSummary.exports.values;
        this.context.preludeAdtEnv = preludeSummary.exports.types;
        this.context.preludeBindings = preludeSummary.runtime;
      }
    } catch (error) {
      if (error instanceof ModuleLoaderError || error instanceof ParseError || error instanceof InferError) {
        console.error(`Warning: Failed to load prelude: ${error.message}`);
      } else {
        console.error(`Warning: Failed to load prelude: ${error}`);
      }
    }
  }
}

export async function startRepl(): Promise<void> {
  const repl = new Repl();
  await repl.start();
}

// Start the REPL
if (import.meta.main) {
  await startRepl();
}
