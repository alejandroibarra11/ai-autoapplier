import type { FormQuestion, QuestionType } from './types';

export interface RawField {
  name: string; label: string; tag: 'input' | 'textarea' | 'select'; inputType?: string; required: boolean; options?: string[];
}

const IDENTITY_NAME = /^(name|full_?name|first_?name|last_?name|email|phone|resume|cv|cover_?letter|location)$/i;
const IDENTITY_LABEL = /^(full name|first name|last name|name|e-?mail|phone|resume|cv|resume\/cv|cover letter)\b/i;

function kind(f: RawField): QuestionType | null {
  const t = (f.inputType ?? '').toLowerCase();
  if (t === 'hidden' || t === 'submit' || t === 'button') return null;
  if (t === 'file' || t === 'email' || t === 'tel' || IDENTITY_NAME.test(f.name) || IDENTITY_LABEL.test(f.label)) return 'identity';
  if (f.tag === 'textarea') return 'textarea';
  if (f.tag === 'select') return 'select';
  if (t === 'checkbox' || t === 'radio') return 'boolean';
  return 'text';
}

export function normalizeFormFields(fields: RawField[]): FormQuestion[] {
  const seen = new Set<string>();
  const out: FormQuestion[] = [];
  for (const f of fields) {
    const type = kind(f);
    if (!type || !f.name || seen.has(f.name)) continue;
    seen.add(f.name);
    const options = f.options?.map((o) => o.trim()).filter(Boolean);
    out.push({ id: f.name, label: (f.label || f.name).trim(), type, required: f.required, ...(options?.length ? { options } : {}) });
  }
  return out;
}
