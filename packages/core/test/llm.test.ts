import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicProvider } from '../src/llm/anthropic';
import { OpenAIProvider } from '../src/llm/openai';
import { LLMParseError, costUsd } from '../src/llm/provider';

const schema = z.object({ ok: z.boolean() });
const req = { system: 's', user: 'u', schema, schemaName: 'x', maxTokens: 100 };

describe('AnthropicProvider', () => {
  it('returns parsed data and usage', async () => {
    let sent: any;
    const fake = { messages: { parse: async (p: unknown) => { sent = p; return {
      parsed_output: { ok: true }, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }; } } };
    const p = new AnthropicProvider(fake as unknown as Anthropic);
    const r = await p.generateStructured('claude-haiku-4-5', req);
    expect(r).toEqual({ data: { ok: true }, usage: { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 5 } });
    expect(sent).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(sent.output_config.format).toBeDefined();
  });

  it('throws LLMParseError with usage when nothing parsed', async () => {
    const fake = { messages: { parse: async () => ({ parsed_output: null, stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }) } };
    const p = new AnthropicProvider(fake as unknown as Anthropic);
    const err = await p.generateStructured('m', req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMParseError);
    expect(err.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });
});

describe('OpenAIProvider', () => {
  it('returns parsed data and usage', async () => {
    const fake = { responses: { parse: async () => ({ output_parsed: { ok: false }, usage: { input_tokens: 7, output_tokens: 3 } }) } };
    const p = new OpenAIProvider(fake as unknown as OpenAI);
    const r = await p.generateStructured('gpt-5.6-luna', req);
    expect(r.data).toEqual({ ok: false });
    expect(r.usage).toEqual({ provider: 'openai', model: 'gpt-5.6-luna', inputTokens: 7, outputTokens: 3 });
  });

  it('throws LLMParseError when output_parsed is null', async () => {
    const fake = { responses: { parse: async () => ({ output_parsed: null, usage: { input_tokens: 1, output_tokens: 1 } }) } };
    await expect(new OpenAIProvider(fake as unknown as OpenAI).generateStructured('m', req)).rejects.toBeInstanceOf(LLMParseError);
  });
});

describe('costUsd', () => {
  it('prices known models and returns 0 for unknown', () => {
    const pricing = { 'claude-haiku-4-5': { input: 1, output: 5 } };
    expect(costUsd(pricing, { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 3000, outputTokens: 300 })).toBeCloseTo(0.0045);
    expect(costUsd(pricing, { provider: 'anthropic', model: 'nope', inputTokens: 3000, outputTokens: 300 })).toBe(0);
  });
});
