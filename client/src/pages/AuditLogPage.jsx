import { useEffect, useState } from 'react';
import { api } from '../api';

const LIMIT = 25;

export default function AuditLogPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [modules, setModules] = useState([]);
  const [filters, setFilters] = useState({ module: '', action: '', username: '', from: '', to: '' });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/audit-log/modules').then((d) => setModules(d.modules)).catch(() => {});
  }, []);

  async function load(targetPage = page) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: targetPage, limit: LIMIT });
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      const data = await api.get(`/audit-log?${params.toString()}`);
      setRows(data.rows);
      setTotal(data.total);
      setPage(data.page);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(e) {
    e.preventDefault();
    load(1);
  }

  function exportCsv() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    window.open(`/api/audit-log/export.csv?${params.toString()}`, '_blank');
  }

  const totalPages = Math.max(Math.ceil(total / LIMIT), 1);

  return (
    <div className="page">
      <h1>Audit Log</h1>
      {error && <p className="error">{error}</p>}

      <form className="filters" onSubmit={applyFilters}>
        <label>
          Module
          <select value={filters.module} onChange={(e) => setFilters({ ...filters, module: e.target.value })}>
            <option value="">All</option>
            {modules.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Action contains
          <input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="e.g. login" />
        </label>
        <label>
          Username contains
          <input value={filters.username} onChange={(e) => setFilters({ ...filters, username: e.target.value })} />
        </label>
        <label>
          From
          <input type="datetime-local" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="datetime-local" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Loading...' : 'Apply'}</button>
        <button type="button" onClick={exportCsv}>Export CSV</button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Module</th>
            <th>IP</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.created_at}</td>
              <td>{r.username || '—'}</td>
              <td>{r.action}</td>
              <td>{r.module || '—'}</td>
              <td className="mono">{r.ip_address || '—'}</td>
              <td className="truncate">{r.details || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pagination">
        <button disabled={page <= 1} onClick={() => load(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {totalPages} ({total} entries)</span>
        <button disabled={page >= totalPages} onClick={() => load(page + 1)}>Next</button>
      </div>
    </div>
  );
}
