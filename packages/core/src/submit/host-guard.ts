const HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const PORTS = ['3100', '3101'];
const ALLOWED = new Set(HOSTS.flatMap((h) => PORTS.map((p) => `${h}:${p}`)));

/** Dashboard Host-header allowlist (blocks DNS rebinding): loopback names on the dashboard ports only. */
export function isAllowedHost(host: string | null | undefined): boolean {
  return !!host && ALLOWED.has(host.toLowerCase());
}
