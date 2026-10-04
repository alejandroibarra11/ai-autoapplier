/// <reference lib="dom" />
import type { Locator, Page, Route } from 'playwright';

const T = 5000;

/** Typed values must never contain line breaks: a newline typed into an input is an Enter key, which submits the form. */
export const oneLine = (v: string): string => v.replace(/[\r\n\t]+/g, ' ').trim();
const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function fillText(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: T });
    const multiline = (await loc.evaluate((el) => el.tagName.toLowerCase())) === 'textarea';
    const want = multiline ? value.replace(/\r\n/g, '\n') : oneLine(value);
    await loc.fill(want, { timeout: T }); // fill sets the value directly: no key presses
    return (await loc.inputValue({ timeout: T })) === want;
  } catch { return false; }
}

export interface ComboOpts {
  allowContains?: boolean;
  accept?: (optionText: string) => boolean;
  /** Custom read-back check, given the input value, selected-value text and container text. */
  verify?: (seen: string[], chosen: string) => boolean;
}

/** Click, type, then click the matching option. Exact (case-insensitive) match unless allowContains; verified by read-back. */
export async function chooseCombobox(page: Page, inputSelector: string, value: string, opts: ComboOpts = {}): Promise<boolean> {
  const typed = oneLine(value);
  if (!typed) return false;
  const want = typed.toLowerCase();
  let input: Locator | undefined;
  try {
    input = page.locator(inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: T });
    await input.click({ timeout: T });
    await input.fill('', { timeout: T }).catch(() => {});
    await input.pressSequentially(typed, { delay: 30, timeout: T });
    // :visible matters: widgets such as the phone country picker keep a hidden listbox in the DOM.
    await page.locator('[role="option"]:visible').first().waitFor({ state: 'visible', timeout: 3000 });
    const ctl = await input.getAttribute('aria-controls');
    const options = ctl && (await page.locator(`[id="${ctl.replace(/"/g, '')}"]`).count())
      ? page.locator(`[id="${ctl.replace(/"/g, '')}"] [role="option"]`)
      : page.locator('[role="option"]:visible');
    // Async autocompletes refresh the list after typing: wait until two reads agree.
    let texts = (await options.allInnerTexts()).map((t) => t.trim());
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(300);
      const next = (await options.allInnerTexts()).map((t) => t.trim());
      const same = next.length === texts.length && next.every((t, j) => t === texts[j]);
      texts = next;
      if (same) break;
    }
    const ok = (t: string) => !opts.accept || opts.accept(t);
    let idx = texts.findIndex((t) => t.toLowerCase() === want && ok(t));
    if (idx < 0 && opts.allowContains) idx = texts.findIndex((t) => t.toLowerCase().includes(want) && ok(t));
    if (idx < 0) throw new Error('no matching option');
    const chosen = texts[idx]!;
    await options.nth(idx).click({ timeout: T });
    return await selectedMatches(input, chosen, opts.verify);
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    await input?.fill('').catch(() => {});
    return false;
  }
}

/** Read the widget back: the input value, or the selected-value node of its container, must equal the chosen option. */
async function selectedMatches(input: Locator, chosen: string, verify?: ComboOpts['verify']): Promise<boolean> {
  const want = norm(chosen);
  for (let i = 0; i < 6; i++) {
    const seen = await input.evaluate((el) => {
      const i = el as HTMLInputElement;
      const wrap = i.closest('[class*="select__control"], [class*="control"]') ?? i.parentElement;
      const single = wrap?.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent ?? '';
      return [i.value ?? '', single, ((wrap as HTMLElement | null)?.innerText ?? '').trim()];
    }).catch(() => ['', '', '']);
    if (verify ? verify(seen, chosen) : seen.slice(0, 2).some((t) => t && norm(t) === want)) return true;
    await input.page().waitForTimeout(200);
  }
  return false;
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

const UPLOAD_ERROR = /upload(ing)? failed|failed to upload|error uploading|couldn'?t upload|could not upload|invalid file|file (is )?too large|unsupported file/i;

export async function setFile(page: Page, selector: string, path: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout: T });
    await loc.setInputFiles(path, { timeout: T });
    const base = path.split(/[\\/]/).pop() ?? path;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (UPLOAD_ERROR.test(body)) return false;
      if ((await page.locator(selector).count()) > 0) {
        if ((await loc.evaluate((i) => (i as HTMLInputElement).files?.length ?? 0).catch(() => 0)) > 0) return true;
      } else if (body.includes(base)) {
        // Greenhouse swaps the input for a chip showing the file name after a successful upload.
        if (await page.getByText(base).first().isVisible().catch(() => false)) return true;
      }
      await page.waitForTimeout(250);
    }
    return false;
  } catch { return false; }
}

/**
 * Defense in depth while filling: abort any non-GET navigation and any non-GET request to the form action or the page URL.
 * Returns an `unguard`. Never installed around submit.
 */
export async function guardFill(page: Page): Promise<() => Promise<void>> {
  const strip = (u: string) => u.split(/[?#]/)[0]!;
  const targets = new Set<string>([strip(page.url())]);
  try {
    for (const a of await page.evaluate(() => Array.from(document.querySelectorAll('form')).map((f) => f.action))) if (a) targets.add(strip(a));
  } catch { /* page not ready: page URL only */ }
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'GET' && (req.isNavigationRequest() || targets.has(strip(req.url())))) return route.abort('blockedbyclient');
    return route.fallback();
  };
  await page.route('**/*', handler);
  return async () => { await page.unroute('**/*', handler).catch(() => {}); };
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
