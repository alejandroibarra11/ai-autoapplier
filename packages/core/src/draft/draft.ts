import type { JobRow } from '../db/repo';
import type { Profile } from '../profile';
import { profileBullets, profileVocabulary } from '../profile';
import type { Answers } from '../answers';
import { matchFixedAnswer, pickOption } from '../answers';
import type { CvSelection, DraftAnswer, FormQuestion } from '../apply/types';
import { LLMParseError, type LLMProvider, type LLMUsage } from '../llm/provider';
import { jobContextText } from '../score/prompt';
import { DraftLLMSchema, type DraftLLMOutput } from './schema';
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

function validChoice(q: FormQuestion, answer: string): boolean {
  const opts = (q.options ?? []).map((o) => o.toLowerCase());
  const parts = q.type === 'multiselect' ? answer.split(';').map((s) => s.trim()) : [answer.trim()];
  return parts.length > 0 && parts.every((p) => opts.includes(p.toLowerCase()));
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
    if (isChoice(q) && !validChoice(q, a)) flags.push(`invalid option for: ${q.label}`);
    generated.push({ questionId: q.id, label: q.label, answer: a, source: 'generated' });
  }

  const vocab = profileVocabulary(ctx.profile);
  const profileText = JSON.stringify(ctx.profile).toLowerCase();
  for (const s of out.claimedSkills) {
    const t = s.trim().toLowerCase();
    if (t && !vocab.includes(t) && !profileText.includes(t)) flags.push(`unverified claim: ${s.trim()}`);
  }

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
