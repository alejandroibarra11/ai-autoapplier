import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCvHtml } from '../src/cv/render';
import { loadProfile } from '../src/profile';
import { parseAnswers } from '../src/answers';
import { findRoot } from '../src/root';

const root = findRoot();
const profile = loadProfile(join(root, 'profile/profile.example.yaml'));
const answers = parseAnswers(readFileSync(join(root, 'profile/answers.example.yaml'), 'utf8'));

describe('renderCvHtml', () => {
  it('renders header, contact, ordered skills and only selected bullets', () => {
    const html = renderCvHtml(profile, answers, { skillsOrder: ['backend', 'ai', 'frontend'], bulletIds: ['e0-b0'] });
    expect(html).toContain('Jane Doe');
    expect(html).toContain('jane@example.com');
    expect(html).toContain('https://github.com/example');
    expect(html.indexOf('Node.js')).toBeLessThan(html.indexOf('OpenAI API'));
    expect(html).toContain('Built X that did Y for Z users.');
    expect(html).toContain('Senior Full Stack Developer');
  });
  it('omits roles with no selected bullets and escapes html', () => {
    const p = { ...profile, name: 'A <b>&</b>', experience: [...profile.experience, { company: 'Other', role: 'Dev', start: '2020', end: '2021', highlights: ['x'] }] };
    const html = renderCvHtml(p, answers, { skillsOrder: [], bulletIds: ['e0-b0'] });
    expect(html).toContain('A &lt;b&gt;&amp;&lt;/b&gt;');
    expect(html).not.toContain('Other');
  });
  it('caps bullets per role at 6', () => {
    const p = { ...profile, experience: [{ ...profile.experience[0]!, highlights: Array.from({ length: 9 }, (_, i) => `bullet ${i}`) }] };
    const ids = Array.from({ length: 9 }, (_, i) => `e0-b${i}`);
    const html = renderCvHtml(p, answers, { skillsOrder: [], bulletIds: ids });
    expect((html.match(/<li>/g) ?? []).length).toBe(6);
  });
  it('renders a repeated bullet id only once', () => {
    const html = renderCvHtml(profile, answers, { skillsOrder: [], bulletIds: ['e0-b0', 'e0-b0', 'e0-b0'] });
    expect((html.match(/<li>/g) ?? []).length).toBe(1);
  });
});
