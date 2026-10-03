import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

const SeedCompany = z.object({
  ats: z.enum(['greenhouse', 'lever', 'ashby', 'workable']),
  token: z.string().min(1),
  name: z.string().min(1),
});

export const ConfigSchema = z.object({
  pollIntervalHours: z.number().int().positive(),
  maxAgeDays: z.number().positive(),
  roles: z.object({ titleInclude: z.array(z.string()).min(1), titleExclude: z.array(z.string()) }),
  eligibility: z.object({
    rejectPatterns: z.array(z.string()),
    usOnlyLocationPatterns: z.array(z.string()),
    allowedRegionPatterns: z.array(z.string()),
  }),
  pay: z.object({ rejectBelowHourly: z.number(), lowPriorityBelowHourly: z.number() }),
  scoring: z.object({
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().min(1),
    threshold: z.number().min(0).max(100),
    maxPerRun: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    dailySpendCapUsd: z.number().positive(),
  }),
  pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number() })),
  sources: z.object({
    greenhouse: z.boolean(),
    lever: z.boolean(),
    ashby: z.boolean(),
    remoteok: z.boolean(),
    remotive: z.object({ enabled: z.boolean(), categories: z.array(z.string()) }),
    himalayas: z.object({
      enabled: z.boolean(), country: z.string(), pages: z.number().int().positive(), queries: z.array(z.string()),
    }),
    wwr: z.object({ enabled: z.boolean(), feeds: z.array(z.string()) }),
  }),
  seedCompanies: z.array(SeedCompany),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(yamlText: string): Config {
  const cfg = ConfigSchema.parse(YAML.parse(yamlText));
  const { rejectPatterns, usOnlyLocationPatterns, allowedRegionPatterns } = cfg.eligibility;
  for (const p of [...rejectPatterns, ...usOnlyLocationPatterns, ...allowedRegionPatterns]) {
    try { new RegExp(p, 'i'); } catch (e) {
      throw new Error(`config: invalid regex "${p}": ${(e as Error).message}`);
    }
  }
  return cfg;
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}
