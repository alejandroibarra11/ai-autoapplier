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
}
export interface DraftResult { coverLetter: string; answers: DraftAnswer[]; cvSelection: CvSelection; flags: string[] }

const isChoice = (q: FormQuestion) => q.type === 'select' || q.type === 'multiselect' || (q.type === 'boolean' && !!q.options);

/** Canonical option text for a generated choice answer, or null when any part is not an option. */
function canonicalChoice(q: FormQuestion, answer: string): string | null {
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

/** True when the term is a profile skill/stack entry or appears as a whole word in the profile prose. */
export function profileSupports(profile: Profile, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (profileVocabulary(profile).includes(t)) return true;
  return termRegex(t).test(profileProse(profile));
}

async function callModel(ctx: DraftContext, toGenerate: FormQuestion[], fixed: DraftAnswer[]): Promise<DraftLLMOutput> {
  const req = {
    system: buildDraftSystem(ctx.profile),
    user: buildDraftUser(jobContextText(ctx.job), toGenerate, fixed),
    schema: DraftLLMSchema, schemaName: 'application_draft', maxTokens: 16000, effort: ctx.effort,
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
  out.claimedSkills.forEach(checkClaim);
  // Ambiguous terms (CASE_SENSITIVE_TERMS) match case-sensitively so ordinary words ("rust belt") do not trip the scan.
  const prose = [out.coverLetter, ...generated.map((g) => g.answer)].join('\n');
  for (const term of TECH_TERMS) if (termRegex(term, CASE_SENSITIVE_TERMS.has(term) ? '' : 'i').test(prose)) checkClaim(term);

  const bullets = profileBullets(ctx.profile);
  const known = new Set(bullets.map((b) => b.id));
  const unknown = out.bulletIds.filter((id) => !known.has(id));
  if (unknown.length) flags.push(`unknown CV bullet ids: ${unknown.join(', ')}`);
  let bulletIds = out.bulletIds.filter((id) => known.has(id));
  if (bulletIds.length === 0) bulletIds = bullets.map((b) => b.id);

  const groups = Object.keys(ctx.profile.skills);
  const skillsOrder = [...out.skillsOrder.filter((k) => groups.includes(k)), ...groups.filter((k) => !out.skillsOrder.includes(k))];

  const words = out.coverLetter.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_COVER_WORDS) flags.push(`cover letter too long: ${words} words`);

  const answers = [...fixed, ...generated].sort((a, b) =>
    ctx.questions.findIndex((q) => q.id === a.questionId) - ctx.questions.findIndex((q) => q.id === b.questionId));
  return { coverLetter: out.coverLetter.trim(), answers, cvSelection: { skillsOrder, bulletIds }, flags };
}
