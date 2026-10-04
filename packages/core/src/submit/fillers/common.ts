/// <reference lib="dom" />
import type { Locator, Page } from 'playwright';
import type { FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseNative, guardFill, requiredEmpty } from '../dom';
import { detectCaptchaChallenge, detectConfirmation } from '../detect';

const T = 5000;

export const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const lastSegment = (t: string) => t.split(',').at(-1)!.trim();
/** Attribute selector for a field name (names such as `cards[uuid][field0]` contain brackets). */
export const byName = (n: string) => `[name="${n.replace(/["\\]/g, '\\$&')}"]`;

/**
 * Shared fill loop: every entry lands in exactly one of filled / notFound / failed; the whole run is guarded against form posts;
 * a URL change or chrome-error after any entry fails that entry and all remaining ones.
 */
export async function runFill(
  page: Page, plan: FillPlan, order: FillEntry[], fillEntry: (e: FillEntry) => Promise<boolean | null>,
  extraRequired: (page: Page) => Promise<string[]> = async () => [],
): Promise<FilledReport> {
  const r: FilledReport = { filled: [], notFound: [], failed: [], requiredEmpty: [] };
  const unguard = await guardFill(page);
  try {
    const startUrl = page.url().split('#')[0];
    let navigated = false;
    for (let i = 0; i < order.length; i++) {
      const e = order[i]!;
      let res: boolean | null;
      try { res = await fillEntry(e); } catch { res = false; }
      await page.waitForTimeout(150); // let a triggered navigation (blocked by the guard) show up
      const now = page.url();
      if (now.split('#')[0] !== startUrl || now.startsWith('chrome-error')) {
        r.failed.push(...order.slice(i).map((x) => x.fieldId));
        navigated = true;
        break;
      }
      (res === null ? r.notFound : res ? r.filled : r.failed).push(e.fieldId);
    }
    r.requiredEmpty = navigated ? ['page navigated during fill'] : [...(await requiredEmpty(page)), ...(await extraRequired(page).catch(() => []))];
    return r;
  } finally {
    await unguard();
  }
}

export async function bodyText(page: Page): Promise<string> {
  try { return await page.evaluate(() => document.body?.innerText ?? ''); } catch { return ''; }
}

export interface SubmitCfg { submitSelector: string; errorText: RegExp; errorSelector: string }

async function errorTexts(page: Page, sel: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const l of await page.locator(sel).all()) {
      if (!(await l.isVisible())) continue;
      const t = (await l.innerText()).trim();
      if (t) out.push(t.slice(0, 300));
    }
  } catch { /* page navigating */ }
  return out;
}

/** Click submit and classify the outcome. Never assumes success: timeout is 'unknown'. */
export async function runSubmit(page: Page, timeoutMs: number, cfg: SubmitCfg): Promise<SubmitOutcome> {
  const preUrl = page.url();
  // Errors already on the page before the click are not submit results.
  const before = { texts: new Set(await errorTexts(page, cfg.errorSelector)), bodyHadError: cfg.errorText.test(await bodyText(page)) };
  const present = async () => { try { return await page.locator(cfg.submitSelector).first().isVisible(); } catch { return false; } };
  await page.locator(cfg.submitSelector).first().click({ timeout: 10_000 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const formPresent = await present();
    if (formPresent) {
      const fresh = (await errorTexts(page, cfg.errorSelector)).find((t) => !before.texts.has(t));
      const m = !before.bodyHadError ? (await bodyText(page)).match(cfg.errorText) : null;
      const err = fresh ?? (m ? m[0] : null);
      if (err) return { kind: 'error', evidence: err };
    }
    if (await detectCaptchaChallenge(page)) return { kind: 'captcha', evidence: 'captcha challenge visible' };
    const text = await bodyText(page);
    if (detectConfirmation({ preUrl, url: page.url(), text, formPresent })) return { kind: 'confirmed', evidence: `${page.url()} ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
    await page.waitForTimeout(300);
  }
  return { kind: 'unknown', evidence: `no confirmation within ${timeoutMs}ms at ${page.url()}` };
}

/** Each input's own label text (label[for=id], else the wrapping label). No inner named functions: tsx injects __name. */
async function ownLabels(inputs: Locator): Promise<string[]> {
  return inputs.evaluateAll((els) => els.map((el) => {
    const i = el as HTMLInputElement;
    const l = (i.id ? document.querySelector('label[for="' + i.id.replace(/"/g, '') + '"]') : null) ?? i.closest('label');
    return (l?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }));
}

/**
 * Radio/checkbox group: check the input whose own label equals each value (exact, case-insensitive), then read `checked` back.
 * `inputs` must select only the group's inputs.
 */
export async function checkByLabel(page: Page, inputs: Locator, values: string[]): Promise<boolean> {
  try {
    if (!values.length) return false;
    const labels = (await ownLabels(inputs)).map(norm);
    for (const v of values) {
      const idx = labels.indexOf(norm(v));
      if (idx < 0) return false;
      const input = inputs.nth(idx);
      try { await input.check({ timeout: 2500 }); } catch {
        // custom-styled controls hide the real input behind a decoy: click its label instead
        const id = await input.getAttribute('id');
        if (!id) return false;
        await page.locator(`label[for="${id.replace(/["\\]/g, '\\$&')}"]`).first().click({ timeout: T });
      }
      if (!(await input.isChecked())) return false;
    }
    return true;
  } catch { return false; }
}

/** Native select with read-back of the selected option's label. */
export async function selectNativeVerified(page: Page, selector: string, value: string): Promise<boolean> {
  if (!(await chooseNative(page, selector, value))) return false;
  const shown = await page.locator(selector).first().evaluate((el) => Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.label)).catch(() => [] as string[]);
  return shown.length === 1 && norm(shown[0]!) === norm(value);
}

/** Alpha-3 codes that autocomplete widgets (Lever) append instead of a country name. Unknown codes never match. */
const ALPHA3: Record<string, string> = {
  USA: 'United States', CAN: 'Canada', MEX: 'Mexico', GBR: 'United Kingdom', IRL: 'Ireland', DEU: 'Germany', FRA: 'France', ESP: 'Spain', PRT: 'Portugal',
  ITA: 'Italy', NLD: 'Netherlands', BEL: 'Belgium', CHE: 'Switzerland', AUT: 'Austria', SWE: 'Sweden', NOR: 'Norway', DNK: 'Denmark', FIN: 'Finland',
  POL: 'Poland', CZE: 'Czechia', ROU: 'Romania', UKR: 'Ukraine', BRA: 'Brazil', ARG: 'Argentina', CHL: 'Chile', COL: 'Colombia', PER: 'Peru',
  URY: 'Uruguay', CRI: 'Costa Rica', PAN: 'Panama', GTM: 'Guatemala', ECU: 'Ecuador', IND: 'India', PAK: 'Pakistan', BGD: 'Bangladesh', PHL: 'Philippines',
  IDN: 'Indonesia', VNM: 'Vietnam', THA: 'Thailand', SGP: 'Singapore', JPN: 'Japan', KOR: 'South Korea', CHN: 'China', AUS: 'Australia', NZL: 'New Zealand',
  ZAF: 'South Africa', NGA: 'Nigeria', KEN: 'Kenya', EGY: 'Egypt', ISR: 'Israel', ARE: 'United Arab Emirates', TUR: 'Turkey', GRC: 'Greece',
};
/** True if the last comma segment of an autocomplete option names `country` (full name, or a known alpha-3 code). */
export function lastSegmentIs(option: string, country: string): boolean {
  const seg = lastSegment(option);
  const want = norm(country);
  if (norm(seg) === want) return true;
  const mapped = ALPHA3[seg.toUpperCase()];
  return /^[A-Za-z]{3}$/.test(seg) && !!mapped && norm(mapped) === want;
}
