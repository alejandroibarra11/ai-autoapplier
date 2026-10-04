import type { PageOpener } from '../browser';
import type { ApplyTarget, FormQuestion } from './types';
import { COMMON_QUESTIONS } from './common';
import { fetchGreenhouseQuestions } from './greenhouse-questions';
import { normalizeFormFields } from './form-fields';

function formUrl(t: ApplyTarget): string {
  if (t.kind === 'lever' && !/\/apply\/?$/.test(t.url)) return `${t.url.replace(/\/$/, '')}/apply`;
  if (t.kind === 'ashby' && !/\/application\/?$/.test(t.url)) return `${t.url.replace(/\/$/, '')}/application`;
  return t.url;
}

export async function extractQuestions(
  t: ApplyTarget, opener: PageOpener | null, fetchGh: typeof fetchGreenhouseQuestions = fetchGreenhouseQuestions,
): Promise<FormQuestion[]> {
  try {
    if (t.kind === 'greenhouse' && t.atsToken && t.atsJobId) return await fetchGh(t.atsToken, t.atsJobId);
    if ((t.kind === 'lever' || t.kind === 'ashby') && opener) {
      const qs = normalizeFormFields(await opener.readForm(formUrl(t)));
      if (qs.some((q) => q.type !== 'identity')) return qs;
    }
  } catch {
    // fall through to common questions
  }
  return COMMON_QUESTIONS;
}
