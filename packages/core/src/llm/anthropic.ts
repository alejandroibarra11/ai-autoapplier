import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LLMParseError, type LLMProvider, type LLMUsage, type StructuredRequest } from './provider';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }> {
    const res = await this.client.messages.parse({
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: zodOutputFormat(req.schema), ...(req.effort ? { effort: req.effort } : {}) },
    });
    const usage: LLMUsage = { provider: 'anthropic', model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (!res.parsed_output) throw new LLMParseError(`anthropic: no parsed output (stop_reason=${res.stop_reason})`, usage);
    return { data: res.parsed_output as T, usage };
  }
}
