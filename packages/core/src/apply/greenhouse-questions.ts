import type { FormQuestion, QuestionType } from './types';
import { getJson } from '../http';

const IDENTITY = new Set(['first_name', 'last_name', 'email', 'phone', 'resume', 'resume_text', 'cover_letter', 'cover_letter_text']);

interface GhField { name: string; type: string; values?: { label: string; value: unknown }[] }
interface GhQuestion { label: string; required?: boolean; fields: GhField[] }

function ghType(f: GhField): QuestionType {
  if (IDENTITY.has(f.name) || f.type === 'input_file') return 'identity';
  if (f.type === 'textarea') return 'textarea';
  if (f.type === 'multi_value_single_select') return 'select';
  if (f.type === 'multi_value_multi_select') return 'multiselect';
  return 'text';
}

export function parseGreenhouseQuestions(raw: unknown): FormQuestion[] {
  const qs = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) throw new Error('greenhouse questions: unexpected response shape');
  return (qs as GhQuestion[]).map((q) => {
    const f = q.fields[0]!;
    const type = q.fields.some((x) => IDENTITY.has(x.name)) ? 'identity' : ghType(f);
    const options = f.values?.length ? f.values.map((v) => v.label) : undefined;
    return { id: f.name, label: q.label.trim(), type, required: !!q.required, ...(options ? { options } : {}) };
  });
}

export async function fetchGreenhouseQuestions(token: string, jobId: string): Promise<FormQuestion[]> {
  return parseGreenhouseQuestions(await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?questions=true`));
}
