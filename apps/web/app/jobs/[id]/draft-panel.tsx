import { isBlockingFlag, type DraftRow, type JobRow } from '@autoapplier/core';
import { approveDraft, markApplied, regenerateDraft, saveDraft, shortlistJob, skipJob } from './actions';

export function DraftPanel({ job, draft }: { job: JobRow; draft: DraftRow | undefined }) {
  if (job.status === 'awaiting_review') {
    return <div className="card"><form action={shortlistJob.bind(null, job.id)}><button>👍 Shortlist & draft</button></form></div>;
  }
  if (!draft) {
    if (['shortlisted', 'drafting'].includes(job.status)) return <div className="card">Drafting… refresh in a minute.</div>;
    if (job.status === 'draft_failed') return <div className="card">Draft failed. <form action={regenerateDraft.bind(null, job.id)}><button>Retry</button></form></div>;
    return null;
  }
  const blocked = draft.flags.some(isBlockingFlag);
  const editable = job.status === 'draft_ready';
  return (
    <div className="card">
      <h3>Draft {draft.editedByUser ? '(edited)' : ''}</h3>
      {draft.flags.length > 0 && <p>⚠️ {draft.flags.join('; ')}</p>}
      <p>Apply via <b>{job.resolvedKind ?? 'manual'}</b>: <a href={job.resolvedApplyUrl ?? job.applyUrl} target="_blank" rel="noreferrer">{job.resolvedApplyUrl ?? job.applyUrl}</a></p>
      {draft.cvPdfPath && <p><a href={`/cv/${job.id}`} target="_blank" rel="noreferrer">📄 CV (PDF)</a></p>}
      <form action={saveDraft}>
        <input type="hidden" name="jobId" value={job.id} />
        <label>Cover letter<textarea name="coverLetter" defaultValue={draft.coverLetter} rows={10} readOnly={!editable} style={{ width: '100%' }} /></label>
        {draft.answers.map((a) => (
          <label key={a.questionId} style={{ display: 'block', marginTop: 8 }}>
            {a.label} <span className="muted">({a.source === 'answers' ? 'fixed' : 'generated'})</span>
            <textarea name={`answer:${a.questionId}`} defaultValue={a.answer} rows={a.answer.length > 80 ? 4 : 1} readOnly={!editable || a.source === 'answers'} style={{ width: '100%' }} />
          </label>
        ))}
        {editable && <button>💾 Save</button>}
      </form>
      {editable && (
        <form action={approveDraft} style={{ marginTop: 8 }}>
          <input type="hidden" name="jobId" value={job.id} />
          {blocked && <label><input type="checkbox" name="override" /> approve anyway (I reviewed the warnings)</label>}
          <button>✅ Approve</button>
          <p className="muted">Approve uses the last saved version.</p>
        </form>
      )}
      {editable && <form action={regenerateDraft.bind(null, job.id)}><button>🔁 Regenerate</button></form>}
      {editable && <form action={skipJob.bind(null, job.id)}><button>⏭ Skip</button></form>}
      {job.status === 'ready_to_apply' && <form action={markApplied.bind(null, job.id)}><button>📨 Mark applied</button></form>}
    </div>
  );
}
