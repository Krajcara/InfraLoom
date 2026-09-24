import { useEffect, useState } from 'react';
import LiveClock from '../components/LiveClock';

const HV_LABELS = { proxmox: 'Proxmox infrastructure', esxi: 'ESXi infrastructure', hyperv: 'Hyper-V infrastructure' };

export default function TvDashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [disabled, setDisabled] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/status/public/dashboard');
        if (res.status === 404) {
          setDisabled(true);
          return;
        }
        if (!res.ok) throw new Error('Could not load dashboard');
        setData(await res.json());
        setUpdatedAt(new Date());
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

  const degradedCount = data ? data.summary.degraded + data.summary.down : 0;

  return (
    <div className="tv-shell">
      <div className="tv-header">
        <div>
          <h1>System status</h1>
          {updatedAt && <p className="tv-updated">Updated {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · auto-refresh every 30s</p>}
        </div>
        <LiveClock />
      </div>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          {degradedCount > 0 && (
            <div className="tv-alert-banner">
              <span className="tv-alert-dot" />
              {data.summary.down > 0 && `${data.summary.down} service${data.summary.down === 1 ? '' : 's'} down`}
              {data.summary.down > 0 && data.summary.degraded > 0 && ' · '}
              {data.summary.degraded > 0 && `${data.summary.degraded} service${data.summary.degraded === 1 ? '' : 's'} degraded`}
            </div>
          )}

          <div className="tv-summary-row">
            <SummaryTile label="Operational" value={data.summary.operational} tone="ok" />
            <SummaryTile label="Degraded" value={data.summary.degraded} tone="warn" />
            <SummaryTile label="Down" value={data.summary.down} tone="danger" />
            <SummaryTile label="Total" value={data.summary.total} tone="neutral" />
          </div>

          <div className="tv-two-col">
            <div className="tv-status-col">
              <CategoryCard title="Uptime monitors" countLabel={`${data.monitors.length} monitors`} items={data.monitors} />
              {data.routers.length > 0 && <CategoryCard title="Routers" countLabel={`${data.routers.length} router${data.routers.length === 1 ? '' : 's'}`} items={data.routers} />}
              {data.switches.length > 0 && <CategoryCard title="Switches" countLabel={`${data.switches.length} switch${data.switches.length === 1 ? 'es' : ''}`} items={data.switches} />}
              {data.access_points.length > 0 && <CategoryCard title="Access points" countLabel={`${data.access_points.length} AP${data.access_points.length === 1 ? '' : 's'}`} items={data.access_points} />}
              {data.dns_servers.length > 0 && <CategoryCard title="DNS servers" countLabel={`${data.dns_servers.length} server${data.dns_servers.length === 1 ? '' : 's'}`} items={data.dns_servers} />}
            </div>

            <div className="tv-status-col">
              <div className="tv-cat-card">
                <div className="tv-cat-header">
                  <span>Internet speed</span>
                  {data.last_speed_test && <span className="tv-badge-ok">Active</span>}
                </div>
                {data.last_speed_test ? (
                  <div className="tv-speed-row">
                    <div className="tv-speed-stat">
                      <div className="tv-speed-value">{Math.round(data.last_speed_test.download)}</div>
                      <div className="tv-speed-unit">↓ Download Mbps</div>
                    </div>
                    <div className="tv-speed-stat">
                      <div className="tv-speed-value">{Math.round(data.last_speed_test.upload)}</div>
                      <div className="tv-speed-unit">↑ Upload Mbps</div>
                    </div>
                    <div className="tv-speed-stat">
                      <div className="tv-speed-value">{Math.round(data.last_speed_test.ping)}</div>
                      <div className="tv-speed-unit">Ping ms</div>
                    </div>
                  </div>
                ) : (
                  <p className="tv-sub tv-list-empty">No test yet</p>
                )}
              </div>

              {['proxmox', 'esxi', 'hyperv'].map((type) =>
                data.hypervisors[type]?.length > 0 ? (
                  <div key={type} className="tv-cat-card">
                    <div className="tv-cat-header">
                      <span>{HV_LABELS[type]}</span>
                      <span className="tv-sub">{data.hypervisors[type].length} node{data.hypervisors[type].length === 1 ? '' : 's'}</span>
                    </div>
                    {data.hypervisors[type].map((n, i) => (
                      <div key={i} className="tv-list-row">
                        <span>
                          <span className={`tv-status-dot ${n.status === 'up' ? 'tv-status-up' : 'tv-status-down'}`} />
                          {n.name} <span className="tv-sub">{n.running}/{n.total} running</span>
                        </span>
                        <span className={n.status === 'up' ? 'tv-badge-ok' : 'tv-badge-danger'}>{n.status === 'up' ? 'Online' : 'Offline'}</span>
                      </div>
                    ))}
                  </div>
                ) : null
              )}

              <div className="tv-cat-card">
                <div className="tv-cat-header">
                  <span>Network devices</span>
                  <span className="tv-sub">{data.network_devices.total} devices</span>
                </div>
                <div className="tv-list-row">
                  <span>{data.network_devices.online}/{data.network_devices.total} online</span>
                  <span className={data.network_devices.online === data.network_devices.total ? 'tv-badge-ok' : 'tv-badge-warn'}>
                    {data.network_devices.online === data.network_devices.total ? 'All up' : 'Attention'}
                  </span>
                </div>
              </div>

              {(data.ssl_expiring.length > 0 || data.licences_expiring.length > 0) && (
                <div className="tv-cat-card">
                  <div className="tv-cat-header"><span>Expiring soon</span></div>
                  {data.ssl_expiring.map((s, i) => (
                    <div key={`ssl-${i}`} className="tv-list-row">
                      <span>{s.label} (SSL)</span>
                      <span className={s.ssl_days <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(s.ssl_days)}d</span>
                    </div>
                  ))}
                  {data.licences_expiring.map((l, i) => (
                    <div key={`lic-${i}`} className="tv-list-row">
                      <span>{l.vendor} — {l.licence_type}</span>
                      <span className={l.days_left <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(l.days_left)}d</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone }) {
  return (
    <div className={`tv-summary-tile tv-summary-${tone}`}>
      <div className="tv-summary-value">{value}</div>
      <div className="tv-summary-label">{label}</div>
    </div>
  );
}

function CategoryCard({ title, countLabel, items }) {
  const allUp = items.every((i) => i.status === 'up');
  return (
    <div className="tv-cat-card">
      <div className="tv-cat-header">
        <span>{title}</span>
        <span className="tv-sub">{countLabel}</span>
      </div>
      {items.length === 0 ? (
        <p className="tv-sub tv-list-empty">None configured</p>
      ) : items.length <= 6 ? (
        items.map((item, i) => (
          <div key={i} className="tv-list-row">
            <span>
              <span className={`tv-status-dot ${item.status === 'up' ? 'tv-status-up' : item.status === 'degraded' ? 'tv-status-warn' : 'tv-status-down'}`} />
              {item.name}{item.detail ? <span className="tv-sub"> · {item.detail}</span> : null}
            </span>
            <span className={item.status === 'up' ? 'tv-badge-ok' : item.status === 'degraded' ? 'tv-badge-warn' : 'tv-badge-danger'}>
              {item.status === 'up' ? 'Online' : item.status === 'degraded' ? 'Degraded' : 'Down'}
            </span>
          </div>
        ))
      ) : (
        <div className="tv-list-row">
          <span>
            <span className={`tv-status-dot ${allUp ? 'tv-status-up' : 'tv-status-warn'}`} />
            {items.filter((i) => i.status === 'up').length}/{items.length} online
          </span>
          <span className={allUp ? 'tv-badge-ok' : 'tv-badge-warn'}>{allUp ? 'All up' : 'Attention'}</span>
        </div>
      )}
    </div>
  );
}
