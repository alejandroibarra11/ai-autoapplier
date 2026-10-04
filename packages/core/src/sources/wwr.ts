import { XMLParser } from 'fast-xml-parser';
import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getText } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface WwrItem { title: string; region?: string; link: string; guid?: string | { '#text': string }; pubDate: string; description?: string }

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });

export function parseWwr(xml: string): NormalizedJob[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: WwrItem | WwrItem[] } } };
  const raw = doc.rss?.channel?.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return items.map((it) => {
    const full = String(it.title);
    const idx = full.indexOf(': ');
    const company = idx > 0 ? full.slice(0, idx) : 'Unknown';
    const title = idx > 0 ? full.slice(idx + 2) : full;
    const html = String(it.description ?? '');
    const ats = findAtsInHtml(html);
    const guid = typeof it.guid === 'object' ? it.guid['#text'] : it.guid;
    return {
      source: 'wwr',
      sourceJobId: String(guid ?? it.link),
      company: company.trim(),
      title: title.trim(),
      locationText: String(it.region ?? '').trim(),
      description: htmlToText(html),
      applyUrl: ats?.url ?? String(it.link),
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: null, compMax: null, compCurrency: null, compPeriod: null,
      postedAt: new Date(it.pubDate),
    };
  });
}

export function wwrSource(feedUrl: string): Source {
  const slug = feedUrl.split('/').pop()?.replace('.rss', '') ?? feedUrl;
  return { name: `wwr:${slug}`, fetchJobs: async () => parseWwr(await getText(feedUrl)) };
}
