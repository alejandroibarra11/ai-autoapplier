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
