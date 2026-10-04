export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const UA = 'ai-autoapplier/0.1 (personal job search)';

export async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const text = await getText(url, init);
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}
