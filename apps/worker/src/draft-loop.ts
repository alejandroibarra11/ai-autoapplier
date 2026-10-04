export function createDraftLoop(deps: { run: () => Promise<void> }) {
  let busy = false;
  return {
    running: () => busy,
    async tick() {
      if (busy) return;
      busy = true;
      try { await deps.run(); } catch (e) { console.error('[draft] loop error', e); } finally { busy = false; }
    },
  };
}

export interface TickOutcome { drafted: number; failed: number; lastError?: string }

/**
 * Detects a drafting loop that keeps failing (3 consecutive ticks with failures and no drafts) and
 * returns a warning at most once per UTC day; null otherwise.
 */
export function createFailureWatch(threshold = 3) {
  let streak = 0;
  let warnedDay: string | null = null;
  return (r: TickOutcome, now = new Date()): string | null => {
    streak = r.failed > 0 && r.drafted === 0 ? streak + 1 : 0;
    const day = now.toISOString().slice(0, 10);
    if (streak < threshold || warnedDay === day) return null;
    warnedDay = day;
    return `⚠️ Drafting keeps failing: ${(r.lastError ?? 'unknown error').slice(0, 300)} — check the model id / API key / credits`;
  };
}
