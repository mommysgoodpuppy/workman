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

  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
}

export function positionToOffset(
  text: string,
  position: { line: number; character: number },
): number {
  let offset = 0;
  let currentLine = 0;

  for (let i = 0; i < text.length; i++) {
    if (currentLine === position.line) {
      return offset + position.character;
    }
    if (text[i] === "\n") {
      currentLine++;
    }
    offset++;
  }

  return offset;
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
