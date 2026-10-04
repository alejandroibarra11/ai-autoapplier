import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findRoot, latestDraft } from '@autoapplier/core';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const db = getDb();
  const draft = db ? latestDraft(db, Number(jobId)) : undefined;
  const base = resolve(join(/*turbopackIgnore: true*/ findRoot(), 'data/cv')) + sep;
  const file = draft?.cvPdfPath ? resolve(draft.cvPdfPath) : null;
  if (!file || !file.startsWith(base) || !existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(readFileSync(file), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="cv-${jobId}.pdf"` } });
}
