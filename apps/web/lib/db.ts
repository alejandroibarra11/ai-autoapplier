import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { findRoot, openDb, type Db } from '@autoapplier/core';

let db: Db | undefined;
export function getDb(): Db | null {
  if (db) return db;
  const path = join(/*turbopackIgnore: true*/ findRoot(), process.env.DATABASE_PATH ?? 'data/app.db');
  if (!existsSync(path)) return null;
  db = openDb(path, { readonly: true, migrate: false });
  return db;
}

let writeDb: Db | undefined;
export function getWriteDb(): Db {
  if (writeDb) return writeDb;
  const path = join(/*turbopackIgnore: true*/ findRoot(), process.env.DATABASE_PATH ?? 'data/app.db');
  if (!existsSync(path)) throw new Error('No database yet — run the worker first');
  writeDb = openDb(path, { migrate: false });
  return writeDb;
}
