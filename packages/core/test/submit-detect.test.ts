import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, type BrowserSession } from '../src/browser';
import { detectConfirmation, detectLoginWall, detectCaptchaChallenge } from '../src/submit/detect';
const PRE = 'https://job-boards.greenhouse.io/acme/jobs/1';
describe('detectConfirmation', () => {
  it('detects a confirmation url after navigation', () => {
    expect(detectConfirmation({ preUrl: PRE, url: PRE + '/confirmation', text: '', formPresent: true })).toBe(true);
    expect(detectConfirmation({ preUrl: 'https://jobs.lever.co/acme/1/apply', url: 'https://jobs.lever.co/acme/1/thanks', text: '', formPresent: true })).toBe(true);
  });
  it('detects confirmation text only when the form is gone', () => {
    expect(detectConfirmation({ preUrl: PRE, url: PRE, text: 'Thank you for applying to Acme!', formPresent: false })).toBe(true);
    expect(detectConfirmation({ preUrl: PRE, url: PRE, text: 'Thank you for applying to Acme!', formPresent: true })).toBe(false);
  });
  it.each([
    'Thank you for your interest in Acme. Apply for this job',
    'Once we have received your application, our team will review it.',
    'No application submitted after Oct 1 will be considered.',
    'Your application has been received only if all fields are complete. This field is required',
  ])('is false for %s', (text) => expect(detectConfirmation({ preUrl: PRE, url: PRE, text, formPresent: true })).toBe(false));
  it('is false when the form is gone but the text is conditional', () => {
    expect(detectConfirmation({ preUrl: PRE, url: PRE, text: 'Once we have received your application, our team will review it.', formPresent: false })).toBe(false);
  });
  it('is false for unchanged url or lookalike paths', () => {
    expect(detectConfirmation({ preUrl: PRE + '/confirmation', url: PRE + '/confirmation', text: '', formPresent: true })).toBe(false);
    expect(detectConfirmation({ preUrl: 'https://x/a', url: 'https://x/thank-you-note-writer/application', text: '', formPresent: true })).toBe(false);
  });
});
describe('detectLoginWall', () => {
  it('detects login urls and texts', () => {
    expect(detectLoginWall('https://acme.myworkdayjobs.com/login', '')).toBe(true);
    expect(detectLoginWall('https://x', 'Sign in to apply')).toBe(true);
    expect(detectLoginWall('https://jobs.ashbyhq.com/a/1/application', 'Apply')).toBe(false);
  });
});

describe('detectCaptchaChallenge', () => {
  let session: BrowserSession;
  afterAll(async () => { await session?.close(); });
  it('is true only for a large visible challenge iframe', async () => {
    session = await openBrowser({ headless: true, userDataDir: join(mkdtempSync(join(tmpdir(), 'aa-detect-')), 'p') });
    const page = await session.context.newPage();
    await page.route('**/recaptcha/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.setContent('<html><body><iframe src="https://www.google.com/recaptcha/api2/anchor" width="64" height="60"></iframe><iframe src="https://www.google.com/recaptcha/api2/bframe" width="1" height="1"></iframe></body></html>');
    expect(await detectCaptchaChallenge(page)).toBe(false);
    await page.setContent('<html><body><iframe src="https://www.google.com/recaptcha/api2/bframe" width="400" height="580"></iframe></body></html>');
    expect(await detectCaptchaChallenge(page)).toBe(true);
    await page.close();
  }, 60_000);
  it('detects an hCaptcha challenge iframe', async () => {
    const page = await session.context.newPage();
    await page.route('**/hcaptcha.html**', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.setContent('<html><body><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" width="400" height="500"></iframe></body></html>');
    expect(await detectCaptchaChallenge(page)).toBe(true);
    await page.close();
  }, 60_000);
});
