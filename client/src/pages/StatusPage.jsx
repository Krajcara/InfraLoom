import { useEffect, useState } from 'react';

const STATUS_LABEL = { up: 'Operational', down: 'Down', degraded: 'Degraded', unknown: 'Pending' };

export default function StatusPage() {
  const [monitors, setMonitors] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/status/public');
        if (!res.ok) throw new Error('Could not load status');
        const data = await res.json();
        setMonitors(data.monitors);
      } catch (err) {
        setError(err.message);
      }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const allUp = monitors && monitors.every((m) => m.last_status === 'up');

  return (
    <div className="status-shell">
      <div className="status-card">
        <h1>InfraLoom Status</h1>
        {error && <p className="error">{error}</p>}
        {monitors && (
          <p className={allUp ? 'success status-summary' : 'warning status-summary'}>
            {allUp ? 'All systems operational' : 'Some systems are experiencing issues'}
          </p>
        )}
        <div className="status-list">
          {monitors?.map((m) => (
            <div key={m.id} className="status-row">
              <span>{m.label}</span>
              <span className={`status-badge status-${m.last_status}`}>{STATUS_LABEL[m.last_status] || m.last_status}</span>
            </div>
          ))}
          {monitors?.length === 0 && <p className="muted">No monitors configured yet.</p>}
        </div>
      </div>
      <footer className="auth-footer">Powered by Krajcara</footer>
    </div>
  );
}
