import Link from 'next/link';
import { JOB_STATUSES, formatComp, latestScore, listJobsByStatus, type JobStatus } from '@autoapplier/core';
import { getDb } from '../lib/db';
import { ago } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function Queue({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const db = getDb();
  if (!db) return <p>No database yet. Run <code>pnpm once</code> first.</p>;
  const { status: raw } = await searchParams;
  const status: JobStatus = (JOB_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as JobStatus) : 'awaiting_review';
  const rows = listJobsByStatus(db, [status], 300)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .sort((a, b) => (b.score?.fitScore ?? -1) - (a.score?.fitScore ?? -1));

  return (
    <>
      <div className="tabs">
        {JOB_STATUSES.map((s) => <Link key={s} href={`/?status=${s}`} className={s === status ? 'on' : ''}>{s}</Link>)}
      </div>
      <table>
        <thead><tr><th>Fit</th><th>Role</th><th className="hide-sm">Eligibility</th><th className="hide-sm">Pay</th><th>Posted</th></tr></thead>
        <tbody>
          {rows.map(({ job, score }) => (
            <tr key={job.id}>
              <td>{score?.fitScore ?? '–'}</td>
              <td><Link href={`/jobs/${job.id}`}>{job.title}</Link><div className="muted">{job.company} · {job.locationText || '—'} · {job.source}</div>
                {job.filterReason && <div className="muted">{job.filterReason}</div>}</td>
              <td className="hide-sm">{score?.eligibility ?? '–'}</td>
              <td className="hide-sm">{formatComp(job) ?? '—'}{job.lowPay ? ' (low)' : ''}</td>
              <td>{ago(job.postedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">Nothing in {status}.</p>}
    </>
  );
}
