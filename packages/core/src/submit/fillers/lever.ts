/// <reference lib="dom" />
import type { Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { fillText, oneLine, setFile } from '../dom';
import { byName, checkByLabel, lastSegmentIs, norm, runFill, runSubmit, selectNativeVerified } from './common';

const IDENTITY_TEXT: Record<string, string> = {
  'identity:fullName': 'input[name="name"]', 'identity:email': 'input[name="email"]', 'identity:phone': 'input[name="phone"]',
  'identity:currentCompany': 'input[name="org"]',
};
const URL_KEYS: Record<string, RegExp> = {
  'identity:linkedin': /linkedin/i, 'identity:github': /github/i, 'identity:portfolio': /portfolio|website|personal|other/i,
};
const SUBMIT = '#btn-submit';
const ERROR_TEXT = /this field is required|is required|there was an error|please (fix|correct|complete)|something went wrong|spam/i;
const ERROR_SEL = '[role="alert"], .error, .error-message, [class*="error"]';
const T = 5000;

/** Lever's location widget is a structured autocomplete (`.dropdown-location` rows) with a hidden `selectedLocation`. */
async function fillLocation(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  const input = page.locator('input[name="location"]').first();
  if (!(await page.locator('input[name="location"]').count())) return null;
  if (!(await page.locator('.dropdown-results').count())) return fillText(page, 'input[name="location"]', e.value);
  const city = oneLine(e.value.split(',')[0]!);
  const planCountry = plan.entries.find((x) => x.fieldId === 'identity:country')?.value.trim();
  const country = planCountry || (e.value.includes(',') ? e.value.split(',').at(-1)!.trim() : '');
  if (!city || !country) return false;
  try {
    await input.waitFor({ state: 'visible', timeout: T });
    await input.click({ timeout: T });
    await input.fill('', { timeout: T });
    await input.pressSequentially(city, { delay: 30, timeout: T });
    const rows = page.locator('.dropdown-results .dropdown-location');
    await rows.first().waitFor({ state: 'visible', timeout: 4000 });
    let texts = (await rows.allInnerTexts()).map((t) => t.trim());
    for (let i = 0; i < 6; i++) { // async results refresh while typing: wait until two reads agree
      await page.waitForTimeout(300);
      const next = (await rows.allInnerTexts()).map((t) => t.trim());
      const same = next.length === texts.length && next.every((t, j) => t === texts[j]);
      texts = next;
      if (same) break;
    }
    const idx = texts.findIndex((t) => lastSegmentIs(t, country));
    if (idx < 0) throw new Error('no option in the requested country');
    const chosen = texts[idx]!;
    await rows.nth(idx).click({ timeout: T });
    for (let i = 0; i < 6; i++) {
      const shown = await input.inputValue();
      const hidden = (await page.locator('input[name="selectedLocation"]').count()) ? await page.locator('input[name="selectedLocation"]').first().inputValue() : 'n/a';
      if (norm(shown) === norm(chosen) && hidden) return true;
      await page.waitForTimeout(200);
    }
    throw new Error('selection not reflected');
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    await input.fill('').catch(() => {});
    return false;
  }
}

async function fillIdentity(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  if (!e.value.trim()) return null;
  const text = IDENTITY_TEXT[e.fieldId];
  if (text) return (await page.locator(text).count()) ? fillText(page, text, e.value) : null;
  const urlKey = URL_KEYS[e.fieldId];
  if (urlKey) {
    const names = await page.locator('input[name^="urls["]').evaluateAll((els) => els.map((el) => el.getAttribute('name') ?? ''));
    const name = names.find((n) => urlKey.test(n));
    return name ? fillText(page, `input${byName(name)}`, e.value) : null;
  }
  switch (e.fieldId) {
    case 'identity:location': return fillLocation(page, plan, e);
    case 'identity:resume': return (await page.locator('input[name="resume"]').count()) ? uploadResume(page, e.value) : null;
    case 'identity:coverLetter': return (await page.locator('textarea[name="comments"]').count()) ? fillText(page, 'textarea[name="comments"]', e.value) : null;
    default: return null; // firstName/lastName/country: Lever has a single name field and no country field
  }
}

/** Lever parses an uploaded resume and may autofill other fields: wait for it to finish (callers upload first). */
async function uploadResume(page: Page, path: string): Promise<boolean> {
  const ok = await setFile(page, 'input[name="resume"]', path);
  await page.locator('.resume-upload-working').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  return ok;
}

async function fillCustom(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  if (e.fieldId === 'location') {
    // a duplicate answer must not wipe a good structured selection made by identity:location
    if ((await page.locator('input[name="selectedLocation"]').first().inputValue().catch(() => '')) !== '') return false;
    return fillLocation(page, plan, e);
  } // scraped as a custom question, but it is the structured autocomplete
  const s = byName(e.fieldId);
  const first = page.locator(s).first();
  if (!(await page.locator(s).count())) return null;
  const { tag, type } = await first.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase() }));
  if (tag === 'select') return selectNativeVerified(page, s, e.value);
  if (type === 'file') return setFile(page, s, e.value);
  if (type === 'radio') return checkByLabel(page, page.locator(`input[type="radio"]${s}`), [e.value.trim()]);
  if (type === 'checkbox') {
    const group = page.locator(`input[type="checkbox"]${s}`);
    if ((await group.count()) > 1) {
      const whole = e.value.trim();
      const values = e.options?.some((o) => norm(o) === norm(whole)) ? [whole] : e.value.split(';').map((x) => x.trim()).filter(Boolean);
      return checkByLabel(page, group, values);
    }
    // a lone checkbox: a boolean, or a single labelled option
    if (/^(true|yes|1|on)$/i.test(e.value.trim())) { try { await group.first().check({ timeout: T }); return await group.first().isChecked(); } catch { return false; } }
    if (/^(false|no|0|off)$/i.test(e.value.trim())) { try { await group.first().uncheck({ timeout: T }); return !(await group.first().isChecked()); } catch { return false; } }
    return checkByLabel(page, group, [e.value.trim()]);
  }
  return fillText(page, s, e.value); // text/textarea/email/url/...
}

export const leverFiller: AtsFiller = {
  kind: 'lever',
  formUrl: (t) => `https://jobs.lever.co/${t.atsToken}/${t.atsJobId}/apply`,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    // The resume goes first: Lever's resume parser may overwrite name/email/phone afterwards.
    const order = [...plan.entries.filter((x) => x.fieldId === 'identity:resume'), ...plan.entries.filter((x) => x.fieldId !== 'identity:resume')];
    return runFill(page, plan, order, (e) => (e.fieldId.startsWith('identity:') ? fillIdentity(page, plan, e) : fillCustom(page, plan, e)));
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    return runSubmit(page, timeoutMs, { submitSelector: SUBMIT, errorText: ERROR_TEXT, errorSelector: ERROR_SEL });
  },
};
