import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnswers, matchFixedAnswer, pickOption, answerValue } from '../src/answers';
import { findRoot } from '../src/root';
import type { FormQuestion } from '../src/apply/types';

const example = readFileSync(join(findRoot(), 'profile/answers.example.yaml'), 'utf8');
const a = parseAnswers(example);
const q = (label: string, extra: Partial<FormQuestion> = {}): FormQuestion => ({ id: 'x', label, type: 'text', required: true, ...extra });

describe('answers', () => {
  it('rejects anything but "No" for US work authorization', () => {
    expect(() => parseAnswers(example.replace('workAuthorizationUS: "No"', 'workAuthorizationUS: "Yes"'))).toThrow();
  });
  it('fails fast on missing required keys', () => {
    expect(() => parseAnswers('fullName: X')).toThrow();
  });
  it.each([
    ['Are you legally authorized to work in the United States?', 'workAuthorizationUS'],
    ['Will you now or in the future require sponsorship for a visa?', 'sponsorship'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['What are your salary expectations?', 'salaryExpectation'],
    ['What is your notice period?', 'noticePeriod'],
    ['What is your current country of residence?', 'country'],
    ['Which time zone are you in?', 'timezone'],
    ['How would you rate your English?', 'englishLevel'],
    ["What's the name you'd prefer us to use?", 'firstName'],
  ])('matches %s', (label, key) => {
    expect(matchFixedAnswer(q(label), a)?.key).toBe(key);
  });
  it('does not match free-text motivation questions', () => {
    expect(matchFixedAnswer(q('Why do you want to work at Acme?'), a)).toBeNull();
  });
  it('derives firstName from fullName', () => expect(answerValue(a, 'firstName')).toBe('Jane'));
  it('honors extraMatchers', () => {
    const b = parseAnswers(`${example}\nextraMatchers:\n  - { pattern: "hourly rate", key: salaryExpectation }\n`);
    expect(matchFixedAnswer(q('Desired hourly rate'), b)?.key).toBe('salaryExpectation');
  });
});

describe('pickOption', () => {
  it('matches exactly, case-insensitive', () => expect(pickOption('mexico', ['Canada', 'Mexico'])).toBe('Mexico'));
  it('matches by leading word for yes/no style answers', () => {
    expect(pickOption("No — I'm based in Mexico", ['Yes, H-1B', 'No'])).toBe('No');
  });
  it('returns null when nothing fits', () => expect(pickOption('Mexico', ['USA', 'Canada'])).toBeNull());
});
