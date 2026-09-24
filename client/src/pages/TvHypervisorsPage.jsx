import { useEffect, useState } from 'react';
import LiveClock from '../components/LiveClock';

export default function TvHypervisorsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/status/public/hypervisors');
        if (!res.ok) throw new Error('Could not load hypervisors');
        setData(await res.json());
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="tv-shell">
      <div className="tv-header">
        <h1>Hypervisors</h1>
        <LiveClock />
      </div>

      {error && <p className="error">{error}</p>}

      {data && (
        <div className="tv-hv-list">
          {data.connections.length === 0 && <p className="tv-sub">No hypervisor connections configured.</p>}
          {data.connections.map((conn, i) => (
            <div key={i} className="tv-hv-connection">
              <div className="tv-hv-connection-header">
                <span className="tv-hv-connection-name">{conn.name}</span>
                <span className="tv-hv-connection-type">{conn.type}</span>
              </div>

              {conn.error ? (
                <p className="tv-badge-danger">Unreachable</p>
              ) : (
                <div className="tv-hv-nodes">
                  {conn.nodes.map((n, j) => (
                    <div key={j} className={`tv-hv-node${n.online ? '' : ' tv-hv-node-offline'}`}>
                      <div className="tv-hv-node-top">
                        <span className={`tv-status-dot ${n.online ? 'tv-status-up' : 'tv-status-down'}`} />
                        <span className="tv-hv-node-name">{n.node}</span>
                        <span className="tv-sub">{n.vms_running}/{n.vms_total} running</span>
                      </div>
                      {n.online && (
                        <div className="tv-usage-row">
                          <UsageBar label="CPU" pct={n.cpu_pct} />
                          <UsageBar label="RAM" pct={n.ram_pct} />
                          <UsageBar label="Disk" pct={n.disk_pct} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsageBar({ label, pct }) {
  if (pct === null || pct === undefined) return (
    <div className="tv-usage-bar-wrap">
      <span className="tv-usage-label">{label}</span>
      <span className="tv-sub">—</span>
    </div>
  );
  const level = pct >= 90 ? 'tv-usage-danger' : pct >= 75 ? 'tv-usage-warn' : 'tv-usage-ok';
  return (
    <div className="tv-usage-bar-wrap">
      <span className="tv-usage-label">{label}</span>
      <div className="tv-usage-bar-track">
        <div className={`tv-usage-bar-fill ${level}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="tv-usage-pct">{Math.round(pct)}%</span>
    </div>
  );
}
