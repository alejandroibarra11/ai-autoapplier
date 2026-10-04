/// <reference lib="dom" />
import { chromium, type BrowserContext } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RawField } from './apply/form-fields';

export interface BrowserSession { context: BrowserContext; close(): Promise<void> }
export interface VisitResult { finalUrl: string; title: string; links: { href: string; text: string }[] }
export interface PageOpener { visit(url: string): Promise<VisitResult>; readForm(url: string): Promise<RawField[]> }

export async function openBrowser(opts: { headless: boolean; userDataDir: string }): Promise<BrowserSession> {
  mkdirSync(opts.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(opts.userDataDir, { headless: opts.headless });
  return { context, close: () => context.close() };
}

export async function renderPdf(session: BrowserSession, html: string, outPath: string): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const page = await session.context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.6in', right: '0.6in' } });
  } finally {
    await page.close();
  }
}

export function makePageOpener(session: BrowserSession, timeoutMs: number): PageOpener {
  return {
    async visit(url) {
      const page = await session.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: Math.min(5000, timeoutMs) }).catch(() => {});
        const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? '').trim().replace(/\s+/g, ' ') })));
        return { finalUrl: page.url(), title: await page.title(), links };
      } finally {
        await page.close();
      }
    },
    async readForm(url) {
      const page = await session.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: Math.min(8000, timeoutMs) }).catch(() => {});
        return await page.$$eval('input[name], textarea[name], select[name]', (els) => els.map((el) => {
          const e = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const tag = e.tagName.toLowerCase() as 'input' | 'textarea' | 'select';
          const byFor = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
          const wrap = e.closest('label');
          const aria = e.getAttribute('aria-label');
          let label = (byFor?.textContent ?? '').trim();
          if (!label && wrap) label = Array.from(wrap.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join(' ').trim();
          if (!label) label = (aria ?? '').trim();
          if (!label) label = e.name;
          const field: { name: string; label: string; tag: typeof tag; inputType: string | undefined; required: boolean; options?: string[] } = {
            name: e.name, label: label.replace(/\s+/g, ' ').replace(/\*$/, '').trim(), tag,
            inputType: tag === 'input' ? ((e as HTMLInputElement).type || 'text') : undefined,
            required: e.required || e.getAttribute('aria-required') === 'true',
          };
          if (tag === 'select') field.options = Array.from((e as HTMLSelectElement).options).filter((o) => o.value !== '').map((o) => (o.textContent ?? '').trim());
          return field;
        }));
      } finally {
        await page.close();
      }
    },
  };
}
