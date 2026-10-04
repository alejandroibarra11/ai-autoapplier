import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGreenhouseQuestions } from '../src/apply/greenhouse-questions';
import { normalizeFormFields } from '../src/apply/form-fields';
import { COMMON_QUESTIONS } from '../src/apply/common';

const gh = JSON.parse(readFileSync(join(__dirname, 'fixtures/greenhouse-questions.json'), 'utf8'));

describe('parseGreenhouseQuestions', () => {
  const qs = parseGreenhouseQuestions(gh);
  it('marks identity and file fields as identity', () => {
    expect(qs.find((q) => q.label === 'First Name')?.type).toBe('identity');
    expect(qs.find((q) => q.label === 'Resume/CV')?.type).toBe('identity');
  });
  it('maps selects with option labels', () => {
    const sp = qs.find((q) => /sponsorship/i.test(q.label))!;
    expect(sp.type).toBe('select');
    expect(sp.options).toContain('No');
    expect(sp.required).toBe(true);
  });
  it('maps plain text questions with their field name as id', () => {
    const li = qs.find((q) => q.label === 'LinkedIn Profile')!;
    expect(li).toMatchObject({ type: 'text', required: false });
    expect(li.id).toMatch(/^question_/);
  });
  it('throws on bad shape', () => expect(() => parseGreenhouseQuestions({})).toThrow(/greenhouse/));
});

describe('normalizeFormFields', () => {
  it('maps tags/types and detects identity fields', () => {
    const qs = normalizeFormFields([
      { name: 'name', label: 'Full name', tag: 'input', inputType: 'text', required: true },
      { name: 'email', label: 'Email', tag: 'input', inputType: 'email', required: true },
      { name: 'resume', label: 'Resume', tag: 'input', inputType: 'file', required: true },
      { name: 'urls[LinkedIn]', label: 'LinkedIn URL', tag: 'input', inputType: 'text', required: false },
      { name: 'comments', label: 'Additional information', tag: 'textarea', required: false },
      { name: 'cards[abc][field0]', label: 'Are you authorized to work in the US?', tag: 'select', required: true, options: ['', 'Yes', 'No'] },
      { name: 'consent', label: 'I agree', tag: 'input', inputType: 'checkbox', required: true },
    ]);
    expect(qs.map((q) => q.type)).toEqual(['identity', 'identity', 'identity', 'text', 'textarea', 'select', 'boolean']);
    expect(qs[5]!.options).toEqual(['Yes', 'No']);
  });
  it('drops hidden/unnamed duplicates', () => {
    expect(normalizeFormFields([
      { name: 'a', label: 'A', tag: 'input', inputType: 'hidden', required: false },
      { name: 'b', label: 'B', tag: 'input', inputType: 'text', required: false },
      { name: 'b', label: 'B', tag: 'input', inputType: 'text', required: false },
    ]).map((q) => q.id)).toEqual(['b']);
  });
});

describe('COMMON_QUESTIONS', () => {
  it('covers motivation, authorization, sponsorship, salary, notice and location', () => {
    const labels = COMMON_QUESTIONS.map((q) => q.label).join(' | ');
    for (const w of ['Why', 'authorized', 'sponsorship', 'salary', 'notice', 'located']) expect(labels).toContain(w);
  });
});
