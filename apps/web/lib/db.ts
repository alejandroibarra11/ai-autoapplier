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
  writeDb ??= openDb(join(/*turbopackIgnore: true*/ findRoot(), process.env.DATABASE_PATH ?? 'data/app.db'), { migrate: false });
  return writeDb;
}
