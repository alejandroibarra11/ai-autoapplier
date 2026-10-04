import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadAnswers, loadConfig, loadProfile, openDb, renderProfileForPrompt, seedCompanies } from '@autoapplier/core';

export function bootstrap() {
  const root = findRoot();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const cfg = loadConfig(join(root, 'config.yaml'));
  for (const p of new Set([cfg.scoring.provider, cfg.drafting.provider])) {
    const v = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (!process.env[v]) throw new Error(`${v} missing in .env (needed for ${p})`);
  }
  const profilePath = join(root, 'profile/profile.yaml');
  if (!existsSync(profilePath)) throw new Error(`missing ${profilePath} — copy profile/profile.example.yaml and fill it in`);
  const profile = loadProfile(profilePath);
  const profileText = renderProfileForPrompt(profile);
  const answersPath = join(root, 'profile/answers.yaml');
  if (!existsSync(answersPath)) throw new Error(`missing ${answersPath} — copy profile/answers.example.yaml and fill it in`);
  const answers = loadAnswers(answersPath);
  const db = openDb(join(root, process.env.DATABASE_PATH ?? 'data/app.db'));
  seedCompanies(db, cfg);
  return {
    root, cfg, profileText, profile, answers, db,
    env: { telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined, chatId: process.env.TELEGRAM_CHAT_ID || undefined },
  };
}
