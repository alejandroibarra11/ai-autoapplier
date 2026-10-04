import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as schema from './schema';
import { findRoot } from '../root';

export function openDb(path: string, opts: { migrate?: boolean; readonly?: boolean } = {}) {
  const { migrate: runMigrations = true, readonly = false } = opts;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  }
  const db = drizzle(sqlite, { schema });
  if (runMigrations && !readonly) {
    migrate(db, { migrationsFolder: join(findRoot(), 'packages/core/drizzle') });
  }
  return db;
}
export type Db = ReturnType<typeof openDb>;
