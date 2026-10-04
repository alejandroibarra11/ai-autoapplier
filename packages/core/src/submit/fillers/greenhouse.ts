/// <reference lib="dom" />
import type { Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseCombobox, chooseNative, fillText, requiredEmpty, setFile } from '../dom';
import { detectCaptchaChallenge, detectConfirmation } from '../detect';

const IDENTITY_TEXT: Record<string, string> = {
  'identity:firstName': '#first_name', 'identity:lastName': '#last_name', 'identity:email': '#email', 'identity:phone': '#phone',
};
const SUBMIT = 'button[type=submit]';
const ERROR_TEXT = /is required|there was an error|please (fix|correct)/i;
const sel = (id: string) => `[id="${id.replace(/"/g, '')}"]`;

async function fillIdentity(page: Page, e: FillEntry): Promise<boolean | null> {
  if (!e.value.trim()) return null;
  const text = IDENTITY_TEXT[e.fieldId];
  if (text) return (await page.locator(text).count()) ? fillText(page, text, e.value) : null;
  switch (e.fieldId) {
    case 'identity:country': return (await page.locator('#country').count()) ? chooseCombobox(page, '#country', e.value) : null;
    case 'identity:location': {
      if (!(await page.locator('#candidate-location').count())) return null;
      const city = e.value.split(',')[0]!.trim();
      const country = e.value.split(',').at(-1)!.trim();
      return chooseCombobox(page, '#candidate-location', city, e.value.includes(',') ? { mustContain: country } : {});
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
      for (const v of e.value.split('; ').map((x) => x.trim()).filter(Boolean)) if (!(await chooseCombobox(page, s, v))) return false;
      return true;
    }
    default: return tag === 'select' ? chooseNative(page, s, e.value) : chooseCombobox(page, s, e.value);
  }
}

async function bodyText(page: Page): Promise<string> {
  try { return await page.evaluate(() => document.body?.innerText ?? ''); } catch { return ''; }
}

async function formPresent(page: Page): Promise<boolean> {
  try { return await page.locator(SUBMIT).first().isVisible(); } catch { return false; }
}

async function visibleError(page: Page): Promise<string | null> {
  try {
    for (const l of await page.locator('[role="alert"], .error, [class*="error"]').all()) {
      if (!(await l.isVisible())) continue;
      const t = (await l.innerText()).trim();
      if (t) return t.slice(0, 300);
    }
    const t = await bodyText(page);
    const m = t.match(ERROR_TEXT);
    if (m && (await formPresent(page))) return m[0];
  } catch { /* page navigating */ }
  return null;
}

export const greenhouseFiller: AtsFiller = {
  kind: 'greenhouse',
  formUrl: (t) => t.url,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    const r: FilledReport = { filled: [], notFound: [], failed: [], requiredEmpty: [] };
    for (const e of plan.entries) {
      let res: boolean | null;
      try { res = e.fieldId.startsWith('identity:') ? await fillIdentity(page, e) : await fillCustom(page, e); } catch { res = false; }
      (res === null ? r.notFound : res ? r.filled : r.failed).push(e.fieldId);
    }
    r.requiredEmpty = await requiredEmpty(page);
    return r;
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    const preUrl = page.url();
    await page.locator(SUBMIT).first().click({ timeout: 10_000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await formPresent(page);
      const err = await visibleError(page);
      if (err) return { kind: 'error', evidence: err };
      if (await detectCaptchaChallenge(page)) return { kind: 'captcha', evidence: 'captcha challenge visible' };
      const text = await bodyText(page);
      if (detectConfirmation({ preUrl, url: page.url(), text, formPresent: present })) return { kind: 'confirmed', evidence: `${page.url()} ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
      await page.waitForTimeout(300);
    }
    return { kind: 'unknown', evidence: `no confirmation within ${timeoutMs}ms at ${page.url()}` };
  },
};
