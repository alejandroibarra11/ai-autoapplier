/// <reference lib="dom" />
import type { Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseCombobox, chooseNative, clickChoiceButton, fillText, setFile } from '../dom';
import { runFill, runSubmit } from './common';

const IDENTITY_TEXT: Record<string, string> = {
  'identity:firstName': '#first_name', 'identity:lastName': '#last_name', 'identity:email': '#email', 'identity:phone': '#phone',
};
const SUBMIT = 'button[type=submit]';
const ERROR_TEXT = /is required|there was an error|please (fix|correct)/i;
const sel = (id: string) => `[id="${id.replace(/"/g, '')}"]`;

const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const lastSegment = (t: string) => t.split(',').at(-1)!.trim();

const COVER_TEXT = '#cover_letter_text';

/**
 * Greenhouse only renders the cover-letter textarea after "Enter manually" is clicked in the cover-letter upload group.
 * The group is the innermost ancestor of the `#cover_letter` file input that has such a button (the resume group has
 * its own "Enter manually", which must not be clicked). True when the textarea is (now) on the page.
 */
async function openCoverLetterText(page: Page): Promise<boolean> {
  if (await page.locator(COVER_TEXT).count()) return true;
  const manual = page.getByRole('button', { name: /^\s*enter manually\s*$/i });
  const group = page.locator('div').filter({ has: page.locator('#cover_letter') }).filter({ has: manual }).last();
  if (!(await group.count())) return false;
  try {
    await group.getByRole('button', { name: /^\s*enter manually\s*$/i }).first().click({ timeout: 5000 });
    await page.locator(COVER_TEXT).first().waitFor({ state: 'visible', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

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
        verify: (seen, chosen) => {
          const code = chosen.match(/\+\d+\s*$/)?.[0].trim();
          if (!code) return [seen.value, seen.single].some((t) => t && norm(t) === norm(chosen));
          // The dial code shown must equal the target exactly (not a substring, +52 vs +520), and any exposed flag label must name the country.
          const codeShown = seen.text.split(/\s+/).includes(code) || seen.single.trim() === code;
          const flagLabels = seen.labels.filter((l) => /[a-z]{3}/i.test(l));
          return codeShown && (flagLabels.length === 0 || flagLabels.some((l) => norm(l).includes(norm(e.value))));
        },
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
    case 'identity:coverLetter': return (await openCoverLetterText(page)) ? fillText(page, COVER_TEXT, e.value) : null;
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
      for (const v of e.value.split('; ').map((x) => x.trim()).filter(Boolean)) {
        // multi widgets clear the input and show one chip per chosen value
        const ok = await chooseCombobox(page, s, v, { verify: (seen, chosen) => seen.chips.some((c) => norm(c) === norm(chosen)) });
        if (!ok) return false;
      }
      return true;
    }
    default: {
      if (tag === 'select') return chooseNative(page, s, e.value);
      if (tag === 'input' && (await page.locator(s).first().getAttribute('role')) === 'combobox') return chooseCombobox(page, s, e.value);
      return clickChoiceButton(page.locator(s).first(), e.value);
    }
  }
}

export const greenhouseFiller: AtsFiller = {
  kind: 'greenhouse',
  formUrl: (t) => t.url,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    return runFill(page, plan, plan.entries, (e) => (e.fieldId.startsWith('identity:') ? fillIdentity(page, plan, e) : fillCustom(page, e)));
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    return runSubmit(page, timeoutMs, { submitSelector: SUBMIT, errorText: ERROR_TEXT, errorSelector: '[role="alert"], .error, [class*="error"]' });
  },
};
