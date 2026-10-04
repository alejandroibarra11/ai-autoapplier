import type { JobRow } from '../db/repo';
import type { LLMProvider, LLMUsage } from '../llm/provider';
import { LLMParseError } from '../llm/provider';
import { normalizeForMatch } from '../text';
import { ScoreSchema, type ScorePayload } from './schema';
import { buildScoringSystem, buildScoringUser, evidenceText, jobContextText } from './prompt';

const MIN_FRAGMENT = 6;

export function evidenceFound(evidence: string, text: string): boolean {
  const hay = normalizeForMatch(text);
  const cleaned = evidence.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  const fragments = cleaned.split(/\s*(?:\.\.\.|…)\s*/).map(normalizeForMatch).filter(Boolean);
  if (fragments.length === 0) return false;
  let pos = 0;
  for (const f of fragments) {
    if (f.length < MIN_FRAGMENT) return false;
    const i = hay.indexOf(f, pos);
    if (i < 0) return false;
    pos = i + f.length;
  }
  return true;
}

export function applyEvidenceCheck(s: ScorePayload, text: string): ScorePayload {
  if ((s.eligibility === 'eligible' || s.eligibility === 'likely') && !evidenceFound(s.eligibilityEvidence, text)) {
    return { ...s, eligibility: 'unlikely', redFlags: [...s.redFlags, 'eligibility evidence not found in posting'] };
  }
  return s;
}

export function decide(s: ScorePayload, threshold: number): 'awaiting_review' | 'ineligible' | 'low_score' {
  if (s.eligibility === 'ineligible' || s.eligibility === 'unlikely') return 'ineligible';
  return s.fitScore >= threshold ? 'awaiting_review' : 'low_score';
}

export async function scoreJob(
  provider: LLMProvider, model: string, profileText: string, job: JobRow, onUsage: (u: LLMUsage) => void,
): Promise<ScorePayload> {
  const context = jobContextText(job);
  const req = {
    system: buildScoringSystem(profileText), user: buildScoringUser(context),
    schema: ScoreSchema, schemaName: 'job_score', maxTokens: 2000,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, usage } = await provider.generateStructured(model, req);
      onUsage(usage);
      const clamped = { ...data, fitScore: Math.max(0, Math.min(100, Math.round(data.fitScore))) };
      return applyEvidenceCheck(clamped, evidenceText(job));
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMParseError) { if (e.usage) onUsage(e.usage); continue; }
      throw e;
    }
  }
  throw lastErr;
}
