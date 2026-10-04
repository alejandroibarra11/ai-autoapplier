/// <reference lib="dom" />
import type { Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseCombobox, chooseNative, clickChoiceButton, fillText, guardFill, requiredEmpty, setFile } from '../dom';
import { detectCaptchaChallenge, detectConfirmation } from '../detect';

const IDENTITY_TEXT: Record<string, string> = {
  'identity:firstName': '#first_name', 'identity:lastName': '#last_name', 'identity:email': '#email', 'identity:phone': '#phone',
};
const SUBMIT = 'button[type=submit]';
const ERROR_TEXT = /is required|there was an error|please (fix|correct)/i;
const sel = (id: string) => `[id="${id.replace(/"/g, '')}"]`;

const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const lastSegment = (t: string) => t.split(',').at(-1)!.trim();

async function fillIdentity(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  if (!e.value.trim()) return null;
  const text = IDENTITY_TEXT[e.fieldId];
  if (text) return (await page.locator(text).count()) ? fillText(page, text, e.value) : null;
  switch (e.fieldId) {
    case 'identity:country': return (await page.locator('#country').count())
      // Option labels are "Mexico +52" and the widget then only shows the dial code, so match without it and verify by code.
      ? chooseCombobox(page, '#country', e.value, {
        allowContains: true,
        accept: (t) => norm(t.replace(/\s*\+\d+\s*$/, '')) === norm(e.value),
        verify: (seen, chosen) => { const code = chosen.match(/\+\d+\s*$/)?.[0].trim(); return code ? seen.some((t) => t.includes(code)) : seen.slice(0, 2).some((t) => norm(t) === norm(chosen)); },
      })
      : null;
    case 'identity:location': {
      if (!(await page.locator('#candidate-location').count())) return null;
      const city = e.value.split(',')[0]!.trim();
      const planCountry = plan.entries.find((x) => x.fieldId === 'identity:country')?.value.trim();
      const country = planCountry || (e.value.includes(',') ? lastSegment(e.value) : '');
      if (!country) return false;
      const want = norm(country);
      return chooseCombobox(page, '#candidate-location', city, { allowContains: true, accept: (t) => norm(lastSegment(t)) === want });
    }
    case 'identity:resume': return (await page.locator('#resume').count()) ? setFile(page, '#resume', e.value) : null;
    case 'identity:coverLetter': return (await page.locator('#cover_letter_text').count()) ? fillText(page, '#cover_letter_text', e.value) : null;
    default: return null;
  }
}

async function fillCustom(page: Page, e: FillEntry): Promise<boolean | null> {
  const s = sel(e.fieldId);
  if (!(await page.locator(s).count())) return null;
  const tag = await page.locator(s).first().evaluate((el) => el.tagName.toLowerCase());
  switch (e.kind) {
    case 'text': case 'textarea': return fillText(page, s, e.value);
    case 'file': return setFile(page, s, e.value);
    case 'checkbox': {
      try { await page.locator(s).first().setChecked(/^(true|yes|1|on)$/i.test(e.value), { timeout: 5000 }); return true; } catch { return false; }
    }
    case 'multiselect': {
      if (!e.value.split('; ').some((x) => x.trim())) return false;
      for (const v of e.value.split('; ').map((x) => x.trim()).filter(Boolean)) if (!(await chooseCombobox(page, s, v))) return false;
      return true;
    }
    default: {
      if (tag === 'select') return chooseNative(page, s, e.value);
      if (tag === 'input' && (await page.locator(s).first().getAttribute('role')) === 'combobox') return chooseCombobox(page, s, e.value);
      return clickChoiceButton(page.locator(s).first(), e.value);
    }
  }
}

async function bodyText(page: Page): Promise<string> {
  try { return await page.evaluate(() => document.body?.innerText ?? ''); } catch { return ''; }
}

async function formPresent(page: Page): Promise<boolean> {
  try { return await page.locator(SUBMIT).first().isVisible(); } catch { return false; }
}

const ERROR_SEL = '[role="alert"], .error, [class*="error"]';

/** Visible error texts currently on the page. */
async function errorTexts(page: Page): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const l of await page.locator(ERROR_SEL).all()) {
      if (!(await l.isVisible())) continue;
      const t = (await l.innerText()).trim();
      if (t) out.push(t.slice(0, 300));
    }
  } catch { /* page navigating */ }
  return out;
}

async function newError(page: Page, before: { texts: Set<string>; bodyHadError: boolean }): Promise<string | null> {
  const fresh = (await errorTexts(page)).find((t) => !before.texts.has(t));
  if (fresh) return fresh;
  if (!before.bodyHadError) {
    const m = (await bodyText(page)).match(ERROR_TEXT);
    if (m) return m[0];
  }
  return null;
}

export const greenhouseFiller: AtsFiller = {
  kind: 'greenhouse',
  formUrl: (t) => t.url,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    const r: FilledReport = { filled: [], notFound: [], failed: [], requiredEmpty: [] };
    const unguard = await guardFill(page); // fill must never submit: block form posts for its whole duration
    try {
      for (const e of plan.entries) {
        let res: boolean | null;
        try { res = e.fieldId.startsWith('identity:') ? await fillIdentity(page, plan, e) : await fillCustom(page, e); } catch { res = false; }
        (res === null ? r.notFound : res ? r.filled : r.failed).push(e.fieldId);
      }
      r.requiredEmpty = await requiredEmpty(page);
      return r;
    } finally {
      await unguard();
    }
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    const preUrl = page.url();
    // Errors already on the page before the click (error boundaries, inline hints) are not submit results.
    const before = { texts: new Set(await errorTexts(page)), bodyHadError: ERROR_TEXT.test(await bodyText(page)) };
    await page.locator(SUBMIT).first().click({ timeout: 10_000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await formPresent(page);
      const err = present ? await newError(page, before) : null;
      if (err) return { kind: 'error', evidence: err };
      if (await detectCaptchaChallenge(page)) return { kind: 'captcha', evidence: 'captcha challenge visible' };
      const text = await bodyText(page);
      if (detectConfirmation({ preUrl, url: page.url(), text, formPresent: present })) return { kind: 'confirmed', evidence: `${page.url()} ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
      await page.waitForTimeout(300);
    }
    return { kind: 'unknown', evidence: `no confirmation within ${timeoutMs}ms at ${page.url()}` };
  },
};
