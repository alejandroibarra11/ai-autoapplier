import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findRoot, latestDraft } from '@autoapplier/core';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId: raw } = await params;
  const jobId = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(jobId)) return new Response('Not found', { status: 404 });
  const db = getDb();
  const draft = db ? latestDraft(db, jobId) : undefined;
  if (!draft?.cvPdfPath) return new Response('Not found', { status: 404 });
  try {
    const base = realpathSync(resolve(join(/*turbopackIgnore: true*/ findRoot(), 'data/cv'))) + sep;
    const file = realpathSync(resolve(draft.cvPdfPath));
    if (!file.startsWith(base)) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="cv-${jobId}.pdf"` } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
