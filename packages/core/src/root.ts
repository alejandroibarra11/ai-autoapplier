import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findRoot(start: string = process.cwd()): string {
  if (process.env.AUTOAPPLIER_ROOT) return process.env.AUTOAPPLIER_ROOT;
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found (no pnpm-workspace.yaml above cwd)');
    dir = parent;
  }
}
