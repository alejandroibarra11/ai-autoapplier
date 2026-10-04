import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, renderPdf, makePageOpener, type BrowserSession } from '../src/browser';

let session: BrowserSession;
const dir = mkdtempSync(join(tmpdir(), 'aa-browser-'));

describe('browser utilities', () => {
  afterAll(async () => { await session?.close(); });

  it('renders a PDF file', async () => {
    session = await openBrowser({ headless: true, userDataDir: join(dir, 'profile') });
    const out = join(dir, 'cv.pdf');
    await renderPdf(session, '<html><body><h1>CV</h1></body></html>', out);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(500);
  }, 60_000);

  it('visits a page and reads links and form fields', async () => {
    const page = join(dir, 'form.html');
    writeFileSync(page, `<html><head><title>Apply</title></head><body>
      <a href="https://jobs.lever.co/acme/123">Apply now</a>
      <form>
        <label for="n">Full name</label><input id="n" name="name" required>
        <label>Why us? <textarea name="why"></textarea></label>
        <label for="s">Authorized to work in the US?</label>
        <select id="s" name="auth" required><option value="">Select</option><option>Yes</option><option>No</option></select>
        <input type="hidden" name="csrf" value="x">
      </form></body></html>`);
    const opener = makePageOpener(session, 10_000);
    const v = await opener.visit(`file://${page}`);
    expect(v.title).toBe('Apply');
    expect(v.links).toContainEqual({ href: 'https://jobs.lever.co/acme/123', text: 'Apply now' });
    const fields = await opener.readForm(`file://${page}`);
    expect(fields).toEqual([
      { name: 'name', label: 'Full name', tag: 'input', inputType: 'text', required: true },
      { name: 'why', label: 'Why us?', tag: 'textarea', inputType: undefined, required: false },
      { name: 'auth', label: 'Authorized to work in the US?', tag: 'select', inputType: undefined, required: true, options: ['Yes', 'No'] },
      { name: 'csrf', label: 'csrf', tag: 'input', inputType: 'hidden', required: false },
    ]);
  }, 60_000);
});
