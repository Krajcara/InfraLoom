import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const emptyForm = {
  vendor: '', licence_type: '', licence_count: 1, licence_used: 0,
  purchase_date: '', expiry_date: '', url: '', licence_username: '',
  licence_password: '', licence_mfa: false, notes: '',
};

export default function LicencesPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);

  const [licences, setLicences] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [form, setForm] = useState(null); // null = closed, {} = create, {...} = edit
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [revealed, setRevealed] = useState({});

  async function load() {
    try {
      const data = await api.get(`/licences?show_hidden=${showHidden}`);
      setLicences(data.licences);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  }

  function openCreate() {
    setForm({ ...emptyForm });
  }

  function openEdit(l) {
    setForm({
      id: l.id, vendor: l.vendor, licence_type: l.licence_type,
      licence_count: l.licence_count, licence_used: l.licence_used,
      purchase_date: l.purchase_date || '', expiry_date: l.expiry_date || '',
      url: l.url || '', licence_username: l.licence_username || '',
      licence_password: '', licence_mfa: !!l.licence_mfa, notes: l.notes || '',
    });
  }

  async function save(e) {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/licences/${form.id}`, form);
      } else {
        await api.post('/licences', form);
      }
      setForm(null);
      flash('Saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(l) {
    if (!confirm(`Delete "${l.vendor} — ${l.licence_type}"?`)) return;
    try {
      await api.del(`/licences/${l.id}`);
      flash('Deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleHidden(l) {
    try {
      await api.post(`/licences/${l.id}/toggle-hidden`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reveal(l) {
    try {
      const data = await api.post(`/licences/${l.id}/reveal-password`);
      setRevealed((prev) => ({ ...prev, [l.id]: data.password }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function renew(l) {
    const newDate = prompt(`New expiry date for "${l.vendor} — ${l.licence_type}" (YYYY-MM-DD):`, l.expiry_date || '');
    if (!newDate) return;
    try {
      await api.post(`/licences/${l.id}/renew`, { expiry_date: newDate });
      flash('Renewed.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1>Licences</h1>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="filters">
        <label className="checkbox-label">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
        {canEdit && <button onClick={openCreate}>+ New licence</button>}
      </div>

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit licence' : 'New licence'}</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>
                Vendor
                <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} required />
              </label>
              <label>
                Licence type
                <input value={form.licence_type} onChange={(e) => setForm({ ...form, licence_type: e.target.value })} required />
              </label>
              <label>
                Count
                <input type="number" min="1" value={form.licence_count} onChange={(e) => setForm({ ...form, licence_count: e.target.value })} />
              </label>
              <label>
                Used
                <input type="number" min="0" value={form.licence_used} onChange={(e) => setForm({ ...form, licence_used: e.target.value })} />
              </label>
            </div>
            <div className="form-row">
              <label>
                Purchase date
                <input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} />
              </label>
              <label>
                Expiry date
                <input type="date" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} />
              </label>
              <label>
                Portal URL
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://..." />
              </label>
            </div>
            <div className="form-row">
              <label>
                Account username
                <input value={form.licence_username} onChange={(e) => setForm({ ...form, licence_username: e.target.value })} autoComplete="off" name="licence_username_field" />
              </label>
              <label>
                Account password
                <input
                  type="password"
                  value={form.licence_password}
                  onChange={(e) => setForm({ ...form, licence_password: e.target.value })}
                  placeholder={form.id ? 'unchanged' : ''}
                  autoComplete="new-password"
                  name="licence_password_field"
                />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.licence_mfa} onChange={(e) => setForm({ ...form, licence_mfa: e.target.checked })} />
                MFA enabled
              </label>
            </div>
            <label>
              Notes
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </label>
            <div className="form-row">
              <button type="submit">Save</button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Type</th>
            <th>Count</th>
            <th>Used</th>
            <th>Expiry</th>
            <th>Account</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {licences.map((l) => (
            <tr key={l.id} className={l.hidden ? 'row-dimmed' : ''}>
              <td>{l.vendor}</td>
              <td>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.licence_type}</a> : l.licence_type}</td>
              <td>{l.licence_count}</td>
              <td>{l.licence_used}</td>
              <td>
                {l.expiry_date ? (
                  <span className={l.expiry_status === 'expired' ? 'error' : l.expiry_status === 'expiring' ? 'warning' : ''}>
                    {l.expiry_date}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {l.licence_username || '—'}
                {l.licence_password && (
                  <>
                    {' · '}
                    {revealed[l.id] ? (
                      <code>{revealed[l.id]}</code>
                    ) : (
                      <button className="btn-link" onClick={() => reveal(l)}>show password</button>
                    )}
                  </>
                )}
              </td>
              <td className="actions">
                {canEdit && (
                  <>
                    <button className="btn-link" onClick={() => openEdit(l)}>Edit</button>
                    <button className="btn-link" onClick={() => renew(l)}>Renew</button>
                    <button className="btn-link" onClick={() => toggleHidden(l)}>{l.hidden ? 'Unhide' : 'Hide'}</button>
                    <button className="btn-link danger" onClick={() => remove(l)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
