export function concatBuffers(
  existing: Uint8Array,
  incoming: Uint8Array,
): Uint8Array {
  if (existing.length === 0) {
    return incoming.slice();
  }
  const combined = new Uint8Array(existing.length + incoming.length);
  combined.set(existing);
  combined.set(incoming, existing.length);
  return combined;
}

export function findHeaderBoundary(buffer: Uint8Array): number {
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (
      buffer[i] === 13 &&
      buffer[i + 1] === 10 &&
      buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

export function extractContentLength(header: string): number | null {
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    return null;
  }
  const length = Number.parseInt(match[1], 10);
  return Number.isNaN(length) ? null : length;
}

export function offsetToPosition(
  text: string,
  offset: number,
): { line: number; character: number } {
  let line = 0;
  let character = 0;
  const clampedOffset = Math.max(0, Math.min(offset, text.length));

  for (let i = 0; i < clampedOffset; i++) {
    const ch = text[i];
    if (ch === "\r") {
      continue;
    }
    if (ch === "\n") {
      line++;
      character = 0;
      continue;
    }
    character++;
  }

  return { line, character };
}

export function positionToOffset(
  text: string,
  position: { line: number; character: number },
): number {
  const targetLine = Math.max(0, position.line);
  const targetChar = Math.max(0, position.character);
  let line = 0;
  let character = 0;

  for (let i = 0; i <= text.length; i++) {
    if (line === targetLine && character === targetChar) {
      return i;
    }
    const ch = text[i];
    if (ch === "\r") {
      continue;
    }
    if (ch === "\n") {
      line++;
      character = 0;
      continue;
    }
    character++;
  }

  return text.length;
}

export function spanToRange(
  text: string,
  span: { start: number; end: number },
): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return {
    start: offsetToPosition(text, span.start),
    end: offsetToPosition(text, span.end),
  };
}

export function getWordAtOffset(
  text: string,
  offset: number,
): { word: string; start: number; end: number } {
  let start = offset;
  let end = offset;

  // Move start back to word boundary
  while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
    start--;
  }

  // Move end forward to word boundary
  while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
    end++;
  }

  return { word: text.substring(start, end), start, end };
}

export function estimateRangeFromMessage(text: string, msg: string) {
    // Check for line and column in "at line X, column Y" format (e.g., Parse Error at line 100, column 7)
    const locationMatch = msg.match(/at line (\d+),\s*column (\d+)/i);
    if (locationMatch) {
      const line = parseInt(locationMatch[1], 10) - 1; // Convert to 0-indexed
      const column = parseInt(locationMatch[2], 10); // 0-indexed already in the match
      // Estimate end position by looking at the character or next few locations
      // For simplicity, highlight from the specified column for 1 character,
      // or find the end of the line/token if possible
      const start = { line, character: Math.max(0, column) };
      const end = { line, character: Math.max(1, column + 1) };
      return { start, end };
    }

    // Fallback to quoted strings in the message
    const quoted = Array.from(msg.matchAll(/["']([^"']+)["']/g)).map((m) =>
      m[1]
    );
    for (const q of quoted) {
      const idx = text.indexOf(q);
      if (idx !== -1) {
        const start = offsetToPosition(text, idx);
        const end = offsetToPosition(text, idx + q.length);
        return { start, end };
      }
    }

    // Default range at the beginning of the document
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  }