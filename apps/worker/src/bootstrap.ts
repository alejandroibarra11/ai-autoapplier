import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, loadProfile, openDb, renderProfileForPrompt, seedCompanies } from '@autoapplier/core';

export function bootstrap() {
  const root = findRoot();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const cfg = loadConfig(join(root, 'config.yaml'));
  const profilePath = join(root, 'profile/profile.yaml');
  if (!existsSync(profilePath)) throw new Error(`missing ${profilePath} — copy profile/profile.example.yaml and fill it in`);
  const profileText = renderProfileForPrompt(loadProfile(profilePath));
  const db = openDb(join(root, process.env.DATABASE_PATH ?? 'data/app.db'));
  seedCompanies(db, cfg);
  return {
    root, cfg, profileText, db,
    env: { telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined, chatId: process.env.TELEGRAM_CHAT_ID || undefined },
  };
}
