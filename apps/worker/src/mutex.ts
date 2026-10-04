/** Serialises async work: each call runs after every earlier call has settled (errors don't block the queue). */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}
