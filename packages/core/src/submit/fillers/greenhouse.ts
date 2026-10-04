/// <reference lib="dom" />
import type { Locator, Page } from 'playwright';
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

/**
 * Greenhouse file uploads (resume, cover letter, custom file questions) are verified inside their own upload group only:
 * the `role=group` labelled `upload-label-<id>`. Success means the file name is visible in that group and no error text is.
 * The file input itself is no evidence: Greenhouse keeps it, with the file set, when its uploader throws
 * ("Cannot read properties of undefined (reading 'uploadFile')" when a file is chosen before the uploader has loaded).
 */
const UPLOAD_GROUP_ERROR = /cannot read|error|failed|unable|try again/i;
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The upload group of file input `id`: Greenhouse's labelled group, else the closest group/wrapper tagged once so it survives the input's removal. */
async function uploadGroup(page: Page, id: string): Promise<Locator | null> {
  const aria = page.locator(`[role="group"][aria-labelledby="upload-label-${id.replace(/"/g, '')}"]`);
  if (await aria.count()) return aria.first();
  const tagged = page.locator(`[data-aa-upload="${id.replace(/"/g, '')}"]`);
  if (await tagged.count()) return tagged.first();
  const ok = await page.locator(sel(id)).first().evaluate((el, gid) => {
    const g = el.closest('[role="group"], .file-upload, .field-wrapper');
    if (!g) return false;
    g.setAttribute('data-aa-upload', gid);
    return true;
  }, id).catch(() => false);
  return ok ? tagged.first() : null;
}

type UploadState = 'attached' | 'error' | 'none';
async function uploadState(group: Locator, base: string): Promise<UploadState> {
  const text = (await group.innerText({ timeout: 2000 }).catch(() => '')).split(base).join(' ');
  if (UPLOAD_GROUP_ERROR.test(text)) return 'error';
  return (await group.getByText(base, { exact: true }).first().isVisible().catch(() => false)) ? 'attached' : 'none';
}

/** Within `ms`: the file name visible in the group with no error text. An error shown for 2 s straight fails early. */
async function verifyUpload(page: Page, group: Locator, base: string, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  let errSince = 0;
  while (Date.now() < deadline) {
    const s = await uploadState(group, base);
    if (s === 'attached') return true;
    if (s === 'error') { errSince ||= Date.now(); if (Date.now() - errSince >= 2000) return false; } else errSince = 0;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Bounded wait for the form to be ready to take a file: load, network idle, the group's Attach button visible and enabled, then `settleMs`. */
async function waitUploadReady(page: Page, group: Locator, settleMs: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const attach = group.getByRole('button', { name: /^\s*attach\s*$/i }).first();
  await attach.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  for (let i = 0; i < 20 && !(await attach.isEnabled().catch(() => true)); i++) await page.waitForTimeout(250);
  await page.waitForTimeout(settleMs);
}

/**
 * Upload `path` into file input `id` and verify it in its group. Once Greenhouse's uploader has thrown it stays broken
 * until the page reloads, so with `reload` (only before anything else was filled) a failed first try reloads the page
 * (a GET of the same URL) and tries once more. null when the form has neither the input nor its group.
 */
async function uploadFile(page: Page, id: string, path: string, reload: boolean): Promise<boolean | null> {
  if (!path.trim()) return null;
  const input = sel(id);
  if (!(await page.locator(input).count()) && !(await page.locator(`[role="group"][aria-labelledby="upload-label-${id.replace(/"/g, '')}"]`).count())) return null;
  const base = basename(path);
  for (let attempt = 0; attempt < (reload ? 2 : 1); attempt++) {
    if (attempt > 0) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch { return false; }
    }
    const group = await uploadGroup(page, id);
    if (!group) return setFile(page, input, path); // no group around the input: plain input check
    if ((await uploadState(group, base)) === 'attached') return true;
    await waitUploadReady(page, group, attempt > 0 ? 2000 : 500);
    if (!(await page.locator(input).count())) continue;
    try { await page.locator(input).first().setInputFiles(path, { timeout: 5000 }); } catch { continue; }
    if (await verifyUpload(page, group, base)) return true;
  }
  return false;
}

/** True when the file is (still) attached in the group of `id`. */
async function fileAttached(page: Page, id: string, path: string): Promise<boolean> {
  const group = await uploadGroup(page, id);
  return !!group && (await uploadState(group, basename(path))) === 'attached';
}

/** Plain text inputs written during this fill: re-read at the end to catch a late resume-parse / re-render wipe. */
type Written = { fieldId: string; selector: string; value: string; want: string };

/** fillText, remembering what the input actually holds afterwards. */
async function typed(page: Page, selector: string, e: FillEntry, written: Written[]): Promise<boolean> {
  const ok = await fillText(page, selector, e.value);
  if (ok) written.push({ fieldId: e.fieldId, selector, value: e.value, want: await page.locator(selector).first().inputValue() });
  return ok;
}

async function fillIdentity(page: Page, plan: FillPlan, e: FillEntry, written: Written[], first: boolean): Promise<boolean | null> {
  if (!e.value.trim()) return null;
  const text = IDENTITY_TEXT[e.fieldId];
  if (text) return (await page.locator(text).count()) ? typed(page, text, e, written) : null;
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
    case 'identity:resume': return uploadFile(page, 'resume', e.value, first);
    case 'identity:coverLetter': return (await openCoverLetterText(page)) ? typed(page, COVER_TEXT, e, written) : null;
    default: return null;
  }
}

async function fillCustom(page: Page, e: FillEntry, written: Written[]): Promise<boolean | null> {
  const s = sel(e.fieldId);
  if (!(await page.locator(s).count())) return null;
  const tag = await page.locator(s).first().evaluate((el) => el.tagName.toLowerCase());
  switch (e.kind) {
    case 'text': case 'textarea': return typed(page, s, e, written);
    case 'file': return uploadFile(page, e.fieldId, e.value, false);
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
    // The resume goes first: Greenhouse parses it and may re-render / overwrite the text fields afterwards.
    const order = [...plan.entries.filter((x) => x.fieldId === 'identity:resume'), ...plan.entries.filter((x) => x.fieldId !== 'identity:resume')];
    const written: Written[] = [];
    const read = (sel: string) => page.locator(sel).first().inputValue().catch(() => null);
    const resume = order.find((x) => x.fieldId === 'identity:resume' && x.value.trim());
    let done = 0;
    const move = (r: FilledReport, id: string, to: 'filled' | 'failed') => {
      const from = to === 'filled' ? r.failed : r.filled;
      if (from.includes(id)) { from.splice(from.indexOf(id), 1); r[to].push(id); }
    };
    return runFill(page, plan, order, async (e) => {
      const first = done++ === 0; // nothing typed yet: a reload to recover the uploader loses nothing
      const res = e.fieldId.startsWith('identity:') ? await fillIdentity(page, plan, e, written, first) : await fillCustom(page, e, written);
      if (e.fieldId === 'identity:resume' && res) await page.waitForTimeout(1500); // let the parse / autofill land before typing anything
      return res;
    }, undefined, async (r) => {
      // Re-verify the resume in its group; retry the upload once (no reload: fields are filled) before trusting the report.
      if (resume && (r.filled.includes(resume.fieldId) || r.failed.includes(resume.fieldId))) {
        let ok = await fileAttached(page, 'resume', resume.value);
        if (!ok) {
          ok = (await uploadFile(page, 'resume', resume.value, false)) === true;
          if (ok) await page.waitForTimeout(1500); // a fresh upload re-runs the parser: let it land before the re-read below
        }
        move(r, resume.fieldId, ok ? 'filled' : 'failed');
      }
      await page.waitForTimeout(500);
      for (const w of written) {
        if (!r.filled.includes(w.fieldId) || (await read(w.selector)) === w.want) continue;
        // Wiped after we typed it: re-type once via fillText and re-read.
        await fillText(page, w.selector, w.value); // keeps textarea newlines, oneLine for inputs, no key presses
        await page.waitForTimeout(500);
        if ((await read(w.selector)) !== w.want) { r.filled.splice(r.filled.indexOf(w.fieldId), 1); r.failed.push(w.fieldId); }
      }
    });
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    return runSubmit(page, timeoutMs, { submitSelector: SUBMIT, errorText: ERROR_TEXT, errorSelector: '[role="alert"], .error, [class*="error"]' });
  },
};
