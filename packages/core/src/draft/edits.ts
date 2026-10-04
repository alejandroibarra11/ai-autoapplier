import type { DraftAnswer, FormQuestion } from '../apply/types';
import { canonicalChoice } from './draft';

const invalidFlag = (label: string) => `invalid option for: ${label}`;

/** True when the answer to a question with options must be corrected by picking one of them. */
export function needsOptionFix(q: FormQuestion | undefined, answer: string, flags: string[]): boolean {
  if (!q?.options?.length) return false;
  return canonicalChoice(q, answer) !== answer || flags.includes(invalidFlag(q.label));
}

export interface DraftEditable { coverLetter: string; answers: DraftAnswer[]; questions: FormQuestion[]; flags: string[] }
export interface DraftEdits { coverLetter?: string; answers: Record<string, string | undefined> }

/**
 * Applies dashboard edits to a draft. Generated answers take any text; fixed answers (source
 * 'answers') only change when the question has options and the new value is one of them. A valid
 * choice clears the matching `invalid option for: <label>` flag; an invalid generated choice adds it.
 */
export function applyDraftEdits(d: DraftEditable, edits: DraftEdits): { coverLetter: string; answers: DraftAnswer[]; flags: string[] } {
  const fixedLabels = new Set<string>();
  const brokenLabels = new Set<string>();
  const answers = d.answers.map((a) => {
    const submitted = edits.answers[a.questionId];
    const q = d.questions.find((x) => x.id === a.questionId);
    const canon = q?.options?.length ? canonicalChoice(q, submitted ?? a.answer) : null;
    if (submitted === undefined) return a;
    if (a.source === 'answers') {
      if (canon === null) return a;
      fixedLabels.add(a.label);
      return { ...a, answer: canon };
    }
    if (canon !== null) fixedLabels.add(a.label); else if (q?.options?.length) brokenLabels.add(a.label);
    return { ...a, answer: canon ?? submitted };
  });
  const flags = d.flags.filter((f) => ![...fixedLabels].some((l) => f === invalidFlag(l)));
  for (const l of brokenLabels) if (!flags.includes(invalidFlag(l))) flags.push(invalidFlag(l));
  return { coverLetter: edits.coverLetter ?? d.coverLetter, answers, flags };
}
