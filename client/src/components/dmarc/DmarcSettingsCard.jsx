import { useEffect, useState } from 'react';
import { api } from '../../api';

/** Settings → DMARC: the mailbox the reports arrive in, how it is read, and how long things are kept. */
export default function DmarcSettingsCard() {
  const [s, setS] = useState(null);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { api.get('/dmarc/settings').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const set = (k, v) => { setS({ ...s, [k]: v }); setDirty(true); setMsg(null); setTest(null); };

  async function save() {
    setSaving(true); setMsg(null); setTest(null);
    try {
      const body = { ...s };
      delete body.client_secret_set; delete body.graph_configured;
      if (secret) body.client_secret = secret;
      const d = await api.put('/dmarc/settings', body);
      setS(d); setSecret(''); setDirty(false);
      setMsg({ type: 'success', text: 'Saved. The menu and the dashboard card update after you reload the page.' });
    } catch (err) { setMsg({ type: 'error', text: err.message }); } finally { setSaving(false); }
  }

  async function runTest() {
    setTest({ busy: true });
    try {
      const r = await api.post('/dmarc/test-graph');
      setTest({ ok: true, text: r.sample ? `Connected. The newest message in the mailbox: “${r.sample.subject}”.` : 'Connected. The mailbox is empty so far.' });
    } catch (err) { setTest({ ok: false, text: err.message }); }
  }

  return (
    <section className="card" id="dmarc-settings">
      <h2>DMARC reports</h2>
      <p className="muted">Reads the aggregate reports that mail receivers send to a dedicated Microsoft 365 mailbox, and shows who sends mail in the name of your domains. Reports can also be imported by hand when the mailbox is not set up. See the README for the Microsoft 365 setup (app registration, access limited to that one mailbox).</p>
      <label className="checkbox-row"><input type="checkbox" checked={s.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>DMARC module enabled</span></label>
      <div className="form-row">
        <label>Tenant ID<input value={s.tenant_id} onChange={(e) => set('tenant_id', e.target.value)} placeholder="6f9e3d4c-…" autoComplete="off" /></label>
        <label>Client (application) ID<input value={s.client_id} onChange={(e) => set('client_id', e.target.value)} placeholder="6b84056d-…" autoComplete="off" /></label>
      </div>
      <div className="form-row">
        <label>Client secret
          <input type="password" value={secret} onChange={(e) => { setSecret(e.target.value); setDirty(true); setMsg(null); setTest(null); }} placeholder={s.client_secret_set ? '•••••••• saved — leave empty to keep it' : 'the secret value'} autoComplete="new-password" aria-label="Client secret" />
        </label>
        <label>Secret expires on
          <input type="date" value={s.secret_expires} onChange={(e) => set('secret_expires', e.target.value)} aria-label="Secret expiry date" />
        </label>
        <label>Mailbox<input value={s.mailbox} onChange={(e) => set('mailbox', e.target.value)} placeholder="dmarc@example.com" autoComplete="off" /></label>
      </div>
      <p className="muted">A reminder is sent 30 and 7 days before the secret expires, and when it has. The secret is stored encrypted with the rest of the database and is never shown again.</p>
      <div className="form-row">
        <label>Check every (minutes)<input type="number" min="5" max="1440" value={s.poll_minutes} onChange={(e) => set('poll_minutes', e.target.value)} className="cab-in-num" /></label>
        <label>First read goes back (days)<input type="number" min="1" max="365" value={s.initial_lookback_days} onChange={(e) => set('initial_lookback_days', e.target.value)} className="cab-in-num" /></label>
        <label>Keep reports (days)<input type="number" min="30" max="3650" value={s.retention_days} onChange={(e) => set('retention_days', e.target.value)} className="cab-in-num" /></label>
        <label>Keep original XML (days, 0 = as long as the report)<input type="number" min="0" max="3650" value={s.raw_xml_days} onChange={(e) => set('raw_xml_days', e.target.value)} className="cab-in-num" /></label>
      </div>
      <label>Trusted senders (approved the first time they are seen; comma-separated)
        <input value={s.trusted_groups} onChange={(e) => set('trusted_groups', e.target.value)} placeholder="Microsoft 365" />
      </label>
      <label className="checkbox-row"><input type="checkbox" checked={s.store_raw_xml} onChange={(e) => set('store_raw_xml', e.target.checked)} /><span>Keep the original XML of each report</span></label>
      <label className="checkbox-row"><input type="checkbox" checked={s.alert_new_sources} onChange={(e) => set('alert_new_sources', e.target.checked)} /><span>Notify about a new sender</span></label>
      <label className="checkbox-row"><input type="checkbox" checked={s.alert_overrides} onChange={(e) => set('alert_overrides', e.target.checked)} /><span>Also notify about failures the receiver let through (forwarding, mailing lists)</span></label>
      <div className="form-row">
        <button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button type="button" className="cab-btn-ghost" onClick={runTest} disabled={dirty || !s.graph_configured || test?.busy} title={dirty ? 'Save first' : !s.graph_configured ? 'Fill in tenant, client, secret and mailbox first' : ''}>{test?.busy ? 'Testing…' : 'Test connection'}</button>
      </div>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
      {test && !test.busy && <p className={test.ok ? 'success' : 'error'}>{test.text}</p>}
    </section>
  );
}
