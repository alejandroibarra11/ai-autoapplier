import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Source } from '../sources/types';
import { HttpError } from '../http';
import { deactivateCompany, insertJobs, markPolled, upsertCompany } from '../db/repo';

export interface DiscoverResult { fetched: number; inserted: number; errors: { source: string; message: string }[] }

export function seedCompanies(db: Db, cfg: Config): void {
  for (const c of cfg.seedCompanies) upsertCompany(db, { ...c, source: 'seed' });
}

export async function runDiscover(db: Db, sources: Source[], now = new Date()): Promise<DiscoverResult> {
  const r: DiscoverResult = { fetched: 0, inserted: 0, errors: [] };
  for (const src of sources) {
    try {
      const list = await src.fetchJobs();
      r.fetched += list.length;
      r.inserted += insertJobs(db, list, now);
      if (src.companyId !== undefined) markPolled(db, src.companyId, now);
      for (const j of list) {
        if (j.ats && j.atsToken && j.source !== j.ats) {
          upsertCompany(db, { ats: j.ats, token: j.atsToken, name: j.company, source: j.source });
        }
      }
    } catch (e) {
      r.errors.push({ source: src.name, message: e instanceof Error ? e.message : String(e) });
      if (src.companyId !== undefined && e instanceof HttpError && e.status === 404) deactivateCompany(db, src.companyId);
    }
  }
  return r;
}
