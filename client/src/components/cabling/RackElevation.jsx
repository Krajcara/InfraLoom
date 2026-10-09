import { Link } from 'react-router-dom';
import { labelOf } from './common';

const TYPE_CLASS = { switch: 'sw', router: 'rt', firewall: 'rt', hypervisor: 'sv', server: 'sv', nas: 'sv', patch_panel: 'pp', fiber_panel: 'fp', access_point: 'ap' };
const unitsOf = (d) => d.height_u || 1;

function Rack({ rack, devices, catalog, selectedId, onSelect, canEdit, roomId }) {
  const H = rack.height_u;
  const fits = (d) => d.rack_position >= 1 && d.rack_position + unitsOf(d) - 1 <= H;
  const placed = devices.filter((d) => d.rack_position && fits(d));
  const loose = devices.filter((d) => !d.rack_position || !fits(d));
  const taken = new Set();
  placed.forEach((d) => { for (let u = d.rack_position; u < d.rack_position + unitsOf(d); u++) taken.add(u); });
  const fromTop = !!rack.units_from_top;
  // the numbers are the ones printed on the rack: U1 at the bottom (the usual way) or at the top
  const units = Array.from({ length: H }, (_, i) => (fromTop ? i + 1 : H - i));
  const rowOf = (u) => (fromTop ? u : H - u + 1);

  return (
    <div className="cab-rackview">
      <div className="cab-rackview-title"><strong>{rack.name}</strong> <span className="muted">· {H} U · {taken.size} used{fromTop ? ' · U1 at the top' : ''}</span></div>
      <div className="cab-rackgrid" style={{ gridTemplateRows: `repeat(${H}, 24px)` }}>
        {units.map((u, i) => <div key={`l${u}`} className="cab-ulabel mono" style={{ gridColumn: 1, gridRow: i + 1 }}>{u}</div>)}
        {units.filter((u) => !taken.has(u)).map((u) => (
          <div key={`f${u}`} className="cab-uslot" style={{ gridColumn: 2, gridRow: rowOf(u) }}>
            {canEdit && <Link to={`/cabling/devices/new?room=${roomId}&rack=${rack.id}&u=${u}`} title={`Add a device at U${u}`} aria-label={`Add a device at U${u}`}>+</Link>}
          </div>
        ))}
        {placed.map((d) => {
          const top = d.rack_position + unitsOf(d) - 1;
          return (
            <button
              type="button" key={d.id} id={`cab-u-${d.id}`}
              className={`cab-udev cab-udev--${TYPE_CLASS[d.device_type] || 'ot'}${selectedId === d.id ? ' cab-udev--sel' : ''}`}
              style={{ gridColumn: 2, gridRow: `${fromTop ? d.rack_position : H - top + 1} / span ${unitsOf(d)}` }}
              onClick={() => onSelect(d)}
              title={`${d.name} · U${d.rack_position}${unitsOf(d) > 1 ? `–U${top}` : ''}`}
            >
              <i className={`cab-live cab-live--${['up', 'down', 'warn'].includes(d.live?.state) ? d.live.state : 'none'}`} />
              <span className="mono cab-udev-name">{d.name}</span>
              <span className="cab-udev-sub">{d.model || labelOf(catalog?.device_types, d.device_type)}</span>
            </button>
          );
        })}
      </div>
      {loose.length > 0 && (
        <div className="cab-loose muted">
          Without a place in this rack: {loose.map((d) => <button type="button" key={d.id} className="btn-link" onClick={() => onSelect(d)}>{d.name}</button>)}
        </div>
      )}
    </div>
  );
}

/** The front of every rack in the room, unit by unit, like standing in front of it. */
export default function RackElevation({ racks, devices, catalog, selectedId, onSelect, canEdit, roomId }) {
  if (!racks.length) return <p className="muted">This room has no rack yet.</p>;
  return (
    <div className="cab-racks">
      {racks.map((r) => <Rack key={r.id} rack={r} devices={devices.filter((d) => d.rack_id === r.id)} catalog={catalog} selectedId={selectedId} onSelect={onSelect} canEdit={canEdit} roomId={roomId} />)}
    </div>
  );
}
