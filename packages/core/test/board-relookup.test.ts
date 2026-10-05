import { describe, it, expect } from 'vitest';
import { makeBoardLookup, runBoardRelookup } from '../src/pipeline/board-relookup';
import { getJob, insertJobs, listEvents, listJobsByStatus, listJobsForFilling, setResolved, setStatus, upsertCompany } from '../src/db/repo';
import type { ApplyTarget } from '../src/apply/types';
import type { JobRow } from '../src/db/repo';
import type { JobStatus } from '../src/types';
import type { FetchLike } from '../src/apply/board-lookup';
import { makeJob, testDb } from './helpers';

const now = new Date('2026-10-05T12:00:00Z');

function seed(rows: { company: string; status: JobStatus; kind: ApplyTarget['kind'] }[]) {
  const db = testDb();
  insertJobs(db, rows.map((r, i) => makeJob({ company: r.company, title: `Engineer ${i}`, source: 'himalayas', applyUrl: `https://himalayas.app/j/${i}`, ats: null, atsToken: null })));
  const jobs = listJobsByStatus(db, ['discovered']).sort((a, b) => a.id - b.id);
  jobs.forEach((j, i) => {
    setStatus(db, j.id, rows[i]!.status, null, {}, new Date('2026-10-01T00:00:00Z'));
    setResolved(db, j.id, j.applyUrl, rows[i]!.kind);
  });
  return { db, ids: jobs.map((j) => j.id) };
}

const target = (token: string, id: string): ApplyTarget => ({ kind: 'ashby', url: `https://jobs.ashbyhq.com/${token}/${id}`, atsToken: token, atsJobId: id });

describe('runBoardRelookup', () => {
  it('re-resolves manual/other draft_ready + ready_to_apply jobs once via the board lookup, without touching status', async () => {
    const { db, ids } = seed([
      { company: 'Clera', status: 'draft_ready', kind: 'manual' },
      { company: 'Dremio', status: 'ready_to_apply', kind: 'manual' },
      { company: 'Pavago', status: 'draft_ready', kind: 'other' },
      { company: 'Shorty', status: 'shortlisted', kind: 'manual' },
      { company: 'Hasats', status: 'ready_to_apply', kind: 'greenhouse' },
      { company: 'Needy', status: 'needs_manual', kind: 'manual' },
    ]);
    const [clera, dremio, pavago, shorty, hasats, needy] = ids as [number, number, number, number, number, number];
    const before = getJob(db, clera)!;
    const calls: string[] = [];
    const lookup = async (j: Pick<JobRow, 'company' | 'title'>) => {
      calls.push(j.company);
      if (j.company === 'Clera') return target('clera', 'u-1');
      if (j.company === 'Dremio') return target('dremio', 'u-2');
      return null;
    };

    const r = await runBoardRelookup({ db, lookup, now });
    expect(r).toEqual({ checked: 3, matched: 2 });
    expect(calls.sort()).toEqual(['Clera', 'Dremio', 'Pavago']);

    const c = getJob(db, clera)!;
    expect(c).toMatchObject({ status: 'draft_ready', resolvedKind: 'ashby', resolvedApplyUrl: 'https://jobs.ashbyhq.com/clera/u-1' });
    expect(c.updatedAt).toEqual(before.updatedAt);
    expect(c.boardLookupAt).toEqual(now);
    const ev = listEvents(db, clera).at(-1)!;
    expect(ev).toMatchObject({ fromStatus: 'draft_ready', toStatus: 'draft_ready' });
    expect(ev.note).toContain('https://jobs.ashbyhq.com/clera/u-1');

    expect(getJob(db, dremio)).toMatchObject({ status: 'ready_to_apply', resolvedKind: 'ashby' });
    expect(listJobsForFilling(db, 10).map((j) => j.id)).toContain(dremio);

    const p = getJob(db, pavago)!;
    expect(p).toMatchObject({ status: 'draft_ready', resolvedKind: 'other', resolvedApplyUrl: 'https://himalayas.app/j/2' });
    expect(p.boardLookupAt).toEqual(now);
    expect(listEvents(db, pavago).some((e) => e.note?.includes('board'))).toBe(false);

    for (const id of [shorty, hasats, needy]) expect(getJob(db, id)!.boardLookupAt).toBeNull();

    // once per job: a second run looks nothing up again
    expect(await runBoardRelookup({ db, lookup, now })).toEqual({ checked: 0, matched: 0 });
    expect(calls).toHaveLength(3);
  });

  it('marks a job as tried even when the lookup throws, and keeps going', async () => {
    const { db, ids } = seed([
      { company: 'Boom', status: 'draft_ready', kind: 'manual' },
      { company: 'Clera', status: 'draft_ready', kind: 'manual' },
    ]);
    const r = await runBoardRelookup({ db, now, lookup: async (j) => { if (j.company === 'Boom') throw new Error('net'); return target('clera', 'u-1'); } });
    expect(r).toEqual({ checked: 2, matched: 1 });
    expect(getJob(db, ids[0]!)).toMatchObject({ resolvedKind: 'manual', boardLookupAt: now });
    expect(getJob(db, ids[1]!)!.resolvedKind).toBe('ashby');
  });

  it('respects the per-run limit', async () => {
    const { db } = seed([
      { company: 'A', status: 'draft_ready', kind: 'manual' },
      { company: 'B', status: 'draft_ready', kind: 'manual' },
      { company: 'C', status: 'draft_ready', kind: 'manual' },
    ]);
    const lookup = async () => null;
    expect((await runBoardRelookup({ db, lookup, now, limit: 2 })).checked).toBe(2);
    expect((await runBoardRelookup({ db, lookup, now, limit: 2 })).checked).toBe(1);
  });
});

describe('makeBoardLookup', () => {
  it('passes known board tokens from the companies table to the lookup', async () => {
    const db = testDb();
    upsertCompany(db, { ats: 'greenhouse', token: 'automatticcareers', name: 'Automattic', source: 'seed' });
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      seen.push(url);
      if (url.startsWith('https://boards-api.greenhouse.io/v1/boards/automatticcareers/jobs')) {
        return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 7, title: 'Code Wrangler', absolute_url: 'https://job-boards.greenhouse.io/automatticcareers/jobs/7', updated_at: '2026-10-01T00:00:00Z', company_name: 'Automattic' }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const t = await makeBoardLookup(db, fetch)({ company: 'automattic', title: 'Code Wrangler' });
    expect(t).toEqual({ kind: 'greenhouse', url: 'https://job-boards.greenhouse.io/automatticcareers/jobs/7', atsToken: 'automatticcareers', atsJobId: '7' });
  });
});
