import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFillPlan, isDemographic, pickDecline } from '../src/submit/plan';
import { fillSummary, verifyFill } from '../src/submit/verify';
import { parseAnswers } from '../src/answers';
import { loadProfile } from '../src/profile';
import { findRoot } from '../src/root';
import type { FormQuestion } from '../src/apply/types';

const root = findRoot();
const answers = parseAnswers(readFileSync(join(root, 'profile/answers.example.yaml'), 'utf8'));
const profile = loadProfile(join(root, 'profile/profile.example.yaml'));
const draft = {
  coverLetter: 'Hello Acme', cvPdfPath: '/tmp/cv.pdf',
  answers: [
    { questionId: 'q_auth', label: 'Authorized in the US?', answer: 'No', source: 'answers' as const },
    { questionId: 'q_why', label: 'Why us?', answer: 'Because', source: 'generated' as const },
  ],
};
const qs: FormQuestion[] = [
  { id: 'first_name', label: 'First Name', type: 'identity', required: true },
  { id: 'q_auth', label: 'Authorized in the US?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: 'q_why', label: 'Why us?', type: 'textarea', required: true },
  { id: 'q_years', label: 'Years of Rust?', type: 'text', required: true },
  { id: 'q_opt', label: 'Anything else?', type: 'textarea', required: false },
  { id: 'gender', label: 'Gender', type: 'select', required: true, options: ['Male', 'Female', 'Decline to self-identify'] },
  { id: 'veteran', label: 'Veteran status', type: 'select', required: false, options: ['Yes', 'No', 'I don\'t wish to answer'] },
  { id: 'q_port', label: 'Portfolio PDF', type: 'file', required: false },
];

describe('buildFillPlan', () => {
  const plan = buildFillPlan({ questions: qs, draft, answers, profile });
  const by = (id: string) => plan.entries.find((e) => e.fieldId === id);
  it('adds identity entries from answers and profile', () => {
    expect(by('identity:firstName')?.value).toBe('Jane');
    expect(by('identity:lastName')?.value).toBe('Doe');
    expect(by('identity:email')?.value).toBe('jane@example.com');
    expect(by('identity:resume')).toMatchObject({ kind: 'file', value: '/tmp/cv.pdf' });
    expect(by('identity:coverLetter')?.value).toBe('Hello Acme');
    expect(by('identity:currentCompany')?.value).toBe('Example Co');
  });
  it('maps draft answers with sources and kinds', () => {
    expect(by('q_auth')).toMatchObject({ value: 'No', source: 'answers', kind: 'select', required: true });
    expect(by('q_why')).toMatchObject({ value: 'Because', source: 'draft', kind: 'textarea' });
  });
  it('reports missing required answers but not optional ones', () => {
    expect(plan.missingRequired).toEqual([{ fieldId: 'q_years', label: 'Years of Rust?' }]);
    expect(by('q_opt')).toBeUndefined();
  });
  it('declines required demographic questions and skips optional ones', () => {
    expect(by('gender')).toMatchObject({ value: 'Decline to self-identify', source: 'decline' });
    expect(by('veteran')).toBeUndefined();
  });
  it('sends required demographic questions without a decline option to manual', () => {
    const p = buildFillPlan({ questions: [{ id: 'g', label: 'Gender', type: 'select', required: true, options: ['Male', 'Female'] }], draft, answers, profile });
    expect(p.manualReasons).toEqual(['required demographic question without a decline option: Gender']);
  });
  it('sends required extra file uploads and missing CV to manual', () => {
    const p = buildFillPlan({ questions: [{ id: 'f', label: 'Writing sample', type: 'file', required: true }], draft: { ...draft, cvPdfPath: null }, answers, profile });
    expect(p.manualReasons).toEqual(['no CV PDF', 'required file upload: Writing sample']);
  });
});

describe('demographic helpers', () => {
  it.each(['Gender', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability status', 'Race'])('%s is demographic', (l) => expect(isDemographic(l)).toBe(true));
  it('is not fooled by ordinary questions', () => expect(isDemographic('Years of experience')).toBe(false));
  it('picks decline options', () => {
    expect(pickDecline(['Yes', 'No', 'I don\'t wish to answer'])).toBe('I don\'t wish to answer');
    expect(pickDecline(['Male', 'Prefer not to say'])).toBe('Prefer not to say');
    expect(pickDecline(['Yes', 'No'])).toBeNull();
  });
});

describe('demographic detection (word-bounded)', () => {
  it.each(['How do you embrace feedback?', 'Graceful degradation experience', 'Based in Sussex?'])('%s is not demographic', (l) => expect(isDemographic(l)).toBe(false));
  it('"Disability insurance experience" still matches (accepted, safe direction)', () => expect(isDemographic('Disability insurance experience')).toBe(true));
  it.each(['Do you identify as LGBTQ+?', 'Age', 'Preferred pronouns', 'Date of birth'])('%s is demographic', (l) => expect(isDemographic(l)).toBe(true));
});

describe('verifyFill', () => {
  it('flags planned non-identity entries the filler never reported', () => {
    const p = buildFillPlan({ questions: qs.slice(0, 3), draft, answers, profile });
    expect(verifyFill(p, { filled: ['q_auth'], notFound: [], failed: [], requiredEmpty: [] })).toEqual(['field not reported: Why us?']);
  });

  const plan = buildFillPlan({ questions: qs.slice(0, 3), draft, answers, profile });
  it('accepts a clean report', () => expect(verifyFill(plan, { filled: ['q_auth', 'q_why'], notFound: ['identity:github'], failed: [], requiredEmpty: [] })).toEqual([]));
  it('flags missing planned questions, failures and empty required fields', () => {
    expect(verifyFill(plan, { filled: [], notFound: ['q_why'], failed: ['q_auth'], requiredEmpty: ['Location (City)'] })).toEqual([
      'field not found: Why us?', 'could not set: Authorized in the US?', 'required field empty: Location (City)',
    ]);
  });
});

describe('fillSummary', () => {
  const en = (fieldId: string, label: string, value: string, kind: 'text' | 'file' = 'text', source: 'identity' | 'draft' = 'identity') =>
    ({ fieldId, label, kind, value, source, required: false });
  const plan = { missingRequired: [], manualReasons: [], entries: [
    en('identity:firstName', 'First name', 'Jane'), en('identity:linkedin', 'LinkedIn', 'https://l'), en('identity:github', 'GitHub', ''),
    en('identity:resume', 'Resume', '/cv.pdf', 'file'), en('q1', 'Why?', 'x', 'text', 'draft'),
  ] };

  it('counts from the fill report: filled (non-file), non-empty identity entries not on the form, CV attached', () => {
    const report = { filled: ['identity:firstName', 'identity:resume', 'q1'], notFound: ['identity:linkedin', 'identity:github'], failed: [], requiredEmpty: [] };
    expect(fillSummary(plan, report)).toEqual({ filled: 2, notOnForm: ['LinkedIn'], cvAttached: true });
    expect(fillSummary(plan, { ...report, filled: ['identity:firstName', 'q1'], notFound: ['identity:resume'] }).cvAttached).toBe(false);
  });

  it('falls back to plan counts for rows without a report', () => {
    expect(fillSummary(plan, null)).toEqual({ filled: 4, notOnForm: [], cvAttached: true });
  });
});
