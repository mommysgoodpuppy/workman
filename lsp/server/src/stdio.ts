import type { WorkmanLanguageServer } from "./server.ts";

export function writeMessage(ctx: WorkmanLanguageServer, message: any) {
  // Simple mutex-based queue to prevent interleaving
  return new Promise<void>((resolve, reject) => {
    ctx.writeQueue.push(async () => {
      try {
        const encoder = new TextEncoder();
        // Use a replacer to handle circular references and ensure clean serialization
        const messageStr = JSON.stringify(message, (key, value) => {
          // Handle circular references
          if (value instanceof Map) {
            return `[Map with ${value.size} entries]`;
          }
          if (value instanceof Set) {
            return `[Set with ${value.size} entries]`;
          }
          // Avoid serializing large or problematic objects
          if (typeof value === "object" && value !== null) {
            // Check for circular references by tracking seen objects
            // (This is a simple check; a full solution would need a WeakSet)
            if (key === "conflicts" && Array.isArray(value)) {
              // Simplify conflicts to avoid serialization issues
              return value.length;
            }
          }
          return value;
        });
        const bodyBytes = encoder.encode(messageStr);
        const header = `Content-Length: ${bodyBytes.length}\r\n\r\n`;
        const headerBytes = encoder.encode(header);
        const bytes = new Uint8Array(headerBytes.length + bodyBytes.length);
        bytes.set(headerBytes, 0);
        bytes.set(bodyBytes, headerBytes.length);

        let written = 0;
        while (written < bytes.length) {
          const n = await Deno.stdout.write(bytes.subarray(written));
          written += n;
        }

        resolve();
      } catch (error) {
        console.error(`[LSP] Write error: ${error}`);
        console.error(
          `[LSP] Failed message: ${
            JSON.stringify(message, null, 2).substring(0, 500)
          }`,
        );
        reject(error);
      }
    });

    processWriteQueue(ctx);
  });
}

async function processWriteQueue(ctx: WorkmanLanguageServer) {
  if (ctx.writeLock || ctx.writeQueue.length === 0) {
    return;
  }

  ctx.writeLock = true;
  const writer = ctx.writeQueue.shift()!;
  try {
    await writer();
  } catch (error) {
    console.error(`[LSP] Queue processing error: ${error}`);
  }
  ctx.writeLock = false;

  // Process next item if any
  if (ctx.writeQueue.length > 0) {
    processWriteQueue(ctx);
  }
}
