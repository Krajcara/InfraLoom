import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';
import { formatUntil } from './MaintenanceBadge';

/** Strip across the top of every page while alerts are muted — muting is only safe if nobody forgets about it. */
export default function MaintenanceBanner() {
  const [windows, setWindows] = useState([]);

  const load = useCallback(() => {
    api.get('/maintenance/active').then((d) => setWindows(d.windows)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // windows start and expire by the clock, not by an event
    return () => clearInterval(t);
  }, [load]);
  useSocket({ 'maintenance:update': load });

  if (!windows.length) return null;
  const everything = windows.find((w) => w.target_type === 'all');
  const text = everything
    ? `Maintenance mode — ALL state-change alerts are muted until ${formatUntil(everything.ends_at)}`
    : `Alerts muted for maintenance: ${windows.map((w) => `${w.target_label} (until ${formatUntil(w.ends_at)})`).join(', ')}`;

  return (
    <div className="maintenance-banner" role="status">
      <span>🔧 {text}</span>
      <Link to="/maintenance" className="btn-link">Manage</Link>
    </div>
  );
}
