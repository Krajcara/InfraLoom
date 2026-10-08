import PortStrip from './PortStrip';

export const emptyGroup = () => ({ prefix: '', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G', poe: false, role: 'lan', connector: '' });

const countOf = (g) => {
  const a = Number(g.start_no), b = Number(g.end_no);
  return g.start_no !== '' && g.end_no !== '' && Number.isInteger(a) && Number.isInteger(b) && b >= a ? b - a + 1 : 0;
};
export const totalPorts = (groups) => groups.reduce((n, g) => n + countOf(g), 0);

/** The ports a set of groups would create, for the preview (the server does the real generation). */
export function expandGroups(groups) {
  const out = [];
  for (const g of groups) {
    for (let i = 0; i < countOf(g) && out.length < 600; i++) {
      out.push({ name: `${g.prefix || ''}${Number(g.start_no) + i}`, port_type: g.port_type, speed: g.speed, poe: g.poe, role: g.role, status: 'free' });
    }
  }
  return out;
}

/** Numbers go to the server as numbers, the rest as typed. */
export const groupsForApi = (groups) => groups.map((g) => ({ ...g, start_no: Number(g.start_no), end_no: Number(g.end_no) }));

export default function PortGroupsEditor({ groups, onChange, catalog, panel = false }) {
  const set = (i, patch) => onChange(groups.map((g, n) => (n === i ? { ...g, ...patch } : g)));
  const total = totalPorts(groups);
  return (
    <div className="cab-groups">
      <table className="table">
        <thead>
          <tr><th>Name (prefix)</th><th>From</th><th>To</th><th>Port type</th><th>Speed</th><th>PoE</th><th>Role</th><th>Connector</th><th>Count</th><th /></tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={i}>
              <td><input className="cab-in-prefix mono" value={g.prefix} maxLength={20} placeholder="Gi1/0/" onChange={(e) => set(i, { prefix: e.target.value })} aria-label="Port name prefix" /></td>
              <td><input className="cab-in-num" type="number" min="0" max="9999" value={g.start_no} onChange={(e) => set(i, { start_no: e.target.value })} aria-label="First port number" /></td>
              <td><input className="cab-in-num" type="number" min="0" max="9999" value={g.end_no} onChange={(e) => set(i, { end_no: e.target.value })} aria-label="Last port number" /></td>
              <td>
                <select value={g.port_type} onChange={(e) => set(i, { port_type: e.target.value })} aria-label="Port type">
                  {(catalog?.port_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </td>
              <td>
                <select value={g.speed || ''} onChange={(e) => set(i, { speed: e.target.value })} aria-label="Speed">
                  <option value="">—</option>
                  {(catalog?.speeds || []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td><label className="checkbox-row"><input type="checkbox" checked={!!g.poe} onChange={(e) => set(i, { poe: e.target.checked })} aria-label="PoE" /><span>PoE</span></label></td>
              <td>
                <select value={g.role || ''} onChange={(e) => set(i, { role: e.target.value })} aria-label="Role">
                  <option value="">—</option>
                  {(catalog?.port_roles || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </td>
              <td>
                <select value={g.connector || ''} onChange={(e) => set(i, { connector: e.target.value })} aria-label="Connector">
                  <option value="">—</option>
                  {(catalog?.connectors || []).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </td>
              <td className="mono">{countOf(g)}</td>
              <td><button type="button" className="btn-link danger" onClick={() => onChange(groups.filter((_, n) => n !== i))} title="Remove this group" aria-label="Remove group">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button type="button" className="cab-btn-ghost" onClick={() => onChange([...groups, { ...emptyGroup(), start_no: 1, end_no: 4 }])}>+ Add group</button>
        <span className="muted mono">{total} port{total === 1 ? '' : 's'} will be created</span>
      </div>
      {total > 0 && (
        <div className="cab-preview">
          <div className="muted">Front panel preview</div>
          <PortStrip ports={expandGroups(groups)} panel={panel} />
        </div>
      )}
    </div>
  );
}
