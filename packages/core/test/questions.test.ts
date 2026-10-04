import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGreenhouseQuestions } from '../src/apply/greenhouse-questions';
import { normalizeFormFields, looksUnlabeled, type RawField } from '../src/apply/form-fields';
import { COMMON_QUESTIONS } from '../src/apply/common';

const gh = JSON.parse(readFileSync(join(__dirname, 'fixtures/greenhouse-questions.json'), 'utf8'));

describe('parseGreenhouseQuestions', () => {
  const qs = parseGreenhouseQuestions(gh);
  it('marks identity and file fields as identity', () => {
    expect(qs.find((q) => q.label === 'First Name')?.type).toBe('identity');
    expect(qs.find((q) => q.label === 'Resume/CV')?.type).toBe('identity');
    expect(qs.find((q) => q.label === 'Resume/CV')?.required).toBe(true);
  });
  it('skips questions with no fields', () => {
    const out = parseGreenhouseQuestions({ questions: [{ label: 'Empty', required: false, fields: [] }, { label: 'Q', required: false, fields: [{ name: 'question_1', type: 'input_text' }] }] });
    expect(out.map((q) => q.id)).toEqual(['question_1']);
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
  it('does not swallow real questions as identity', () => {
    const qs = normalizeFormFields([
      { name: 'location', label: 'Location', tag: 'input', inputType: 'text', required: false },
      { name: 'employer', label: 'Name of your current employer', tag: 'input', inputType: 'text', required: false },
      { name: 'optin', label: 'Email me about future roles', tag: 'input', inputType: 'checkbox', required: false },
      { name: 'referrer_email', label: "Referrer's email", tag: 'input', inputType: 'email', required: false },
      { name: 'portfolio_file', label: 'Portfolio (PDF)', tag: 'input', inputType: 'file', required: false },
    ]);
    expect(qs.map((q) => q.type)).toEqual(['text', 'text', 'boolean', 'text', 'file']);
  });
  it('drops hidden/unnamed duplicates', () => {
    expect(normalizeFormFields([
      { name: 'a', label: 'A', tag: 'input', inputType: 'hidden', required: false },
      { name: 'b', label: 'B', tag: 'input', inputType: 'text', required: false },
      { name: 'b', label: 'B', tag: 'input', inputType: 'text', required: false },
    ]).map((q) => q.id)).toEqual(['b']);
  });
});

describe('normalizeFormFields (ATS cleanup)', () => {
  const f = (name: string, label: string, extra: Partial<RawField> = {}): RawField => ({ name, label, tag: 'input', inputType: 'text', required: false, ...extra });
  it('groups radios by name into one select with each input label as option', () => {
    const qs = normalizeFormFields([
      f('cards[x][field3]', 'Highest education?', { inputType: 'radio', required: true, optionLabel: 'High school' }),
      f('cards[x][field3]', 'Highest education?', { inputType: 'radio', required: true, optionLabel: 'Bachelor' }),
      f('other', 'Other question'),
    ]);
    expect(qs).toEqual([
      { id: 'cards[x][field3]', label: 'Highest education?', type: 'select', required: true, options: ['High school', 'Bachelor'] },
      { id: 'other', label: 'Other question', type: 'text', required: false },
    ]);
  });
  it('groups multiple checkboxes into a multiselect and keeps a lone checkbox boolean', () => {
    const qs = normalizeFormFields([
      f('langs', 'Languages', { inputType: 'checkbox', optionLabel: 'English' }),
      f('langs', 'Languages', { inputType: 'checkbox', optionLabel: 'Spanish' }),
      f('consent', 'I agree', { inputType: 'checkbox' }),
    ]);
    expect(qs.map((q) => [q.type, q.options])).toEqual([['multiselect', ['English', 'Spanish']], ['boolean', undefined]]);
  });
  it('drops unlabeled and raw-id fields', () => {
    expect(normalizeFormFields([
      f('cards[a][field0]', 'cards[a][field0]', { tag: 'textarea' }),
      f('3a4f61e5-718f-4e88-b2e3-0f4244ffe604', '3a4f61e5-718f-4e88-b2e3-0f4244ffe604'),
      f('q1', '3a4f61e5-718f-4e88-b2e3'),
      f('q2', 'urls[Github]'),
      f('q3', 'Real question?'),
    ]).map((q) => q.id)).toEqual(['q3']);
  });
  it('drops captcha, EEOC and other Ashby system fields but keeps name/email', () => {
    expect(normalizeFormFields([
      f('g-recaptcha-response', 'g-recaptcha-response', { tag: 'textarea' }),
      f('h-captcha-response', 'Captcha'),
      f('abc__systemfield_eeoc_gender', 'Gender', { inputType: 'radio', optionLabel: 'Male' }),
      f('race', 'Race'),
      f('eth', 'Ethnicity'),
      f('vet', 'Veteran Status'),
      f('dis', 'Disability status'),
      f('_systemfield_location', 'Location'),
      f('_systemfield_name', 'Name'),
      f('_systemfield_email', 'Email', { inputType: 'email' }),
      f('trace', 'Experience with traceability or embracing change?'),
    ]).map((q) => q.id)).toEqual(['_systemfield_name', '_systemfield_email', 'trace']);
  });
});

describe('looksUnlabeled', () => {
  it('flags labels equal to the id or shaped like raw ids', () => {
    expect(looksUnlabeled({ id: 'a1', label: 'a1' })).toBe(true);
    expect(looksUnlabeled({ id: 'x', label: 'cards[x][field0]' })).toBe(true);
    expect(looksUnlabeled({ id: 'x', label: '84467dbc-cb9f-41af-8f8e-7e88768f9f75' })).toBe(true);
    expect(looksUnlabeled({ id: 'x', label: 'Why us?' })).toBe(false);
  });
});

describe('COMMON_QUESTIONS', () => {
  it('covers motivation, authorization, sponsorship, salary, notice and location', () => {
    const labels = COMMON_QUESTIONS.map((q) => q.label).join(' | ');
    for (const w of ['Why', 'authorized', 'sponsorship', 'salary', 'notice', 'located']) expect(labels).toContain(w);
  });
});
