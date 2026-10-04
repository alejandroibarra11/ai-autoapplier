import { describe, it, expect } from 'vitest';
import { applyDraftEdits, needsOptionFix } from '../src/draft/edits';
import type { DraftAnswer, FormQuestion } from '../src/apply/types';

const questions: FormQuestion[] = [
  { id: 'auth', label: 'Authorized to work in the US?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: 'why', label: 'Why us?', type: 'textarea', required: true },
  { id: 'salary', label: 'Salary', type: 'text', required: false },
  { id: 'size', label: 'Team size?', type: 'select', required: false, options: ['Small', 'Large'] },
];
const answers: DraftAnswer[] = [
  { questionId: 'auth', label: 'Authorized to work in the US?', answer: 'Nope', source: 'answers' },
  { questionId: 'why', label: 'Why us?', answer: 'Because', source: 'generated' },
  { questionId: 'salary', label: 'Salary', answer: '100k', source: 'answers' },
  { questionId: 'size', label: 'Team size?', answer: 'Medium', source: 'generated' },
];
const base = () => ({
  coverLetter: 'Hi', answers: structuredClone(answers), questions,
  flags: ['invalid option for: Authorized to work in the US?', 'invalid option for: Team size?', 'unverified claim: Go'],
});

describe('needsOptionFix', () => {
  it('is true when the answer is not one of the options or the label is flagged', () => {
    expect(needsOptionFix(questions[0], 'Nope', [])).toBe(true);
    expect(needsOptionFix(questions[0], 'No', [])).toBe(false);
    expect(needsOptionFix(questions[0], 'No', ['invalid option for: Authorized to work in the US?'])).toBe(true);
    expect(needsOptionFix(questions[1], 'anything', [])).toBe(false);
    expect(needsOptionFix(undefined, 'x', [])).toBe(false);
  });
});

describe('applyDraftEdits', () => {
  it('accepts a valid option for a fixed answer, keeps its source and clears the flag', () => {
    const r = applyDraftEdits(base(), { coverLetter: 'Hello', answers: { auth: 'No' } });
    expect(r.coverLetter).toBe('Hello');
    expect(r.answers[0]).toEqual({ questionId: 'auth', label: 'Authorized to work in the US?', answer: 'No', source: 'answers' });
    expect(r.flags).toEqual(['invalid option for: Team size?', 'unverified claim: Go']);
  });
  it('rejects a fixed answer that is not one of the options', () => {
    const r = applyDraftEdits(base(), { answers: { auth: 'Maybe' } });
    expect(r.answers[0]!.answer).toBe('Nope');
    expect(r.flags).toContain('invalid option for: Authorized to work in the US?');
  });
  it('never changes fixed answers without options', () => {
    expect(applyDraftEdits(base(), { answers: { salary: '1M' } }).answers[2]!.answer).toBe('100k');
  });
  it('accepts free edits of generated answers and clears the flag once a choice is valid', () => {
    const r = applyDraftEdits(base(), { answers: { why: 'Mission', size: 'large' } });
    expect(r.answers[1]!.answer).toBe('Mission');
    expect(r.answers[3]).toMatchObject({ answer: 'Large', source: 'generated' });
    expect(r.flags).toEqual(['invalid option for: Authorized to work in the US?', 'unverified claim: Go']);
  });
  it('keeps the flag when a generated choice is still invalid', () => {
    const r = applyDraftEdits(base(), { answers: { size: 'Huge' } });
    expect(r.answers[3]!.answer).toBe('Huge');
    expect(r.flags).toContain('invalid option for: Team size?');
  });
  it('flags a generated choice edited into a value that is not an option', () => {
    const d = { ...base(), flags: [] };
    d.answers[3]!.answer = 'Small';
    expect(applyDraftEdits(d, { answers: { size: 'Tiny' } }).flags).toEqual(['invalid option for: Team size?']);
  });
  it('keeps values when fields are not submitted', () => {
    const r = applyDraftEdits(base(), { answers: {} });
    expect(r).toEqual({ coverLetter: 'Hi', answers, flags: base().flags });
  });
});
