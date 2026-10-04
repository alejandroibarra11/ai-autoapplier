import type { JobRow, SubmissionRow } from '@autoapplier/core';
import { cancelSubmission, markApplied } from './actions';
import { SubmitForm } from './submit-form';

const RESULT_TEXT: Record<string, string> = {
  filled: 'Filled, waiting for your decision', dry_run: 'Dry run (nothing was sent)', blocked: 'Finish manually',
  submitted: 'Submitted', failed: 'Submit failed', cancelled: 'Cancelled',
};

export function SubmitPanel({ job, sub, dryRun }: { job: JobRow; sub: SubmissionRow | undefined; dryRun: boolean }) {
  if (!sub) return null;
  const awaiting = job.status === 'awaiting_submit';
  const finished = sub.result === 'submitted' || sub.result === 'dry_run' || sub.result === 'failed' || sub.result === 'blocked' || sub.result === 'cancelled';
  return (
    <div className="card">
      <h3>Submission</h3>
      {awaiting && (dryRun
        ? <p>🧪 <b>Dry run is ON</b> — Submit will not send anything.</p>
        : <p>🔴 <b>Dry run is OFF</b> — Submit will send the application for real.</p>)}
      <p>Result: <b>{RESULT_TEXT[sub.result] ?? sub.result}</b>{sub.evidence ? <span className="muted"> — {sub.evidence}</span> : null}</p>
      {sub.fillShot && <p><a href={`/shot/${sub.id}?k=fill`} target="_blank" rel="noreferrer"><img src={`/shot/${sub.id}?k=fill`} alt="Filled form screenshot" style={{ maxWidth: '100%', maxHeight: 480, border: '1px solid var(--line)' }} /></a></p>}
      <table>
        <thead><tr><th>Field</th><th>Value</th><th>Source</th></tr></thead>
        <tbody>
          {sub.plan.entries.map((e) => (
            <tr key={e.fieldId} style={e.source === 'fill_time' ? { background: 'rgba(250, 204, 21, 0.18)' } : undefined}>
              <td>{e.label}{e.required ? ' *' : ''}</td>
              <td style={{ wordBreak: 'break-word' }}>{e.kind === 'file' ? (e.value ? '📎 attached' : '—') : (e.value || '—')}</td>
              <td>{e.source === 'fill_time' ? '⚠️ generated at fill time — check' : e.source === 'decline' ? '🚫 decline option (demographic)' : e.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {awaiting && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-start' }}>
          <SubmitForm jobId={job.id} dryRun={dryRun} />
          <form action={cancelSubmission.bind(null, job.id)}><button>✋ Cancel</button></form>
        </div>
      )}
      {(job.status === 'needs_manual' || job.status === 'submit_failed') && (
        <form action={markApplied.bind(null, job.id)} style={{ marginTop: 12 }}>
          {job.status === 'submit_failed' && <p className="muted">Check your email first: the application may have been sent.</p>}
          <button>📨 Mark applied</button>
        </form>
      )}
      {finished && sub.submitShot && (
        <>
          <h4>Last screenshot</h4>
          <p><a href={`/shot/${sub.id}?k=submit`} target="_blank" rel="noreferrer"><img src={`/shot/${sub.id}?k=submit`} alt="Submit screenshot" style={{ maxWidth: '100%', maxHeight: 480, border: '1px solid var(--line)' }} /></a></p>
        </>
      )}
    </div>
  );
}
