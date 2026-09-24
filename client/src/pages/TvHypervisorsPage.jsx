import { useEffect, useState } from 'react';
import LiveClock from '../components/LiveClock';

const TYPE_LABELS = { proxmox: 'Proxmox VE', hyperv: 'Hyper-V', esxi: 'VMware ESXi' };

function formatUptime(seconds) {
  if (!seconds) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

export default function TvHypervisorsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/status/public/hypervisors');
        if (res.status === 404) {
          setDisabled(true);
          return;
        }
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

  if (disabled) {
    return (
      <div className="tv-shell">
        <p className="tv-sub">This page is currently disabled.</p>
      </div>
    );
  }

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
              {conn.error ? (
                <div className="tv-hv-connection-header">
                  <span className="tv-hv-connection-name">{conn.name}</span>
                  <span className="tv-hv-connection-type">{TYPE_LABELS[conn.type] || conn.type}</span>
                  <span className="tv-badge-danger">Unreachable</span>
                </div>
              ) : (
                conn.nodes.map((n, j) => (
                  <div key={j} className="tv-hv-node-section">
                    <div className="tv-hv-node-header">
                      <span className={`tv-status-dot ${n.online ? 'tv-status-up' : 'tv-status-down'}`} />
                      <span className="tv-hv-node-name">{n.node}</span>
                      <span className="tv-hv-connection-type">{TYPE_LABELS[conn.type] || conn.type}</span>
                      <span className="tv-sub">{n.online ? 'online' : 'offline'}{formatUptime(n.uptime_s) ? ` · ${formatUptime(n.uptime_s)}` : ''}</span>
                      {n.online && (
                        <div className="tv-hv-node-bars">
                          <MiniUsage label="CPU" pct={n.cpu_pct} extra={n.cpus ? `${n.cpus}c` : null} />
                          <MiniUsage label="RAM" pct={n.ram_pct} extra={n.mem_used_gb && n.mem_max_gb ? `${n.mem_used_gb}/${n.mem_max_gb}GB` : null} />
                          <MiniUsage label="Disk" pct={n.disk_pct} />
                        </div>
                      )}
                      {n.online && <span className="tv-sub tv-hv-running">{n.running_count}/{n.total_count} running</span>}
                    </div>

                    {n.online && n.guests.length > 0 && (
                      <div className="tv-guest-grid">
                        {n.guests.map((g) => (
                          <GuestCard key={`${g.type}-${g.vmid}`} guest={g} />
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniUsage({ label, pct, extra }) {
  if (pct === null || pct === undefined) return null;
  const level = pct >= 90 ? 'tv-usage-danger' : pct >= 75 ? 'tv-usage-warn' : 'tv-usage-ok';
  return (
    <div className="tv-mini-usage">
      <span className="tv-usage-label">{label}{extra ? ` (${extra})` : ''}</span>
      <div className="tv-usage-bar-track tv-usage-bar-track-mini">
        <div className={`tv-usage-bar-fill ${level}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="tv-usage-pct">{pct}%</span>
    </div>
  );
}

function GuestBar({ label, pct, extra }) {
  const value = pct ?? 0;
  const level = value >= 90 ? 'tv-usage-danger' : value >= 75 ? 'tv-usage-warn' : 'tv-usage-ok';
  return (
    <div className="tv-guest-bar-row">
      <span className="tv-guest-bar-label">{label}{extra ? ` ${extra}` : ''}</span>
      <div className="tv-guest-bar-track">
        <div className={`tv-guest-bar-fill ${level}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className="tv-guest-bar-pct">{value}%</span>
    </div>
  );
}

function GuestCard({ guest }) {
  const isRunning = guest.status === 'running';
  return (
    <div className={`tv-guest-card${isRunning ? '' : ' tv-guest-card-stopped'}`}>
      <div className="tv-guest-card-top">
        <span className={`tv-status-dot ${isRunning ? 'tv-status-up' : 'tv-status-off'}`} />
        <span className="tv-guest-name">{guest.name}</span>
        <span className={`tv-guest-type-badge tv-guest-type-${guest.type}`}>{guest.type === 'lxc' ? 'LXC' : 'VM'}</span>
        <span className="tv-sub">#{guest.vmid}</span>
      </div>
      {isRunning ? (
        <>
          <GuestBar label="CPU" pct={guest.cpu_pct} />
          <GuestBar label="MEM" pct={guest.mem_pct} extra={guest.mem_used_gb && guest.mem_max_gb ? `${guest.mem_used_gb}/${guest.mem_max_gb}GB` : null} />
          <GuestBar label="DSK" pct={guest.disk_pct} />
          <div className="tv-guest-footer">
            <span>{guest.os || '—'}</span>
            <span>{guest.ip || '—'}</span>
          </div>
        </>
      ) : (
        <div className="tv-guest-stopped-label">stopped</div>
      )}
    </div>
  );
}
