import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const emptyForm = { app_name: '', app_id: '', client_secret: '', secret_expiry: '', assigned_to: '', project: '', notes: '' };

export default function EntraAppsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);

  const [apps, setApps] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [revealed, setRevealed] = useState({});

  async function load() {
    try {
      const data = await api.get(`/entra-apps?show_hidden=${showHidden}`);
      setApps(data.apps);
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

  function openEdit(a) {
    setForm({
      id: a.id, app_name: a.app_name, app_id: a.app_id || '', client_secret: '',
      secret_expiry: a.secret_expiry || '', assigned_to: a.assigned_to || '',
      project: a.project || '', notes: a.notes || '',
    });
  }

  async function save(e) {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/entra-apps/${form.id}`, form);
      } else {
        await api.post('/entra-apps', form);
      }
      setForm(null);
      flash('Saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(a) {
    if (!confirm(`Delete "${a.app_name}"?`)) return;
    try {
      await api.del(`/entra-apps/${a.id}`);
      flash('Deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleHidden(a) {
    try {
      await api.post(`/entra-apps/${a.id}/toggle-hidden`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reveal(a) {
    try {
      const data = await api.post(`/entra-apps/${a.id}/reveal`);
      setRevealed((prev) => ({ ...prev, [a.id]: data.secret }));
    } catch (err) {
      setError(err.message);
    }
  }

  function exportCsv() {
    window.open('/api/entra-apps/export.csv', '_blank');
  }

  return (
    <div className="page">
      <h1>Entra ID Apps</h1>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="filters">
        <label className="checkbox-label">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
        {canEdit && <button onClick={openCreate}>+ New app</button>}
        <button onClick={exportCsv}>Export CSV</button>
      </div>

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit app' : 'New app'}</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>
                App name
                <input value={form.app_name} onChange={(e) => setForm({ ...form, app_name: e.target.value })} required />
              </label>
              <label>
                Application (client) ID
                <input value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
              </label>
            </div>
            <div className="form-row">
              <label>
                Client secret
                <input
                  type="password"
                  value={form.client_secret}
                  onChange={(e) => setForm({ ...form, client_secret: e.target.value })}
                  placeholder={form.id ? 'unchanged' : ''}
                  autoComplete="new-password"
                  name="entra_secret_field"
                />
              </label>
              <label>
                Secret expiry
                <input type="date" value={form.secret_expiry} onChange={(e) => setForm({ ...form, secret_expiry: e.target.value })} />
              </label>
            </div>
            <div className="form-row">
              <label>
                Assigned to
                <input value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} />
              </label>
              <label>
                Project
                <input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} />
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
            <th>App name</th>
            <th>Application ID</th>
            <th>Secret expiry</th>
            <th>Assigned to</th>
            <th>Project</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className={a.hidden ? 'row-dimmed' : ''}>
              <td>{a.app_name}</td>
              <td className="mono">{a.app_id || '—'}</td>
              <td>
                {a.secret_expiry ? (
                  <span className={a.secret_status === 'expired' ? 'error' : a.secret_status === 'expiring' ? 'warning' : ''}>
                    {a.secret_expiry}
                  </span>
                ) : (
                  '—'
                )}
                {a.client_secret && (
                  <>
                    {' · '}
                    {revealed[a.id] ? (
                      <code>{revealed[a.id]}</code>
                    ) : (
                      <button className="btn-link" onClick={() => reveal(a)}>show secret</button>
                    )}
                  </>
                )}
              </td>
              <td>{a.assigned_to || '—'}</td>
              <td>{a.project || '—'}</td>
              <td className="actions">
                {canEdit && (
                  <>
                    <button className="btn-link" onClick={() => openEdit(a)}>Edit</button>
                    <button className="btn-link" onClick={() => toggleHidden(a)}>{a.hidden ? 'Unhide' : 'Hide'}</button>
                    <button className="btn-link danger" onClick={() => remove(a)}>Delete</button>
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
