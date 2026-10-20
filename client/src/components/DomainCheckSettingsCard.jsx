import { useEffect, useState } from 'react';
import { api } from '../api';

/** Settings → Domain checks: which DNS servers the checks of a domain ask. */
export default function DomainCheckSettingsCard() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get('/dns/check-settings').then(setS).catch(() => {}); }, []);
  if (!s) return null;

  async function save(e) {
    e.preventDefault(); setSaving(true); setMsg(null);
    try {
      const d = await api.put('/dns/check-settings', { mode: s.mode, servers: s.servers });
      setS(d); setMsg({ type: 'success', text: 'Saved.' });
    } catch (err) { setMsg({ type: 'error', text: err.message }); } finally { setSaving(false); }
  }

  return (
    <section className="card" id="domain-check-settings">
      <h2>Domain checks</h2>
      <p className="muted">The checks of a domain — MX, SPF, DKIM and DMARC on the DNS page, and the DMARC record of a domain added by hand — ask these DNS servers. If your own DNS keeps a copy of a zone, it may lack records that exist outside (MX, DKIM, DMARC), and the check then shows the inside view; public servers show what Google or Microsoft see.</p>
      <form onSubmit={save}>
        <div className="form-row">
          <label>Ask
            <select value={s.mode} onChange={(e) => { setS({ ...s, mode: e.target.value }); setMsg(null); }} aria-label="DNS servers for the checks">
              <option value="public">Public DNS servers (1.1.1.1 and 8.8.8.8)</option>
              <option value="system">This server's own DNS (what it is set up to use)</option>
              <option value="custom">DNS servers I give</option>
            </select>
          </label>
          {s.mode === 'custom' && (
            <label className="cab-grow">Addresses (up to four, separated by commas)
              <input value={s.servers || ''} onChange={(e) => { setS({ ...s, servers: e.target.value }); setMsg(null); }} placeholder="9.9.9.9, 149.112.112.112" aria-label="DNS server addresses" autoComplete="off" />
            </label>
          )}
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
    </section>
  );
}
