'use client';
import { useActionState } from 'react';
import { submitApplication } from './actions';

/** 🚀 Submit with the dry-run mode the panel was rendered under (the server action compares it with the current config). */
export function SubmitForm({ jobId, dryRun }: { jobId: number; dryRun: boolean }) {
  const [msg, action, pending] = useActionState(submitApplication, null);
  return (
    <form action={action} style={{ display: 'inline-block' }}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="renderedDry" value={dryRun ? '1' : '0'} />
      <button disabled={pending}>{pending ? '⏳ Submitting… (up to a minute)' : '🚀 Submit'}</button>
      {msg && <p role="status"><b>{msg}</b></p>}
    </form>
  );
}
