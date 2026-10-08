import { Link } from 'react-router-dom';

const unitOf = (t) => (t.medium === 'fiber' ? 'strands' : 'pairs');

/** One run between two rooms: how it is built, which panels it joins, and how many strands are taken. */
export default function TrunkCard({ trunk, open, onToggle, rights, onEdit, onDelete }) {
  const used = new Set(trunk.strand_numbers || []);
  const pairs = new Set((trunk.links || []).map((l) => {
    const aFirst = l.room_a_id === trunk.room_a_id;
    return `${aFirst ? l.device_a_name : l.device_b_name} ↔ ${aFirst ? l.device_b_name : l.device_a_name}`;
  }));
  const kind = trunk.medium === 'fiber' ? `Fibre${trunk.fiber_type ? ` ${trunk.fiber_type}` : ''}` : 'Copper';
  const facts = [kind, `${trunk.strand_count} ${unitOf(trunk)}`, trunk.length_m ? `${trunk.length_m} m` : null, [...pairs].join(', ') || null].filter(Boolean).join(' · ');
  return (
    <div className="card cab-wide cab-trunk">
      <div className="cab-trunk-head">
        <div>
          <strong className="mono">
            <Link to={`/cabling/rooms/${trunk.room_a_id}`}>{trunk.room_a_name}</Link> ↔ <Link to={`/cabling/rooms/${trunk.room_b_id}`}>{trunk.room_b_name}</Link>
          </strong>
          <span className="muted"> · {trunk.name}</span>
          <div className="muted">{facts}</div>
        </div>
        <div className="cab-strands" title={`${trunk.used_strands} of ${trunk.strand_count} ${unitOf(trunk)} in use`}>
          {trunk.strand_count <= 48
            ? <div className="cab-strand-squares">{Array.from({ length: trunk.strand_count }, (_, i) => <i key={i} className={used.has(i + 1) ? 'on' : ''} />)}</div>
            : <div className="cab-strand-bar"><i style={{ width: `${(100 * trunk.used_strands) / trunk.strand_count}%` }} /></div>}
          <span className="mono">{trunk.used_strands}/{trunk.strand_count}</span>
        </div>
      </div>
      <div className="form-row">
        {onToggle && <button type="button" className="btn-link" onClick={onToggle}>{open ? 'Hide links' : `Links (${(trunk.links || []).length})`}</button>}
        {rights?.canEdit && onEdit && <button type="button" className="btn-link" onClick={onEdit}>Edit</button>}
        {rights?.canDelete && onDelete && <button type="button" className="btn-link danger" onClick={onDelete}>Delete</button>}
      </div>
      {open && (
        (trunk.links || []).length === 0
          ? <p className="muted">No panel is connected to this trunk yet. In the room view select a fibre-panel port, press Connect, choose rear, and pick the panel in the other room.</p>
          : (
            <table className="table">
              <thead><tr><th>{unitOf(trunk) === 'strands' ? 'Strands' : 'Pair'}</th><th>{trunk.room_a_name}</th><th>{trunk.room_b_name}</th><th>Cable</th></tr></thead>
              <tbody>
                {trunk.links.map((l) => {
                  const aFirst = l.room_a_id === trunk.room_a_id;
                  const left = aFirst ? [l.device_a_name, l.port_a_name] : [l.device_b_name, l.port_b_name];
                  const right = aFirst ? [l.device_b_name, l.port_b_name] : [l.device_a_name, l.port_a_name];
                  return (
                    <tr key={l.id}>
                      <td className="mono">{l.strands || '—'}</td>
                      <td className="mono">{left[0]} · {left[1]}</td><td className="mono">{right[0]} · {right[1]}</td>
                      <td>{[l.cable_type, l.length_m ? `${l.length_m} m` : null, l.color].filter(Boolean).join(' · ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
      )}
    </div>
  );
}
