import { Link } from 'react-router-dom';

/** "10:30" for today, "Mon 5 10:30" for another day. */
export function formatUntil(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Small badge shown next to something whose alerts are currently muted by a maintenance window. */
export default function MaintenanceBadge({ w }) {
  if (!w) return null;
  return (
    <span
      className="status-badge status-degraded"
      style={{ marginLeft: 8 }}
      title={w.reason ? `Maintenance: ${w.reason} — alerts muted` : 'Maintenance window active — alerts muted'}
    >
      Maintenance · until {formatUntil(w.ends_at)}
    </span>
  );
}

/** Opens the Maintenance page with the form already pointing at this target. */
export function MaintenanceLink({ type, id, table }) {
  const q = new URLSearchParams({ type, id: String(id) });
  if (table) q.set('table', table);
  return (
    <Link className="btn-link" to={`/maintenance?${q.toString()}`} title="Mute alerts for this while you work on it">
      Maintenance
    </Link>
  );
}
