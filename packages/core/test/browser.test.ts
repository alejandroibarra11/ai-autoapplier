import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, renderPdf, makePageOpener, type BrowserSession } from '../src/browser';
import { normalizeFormFields } from '../src/apply/form-fields';

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

  describe('real ATS application pages (captured fixtures)', () => {
    const fixture = (f: string) => `file://${join(__dirname, 'fixtures', f)}`;
    const SENSITIVE = /captcha|eeoc|gender|race|ethnicity|veteran|disabilit/i;
    const human = (q: { id: string; label: string }) => q.label !== q.id && !/^[0-9a-f-]{20,}$/i.test(q.label) && !/\[.*\]/.test(q.label) && /[a-z]{3}/i.test(q.label);

    it('reads Lever questions with human labels and collapses radio groups', async () => {
      const qs = normalizeFormFields(await makePageOpener(session, 10_000).readForm(fixture('lever-application.html')));
      for (const q of qs) { expect(human(q), JSON.stringify(q)).toBe(true); expect(`${q.id} ${q.label}`).not.toMatch(SENSITIVE); }
      expect(qs.find((q) => q.id === 'location')?.label).toBe('Current location');
      expect(qs.find((q) => q.id === 'urls[LinkedIn Profile]')?.label).toBe('LinkedIn Profile URL');
      expect(qs.filter((q) => q.type === 'textarea').map((q) => q.label)).toContain('Tell us a little about yourself.');
      const edu = qs.filter((q) => /highest level of education/.test(q.label));
      expect(edu).toHaveLength(1);
      expect(edu[0]).toMatchObject({ type: 'select', required: true });
      expect(edu[0]!.options).toEqual(['High school diploma', "Associate's degree", 'Partially complete College/University; not currently enrolled',
        'Partially complete College/University; currently enrolled and working toward degree', "Undergraduate/Bachelor's degree", "Graduate/Master's degree or above"]);
    }, 60_000);

    it('reads Ashby questions with human labels and drops EEOC/captcha fields', async () => {
      const qs = normalizeFormFields(await makePageOpener(session, 10_000).readForm(fixture('ashby-application.html')));
      for (const q of qs) { expect(human(q), JSON.stringify(q)).toBe(true); expect(`${q.id} ${q.label}`).not.toMatch(SENSITIVE); }
      const labels = qs.map((q) => q.label);
      expect(labels).toEqual(expect.arrayContaining(['Name', 'Email', 'Phone Number', 'Linkedin', 'Github Link',
        'Are you able to work in our San Francisco office 3 - 5 days a week?', 'Are you authorized to work in the US?', 'Will you now or in the future require visa sponsorship?']));
      expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    }, 60_000);

    it('groups radio inputs by name into one question labelled by the fieldset legend', async () => {
      const page = join(dir, 'radios.html');
      writeFileSync(page, `<html><body><form>
        <fieldset><legend>Preferred contract</legend>
          <label><input type="radio" name="contract" value="ft"> Full-time</label>
          <label><input type="radio" name="contract" value="pt"> Part-time</label>
        </fieldset></form></body></html>`);
      const qs = normalizeFormFields(await makePageOpener(session, 10_000).readForm(`file://${page}`));
      expect(qs).toEqual([{ id: 'contract', label: 'Preferred contract', type: 'select', required: false, options: ['Full-time', 'Part-time'] }]);
    }, 60_000);
  });
});
