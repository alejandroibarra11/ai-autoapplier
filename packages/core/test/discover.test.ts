import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { makeJob, testDb } from './helpers';
import { runDiscover, seedCompanies } from '../src/pipeline/discover';
import { buildSources } from '../src/sources';
import { HttpError } from '../src/http';
import { listActiveCompanies, listJobsByStatus, upsertCompany } from '../src/db/repo';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import type { Source } from '../src/sources/types';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));

describe('runDiscover', () => {
  it('continues after a failing source and records the error', async () => {
    const db = testDb();
    const bad: Source = { name: 'bad', fetchJobs: async () => { throw new Error('boom'); } };
    const good: Source = { name: 'good', fetchJobs: async () => [makeJob({ title: 'AI Engineer A' })] };
    const r = await runDiscover(db, [bad, good]);
    expect(r).toMatchObject({ fetched: 1, inserted: 1, errors: [{ source: 'bad', message: 'boom' }] });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(1);
  });

  it('deactivates a company whose board returns 404', async () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'gone', name: 'Gone', source: 'seed' });
    const [c] = listActiveCompanies(db);
    const src: Source = { name: 'lever:gone', companyId: c!.id, fetchJobs: async () => { throw new HttpError(404, 'u'); } };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db)).toHaveLength(0);
  });

  it('keeps a company active on non-404 errors', async () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'flaky', name: 'Flaky', source: 'seed' });
    const [c] = listActiveCompanies(db);
    const src: Source = { name: 'lever:flaky', companyId: c!.id, fetchJobs: async () => { throw new HttpError(503, 'u'); } };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db)).toHaveLength(1);
  });

  it('grows the watchlist from board jobs that link to an ATS', async () => {
    const db = testDb();
    const src: Source = { name: 'remoteok', fetchJobs: async () => [
      makeJob({ source: 'remoteok', company: 'NewCo', ats: 'ashby', atsToken: 'newco' }),
      makeJob({ source: 'remoteok', company: 'NoAts', ats: null, atsToken: null }),
    ] };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db).map((c) => `${c.ats}:${c.token}`)).toEqual(['ashby:newco']);
  });
});

describe('buildSources', () => {
  it('builds per-company and board sources from config, skipping workable', () => {
    const db = testDb();
    seedCompanies(db, cfg);
    upsertCompany(db, { ats: 'workable', token: 'hf', name: 'HF', source: 'seed' });
    const names = buildSources(cfg, listActiveCompanies(db)).map((s) => s.name);
    expect(names).toContain('greenhouse:gitlab');
    expect(names).toContain('ashby:vapi');
    expect(names).toContain('lever:toptal');
    expect(names).toContain('remoteok');
    expect(names).toContain('remotive:software-development');
    expect(names).toContain('himalayas:ai engineer');
    expect(names.some((n) => n.startsWith('wwr:'))).toBe(true);
    expect(names.some((n) => n.startsWith('workable:'))).toBe(false);
  });
});
