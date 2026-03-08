import { promises as fs } from 'fs';

export interface ParsedStatsSummary {
  peakMemoryBytes?: number;
}

interface StatsMetadata {
  peak_memory?: unknown;
  [key: string]: unknown;
}

interface StatsJson {
  metadata?: StatsMetadata;
  [key: string]: unknown;
}

function parsePeakMemory(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function parseStatsSummary(raw: unknown): ParsedStatsSummary {
  const data = (raw ?? {}) as StatsJson;
  const peakMemoryBytes = parsePeakMemory(data.metadata?.peak_memory);
  return { peakMemoryBytes };
}

export async function readStatsSummaryFromFile(filePath: string): Promise<ParsedStatsSummary | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseStatsSummary(parsed);
  } catch {
    return undefined;
  }
}
