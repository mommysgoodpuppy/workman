import { Pty } from "@sigma/pty-ffi";
import { writeAll } from "@std/io/write-all";

const RAW_LIVE_TAIL_LIMIT = 8_192;
const DIAGNOSTIC_TAIL_MAX_LINES = 200;
const DIAGNOSTIC_TAIL_MAX_CHARS = 24_576;
const PROGRESS_LINE_PATTERN =
  /^\s*(\[\d+\]\s+Compile Build Script|├─|\└─|\│|\s+Target\.|Build Summary|run\s*$|workman diagnostics:?)/i;
const ENABLE_PRELIVE_SNAPSHOT = true; // vscode terminal pls

export interface ZigBuildResult {
  exitCode: number;
  output: string;
  rawLiveOutput: string;
  liveContentPossiblyLost: boolean;
}

export interface RunZigBuildOptions {
  usePty?: boolean;
}

export async function runZigBuild(
  args: string[],
  cwd: string,
  options?: RunZigBuildOptions,
): Promise<ZigBuildResult> {
  const usePty = options?.usePty ?? true;
  return usePty
    ? runZigBuildWithPty(args, cwd)
    : runZigBuildDirect(args, cwd);
}

export async function runZigBuildWithPty(
  args: string[],
  cwd: string,
): Promise<ZigBuildResult> {
  const pty = new Pty("zig", { args, cwd });
  if (typeof pty.setPollingInterval === "function") {
    pty.setPollingInterval(16);
  }
  const stopResizeSync = syncPtySizeToStdout(pty);
  const display = new PtyDisplay();
  const rawLiveChunks: string[] = [];
  const combinedChunks: string[] = [];
  const encoder = new TextEncoder();
  const usePreLiveSnapshot = ENABLE_PRELIVE_SNAPSHOT;
  let rawLiveLength = 0;
  let liveContentPossiblyLost = false;
  let trailingPreLiveLine = "";
  let shouldFlushTrailingPreLive = false;
  try {
    for await (const chunk of pty.readable) {
      if (chunk.length === 0) continue;
      combinedChunks.push(chunk);
      if (usePreLiveSnapshot && !display.isLiveMode()) {
        const sanitized = sanitizeDisplayChunk(chunk);
        const lastNewline = sanitized.lastIndexOf("\n");
        if (lastNewline !== -1) {
          trailingPreLiveLine = sanitized.slice(lastNewline + 1);
        } else {
          trailingPreLiveLine += sanitized;
        }
        trailingPreLiveLine = trailingPreLiveLine.slice(-RAW_LIVE_TAIL_LIMIT);
        if (trailingPreLiveLine.trim().length > 0) {
          shouldFlushTrailingPreLive = true;
        }
      }
      await display.append(chunk);
      if (
        usePreLiveSnapshot &&
        shouldFlushTrailingPreLive &&
        display.isLiveMode()
      ) {
        const snapshot = trailingPreLiveLine.trimEnd();
        if (snapshot.length > 0) {
          await writeAll(Deno.stdout, encoder.encode(`${snapshot}\n`));
        }
        trailingPreLiveLine = "";
        shouldFlushTrailingPreLive = false;
      }
      if (display.isLiveMode()) {
        if (DESTRUCTIVE_ANSI_PATTERN.test(chunk)) {
          liveContentPossiblyLost = true;
        }
        rawLiveChunks.push(chunk);
        rawLiveLength += chunk.length;
        while (
          rawLiveLength > RAW_LIVE_TAIL_LIMIT && rawLiveChunks.length > 1
        ) {
          const removed = rawLiveChunks.shift()!;
          rawLiveLength -= removed.length;
        }
      }
    }
    await display.finish();
  } finally {
    stopResizeSync?.();
    pty.close();
  }
  return {
    exitCode: pty.exitCode ?? 0,
    output: combinedChunks.join(""),
    rawLiveOutput: rawLiveChunks.join(""),
    liveContentPossiblyLost,
  };
}

export async function runZigBuildDirect(
  args: string[],
  cwd: string,
): Promise<ZigBuildResult> {
  const command = new Deno.Command("zig", {
    args,
    cwd,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const statusPromise = child.status;
  const stdoutPromise = pipeReadableToSink(
    child.stdout,
    async (chunk) => {
      try {
        await writeAll(Deno.stdout, chunk);
      } catch {
        // stdout might not be writable (e.g., piped); ignore
      }
    },
    stdoutChunks,
  );
  const stderrPromise = pipeReadableToSink(
    child.stderr,
    async (chunk) => {
      try {
        await writeAll(Deno.stderr, chunk);
      } catch {
        // stderr might not be writable (e.g., piped); ignore
      }
    },
    stderrChunks,
  );
  const [status] = await Promise.all([statusPromise, stdoutPromise, stderrPromise]);
  return {
    exitCode: status.success ? 0 : status.code ?? 1,
    output: stdoutChunks.join("") + stderrChunks.join(""),
    rawLiveOutput: "",
    liveContentPossiblyLost: false,
  };
}

class PtyDisplay {
  #encoder = new TextEncoder();
  #currentLine = "";
  #lastVisibleLength = 0;
  #emptyLineRun = 0;
  #liveMode = false;

  async append(text: string): Promise<void> {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\r") {
        if (!this.#liveMode) {
          await this.#ensureLiveMode();
        }
        await this.#renderCurrent(false);
        this.#currentLine = "";
      } else if (char === "\n") {
        await this.#renderCurrent(true);
        this.#currentLine = "";
      } else {
        this.#currentLine += char;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.#currentLine.length > 0) {
      await this.#renderCurrent(true);
      this.#currentLine = "";
    }
  }

  isLiveMode(): boolean {
    return this.#liveMode;
  }

  async #ensureLiveMode(): Promise<void> {
    if (this.#liveMode) return;
    this.#liveMode = true;
    if (this.#currentLine.length > 0) {
      await this.#write(`${this.#currentLine}\n`);
      this.#currentLine = "";
    }
    await this.#write("\n");
    this.#lastVisibleLength = 0;
    this.#emptyLineRun = 0;
  }

  async #renderCurrent(newline: boolean): Promise<void> {
    const { visibleLength, hasVisibleChars } = getVisibleMetrics(
      this.#currentLine,
    );
    const isVisiblyEmpty = !hasVisibleChars;
    if (isVisiblyEmpty && !newline) {
      return;
    }
    if (newline) {
      if (isVisiblyEmpty) {
        if (this.#emptyLineRun > 0) {
          return;
        }
        this.#emptyLineRun += 1;
        await this.#write("\n");
        this.#lastVisibleLength = 0;
        return;
      }
      this.#emptyLineRun = 0;
      await this.#write(`${this.#currentLine}\n`);
      this.#lastVisibleLength = 0;
    } else {
      this.#emptyLineRun = 0;
      const padding = this.#lastVisibleLength > visibleLength
        ? " ".repeat(this.#lastVisibleLength - visibleLength)
        : "";
      await this.#write(`\r${this.#currentLine}${padding}`);
      this.#lastVisibleLength = visibleLength;
    }
  }

  async #write(text: string): Promise<void> {
    if (text.length === 0) return;
    await writeAll(Deno.stdout, this.#encoder.encode(text));
  }
}

const ANSI_ALL_PATTERN =
  // deno-lint-ignore no-control-regex
  /(?:\x1B\[[0-?]*[ -/]*[@-~])|(?:\x1B\][^\x07]*(?:\x07|\x1B\\))/g;
// deno-lint-ignore no-control-regex
const DESTRUCTIVE_ANSI_PATTERN = /\x1B\[[0-9;?]*[JKHhfABCDGdEFST]/g;

function getVisibleMetrics(text: string): {
  visibleLength: number;
  hasVisibleChars: boolean;
} {
  const stripped = stripAnsiAll(text);
  const trimmed = stripped.trim();
  return {
    visibleLength: stripped.length,
    hasVisibleChars: trimmed.length > 0,
  };
}

function stripAnsiAll(text: string): string {
  return text.replace(ANSI_ALL_PATTERN, "");
}

function _extractDiagnosticTail(raw: string): string {
  const sanitized = stripAnsiAll(raw);
  const lines = sanitized.split(/\r?\n/);
  const important: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (!capturing) {
      const trimmed = line.trim();
      if (
        trimmed.includes("error:") ||
        trimmed.toLowerCase().includes("workman diagnostics") ||
        trimmed.toLowerCase().includes("build summary") ||
        trimmed.toLowerCase().includes("zig build failed")
      ) {
        capturing = true;
      } else {
        continue;
      }
    }
    if (capturing) {
      if (PROGRESS_LINE_PATTERN.test(line)) {
        continue;
      }
      if (important.length === 0 || important[important.length - 1] !== line) {
        important.push(line);
      }
    }
  }
  const limitedLines = important.slice(-DIAGNOSTIC_TAIL_MAX_LINES);
  let tail = limitedLines.join("\n");
  if (tail.length > DIAGNOSTIC_TAIL_MAX_CHARS) {
    tail = tail.slice(tail.length - DIAGNOSTIC_TAIL_MAX_CHARS);
    const firstNewline = tail.indexOf("\n");
    if (firstNewline !== -1) {
      tail = tail.slice(firstNewline + 1);
    }
  }
  return tail.replace(/\s+$/, "");
}

function sanitizeDisplayChunk(text: string): string {
  return text.replace(DESTRUCTIVE_ANSI_PATTERN, "");
}

async function pipeReadableToSink(
  readable: ReadableStream<Uint8Array> | null | undefined,
  sink: (chunk: Uint8Array) => Promise<void>,
  collector: string[],
): Promise<void> {
  if (!readable) {
    return;
  }
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      collector.push(decoder.decode(value, { stream: true }));
      try {
        await sink(value);
      } catch {
        // ignore sink errors (e.g., closed stdout/stderr)
      }
    }
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      collector.push(trailing);
    }
  } finally {
    reader.releaseLock();
  }
}

function syncPtySizeToStdout(pty: Pty): (() => void) | undefined {
  if (typeof Deno.consoleSize !== "function") return undefined;

  const applySize = () => {
    try {
      const { columns, rows } = Deno.consoleSize();
      if (Number.isFinite(columns) && Number.isFinite(rows)) {
        pty.resize({ cols: columns, rows });
      }
    } catch {
      // stdout might not be a TTY; ignore
    }
  };

  applySize();

  if (
    typeof Deno.addSignalListener === "function" &&
    typeof Deno.removeSignalListener === "function" &&
    Deno.build.os !== "windows"
  ) {
    const handler = () => applySize();
    Deno.addSignalListener("SIGWINCH", handler);
    return () => {
      try {
        Deno.removeSignalListener("SIGWINCH", handler);
      } catch {
        // ignore cleanup errors
      }
    };
  }

  return undefined;
}