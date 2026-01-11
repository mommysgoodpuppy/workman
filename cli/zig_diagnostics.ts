import { IO, resolve } from "../src/io.ts";

interface ZigError {
  file: string;
  line: number;
  column: number;
  message: string;
  notes: ZigNote[];
}

interface ZigNote {
  file: string;
  line: number;
  column: number;
  message: string;
}

interface WmSourceMapEntry {
  genLine: number;
  genCol: number;
  srcFile: string;
  srcLine: number;
  srcCol: number;
  srcLineText?: string;
}

interface WmSourceMap {
  version: 1;
  file: string;
  mappings: WmSourceMapEntry[];
}

export async function reportWorkmanDiagnosticsForZig(
  stderrText: string,
  baseDir: string,
): Promise<void> {
  const errors = parseZigErrors(stderrText);
  console.log(`Parsed ${errors.length} Zig error(s) for Workman diagnostics.`);
  if (errors.length === 0) {
    if (stderrText.includes("error:")) {
      console.error("Zig error parsing failed.");
    }
    return;
  }
  const reports: string[] = [];
  for (const err of errors) {
    const annotation = await findWorkmanAnnotationFromMap(
      err.file,
      err.line,
      baseDir,
    );
    if (!annotation) {
      reports.push(`Workman: (no source map) ${err.file}:${err.line}:${err.column}`);
      reports.push(`  Zig: ${err.message}`);
      for (const note of err.notes) {
        reports.push(
          `  Note: ${note.message} (${note.file}:${note.line}:${note.column})`,
        );
      }
      continue;
    }
    reports.push(`Workman: ${annotation.file}:${annotation.line}:${annotation.column}`);
    if (annotation.lineText) {
      reports.push(`  ${annotation.lineText}`);
    }
    reports.push(`  Zig: ${err.message}`);
    for (const note of err.notes) {
      const noteAnnotation = await findWorkmanAnnotationFromMap(
        note.file,
        note.line,
        baseDir,
      );
      if (noteAnnotation) {
        reports.push(
          `  Note: ${note.message} (${noteAnnotation.file}:${noteAnnotation.line}:${noteAnnotation.column})`,
        );
      } else {
        reports.push(`  Note: ${note.message} (${note.file}:${note.line}:${note.column})`);
      }
    }
    const hint = deriveWorkmanHint(err, annotation.lineText);
    if (hint) {
      reports.push(`  Hint: ${hint}`);
    }
  }
  if (reports.length > 0) {
    console.error("\nWorkman diagnostics:");
    for (const line of reports) {
      console.error(line);
    }
  }
}

export async function generateWmSourceMaps(zigFiles: string[]): Promise<void> {
  for (const file of zigFiles) {
    let text: string;
    try {
      text = await IO.readTextFile(file);
    } catch {
      continue;
    }
    const entries = extractWmSourceMapEntries(text);
    const mapPath = `${file}.wmmap.json`;
    if (entries.length === 0) {
      try {
        await Deno.remove(mapPath);
      } catch {
        // ignore missing map files
      }
      continue;
    }
    const map: WmSourceMap = {
      version: 1,
      file: file.replace(/\\/g, "/"),
      mappings: entries,
    };
    await IO.writeTextFile(mapPath, JSON.stringify(map, null, 2));
  }
}

function extractWmSourceMapEntries(code: string): WmSourceMapEntry[] {
  const entries: WmSourceMapEntry[] = [];
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/\/\/\s*wm:\s*(.+?):(\d+):(\d+)(?:\s*\|\s*(.*))?/);
    if (!match) continue;
    const [, file, lineStr, colStr, lineText] = match;
    const hasOnlyComment = line.trimStart().startsWith("//");
    const genLine = hasOnlyComment ? Math.min(i + 2, lines.length) : i + 1;
    entries.push({
      genLine,
      genCol: 1,
      srcFile: file,
      srcLine: Number(lineStr),
      srcCol: Number(colStr),
      srcLineText: lineText ? lineText.trim() : undefined,
    });
  }
  return entries;
}

function parseZigErrors(stderrText: string): ZigError[] {
  const errors: ZigError[] = [];
  const cleanText = stripAnsi(stderrText);
  let current: ZigError | null = null;
  for (const line of cleanText.split(/\r?\n/)) {
    const errorMatch = line.match(/^(.*\.zig):(\d+):(\d+): error: (.+)$/);
    if (errorMatch) {
      const [, zigFile, lineStr, colStr, message] = errorMatch;
      current = {
        file: zigFile,
        line: Number(lineStr),
        column: Number(colStr),
        message,
        notes: [],
      };
      errors.push(current);
      continue;
    }
    const noteMatch = line.match(/^(.*\.zig):(\d+):(\d+): note: (.+)$/);
    if (noteMatch && current) {
      const [, zigFile, lineStr, colStr, message] = noteMatch;
      current.notes.push({
        file: zigFile,
        line: Number(lineStr),
        column: Number(colStr),
        message,
      });
    }
  }
  return errors;
}

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function findWorkmanAnnotationFromMap(
  zigFile: string,
  zigLine: number,
  baseDir: string,
): Promise<{ file: string; line: number; column: number; lineText?: string } | null> {
  const resolvedZigFile = zigFile.match(/^[A-Za-z]:[\\/]/) || zigFile.startsWith("/")
    ? zigFile
    : resolve(baseDir, zigFile);
  const mapPath = `${resolvedZigFile}.wmmap.json`;
  try {
    const text = await IO.readTextFile(mapPath);
    const map = JSON.parse(text) as WmSourceMap;
    const exact = map.mappings.find((m) => m.genLine === zigLine);
    if (exact) {
      return {
        file: exact.srcFile,
        line: exact.srcLine,
        column: exact.srcCol,
        lineText: exact.srcLineText,
      };
    }
    const nearest = map.mappings
      .filter((m) => m.genLine <= zigLine)
      .sort((a, b) => b.genLine - a.genLine)[0];
    if (!nearest) return null;
    return {
      file: nearest.srcFile,
      line: nearest.srcLine,
      column: nearest.srcCol,
      lineText: nearest.srcLineText,
    };
  } catch {
    return scanWmComment(resolvedZigFile, zigLine);
  }
}

async function scanWmComment(
  zigFile: string,
  zigLine: number,
): Promise<{ file: string; line: number; column: number; lineText?: string } | null> {
  try {
    const text = await IO.readTextFile(zigFile);
    const lines = text.split(/\r?\n/);
    const maxScan = Math.min(8, zigLine - 1);
    for (let offset = 0; offset <= maxScan; offset += 1) {
      const idx = zigLine - 1 - offset;
      const candidate = lines[idx];
      const match = candidate.match(/\/\/\s*wm:\s*(.+?):(\d+):(\d+)(?:\s*\|\s*(.*))?/);
      if (!match) continue;
      const [, file, lineStr, colStr, lineText] = match;
      return {
        file,
        line: Number(lineStr),
        column: Number(colStr),
        lineText: lineText ? lineText.trim() : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function deriveWorkmanHint(
  err: ZigError,
  lineText?: string,
): string | null {
  if (!lineText) return null;
  if (
    err.message.includes("incompatible types") &&
    lineText.includes("match")
  ) {
    return "Match branches must return the same type; ensure the error case returns a compatible value.";
  }
  if (
    err.message.includes("incompatible types") &&
    lineText.includes("if")
  ) {
    return "Both branches of an if-expression must return the same type.";
  }
  return null;
}
