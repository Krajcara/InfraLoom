import { useEffect, useState } from 'react';
import { api } from '../../api';

/** Settings → Cabling: switch the module off, or limit it to your own networks (the data is a map of the network). */
export default function CablingSettingsCard() {
  const [s, setS] = useState(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get('/cabling/settings').then((d) => { setS(d); setText(d.allowed_networks.join('\n')); }).catch(() => {}); }, []);
  if (!s) return null;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const list = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const d = await api.put('/cabling/settings', { enabled: s.enabled, allowed_networks: list });
      setS(d); setText(d.allowed_networks.join('\n'));
      setMsg({ type: 'success', text: 'Saved. The menu updates after you reload the page.' });
    } catch (err) { setMsg({ type: 'error', text: err.message }); } finally { setSaving(false); }
  }

  return (
    <section className="card">
      <h2>Cabling module</h2>
      <p className="muted">Technical rooms, devices, patch panels and wall outlets. The data is a map of your network, so you can switch the module off or limit it to your own networks.</p>
      <label className="checkbox-row"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /><span>Cabling module enabled</span></label>
      <label>Allowed networks (one per line or comma-separated; empty = everyone who can sign in)
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={'10.10.0.0/16\n192.168.1.15'} />
      </label>
      <p className="muted">You are connecting from <span className="mono">{s.your_ip}</span>. A list that does not include your own address is refused.</p>
      <div className="form-row"><button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></div>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
    </section>
  );
}
