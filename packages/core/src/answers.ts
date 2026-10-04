import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { FormQuestion } from './apply/types';

const stringAnswerKeys = z.enum(['fullName', 'firstName', 'email', 'phone', 'country', 'location', 'timezone', 'workAuthorizationUS', 'sponsorship', 'salaryExpectation', 'noticePeriod', 'englishLevel', 'linkedin', 'github', 'portfolio']);

export const AnswersSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().min(3),
  phone: z.string().min(3),
  country: z.string().min(1),
  location: z.string().min(1),
  timezone: z.string().min(1),
  workAuthorizationUS: z.literal('No'),
  sponsorship: z.string().min(1),
  salaryExpectation: z.string().min(1),
  noticePeriod: z.string().min(1),
  englishLevel: z.string().min(1),
  linkedin: z.string().min(1),
  github: z.string().min(1),
  portfolio: z.string().optional(),
  extraMatchers: z.array(z.object({ pattern: z.string(), key: stringAnswerKeys })).default([]),
});
export type Answers = z.infer<typeof AnswersSchema>;
export type AnswerKey =
  | 'fullName' | 'firstName' | 'email' | 'phone' | 'country' | 'location' | 'timezone' | 'workAuthorizationUS'
  | 'sponsorship' | 'salaryExpectation' | 'noticePeriod' | 'englishLevel' | 'linkedin' | 'github' | 'portfolio';

const DEFAULT_MATCHERS: [RegExp, AnswerKey][] = [
  [/(?=.*(authori[sz]ed to work|work authori[sz]ation|legally (able|eligible|permitted) to work))(?=.*(united states|u\.s\.a?\.?|\busa\b|\bus\b|america))/i, 'workAuthorizationUS'],
  [/sponsor/i, 'sponsorship'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/portfolio|personal (web)?site/i, 'portfolio'],
  [/salary|compensation expectation|expected (pay|rate|compensation)|desired (salary|rate|pay)/i, 'salaryExpectation'],
  [/notice period|earliest start|when can you start|start date/i, 'noticePeriod'],
  [/country of residence|which country|country are you/i, 'country'],
  [/time ?zone/i, 'timezone'],
  [/where are you (located|based)|current location|city of residence/i, 'location'],
  [/english (level|proficiency|skills)|proficiency in english|rate your english|english fluency/i, 'englishLevel'],
  [/prefer(red)? name|name you['’]?d prefer/i, 'firstName'],
];

export function parseAnswers(yamlText: string): Answers {
  const a = AnswersSchema.parse(YAML.parse(yamlText));
  for (const m of a.extraMatchers) {
    try { new RegExp(m.pattern, 'i'); } catch (e) { throw new Error(`answers: invalid regex "${m.pattern}": ${(e as Error).message}`); }
  }
  return a;
}

export function loadAnswers(path: string): Answers {
  return parseAnswers(readFileSync(path, 'utf8'));
}

export function answerValue(a: Answers, key: AnswerKey): string | undefined {
  if (key === 'firstName') return a.fullName.trim().split(/\s+/)[0];
  return a[key];
}

export function matchFixedAnswer(q: FormQuestion, a: Answers): { key: AnswerKey; value: string } | null {
  if (q.type === 'textarea') return null;
  const matchers: [RegExp, AnswerKey][] = [
    ...a.extraMatchers.map((m) => [new RegExp(m.pattern, 'i'), m.key] as [RegExp, AnswerKey]),
    ...DEFAULT_MATCHERS,
  ];
  for (const [re, key] of matchers) {
    if (!re.test(q.label)) continue;
    const value = answerValue(a, key);
    if (value) return { key, value };
  }
  return null;
}

export function pickOption(value: string, options: string[]): string | null {
  const v = value.trim().toLowerCase();
  // Exact match (case-insensitive)
  const exact = options.find((o) => o.trim().toLowerCase() === v);
  if (exact) return exact;
  // Leading word match for yes/no style answers
  const lead = v.split(/[\s,—–-]+/)[0];
  if (lead === 'yes' || lead === 'no') {
    return options.find((o) => {
      const trimmed = o.trim().toLowerCase();
      const withoutPunc = trimmed.replace(/[.!?]*$/, '');
      return withoutPunc === lead;
    }) ?? null;
  }
  return null;
}
