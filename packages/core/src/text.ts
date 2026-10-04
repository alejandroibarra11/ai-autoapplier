import { convert } from 'html-to-text';

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function htmlToText(html: string): string {
  if (!html) return '';
  // Greenhouse returns entity-escaped HTML; unescape once so tags are real tags.
  const src = /&lt;\/?[a-z]/i.test(html) ? decodeBasicEntities(html) : html;
  return convert(src, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeKey(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Soft cross-source dedupe key. The hard identity of a job is (source, sourceJobId). */
export function dedupeKey(company: string, title: string, locationText: string): string {
  return `${normalizeKey(company)}|${normalizeKey(title)}|${normalizeKey(locationText)}`;
}

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
