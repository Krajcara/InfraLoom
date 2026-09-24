import { useEffect, useState } from 'react';
import LiveClock from '../components/LiveClock';

export default function TvDashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [disabled, setDisabled] = useState(false);

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
        <h1>InfraLoom</h1>
        <LiveClock />
      </div>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          {/* KPI row */}
          <div className="tv-kpi-row">
            <Kpi label="Monitors" value={`${data.monitors.up}/${data.monitors.total}`} ok={data.monitors.up === data.monitors.total} />
            <Kpi label="Hypervisor VMs" value={`${data.hypervisors.vms_running}/${data.hypervisors.vms_total}`} ok={data.hypervisors.vms_running > 0 || data.hypervisors.vms_total === 0} />
            <Kpi label="Routers" value={`${data.routers.online}/${data.routers.total}`} ok={data.routers.online === data.routers.total} />
            <Kpi label="Switches" value={`${data.switches.online}/${data.switches.total}`} ok={data.switches.online === data.switches.total} />
            <Kpi label="Access Points" value={`${data.access_points.online}/${data.access_points.total}`} ok={data.access_points.online === data.access_points.total} />
            <Kpi label="Network Devices" value={`${data.network_devices.online}/${data.network_devices.total}`} ok={data.network_devices.online === data.network_devices.total} />
            <Kpi label="DNS Servers" value={data.dns_configured} neutral />
            <Kpi label="Pending Patches" value={data.pending_patches} ok={data.pending_patches === 0} />
          </div>

          {/* Net Speed strip */}
          <div className="tv-chart-row">
            <div className="tv-chart-card tv-speed-card">
              <div className="tv-chart-title">Net Speed</div>
              {data.last_speed_test ? (
                <div className="tv-speed-row">
                  <div className="tv-speed-stat">
                    <div className="tv-speed-value">{Math.round(data.last_speed_test.download)}</div>
                    <div className="tv-speed-unit">Mbps down</div>
                  </div>
                  <div className="tv-speed-stat">
                    <div className="tv-speed-value">{Math.round(data.last_speed_test.upload)}</div>
                    <div className="tv-speed-unit">Mbps up</div>
                  </div>
                  <div className="tv-speed-stat">
                    <div className="tv-speed-value">{Math.round(data.last_speed_test.ping)}</div>
                    <div className="tv-speed-unit">ms ping</div>
                  </div>
                  <div className="tv-speed-provider">{data.last_speed_test.provider}</div>
                </div>
              ) : (
                <div className="tv-chart-empty">No test yet</div>
              )}
            </div>
          </div>

          {/* Expiring SSL / Licences */}
          <div className="tv-two-col">
            <div className="tv-section">
              <div className="tv-section-title">SSL Expiring</div>
              <div className="tv-list-card">
                {data.ssl_expiring.length === 0 ? (
                  <p className="tv-sub tv-list-empty">Nothing expiring soon</p>
                ) : (
                  data.ssl_expiring.map((s, i) => (
                    <div key={i} className="tv-list-row">
                      <span>{s.label}</span>
                      <span className={s.ssl_days <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(s.ssl_days)}d</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="tv-section">
              <div className="tv-section-title">Licences Expiring</div>
              <div className="tv-list-card">
                {data.licences_expiring.length === 0 ? (
                  <p className="tv-sub tv-list-empty">Nothing expiring soon</p>
                ) : (
                  data.licences_expiring.map((l, i) => (
                    <div key={i} className="tv-list-row">
                      <span>{l.vendor} — {l.licence_type}</span>
                      <span className={l.days_left <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(l.days_left)}d</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, ok, neutral }) {
  const cls = neutral ? 'tv-kpi-neutral' : ok ? 'tv-kpi-ok' : 'tv-kpi-warn';
  return (
    <div className={`tv-kpi-tile ${cls}`}>
      <div className="tv-kpi-label">{label}</div>
      <div className="tv-kpi-value">{value}</div>
    </div>
  );
}
