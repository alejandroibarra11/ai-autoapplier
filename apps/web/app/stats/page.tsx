import { countBySource, countByStatus, spendByDay } from '@autoapplier/core';
import { getDb } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default function Stats() {
  const db = getDb();
  if (!db) return <p>No database yet.</p>;
  const byStatus = countByStatus(db);
  const bySource = countBySource(db);
  const spend = spendByDay(db);
  const total = spend.reduce((a, d) => a + d.costUsd, 0);
  return (
    <>
      <div className="card"><h3>By status</h3><table><tbody>{byStatus.map((r) => <tr key={r.status}><td>{r.status}</td><td>{r.count}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>By source</h3><table><tbody>{bySource.map((r) => <tr key={r.source}><td>{r.source}</td><td>{r.count}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>LLM spend (last {spend.length} days: ${total.toFixed(2)})</h3>
        <table><tbody>{spend.map((d) => <tr key={d.day}><td>{d.day}</td><td>${d.costUsd.toFixed(3)}</td></tr>)}</tbody></table></div>
    </>
  );
}
