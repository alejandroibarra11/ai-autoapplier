import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findRoot, getSubmission } from '@autoapplier/core';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';
const notFound = () => new Response('Not found', { status: 404 });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id)) return notFound();
  const k = new URL(req.url).searchParams.get('k');
  if (k !== 'fill' && k !== 'submit') return notFound();
  const db = getDb();
  const sub = db ? getSubmission(db, id) : undefined;
  const path = k === 'fill' ? sub?.fillShot : sub?.submitShot;
  if (!path) return notFound();
  try {
    const base = realpathSync(resolve(join(/*turbopackIgnore: true*/ findRoot(), 'data/screenshots'))) + sep;
    const file = realpathSync(resolve(path));
    if (!file.startsWith(base) || !file.toLowerCase().endsWith('.png')) return notFound();
    const bytes = readFileSync(file);
    if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) return notFound();
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' } });
  } catch {
    return notFound();
  }
}
