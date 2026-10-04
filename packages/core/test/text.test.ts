import { describe, it, expect } from 'vitest';
import { htmlToText, dedupeKey, normalizeKey, normalizeForMatch } from '../src/text';

describe('htmlToText', () => {
  it('decodes entity-escaped html (greenhouse style)', () => {
    const out = htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;');
    expect(out).toContain('Hello & welcome');
    expect(out).toContain('TypeScript');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('<p>');
  });
  it('converts normal html and drops link urls', () => {
    const out = htmlToText('<p>Apply <a href="https://x.com/a">here</a></p>');
    expect(out).toBe('Apply here');
  });
  it('returns empty string for empty input', () => expect(htmlToText('')).toBe(''));
});

describe('keys', () => {
  it('normalizes company + title + location for dedupe', () => {
    expect(dedupeKey('Acme, Inc.', 'Senior AI Engineer (Remote)', 'Remote - LATAM')).toBe('acme inc|senior ai engineer remote|remote latam');
  });
  it('strips accents', () => expect(normalizeKey('México Ñandú')).toBe('mexico nandu'));
  it('normalizeForMatch collapses whitespace and lowercases', () => {
    expect(normalizeForMatch('  Remote\n  LATAM  ')).toBe('remote latam');
  });
  it('normalizeForMatch folds curly quotes, en/em dashes and NBSP', () => {
    expect(normalizeForMatch('We\u2019re \u201cremote\u201d \u2018first\u2019')).toBe('we\'re "remote" \'first\'');
    expect(normalizeForMatch('Remote \u2013 LATAM \u2014 Mexico')).toBe('remote - latam - mexico');
    expect(normalizeForMatch('Remote\u00a0-\u00a0LATAM')).toBe('remote - latam');
  });
});
