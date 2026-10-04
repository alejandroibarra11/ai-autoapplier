import type { LLMProvider } from './provider';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export function createProvider(name: 'anthropic' | 'openai'): LLMProvider {
  return name === 'anthropic' ? new AnthropicProvider() : new OpenAIProvider();
}
