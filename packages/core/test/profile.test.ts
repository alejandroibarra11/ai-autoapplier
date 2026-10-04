import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadProfile, renderProfileForPrompt, profileBullets, profileVocabulary } from '../src/profile';
import { findRoot } from '../src/root';

describe('profile', () => {
  it('parses the example and renders a prompt block', () => {
    const p = loadProfile(join(findRoot(), 'profile/profile.example.yaml'));
    const text = renderProfileForPrompt(p);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('Work authorization: Based in Mexico');
    expect(text).toContain('- Built X that did Y for Z users.');
    expect(text).toContain('ai: OpenAI API, RAG, Prompt engineering');
  });
});

describe('profile helpers', () => {
  it('gives stable bullet ids and a vocabulary', () => {
    const p = loadProfile(join(findRoot(), 'profile/profile.example.yaml'));
    expect(profileBullets(p)[0]).toEqual({ id: 'e0-b0', role: 'Senior Full Stack Developer', company: 'Example Co', text: 'Built X that did Y for Z users.' });
    expect(profileVocabulary(p)).toEqual(expect.arrayContaining(['openai api', 'react', 'python']));
  });
});
