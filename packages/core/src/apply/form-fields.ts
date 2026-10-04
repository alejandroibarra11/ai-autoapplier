import type { FormQuestion, QuestionType } from './types';

export interface RawField {
  name: string; label: string; tag: 'input' | 'textarea' | 'select'; inputType?: string; required: boolean; options?: string[];
}

const IDENTITY_NAME = /^(name|full_?name|first_?name|last_?name|email|e-?mail|phone|phone_?number|resume|cv|cover_?letter)$/i;
const IDENTITY_LABEL = /^(full name|first name|last name|name|e-?mail( address)?|phone( number)?|resume|cv|resume\/cv|cover letter)$/i;

function isIdentity(f: RawField): boolean {
  const label = f.label.trim().replace(/[\s*:]+$/, '');
  return IDENTITY_NAME.test(f.name) || IDENTITY_LABEL.test(label);
}

function kind(f: RawField): QuestionType | null {
  const t = (f.inputType ?? '').toLowerCase();
  if (t === 'hidden' || t === 'submit' || t === 'button') return null;
  if (isIdentity(f)) return 'identity';
  if (t === 'file') return 'file';
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
