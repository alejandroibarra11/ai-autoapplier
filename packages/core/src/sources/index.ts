import type { Config } from '../config';
import type { CompanyRow } from '../db/repo';
import type { Source } from './types';
import { greenhouseSource } from './greenhouse';
import { leverSource } from './lever';
import { ashbySource } from './ashby';
import { remoteOkSource } from './remoteok';
import { remotiveSource } from './remotive';
import { himalayasSource } from './himalayas';
import { wwrSource } from './wwr';

export type { Source } from './types';

export function buildSources(cfg: Config, companies: CompanyRow[]): Source[] {
  const s = cfg.sources;
  const out: Source[] = [];
  for (const c of companies) {
    if (c.ats === 'greenhouse' && s.greenhouse) out.push(greenhouseSource(c));
    else if (c.ats === 'lever' && s.lever) out.push(leverSource(c));
    else if (c.ats === 'ashby' && s.ashby) out.push(ashbySource(c));
    // workable: no adapter in phase 1
  }
  if (s.remoteok) out.push(remoteOkSource());
  if (s.remotive.enabled) for (const cat of s.remotive.categories) out.push(remotiveSource(cat));
  if (s.himalayas.enabled) for (const q of s.himalayas.queries) out.push(himalayasSource(q, s.himalayas.country, s.himalayas.pages));
  if (s.wwr.enabled) for (const f of s.wwr.feeds) out.push(wwrSource(f));
  return out;
}
