import fsp from 'node:fs/promises';

const DEFAULT_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value.map(stringValue).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }

  for (const key of ['text', 'content', 'message']) {
    const candidate = stringValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

export function extractModelResponse(record: unknown): string | null {
  if (!isPlainObject(record)) {
    return null;
  }

  const source = String(record['source'] ?? '').toUpperCase();
  const type = String(record['type'] ?? '').toUpperCase();
  const status = String(record['status'] ?? '').toUpperCase();
  const role = String(record['role'] ?? '').toUpperCase();
  const nestedMessage = isPlainObject(record['message']) ? record['message'] : null;
  const nestedRole = String(nestedMessage?.['role'] ?? '').toUpperCase();

  if (status && !['DONE', 'COMPLETE', 'COMPLETED', 'SUCCESS'].includes(status)) {
    return null;
  }

  const responseLike =
    source === 'MODEL' ||
    role === 'ASSISTANT' ||
    role === 'MODEL' ||
    nestedRole === 'ASSISTANT' ||
    nestedRole === 'MODEL' ||
    type.includes('PLANNER_RESPONSE') ||
    type.includes('ASSISTANT') ||
    type.includes('MODEL_RESPONSE');

  if (!responseLike) {
    return null;
  }

  return stringValue(record['content']) ?? stringValue(nestedMessage);
}

async function readUtf8Tail(path: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(path, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, Math.max(1, maxBytes));
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}

export async function readLatestModelResponse(
  transcriptPath: string,
  maxBytes = DEFAULT_TRANSCRIPT_TAIL_BYTES
): Promise<string | null> {
  if (typeof transcriptPath !== 'string' || transcriptPath.trim().length === 0) {
    return null;
  }

  try {
    const text = await readUtf8Tail(transcriptPath, maxBytes);
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const response = extractModelResponse(JSON.parse(lines[index] ?? ''));
        if (response) {
          return response;
        }
      } catch {
        // A truncated or unknown record must not hide an earlier valid response.
      }
    }
  } catch {
    return null;
  }
  return null;
}
