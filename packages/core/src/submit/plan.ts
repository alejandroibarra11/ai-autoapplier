import type { Answers } from '../answers';
import type { Profile } from '../profile';
import type { FormQuestion } from '../apply/types';
import type { DraftRow } from '../db/repo';
import type { EntryKind, FillEntry, FillPlan, IdentityKey } from './types';

export const DEMOGRAPHIC = /\b(gender|sex|race|racial|ethnicity|ethnic|hispanic|latin[oax]|veteran|disability|disabilities|sexual orientation|pronouns?|transgender|lgbtq\+?|age|date of birth)\b/i;
const DECLINE = /decline|prefer not|don'?t wish|do not wish|not to (say|answer|disclose)|choose not/i;

export function isDemographic(label: string): boolean {
  return DEMOGRAPHIC.test(label);
}

export function pickDecline(options: string[]): string | null {
  return options.find((o) => DECLINE.test(o)) ?? null;
}

const KIND: Record<string, EntryKind> = { text: 'text', textarea: 'textarea', select: 'select', multiselect: 'multiselect', boolean: 'choice', file: 'file' };

export interface FillPlanInput {
  questions: FormQuestion[];
  draft: Pick<DraftRow, 'answers' | 'coverLetter' | 'cvPdfPath'>;
  answers: Answers;
  profile: Profile;
}

export function buildFillPlan(input: FillPlanInput): FillPlan {
  const { questions, draft, answers, profile } = input;
  const entries: FillEntry[] = [];
  const missingRequired: FillPlan['missingRequired'] = [];
  const manualReasons: string[] = [];

  const identity = (key: IdentityKey, label: string, value: string, kind: EntryKind = 'text') =>
    entries.push({ fieldId: `identity:${key}`, label, kind, value, source: 'identity', required: false });

  const [first = '', ...rest] = answers.fullName.trim().split(/\s+/);
  identity('firstName', 'First name', first);
  identity('lastName', 'Last name', rest.join(' '));
  identity('fullName', 'Full name', answers.fullName);
  identity('email', 'Email', answers.email);
  identity('phone', 'Phone', answers.phone);
  identity('country', 'Country', answers.country);
  identity('location', 'Location', answers.location);
  identity('linkedin', 'LinkedIn', answers.linkedin);
  identity('github', 'GitHub', answers.github);
  if (answers.portfolio) identity('portfolio', 'Portfolio', answers.portfolio);
  identity('currentCompany', 'Current company', profile.experience[0]?.company ?? '');
  if (draft.cvPdfPath) identity('resume', 'Resume', draft.cvPdfPath, 'file');
  else manualReasons.push('no CV PDF');
  identity('coverLetter', 'Cover letter', draft.coverLetter ?? '', 'textarea');

  const byId = new Map(draft.answers.map((a) => [a.questionId, a]));
  for (const q of questions) {
    if (q.type === 'identity') continue;
    if (isDemographic(q.label)) {
      if (!q.required) continue;
      const decline = pickDecline(q.options ?? []);
      if (decline) entries.push({ fieldId: q.id, label: q.label, kind: KIND[q.type] ?? 'text', value: decline, source: 'decline', required: true, options: q.options });
      else manualReasons.push(`required demographic question without a decline option: ${q.label}`);
      continue;
    }
    if (q.type === 'file') {
      if (q.required) manualReasons.push(`required file upload: ${q.label}`);
      continue;
    }
    const a = byId.get(q.id);
    if (!a) {
      if (q.required) missingRequired.push({ fieldId: q.id, label: q.label });
      continue;
    }
    entries.push({ fieldId: q.id, label: q.label, kind: KIND[q.type] ?? 'text', value: a.answer, source: a.source === 'answers' ? 'answers' : 'draft', required: q.required, ...(q.options ? { options: q.options } : {}) });
  }
  return { entries, missingRequired, manualReasons };
}
