// Captures a rendered ATS application page (public GET) as a static HTML fixture for browser tests.
// Usage: tsx scripts/capture-form-fixture.ts <url> <out.html>
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../src/browser';

const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error('usage: capture-form-fixture <url> <out.html>'); process.exit(1); }

function sanitize(html: string): string {
  let h = html;
  for (const re of [/<style\b[\s\S]*?<\/style>/gi, /<script\b[\s\S]*?<\/script>/gi, /<noscript\b[\s\S]*?<\/noscript>/gi,
    /<iframe\b[\s\S]*?<\/iframe>/gi, /<link\b[^>]*>/gi, /<img\b[^>]*>/gi, /<meta\b[^>]*>/gi, /\sstyle="[^"]*"/gi]) h = h.replace(re, '');
  // Lever injects the visitor's local time zone; it is not posting data.
  h = h.replace(/(name="timezone" id="applicant-timezone" value=")[^"]*"/, '$1"');
  h = h.replace(/(<head\b[^>]*>)/i, '$1<meta charset="utf-8">');
  return h.replace(/<html/i, `<!-- Captured ${url} on ${new Date().toISOString().slice(0, 10)} via scripts/capture-form-fixture.ts (blank public form; scripts/styles/iframes stripped) -->\n<html`);
}

const session = await openBrowser({ headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'aa-capture-')) });
try {
  const page = await session.context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const html = sanitize(await page.content());
  writeFileSync(out, html);
  console.log(`saved ${html.length} bytes from ${page.url()}`);
} finally {
  await session.close();
}
