/// <reference lib="dom" />
import type { Locator, Page } from 'playwright';

const T = 5000;

export async function fillText(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: T });
    await loc.fill(value, { timeout: T });
    return (await loc.inputValue({ timeout: T })) === value;
  } catch { return false; }
}

/** Click, type, then click the matching `[role=option]`. mustContain narrows the candidates (e.g. a country). */
export async function chooseCombobox(page: Page, inputSelector: string, value: string, opts: { mustContain?: string } = {}): Promise<boolean> {
  const want = value.trim().toLowerCase();
  const must = opts.mustContain?.trim().toLowerCase();
  try {
    const input = page.locator(inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: T });
    await input.click({ timeout: T });
    await input.fill('', { timeout: T }).catch(() => {});
    await input.pressSequentially(value, { delay: 30, timeout: T });
    // :visible matters: widgets such as the phone country picker keep a hidden listbox in the DOM.
    const options = page.locator('[role="option"]:visible');
    await options.first().waitFor({ state: 'visible', timeout: 3000 });
    // Async autocompletes refresh the list after typing: wait until two reads agree.
    let texts = (await options.allInnerTexts()).map((t) => t.trim());
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(300);
      const next = (await options.allInnerTexts()).map((t) => t.trim());
      const same = next.length === texts.length && next.every((t, j) => t === texts[j]);
      texts = next;
      if (same) break;
    }
    const ok = (t: string) => !must || t.toLowerCase().includes(must);
    let idx = texts.findIndex((t) => t.toLowerCase() === want && ok(t));
    if (idx < 0) idx = texts.findIndex((t) => t.toLowerCase().includes(want) && ok(t));
    if (idx < 0) { await input.press('Escape').catch(() => {}); return false; }
    await options.nth(idx).click({ timeout: T });
    return true;
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

export async function chooseNative(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const picked = await page.locator(selector).first().selectOption({ label: value }, { timeout: T });
    return picked.length > 0;
  } catch { return false; }
}

export async function clickChoiceButton(container: Locator, value: string): Promise<boolean> {
  try {
    const want = value.trim().toLowerCase();
    const cands = container.locator('button, label, [role="radio"]');
    const texts = (await cands.allInnerTexts()).map((t) => t.trim().toLowerCase());
    const idx = texts.indexOf(want);
    if (idx < 0) return false;
    await cands.nth(idx).click({ timeout: T });
    return true;
  } catch { return false; }
}

export async function setFile(page: Page, selector: string, path: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout: T });
    await loc.setInputFiles(path, { timeout: T });
    await page.waitForTimeout(500);
    // Greenhouse swaps the input for a filename chip after a successful upload (the input detaches).
    if ((await page.locator(selector).count()) === 0) return true;
    return (await loc.evaluate((i) => (i as HTMLInputElement).files?.length ?? 0)) > 0;
  } catch { return false; }
}

/**
 * Labels of visible required inputs that are still empty. The page-side code is a plain string on purpose:
 * tsx (esbuild keepNames) injects a `__name` helper into function bodies that does not exist in the page.
 */
const REQUIRED_EMPTY_JS = `(() => {
  const els = Array.from(document.querySelectorAll('input[required], input[aria-required="true"], textarea[required], textarea[aria-required="true"], select[required], select[aria-required="true"]'));

    const out = [];
    const clean = (t) => (t ?? '').replace(/\\s+/g, ' ').replace(/[*✱]+\\s*$/, '').trim();
    for (const el of els) {
      const e = el;
      const type = (e.getAttribute('type') ?? '').toLowerCase();
      if (type === 'hidden' || type === 'search') continue;
      if (/recaptcha|captcha/i.test(e.id + ' ' + e.name + ' ' + e.className)) continue;
      if (/search/i.test(e.id + ' ' + e.className) || e.getAttribute('role') === 'searchbox') continue;
      const box = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      const isFile = type === 'file';
      if (!isFile && (style.visibility === 'hidden' || style.display === 'none' || (box.width === 0 && box.height === 0))) continue;
      let empty;
      if (type === 'checkbox' || type === 'radio') empty = !e.checked;
      else if (isFile) empty = (e.files?.length ?? 0) === 0;
      else if (e.getAttribute('role') === 'combobox') {
        // react-select style widgets keep the chosen value in a sibling node while the input stays blank.
        const wrap = e.closest('[class*="select__control"], [class*="control"]') ?? e.parentElement;
        const shown = wrap ? clean(wrap.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent) : '';
        empty = !e.value && !shown;
      } else empty = !e.value;
      if (!empty) continue;
      const byFor = e.id ? document.querySelector('label[for="' + e.id + '"]') : null;
      out.push(clean(byFor?.textContent) || clean(e.getAttribute('aria-label')) || clean(e.getAttribute('placeholder')) || e.id || e.name);
    }
    return out;
})()`;

export async function requiredEmpty(page: Page): Promise<string[]> {
  return page.evaluate(REQUIRED_EMPTY_JS) as Promise<string[]>;
}
