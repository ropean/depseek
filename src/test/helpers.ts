import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temp directory tree from { "rel/path": content } (objects are JSON-encoded). */
export function fixture(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depseek-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}
