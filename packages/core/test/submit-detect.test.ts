import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, type BrowserSession } from '../src/browser';
import { detectConfirmation, detectLoginWall, detectCaptchaChallenge } from '../src/submit/detect';
describe('detectConfirmation', () => {
  it.each([
    ['https://job-boards.greenhouse.io/acme/jobs/1/confirmation', ''],
    ['https://jobs.lever.co/acme/1/thanks', ''],
    ['https://x', 'Thank you for applying to Acme!'],
    ['https://x', 'Your application was successfully submitted.'],
    ['https://x', "We've received your application"],
  ])('%s %s', (u, t) => expect(detectConfirmation(u, t)).toBe(true));
  it('is false for the form itself or an error', () => {
    expect(detectConfirmation('https://jobs.lever.co/acme/1/apply', 'Submit application')).toBe(false);
    expect(detectConfirmation('https://x', 'This field is required')).toBe(false);
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
});
