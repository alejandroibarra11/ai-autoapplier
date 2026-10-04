import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

export const ProfileSchema = z.object({
  name: z.string(),
  headline: z.string(),
  location: z.string(),
  timezone: z.string(),
  workAuthorization: z.string(),
  englishLevel: z.string(),
  yearsExperience: z.number(),
  summary: z.string(),
  skills: z.record(z.string(), z.array(z.string())),
  experience: z.array(z.object({
    company: z.string(), role: z.string(), start: z.coerce.string(), end: z.coerce.string(),
    highlights: z.array(z.string()),
  })),
  projects: z.array(z.object({ name: z.string(), summary: z.string(), stack: z.array(z.string()) })).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(yamlText: string): Profile {
  return ProfileSchema.parse(YAML.parse(yamlText));
}

export function loadProfile(path: string): Profile {
  return parseProfile(readFileSync(path, 'utf8'));
}

export function renderProfileForPrompt(p: Profile): string {
  const lines = [
    `Name: ${p.name}`,
    `Headline: ${p.headline}`,
    `Location: ${p.location} (${p.timezone})`,
    `Work authorization: ${p.workAuthorization}`,
    `English: ${p.englishLevel}`,
    `Years of experience: ${p.yearsExperience}`,
    `Summary: ${p.summary}`,
    'Skills:',
    ...Object.entries(p.skills).map(([k, v]) => `  ${k}: ${v.join(', ')}`),
    'Experience:',
  ];
  for (const e of p.experience) {
    lines.push(`* ${e.role} — ${e.company} (${e.start} – ${e.end})`);
    for (const h of e.highlights) lines.push(`  - ${h}`);
  }
  if (p.projects.length) {
    lines.push('Projects:');
    for (const pr of p.projects) lines.push(`* ${pr.name}: ${pr.summary} [${pr.stack.join(', ')}]`);
  }
  return lines.join('\n');
}

export function profileBullets(p: Profile): { id: string; role: string; company: string; text: string }[] {
  return p.experience.flatMap((e, ei) => e.highlights.map((text, bi) => ({ id: `e${ei}-b${bi}`, role: e.role, company: e.company, text })));
}

export function profileVocabulary(p: Profile): string[] {
  const terms = [...Object.values(p.skills).flat(), ...p.projects.flatMap((pr) => pr.stack)];
  return [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}
