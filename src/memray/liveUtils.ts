/**
 * liveUtils.ts — Pure utility functions for live mode that can be imported
 * independently without triggering top-level await or import.meta issues.
 */

export interface LiveSnapshot {
  ts: number;
  heap: number;
  peak: number;
  top: Array<{
    function: string;
    file: string;
    line: number;
    size: number;
    count: number;
  }>;
}

/**
 * Splits a potentially chunked stdout buffer into complete JSON lines.
 * Returns { lines, remainder } where remainder is any incomplete trailing data.
 */
export function splitJsonLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split('\n');
  const remainder = parts.pop() ?? '';
  const lines = parts.filter(l => l.trim().length > 0);
  return { lines, remainder };
}

/**
 * Safely parse a JSON line into a LiveSnapshot. Returns null on failure.
 */
export function parseSnapshot(line: string): LiveSnapshot | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof obj.ts !== 'number' ||
      typeof obj.heap !== 'number' ||
      typeof obj.peak !== 'number' ||
      !Array.isArray(obj.top)
    ) {
      return null;
    }
    return obj as unknown as LiveSnapshot;
  } catch {
    return null;
  }
}
