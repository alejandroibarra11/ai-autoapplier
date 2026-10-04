export function ago(d: Date): string {
  const h = Math.round((Date.now() - d.getTime()) / 3_600_000);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
