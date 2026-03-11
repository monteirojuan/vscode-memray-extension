import { promises as fs } from 'fs';

export interface FlamegraphSummary {
  peakMemoryBytes?: number;
  totalAllocations?: number;
  totalBytesAllocated?: number;
  durationMs?: number;
}

export interface FlamegraphNode {
  name: string;
  function: string;
  file: string;
  line: number;
  value: number;
  nAllocations: number;
  threadId: string;
  interesting: boolean;
  importSystem: boolean;
  children: FlamegraphNode[];
}

export interface FlamegraphData {
  version: number;
  runId: string;
  script: string;
  generatedAt: string;
  nativeTraces: boolean;
  mergeThreads: boolean;
  summary?: FlamegraphSummary;
  threads?: Array<{ id: string; label: string }>;
  root: FlamegraphNode;
}

export async function readFlamegraphData(filePath: string): Promise<FlamegraphData> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as FlamegraphData;
  if (!parsed?.root || typeof parsed.root !== 'object') {
    throw new Error('Invalid flamegraph.json: missing root node');
  }
  return parsed;
}
