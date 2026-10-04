import type { z } from 'zod';
import type { Config } from '../config';

export interface LLMUsage { provider: 'anthropic' | 'openai'; model: string; inputTokens: number; outputTokens: number }

export interface StructuredRequest<T> {
  system: string; user: string; schema: z.ZodType<T>; schemaName: string; maxTokens: number;
}

export interface LLMProvider {
  readonly name: 'anthropic' | 'openai';
  generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }>;
}

export class LLMParseError extends Error {
  constructor(message: string, public readonly usage?: LLMUsage) { super(message); }
}

const warned = new Set<string>();
export function costUsd(pricing: Config['pricing'], usage: LLMUsage): number {
  const p = pricing[usage.model];
  if (!p) {
    if (!warned.has(usage.model)) { warned.add(usage.model); console.warn(`[llm] no pricing for model ${usage.model}; cost recorded as 0`); }
    return 0;
  }
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
