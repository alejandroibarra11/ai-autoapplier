import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { LLMParseError, type LLMProvider, type LLMUsage, type StructuredRequest } from './provider';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  constructor(private readonly client: OpenAI = new OpenAI()) {}

  async generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }> {
    const res = await this.client.responses.parse({
      model,
      instructions: req.system,
      input: req.user,
      max_output_tokens: req.maxTokens,
      text: { format: zodTextFormat(req.schema, req.schemaName) },
    });
    const usage: LLMUsage = {
      provider: 'openai', model, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0,
    };
    if (!res.output_parsed) throw new LLMParseError('openai: no parsed output', usage);
    return { data: res.output_parsed as T, usage };
  }
}
