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
        <div className="tv-grid">
          <TvCard title="Uptime Monitor" status={data.monitors.up === data.monitors.total ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.monitors.up}/{data.monitors.total}</div>
            <div className="tv-sub">monitors up</div>
          </TvCard>

          <TvCard title="Hypervisors" status={data.hypervisors.vms_running > 0 || data.hypervisors.vms_total === 0 ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.hypervisors.vms_running}/{data.hypervisors.vms_total}</div>
            <div className="tv-sub">guests running · {data.hypervisors.connections} connection(s)</div>
          </TvCard>

          <TvCard title="Routers" status={data.routers.online === data.routers.total ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.routers.online}/{data.routers.total}</div>
            <div className="tv-sub">online</div>
          </TvCard>

          <TvCard title="Switches" status={data.switches.online === data.switches.total ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.switches.online}/{data.switches.total}</div>
            <div className="tv-sub">online</div>
          </TvCard>

          <TvCard title="Access Points" status={data.access_points.online === data.access_points.total ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.access_points.online}/{data.access_points.total}</div>
            <div className="tv-sub">online</div>
          </TvCard>

          <TvCard title="Network Devices" status={data.network_devices.online === data.network_devices.total ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.network_devices.online}/{data.network_devices.total}</div>
            <div className="tv-sub">online</div>
          </TvCard>

          <TvCard title="DNS Servers" status="up">
            <div className="tv-big-number">{data.dns_configured}</div>
            <div className="tv-sub">configured</div>
          </TvCard>

          <TvCard title="Net Speed" status="up">
            {data.last_speed_test ? (
              <>
                <div className="tv-big-number">{Math.round(data.last_speed_test.download)} <span className="tv-unit">Mbps</span></div>
                <div className="tv-sub">↑ {Math.round(data.last_speed_test.upload)} Mbps · {Math.round(data.last_speed_test.ping)} ms</div>
              </>
            ) : (
              <div className="tv-sub">No test yet</div>
            )}
          </TvCard>

          <TvCard title="Pending Patches" status={data.pending_patches === 0 ? 'up' : 'warn'}>
            <div className="tv-big-number">{data.pending_patches}</div>
            <div className="tv-sub">awaiting approval</div>
          </TvCard>

          <TvCard title="SSL Expiring" status={data.ssl_expiring.length === 0 ? 'up' : 'warn'} wide>
            {data.ssl_expiring.length === 0 ? (
              <div className="tv-sub">Nothing expiring soon</div>
            ) : (
              data.ssl_expiring.map((s, i) => (
                <div key={i} className="tv-list-row">
                  <span>{s.label}</span>
                  <span className={s.ssl_days <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(s.ssl_days)}d</span>
                </div>
              ))
            )}
          </TvCard>

          <TvCard title="Licences Expiring" status={data.licences_expiring.length === 0 ? 'up' : 'warn'} wide>
            {data.licences_expiring.length === 0 ? (
              <div className="tv-sub">Nothing expiring soon</div>
            ) : (
              data.licences_expiring.map((l, i) => (
                <div key={i} className="tv-list-row">
                  <span>{l.vendor} — {l.licence_type}</span>
                  <span className={l.days_left <= 3 ? 'tv-badge-danger' : 'tv-badge-warn'}>{Math.round(l.days_left)}d</span>
                </div>
              ))
            )}
          </TvCard>
        </div>
      )}
    </div>
  );
}

function TvCard({ title, status, children, wide }) {
  return (
    <div className={`tv-card tv-card-${status}${wide ? ' tv-card-wide' : ''}`}>
      <div className="tv-card-title">{title}</div>
      <div className="tv-card-body">{children}</div>
    </div>
  );
}
