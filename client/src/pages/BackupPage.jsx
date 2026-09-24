import { useEffect, useState } from 'react';
import { Download, Trash2, RefreshCw, Play } from 'lucide-react';
import { api } from '../api';

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackupPage() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const d = await api.get('/backup');
      setBackups(d.backups);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createNow() {
    setCreating(true);
    setError(null);
    try {
      await api.post('/backup');
      setMessage('Backup created.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function remove(filename) {
    if (!confirm(`Delete backup "${filename}"? This cannot be undone.`)) return;
    try {
      await api.del(`/backup/${filename}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function download(filename) {
    window.location.href = `/api/backup/${filename}/download`;
  }

  return (
    <div className="page">
      <h1>Backup</h1>
      <p className="muted">
        Each backup is a ZIP containing your SQLCipher database and an encrypted copy of your <code>.env</code>{' '}
        (protected with <code>BACKUP_ENCRYPTION_PASSWORD</code> — keep that password somewhere separate from the
        backups themselves, since a backup file alone can't be decrypted without it).
      </p>

      <div className="filters">
        <button onClick={createNow} disabled={creating}>
          <Play size={14} /> {creating ? 'Creating...' : 'Create backup now'}
        </button>
        <button onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}

      <ScheduleSection />

      <section className="card">
        <h2>Backups</h2>
        <table className="table">
          <thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.filename}>
                <td className="mono">{b.filename}</td>
                <td className="muted">{formatSize(b.size)}</td>
                <td className="muted">{new Date(b.created_at).toLocaleString()}</td>
                <td className="actions">
                  <button className="icon-btn" title="Download" onClick={() => download(b.filename)}><Download size={15} /></button>
                  <button className="icon-btn" title="Delete" onClick={() => remove(b.filename)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {backups.length === 0 && !loading && <tr><td colSpan={4} className="muted">No backups yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ScheduleSection() {
  const [cron, setCron] = useState('');
  const [hours, setHours] = useState(3);
  const [retention, setRetention] = useState(14);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/backup/config/schedule').then((d) => {
      setCron(d.cron);
      setRetention(d.retention_count);
      const m = d.cron.match(/^0 (\d+) \* \* \*$/);
      if (m) setHours(parseInt(m[1], 10));
    });
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const newCron = `0 ${Math.min(Math.max(parseInt(hours, 10) || 3, 0), 23)} * * *`;
      await api.post('/backup/config/schedule', { cron: newCron, retention_count: retention });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Schedule</h2>
      <form onSubmit={save} autoComplete="off">
        {error && <p className="error">{error}</p>}
        <div className="form-row">
          <label>
            Run daily at (hour, 0-23)
            <input type="number" min="0" max="23" value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
          <label>
            Keep last N backups
            <input type="number" min="1" value={retention} onChange={(e) => setRetention(e.target.value)} />
          </label>
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </section>
  );
}
