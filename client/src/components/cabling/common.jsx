import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../context/AuthContext';

let catalogPromise = null;

/** The value lists (device types, port types, speeds...) come from the server, once per page load. */
export function useCatalog() {
  const [catalog, setCatalog] = useState(null);
  useEffect(() => {
    catalogPromise = catalogPromise || api.get('/cabling/catalog');
    catalogPromise.then(setCatalog).catch(() => { catalogPromise = null; });
  }, []);
  return catalog;
}

export const labelOf = (list, value) => (list || []).find((x) => x.value === value)?.label ?? value ?? '—';

export function useCablingRights() {
  const { user } = useAuth();
  const role = user?.role;
  return { canEdit: ['superadmin', 'admin', 'operator'].includes(role), canDelete: ['superadmin', 'admin'].includes(role) };
}

/** Live state of the InfraLoom item a device is linked to. */
export function LiveBadge({ live }) {
  if (!live) return null;
  const map = { up: ['status-up', 'online'], down: ['status-down', 'down'], warn: ['status-degraded', 'attention'], unknown: ['', 'no data'], missing: ['', 'link broken'] };
  const [cls, label] = map[live.state] || ['', live.state];
  return (
    <span className={`status-badge ${cls}`} title="Live state from InfraLoom monitoring">
      {label}
      {live.alerts > 0 && ` · ${live.alerts} alert${live.alerts === 1 ? '' : 's'}`}
      {live.maintenance && ' · maintenance'}
    </span>
  );
}

/** "24 × RJ45 1G PoE · 4 × SFP+ 10G" */
export function portSummary(ports, catalog) {
  const groups = [];
  for (const p of ports) {
    const key = `${p.port_type}|${p.speed || ''}|${p.poe ? 1 : 0}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.count += 1; else groups.push({ key, count: 1, p });
  }
  return groups.map((g) => `${g.count} × ${labelOf(catalog?.port_types, g.p.port_type)}${g.p.speed ? ` ${g.p.speed}` : ''}${g.p.poe ? ' PoE' : ''}`).join(' · ');
}

export const errText = (e) => (e && e.message) || 'Something went wrong';
