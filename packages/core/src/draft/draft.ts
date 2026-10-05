import type { JobRow } from '../db/repo';
import type { Profile } from '../profile';
import { profileBullets, profileVocabulary } from '../profile';
import type { Answers } from '../answers';
import { matchFixedAnswer, pickOption } from '../answers';
import type { CvSelection, DraftAnswer, FormQuestion } from '../apply/types';
import { LLMParseError, type LLMProvider, type LLMUsage } from '../llm/provider';
import { jobContextText } from '../score/prompt';
import { DraftLLMSchema, type DraftLLMOutput } from './schema';
import { TECH_TERMS, CASE_SENSITIVE_TERMS } from './tech-terms';
import { buildDraftSystem, buildDraftUser } from './prompt';

export const MAX_COVER_WORDS = 260;
const BLOCKING = ['unverified claim', 'missing answer', 'invalid option'];
export const isBlockingFlag = (f: string): boolean => BLOCKING.some((p) => f.startsWith(p));

export interface DraftContext {
  provider: LLMProvider; model: string; effort: 'low' | 'medium' | 'high';
  profile: Profile; answers: Answers; job: JobRow; questions: FormQuestion[]; onUsage: (u: LLMUsage) => void;
  /** Fill-time mode: only the answers are wanted (no cover letter / CV picks), smaller token budget. */
  answersOnly?: boolean;
}
export interface DraftResult { coverLetter: string; answers: DraftAnswer[]; cvSelection: CvSelection; flags: string[] }

const isChoice = (q: FormQuestion) => q.type === 'select' || q.type === 'multiselect' || (q.type === 'boolean' && !!q.options);

/** Canonical option text for a generated choice answer, or null when any part is not an option. */
export function canonicalChoice(q: FormQuestion, answer: string): string | null {
  const opts = q.options ?? [];
  const parts = q.type === 'multiselect' ? answer.split(';').map((s) => s.trim()) : [answer.trim()];
  const mapped = parts.map((p) => opts.find((o) => o.toLowerCase() === p.toLowerCase()));
  if (mapped.length === 0 || mapped.some((m) => m === undefined)) return null;
  return mapped.join('; ');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRegex = (t: string, flags = 'i') => new RegExp(`(?<![a-zA-Z0-9+#.])${escapeRegExp(t)}(?![a-zA-Z0-9+#])`, flags);

function profileProse(p: Profile): string {
  return [p.headline, p.summary, ...p.experience.flatMap((e) => e.highlights), ...p.projects.flatMap((pr) => [pr.name, pr.summary])].join('\n');
}

/** A sentence stating a gap or a plan to learn something, e.g. "I haven't used Go professionally", "I'd ramp up on Rails". */
const GAP_SENTENCE = /\b(haven'?t|have not|hasn'?t|has not|never|not (yet )?(used|worked|written|built)|no (direct |professional |production |hands-on )?experience|don'?t have|do not have|lack|gaps?|ramp(ing)? up|get up to speed|pick(ing)? up|learn(ing)?|new to|unfamiliar|focused effort|aren'?t|isn'?t|not (proficient|familiar|part)|rather than|instead of)\b/i;

/** True when the term is (a whole-word part of) a profile skill/stack entry, or appears as a whole word in the profile prose. */
export function profileSupports(profile: Profile, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const vocab = profileVocabulary(profile);
  if (vocab.includes(t) || vocab.some((v) => termRegex(t).test(v))) return true; // "Google Cloud" ⊂ "Google Cloud Platform"
  return termRegex(t).test(profileProse(profile));
}

async function callModel(ctx: DraftContext, toGenerate: FormQuestion[], fixed: DraftAnswer[]): Promise<DraftLLMOutput> {
  const req = {
    system: buildDraftSystem(ctx.profile, { answersOnly: ctx.answersOnly }),
    user: buildDraftUser(jobContextText(ctx.job), toGenerate, fixed),
    schema: DraftLLMSchema, schemaName: 'application_draft', maxTokens: ctx.answersOnly ? 4000 : 16000, effort: ctx.effort,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, usage } = await ctx.provider.generateStructured(ctx.model, req);
      ctx.onUsage(usage);
      return data;
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMParseError) { if (e.usage) ctx.onUsage(e.usage); continue; }
      throw e;
    }
  }
  throw lastErr;
}

export async function draftJob(ctx: DraftContext): Promise<DraftResult> {
  const flags: string[] = [];
  const fixed: DraftAnswer[] = [];
  const toGenerate: FormQuestion[] = [];
  for (const q of ctx.questions) {
    if (q.type === 'identity' || q.type === 'file') continue;
    const m = matchFixedAnswer(q, ctx.answers);
    if (!m) { toGenerate.push(q); continue; }
    let answer = m.value;
    if (isChoice(q)) {
      const opt = pickOption(m.value, q.options ?? []);
      if (opt) answer = opt; else flags.push(`invalid option for: ${q.label}`);
    }
    fixed.push({ questionId: q.id, label: q.label, answer, source: 'answers' });
  }

  const out = await callModel(ctx, toGenerate, fixed);

  const generated: DraftAnswer[] = [];
  for (const q of toGenerate) {
    const a = out.answers.find((x) => x.questionId === q.id)?.answer?.trim() ?? '';
    if (!a) { if (q.required) flags.push(`missing answer: ${q.label}`); continue; }
    let answer = a;
    if (isChoice(q)) {
      const canon = canonicalChoice(q, a);
      if (canon === null) flags.push(`invalid option for: ${q.label}`); else answer = canon;
    }
    generated.push({ questionId: q.id, label: q.label, answer, source: 'generated' });
  }

  const flagged = new Set<string>();
  const checkClaim = (term: string) => {
    const t = term.trim();
    if (!t || flagged.has(t.toLowerCase()) || profileSupports(ctx.profile, t)) return;
    flagged.add(t.toLowerCase());
    flags.push(`unverified claim: ${t}`);
  };
  // In answersOnly mode the cover letter is discarded, so only the answers are scanned.
  const prose = [ctx.answersOnly ? '' : out.coverLetter, ...generated.map((g) => g.answer)].join('\n');
  // Sentences that state a gap or an intent to learn ("I haven't used Terraform") are honest, not claims: scan only the others.
  const sentences = prose.split(/(?<=[.!?])\s+|\n+/);
  const claims = sentences.filter((x) => !GAP_SENTENCE.test(x)).join('\n');
  const termRe = (term: string) => termRegex(term, CASE_SENSITIVE_TERMS.has(term) ? '' : 'i');
  // A listed skill named only in gap sentences is not a claim; one missing from the text entirely is still checked.
  out.claimedSkills.forEach((t) => { if (termRe(t.trim()).test(claims) || !termRe(t.trim()).test(prose)) checkClaim(t); });
  // Ambiguous terms (CASE_SENSITIVE_TERMS) match case-sensitively so ordinary words ("rust belt") do not trip the scan.
  for (const term of TECH_TERMS) if (termRe(term).test(claims)) checkClaim(term);

  const sortedAnswers = () => [...fixed, ...generated].sort((a, b) =>
    ctx.questions.findIndex((q) => q.id === a.questionId) - ctx.questions.findIndex((q) => q.id === b.questionId));
  if (ctx.answersOnly) return { coverLetter: '', answers: sortedAnswers(), cvSelection: { skillsOrder: [], bulletIds: [] }, flags };

  const bullets = profileBullets(ctx.profile);
  const known = new Set(bullets.map((b) => b.id));
  const unknown = out.bulletIds.filter((id) => !known.has(id));
  if (unknown.length) flags.push(`unknown CV bullet ids: ${unknown.join(', ')}`);
  let bulletIds = out.bulletIds.filter((id) => known.has(id));
  if (bulletIds.length === 0) bulletIds = bullets.map((b) => b.id);

  const groups = Object.keys(ctx.profile.skills);
  const skillsOrder = [...new Set([...out.skillsOrder.filter((k) => groups.includes(k)), ...groups])];

  const words = out.coverLetter.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_COVER_WORDS) flags.push(`cover letter too long: ${words} words`);

  return { coverLetter: out.coverLetter.trim(), answers: sortedAnswers(), cvSelection: { skillsOrder, bulletIds }, flags };
}

/**
 * Fill-time answers for required questions the draft lacks: the same prompt, validation and truthfulness checks as
 * draftJob (claimed skills, tech terms in the answers, options, missing required), but no cover letter or CV picks.
 */
export async function answerMissing(ctx: Omit<DraftContext, 'answersOnly'>): Promise<{ answers: DraftAnswer[]; flags: string[] }> {
  const r = await draftJob({ ...ctx, answersOnly: true });
  return { answers: r.answers, flags: r.flags };
}
