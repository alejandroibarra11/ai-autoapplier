import type { FormQuestion, QuestionType } from './types';

export interface RawField {
  name: string; label: string; tag: 'input' | 'textarea' | 'select'; inputType?: string; required: boolean; options?: string[];
  /** Radio/checkbox: the input's own label (one choice); `label` is then the group question. */
  optionLabel?: string;
}

const RAW_ID = /^[0-9a-f-]{20,}$/i;
const BRACKETED = /\[.*\]/;
// EEOC/self-identification and anti-bot fields are never drafted.
const SENSITIVE = /captcha|eeoc|(?<![a-z])(gender|race|ethnicity|veterans?|disabilit(?:y|ies))(?![a-z])/i;
const ASHBY_SYSTEM = /^_systemfield_(?!name$|email$)/i;

/** True when a question has no human label (label is its id or looks like a raw field id). */
export function looksUnlabeled(q: { id: string; label: string }): boolean {
  const label = q.label.trim();
  return !label || label === q.id || RAW_ID.test(label) || BRACKETED.test(label);
}

function isSensitive(f: RawField): boolean {
  return SENSITIVE.test(f.name) || SENSITIVE.test(f.label) || ASHBY_SYSTEM.test(f.name);
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
  const groups = new Map<string, RawField[]>();
  for (const f of fields) {
    if (!f.name) continue;
    const g = groups.get(f.name);
    if (g) g.push(f); else groups.set(f.name, [f]);
  }
  const out: FormQuestion[] = [];
  for (const [name, group] of groups) {
    const f = group[0]!;
    const type = kind(f);
    if (!type || isSensitive(f)) continue;
    const label = (f.label || name).trim();
    if (type !== 'identity' && looksUnlabeled({ id: name, label })) continue;
    const t = (f.inputType ?? '').toLowerCase();
    const choices = (t === 'radio' || t === 'checkbox') ? group.map((g) => g.optionLabel?.trim()).filter((o): o is string => !!o) : [];
    if (type === 'boolean' && (t === 'radio' || choices.length > 1)) {
      out.push({ id: name, label, type: t === 'radio' ? 'select' : 'multiselect', required: group.some((g) => g.required), ...(choices.length ? { options: choices } : {}) });
      continue;
    }
    const options = f.options?.map((o) => o.trim()).filter(Boolean);
    out.push({ id: name, label, type, required: f.required, ...(options?.length ? { options } : {}) });
  }
  return out;
}
