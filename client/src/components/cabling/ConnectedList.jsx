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
  if (!d.connected.length) return <p className="muted">Nothing is connected through this device yet.</p>;
  return (
    <div className="cab-connected">
      <p className="muted">
        {d.connected.length} device{d.connected.length === 1 ? '' : 's'} reached through it
        {d.offices.length > 0 && <> · offices: {d.offices.join(', ')}</>}
        {d.down > 0 && <strong className="cab-warn"> · {d.down} already down</strong>}
      </p>
      <table className="table">
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
      </table>
    </div>
  );
}
