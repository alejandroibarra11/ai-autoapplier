const HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOST = /^(\[::1\]|[^:[\]]+)(?::(\d{1,5}))?$/;

/**
 * Dashboard Host-header allowlist (blocks DNS rebinding): loopback hostnames only, on any port (the dashboard port is
 * whatever `next start -p` was given). A rebinding attacker controls the hostname, never a loopback one.
 */
export function isAllowedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const m = HOST.exec(host.toLowerCase());
  return !!m && HOSTNAMES.has(m[1]!);
}
