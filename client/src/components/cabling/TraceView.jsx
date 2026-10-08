import { labelOf } from './common';

const KIND_LABEL = { patch: 'Patch cord', permanent: 'Permanent installation', installation: 'Permanent installation' };

function edgeText(e) {
  const parts = [KIND_LABEL[e.type === 'installation' ? 'installation' : e.kind] || 'Cable'];
  if (e.cable_type) parts.push(e.cable_type);
  if (e.length_m) parts.push(`${e.length_m} m`);
  if (e.color && e.type === 'link') parts.push(e.color);
  return parts.join(' · ');
}

function NodeCard({ n, catalog }) {
  if (n.type === 'outlet') {
    return (
      <div className="cab-tnode cab-tnode--outlet">
        <div className="mono cab-tnode-title">Outlet {n.label || '—'}</div>
        <div className="muted">{n.office_name || 'no office set'}</div>
      </div>
    );
  }
  const where = n.room_name ? `${n.room_name}${n.rack_name ? ` · rack ${n.rack_name}` : ''}` : n.office_name ? n.office_name : null;
  const sub = n.panel
    ? where
    : [labelOf(catalog?.device_types, n.device_type), n.port_type ? labelOf(catalog?.port_types, n.port_type) : null, n.speed, n.poe ? 'PoE' : null, !n.room_name && n.office_name ? n.office_name : null].filter(Boolean).join(' · ');
  return (
    <div className={`cab-tnode${n.is_start ? ' cab-tnode--start' : ''}`}>
      <div className="mono cab-tnode-title">{n.device_name || '?'} · {n.panel ? `port ${n.port_name}` : n.port_name}</div>
      <div className="muted">{sub || labelOf(catalog?.device_types, n.device_type)}</div>
    </div>
  );
}

const END_NOTE = { open: 'No cable on this side', loop: 'The cabling loops back on itself here', truncated: 'The chain is too long — cut off here' };

/** The trace of a port as a vertical chain: devices and panels as cards, cables as labelled connectors. */
export default function TraceView({ trace, catalog }) {
  if (!trace) return <p className="muted">Reading the trace...</p>;
  const first = trace.ends[0], last = trace.ends[1];
  return (
    <div className="cab-trace">
      {END_NOTE[first] && trace.steps.length > 1 && <div className="cab-tend muted">{END_NOTE[first]}</div>}
      {trace.steps.map((s, i) => (
        s.type === 'port' || s.type === 'outlet'
          ? <NodeCard key={i} n={s} catalog={catalog} />
          : (
            <div key={i} className={`cab-tedge cab-tedge--${s.type === 'installation' || s.kind === 'permanent' ? 'dashed' : 'solid'}`}>
              <span>{edgeText(s)}{s.trunk && ` · trunk ${s.trunk.name}${s.strands ? `, strands ${s.strands}` : ''}`}</span>
            </div>
          )
      ))}
      {END_NOTE[last] && <div className="cab-tend muted">{trace.steps.length === 1 ? 'Not connected' : END_NOTE[last]}</div>}
    </div>
  );
}
