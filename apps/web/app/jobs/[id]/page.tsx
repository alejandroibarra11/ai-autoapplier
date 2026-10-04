import { notFound } from 'next/navigation';
import { formatComp, getJob, latestDraft, latestScore, listEvents } from '@autoapplier/core';
import { getDb } from '../../../lib/db';
import { DraftPanel } from './draft-panel';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await params;
  const job = db ? getJob(db, Number(id)) : undefined;
  if (!db || !job) notFound();
  const score = latestScore(db, job.id);
  const draft = latestDraft(db, job.id);
  const events = listEvents(db, job.id);
  return (
    <>
      <div className="card">
        <h2 style={{ margin: 0 }}>{job.title}</h2>
        <p className="muted">{job.company} · {job.locationText || '—'} · {formatComp(job) ?? 'pay not listed'} · {job.source} · status <b>{job.status}</b></p>
        <a href={job.applyUrl} target="_blank" rel="noreferrer">Open posting ↗</a>
      </div>
      <DraftPanel job={job} draft={draft} />
      {score && (
        <div className="card">
          <p><b>Fit {score.fitScore}</b> · {score.roleCategory} · eligibility <b>{score.eligibility}</b></p>
          <blockquote>“{score.eligibilityEvidence}”</blockquote>
          <p>✅ {score.matched.join(', ') || '—'}</p>
          <p>⚠️ {score.missing.join(', ') || '—'}</p>
          {score.redFlags.length > 0 && <p>🚩 {score.redFlags.join('; ')}</p>}
        </div>
      )}
      <div className="card"><pre>{job.description}</pre></div>
      <div className="card">
        <h3>History</h3>
        <ul>{events.map((e) => <li key={e.id}>{e.at.toISOString().slice(0, 16)} — {e.fromStatus ?? '∅'} → {e.toStatus}{e.note ? ` (${e.note})` : ''}</li>)}</ul>
      </div>
    </>
  );
}
