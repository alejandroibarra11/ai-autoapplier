import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadProfile, renderProfileForPrompt } from '../src/profile';
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
