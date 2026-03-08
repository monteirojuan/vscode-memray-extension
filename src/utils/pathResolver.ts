import * as path from 'path';
import { promises as fs } from 'fs';

export async function createMemrayOutputDir(workspacePath: string): Promise<{ dir: string; id: string }> {
  const base = path.join(workspacePath, '.memray');
  await fs.mkdir(base, { recursive: true });

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(base, id);
  await fs.mkdir(dir, { recursive: true });
  return { dir, id };
}

export function resolveArtifactPaths(dir: string, id: string) {
  const bin = path.join(dir, `${id}.bin`);
  const html = path.join(dir, `${id}.html`);
  const meta = path.join(dir, 'meta.json');
  return { bin, html, meta };
}
