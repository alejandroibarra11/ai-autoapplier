import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';

export async function takeShot(page: Page, outPath: string): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
  return outPath;
}

export function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
