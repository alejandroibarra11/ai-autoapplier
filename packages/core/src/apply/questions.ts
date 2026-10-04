import type { PageOpener } from '../browser';
import type { ApplyTarget, FormQuestion } from './types';
import { COMMON_QUESTIONS } from './common';
import { fetchGreenhouseQuestions } from './greenhouse-questions';
import { normalizeFormFields } from './form-fields';

function formUrl(t: ApplyTarget): string | null {
  if (!t.atsToken || !t.atsJobId) return null;
  if (t.kind === 'lever') return `https://jobs.lever.co/${t.atsToken}/${t.atsJobId}/apply`;
  if (t.kind === 'ashby') return `https://jobs.ashbyhq.com/${t.atsToken}/${t.atsJobId}/application`;
  return null;
}

export async function extractQuestions(
  t: ApplyTarget, opener: PageOpener | null, fetchGh: typeof fetchGreenhouseQuestions = fetchGreenhouseQuestions,
): Promise<FormQuestion[]> {
  try {
    if (t.kind === 'greenhouse' && t.atsToken && t.atsJobId) return await fetchGh(t.atsToken, t.atsJobId);
    const url = formUrl(t);
    if (url && opener) {
      const qs = normalizeFormFields(await opener.readForm(url));
      if (qs.some((q) => q.type !== 'identity')) return qs;
    }
  } catch {
    // fall through to common questions
  }
  return COMMON_QUESTIONS;
}
