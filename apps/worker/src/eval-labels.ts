export type EvalLabel = 'eligible' | 'ineligible';
export interface EvalLabelRow { jobId: number; label: EvalLabel }
export interface ParsedEvalLabels { rows: EvalLabelRow[]; unlabeled: number; invalid: { line: number; reason: string }[] }

const LABELS: readonly string[] = ['eligible', 'ineligible'];

/** Parses data/eval/eligibility.jsonl. Rows with label null are unlabeled; anything else malformed is reported. */
export function parseEvalLabels(text: string): ParsedEvalLabels {
  const out: ParsedEvalLabels = { rows: [], unlabeled: 0, invalid: [] };
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let r: { jobId?: unknown; label?: unknown };
    try { r = JSON.parse(raw); } catch { out.invalid.push({ line, reason: 'invalid JSON' }); return; }
    if (typeof r !== 'object' || r === null) { out.invalid.push({ line, reason: 'invalid JSON object' }); return; }
    if (typeof r.jobId !== 'number' || !Number.isInteger(r.jobId)) { out.invalid.push({ line, reason: 'missing or non-integer jobId' }); return; }
    if (r.label === null || r.label === undefined) { out.unlabeled += 1; return; }
    if (typeof r.label !== 'string' || !LABELS.includes(r.label)) {
      out.invalid.push({ line, reason: `label must be "eligible" or "ineligible", got ${JSON.stringify(r.label)}` });
      return;
    }
    out.rows.push({ jobId: r.jobId, label: r.label as EvalLabel });
  });
  return out;
}
