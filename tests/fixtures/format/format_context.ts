export interface FormatContextOptions {
  indentSize: number;
  newline?: string;
}

/**
 * FormatContext centralizes indentation and newline handling for formatter code.
 * Writers should rely on this context instead of manipulating whitespace directly.
 */
export class FormatContext {
  private readonly indentSize: number;
  private readonly newline: string;
  private indentLevel = 0;
  private readonly parts: string[] = [];
  private lineStart = true;

  constructor(options: FormatContextOptions) {
    if (options.indentSize <= 0) {
      throw new Error("indentSize must be a positive integer");
    }
    this.indentSize = options.indentSize;
    this.newline = options.newline ?? "\n";
    if (this.newline.length === 0) {
      throw new Error("newline must be a non-empty string");
    }
  }

  write(text: string): this {
    this.writeInternal(text, true);
    return this;
  }

  writeRaw(text: string): this {
    this.writeInternal(text, false);
    return this;
  }

  writeLine(text = ""): this {
    if (text.length > 0) {
      this.write(text);
    }
    this.parts.push(this.newline);
    this.lineStart = true;
    return this;
  }

  blankLine(): this {
    return this.writeLine();
  }

  withIndent<T>(fn: () => T, levels = 1): T {
    this.increaseIndent(levels);
    try {
      return fn();
    } finally {
      this.decreaseIndent(levels);
    }
  }

  increaseIndent(levels = 1): this {
    if (levels <= 0) {
      throw new Error("levels must be positive");
    }
    this.indentLevel += levels;
    return this;
  }

  decreaseIndent(levels = 1): this {
    if (levels <= 0) {
      throw new Error("levels must be positive");
    }
    if (levels > this.indentLevel) {
      throw new Error("Cannot decrease indent below zero");
    }
    this.indentLevel -= levels;
    return this;
  }

  getIndentString(level = this.indentLevel): string {
    if (level < 0) {
      throw new Error("level cannot be negative");
    }
    return " ".repeat(level * this.indentSize);
  }

  toString(): string {
    return this.parts.join("");
  }

  private ensureIndent(): void {
    if (this.lineStart) {
      this.parts.push(this.getIndentString());
      this.lineStart = false;
    }
  }

  private writeInternal(text: string, applyIndent: boolean): void {
    if (text.length === 0) {
      return;
    }
    const segments = text.split(/(\r\n|\r|\n)/);
    for (const segment of segments) {
      if (segment.length === 0) {
        continue;
      }
      if (segment === "\r" || segment === "\n" || segment === "\r\n") {
        this.parts.push(segment);
        this.lineStart = true;
        continue;
      }
      if (applyIndent) {
        this.ensureIndent();
      } else {
        this.lineStart = false;
      }
      this.parts.push(segment);
    }
  }
}
