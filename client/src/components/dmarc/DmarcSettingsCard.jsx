import { useEffect, useState } from 'react';
import { api } from '../../api';

/** Settings → DMARC: the mailbox the reports arrive in, how it is read, and how long things are kept. */
export default function DmarcSettingsCard() {
  const [s, setS] = useState(null);
  const [secret, setSecret] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [cfTest, setCfTest] = useState(null);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { api.get('/dmarc/settings').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const set = (k, v) => { setS({ ...s, [k]: v }); setDirty(true); setMsg(null); setTest(null); };

  async function save() {
    setSaving(true); setMsg(null); setTest(null); setCfTest(null);
    try {
      const body = { ...s };
      delete body.client_secret_set; delete body.graph_configured; delete body.cf_token_set; delete body.cf_configured;
      if (secret) body.client_secret = secret;
      if (cfToken) body.cf_token = cfToken;
      const d = await api.put('/dmarc/settings', body);
      setS(d); setSecret(''); setCfToken(''); setDirty(false);
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

  async function runCfTest() {
    setCfTest({ busy: true });
    try {
      const r = await api.post('/dmarc/test-cloudflare');
      setCfTest({ ok: true, text: `Connected. ${r.zones} zone${r.zones === 1 ? '' : 's'} can be read.` });
    } catch (err) { setCfTest({ ok: false, text: err.message }); }
  }

  async function removeCfToken() {
    if (!window.confirm('Remove the Cloudflare API token? The domains already listed stay, but they are no longer refreshed from Cloudflare.')) return;
    try { const d = await api.put('/dmarc/settings', { clear_cf_token: true }); setS(d); setCfTest(null); setMsg({ type: 'success', text: 'The Cloudflare token was removed.' }); } catch (err) { setMsg({ type: 'error', text: err.message }); }
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
      <h3 className="cab-h3">Domains from Cloudflare (optional)</h3>
      <p className="muted">The list of your domains, and the DMARC record of each, can be read from Cloudflare. Create an <strong>API token</strong> (My Profile → API Tokens) with <strong>Zone → Zone → Read</strong> and <strong>Zone → DNS → Read</strong> — read-only — limited to the zones you want. Without a token, domains are added by hand on the DMARC page and their records are looked up in public DNS.</p>
      <div className="form-row">
        <label>Cloudflare API token
          <input type="password" value={cfToken} onChange={(e) => { setCfToken(e.target.value); setDirty(true); setMsg(null); setCfTest(null); }} placeholder={s.cf_token_set ? '•••••••• saved — leave empty to keep it' : 'the token'} autoComplete="new-password" aria-label="Cloudflare API token" />
        </label>
        {s.cf_token_set && <button type="button" className="cab-btn-ghost" onClick={removeCfToken}>Remove the token</button>}
      </div>
      <label className="checkbox-row"><input type="checkbox" checked={s.cf_check_records} onChange={(e) => set('cf_check_records', e.target.checked)} /><span>Read the DMARC record of each zone through the Cloudflare API (needs Zone → DNS → Read)</span></label>
      <div className="form-row">
        <button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button type="button" className="cab-btn-ghost" onClick={runTest} disabled={dirty || !s.graph_configured || test?.busy} title={dirty ? 'Save first' : !s.graph_configured ? 'Fill in tenant, client, secret and mailbox first' : ''}>{test?.busy ? 'Testing…' : 'Test connection'}</button>
        <button type="button" className="cab-btn-ghost" onClick={runCfTest} disabled={dirty || !s.cf_configured || cfTest?.busy} title={dirty ? 'Save first' : !s.cf_configured ? 'Save a Cloudflare API token first' : ''}>{cfTest?.busy ? 'Testing…' : 'Test Cloudflare'}</button>
      </div>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
      {test && !test.busy && <p className={test.ok ? 'success' : 'error'}>{test.text}</p>}
      {cfTest && !cfTest.busy && <p className={cfTest.ok ? 'success' : 'error'}>{cfTest.text}</p>}
    </section>
  );
}
