import { useEffect, useState } from 'react';
import { api } from '../../api';
import { LiveBadge, errText, labelOf } from './common';

/** Everything that is reached through a device — what goes quiet if it does. */
export default function ConnectedList({ deviceId, catalog }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setD(null); setError(null); api.get(`/cabling/devices/${deviceId}/connected`).then(setD).catch((e) => setError(errText(e))); }, [deviceId]);
  if (error) return <p className="error">{error}</p>;
  if (!d) return <p className="muted">Reading...</p>;
  const outlets = d.outlets || [];
  if (!d.connected.length && !outlets.length) return <p className="muted">Nothing is connected through this device yet.</p>;
  // wall outlets reached, grouped by office; one without a device recorded behind it is still an outlet that goes quiet
  const byOffice = new Map();
  for (const o of outlets) { const k = o.office_name || 'no office set'; byOffice.set(k, [...(byOffice.get(k) || []), o]); }
  return (
    <div className="cab-connected">
      <p className="muted">
        {d.connected.length > 0 && <>{d.connected.length} device{d.connected.length === 1 ? '' : 's'} reached through it</>}
        {d.connected.length > 0 && outlets.length > 0 && ' · '}
        {outlets.length > 0 && <>{outlets.length} wall outlet{outlets.length === 1 ? '' : 's'} in {byOffice.size} office{byOffice.size === 1 ? '' : 's'}</>}
        {d.offices.length > 0 && <> · offices: {d.offices.join(', ')}</>}
        {d.down > 0 && <strong className="cab-warn"> · {d.down} already down</strong>}
      </p>
      {outlets.length > 0 && (
        <div className="cab-outlets">
          {[...byOffice.entries()].map(([office, list]) => (
            <div key={office}>
              <strong>{office}</strong>: <span className="mono">{list.map((o) => o.label || `port ${o.port}`).join(', ')}</span>
              {list.some((o) => !o.in_use) && <span className="muted"> · no device recorded on {list.filter((o) => !o.in_use).length} of {list.length}</span>}
            </div>
          ))}
        </div>
      )}
      {d.connected.length > 0 && <table className="table">
        <tbody>
          {d.connected.map((x) => (
            <tr key={x.device_id}>
              <td className="mono"><strong>{x.name}</strong></td>
              <td>{labelOf(catalog?.device_types, x.device_type)}</td>
              <td className="muted">{x.room_name || x.office_name || '—'}</td>
              <td className="muted mono">{x.via.map((v) => `${v.port}${v.outlet ? ` → ${v.outlet}` : ''}`).join(', ')}</td>
              <td><LiveBadge live={x.live} /></td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  );
}
