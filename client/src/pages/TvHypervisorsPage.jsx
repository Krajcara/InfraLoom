import { useEffect, useState } from 'react';
import LiveClock from '../components/LiveClock';
import LineChart from '../components/LineChart';
import Gauge from '../components/Gauge';

const TYPE_LABELS = { proxmox: 'Proxmox VE', hyperv: 'Hyper-V', esxi: 'VMware ESXi' };

function formatUptime(seconds) {
  if (!seconds) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days >= 7) return `${Math.floor(days / 7)} week`;
  return `${days}d ${hours}h`;
}

export default function TvHypervisorsPage() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
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
      try {
        const histRes = await fetch('/api/status/public/hypervisors/history?hours=3');
        if (histRes.ok) setHistory(await histRes.json());
      } catch {
        // charts are supplementary — a failed history fetch shouldn't block the rest of the page
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

  // Flatten every online node across every connection for the KPI/summary row.
  const allNodes = (data?.connections || []).filter((c) => !c.error).flatMap((c) => c.nodes.map((n) => ({ ...n, connType: c.type })));
  const onlineNodes = allNodes.filter((n) => n.online);
  const allGuests = onlineNodes.flatMap((n) => n.guests || []);
  const allStorages = onlineNodes.flatMap((n) => n.storages || []);
  const runningGuests = allGuests.filter((g) => g.status === 'running').length;
  const oldestUptime = onlineNodes.reduce((max, n) => Math.max(max, n.uptime_s || 0), 0);
  const avgOf = (arr, key) => {
    const vals = arr.map((x) => x[key]).filter((v) => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgCpu = avgOf(onlineNodes, 'cpu_pct');
  const avgRam = avgOf(onlineNodes, 'ram_pct');

  const cpuPoints = history?.points.map((p) => ({ value: p.cpu })) || [];
  const ramPoints = history?.points.map((p) => ({ value: p.mem })) || [];
  const diskPoints = history?.points.map((p) => ({ value: p.disk })) || [];

  return (
    <div className="tv-shell">
      <div className="tv-header">
        <h1>Hypervisors</h1>
        <LiveClock />
      </div>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          {/* KPI row */}
          <div className="tv-kpi-row">
            <div className="tv-kpi-tile tv-kpi-neutral">
              <div className="tv-kpi-label">Uptime</div>
              <div className="tv-kpi-value">{formatUptime(oldestUptime) || '—'}</div>
            </div>
            <div className={`tv-kpi-tile ${avgCpu === null ? 'tv-kpi-neutral' : avgCpu >= 90 ? 'tv-kpi-danger' : avgCpu >= 75 ? 'tv-kpi-warn' : 'tv-kpi-ok'}`}>
              <div className="tv-kpi-label">CPU Usage</div>
              <div className="tv-kpi-value">{avgCpu !== null ? `${Math.round(avgCpu)}%` : '—'}</div>
            </div>
            <div className={`tv-kpi-tile ${avgRam === null ? 'tv-kpi-neutral' : avgRam >= 90 ? 'tv-kpi-danger' : avgRam >= 75 ? 'tv-kpi-warn' : 'tv-kpi-ok'}`}>
              <div className="tv-kpi-label">RAM Usage</div>
              <div className="tv-kpi-value">{avgRam !== null ? `${Math.round(avgRam)}%` : '—'}</div>
            </div>
            <div className="tv-kpi-tile tv-kpi-neutral">
              <div className="tv-kpi-label">Connections</div>
              <div className="tv-kpi-value">{data.connections.length}</div>
            </div>
            <div className="tv-kpi-tile tv-kpi-neutral">
              <div className="tv-kpi-label">Nodes</div>
              <div className="tv-kpi-value">{allNodes.length}</div>
            </div>
            <div className="tv-kpi-tile tv-kpi-neutral">
              <div className="tv-kpi-label">VM Summary</div>
              <div className="tv-kpi-value">{runningGuests}/{allGuests.length}</div>
            </div>
            <div className="tv-kpi-tile tv-kpi-neutral">
              <div className="tv-kpi-label">Datastore Summary</div>
              <div className="tv-kpi-value">{allStorages.length}</div>
            </div>
          </div>

          {/* Historical charts */}
          <div className="tv-chart-row">
            <div className="tv-chart-card">
              <div className="tv-chart-title">Cluster CPU Usage %</div>
              <LineChart points={cpuPoints} color="#4ade80" />
            </div>
            <div className="tv-chart-card">
              <div className="tv-chart-title">Cluster RAM Usage %</div>
              <LineChart points={ramPoints} color="#60a5fa" />
            </div>
            <div className="tv-chart-card">
              <div className="tv-chart-title">Cluster Disk Usage %</div>
              <LineChart points={diskPoints} color="#facc15" />
            </div>
          </div>

          {/* Datastore gauges */}
          {allStorages.length > 0 && (
            <div className="tv-section">
              <div className="tv-section-title">Datastore Status</div>
              <div className="tv-gauge-row">
                {allStorages.map((s, i) => (
                  <Gauge key={i} label={s.name} pct={s.usage_pct} subLabel={s.used_gb && s.total_gb ? `${s.used_gb}/${s.total_gb} GB` : null} />
                ))}
              </div>
            </div>
          )}

          {/* Per-connection / per-node guest cards */}
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
        </>
      )}
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
