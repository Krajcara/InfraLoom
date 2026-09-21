import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const ALL_ROLES = ['superadmin', 'admin', 'operator', 'viewer'];

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [newUsername, setNewUsername] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [createdInfo, setCreatedInfo] = useState(null);

  const assignableRoles = me?.role === 'superadmin' ? ALL_ROLES : ['operator', 'viewer'];

  async function load() {
    try {
      const data = await api.get('/users');
      setUsers(data.users);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 5000);
  }

  async function createUser(e) {
    e.preventDefault();
    setCreatedInfo(null);
    try {
      const data = await api.post('/users', { username: newUsername, role: newRole });
      setCreatedInfo({ username: data.user.username, password: data.temporaryPassword });
      setNewUsername('');
      setNewRole('viewer');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleActive(u) {
    try {
      await api.put(`/users/${u.id}`, { is_active: u.is_active ? 0 : 1 });
      flash(`${u.username} ${u.is_active ? 'disabled' : 'enabled'}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function changeRole(u, role) {
    try {
      await api.put(`/users/${u.id}`, { role });
      flash(`${u.username}'s role changed to ${role}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPassword(u) {
    try {
      const data = await api.post(`/users/${u.id}/reset-password`);
      setCreatedInfo({ username: u.username, password: data.temporaryPassword });
    } catch (err) {
      setError(err.message);
    }
  }

  async function unlock(u) {
    try {
      await api.post(`/users/${u.id}/unlock`);
      flash(`${u.username} unlocked.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(u) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      await api.del(`/users/${u.id}`);
      flash(`${u.username} deleted.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1>Users</h1>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}
      {createdInfo && (
        <p className="success">
          Temporary password for <strong>{createdInfo.username}</strong> (copy it now):{' '}
          <code>{createdInfo.password}</code>
        </p>
      )}

      <section className="card">
        <h2>New user</h2>
        <form onSubmit={createUser} className="form-row">
          <label>
            Username
            <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} required />
          </label>
          <label>
            Role
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              {assignableRoles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <button type="submit">Create user</button>
        </form>
      </section>

      <table className="table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>2FA</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const canManage = me.role === 'superadmin' || (me.role === 'admin' && ['operator', 'viewer'].includes(u.role));
            return (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>
                  {canManage && u.id !== me.id ? (
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                      {assignableRoles.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    u.role
                  )}
                </td>
                <td>{u.totp_enabled ? '✓' : '—'}</td>
                <td>
                  {u.locked_until && new Date(u.locked_until) > new Date() ? (
                    <span className="error">locked</span>
                  ) : u.is_active ? (
                    'active'
                  ) : (
                    'disabled'
                  )}
                </td>
                <td className="actions">
                  {canManage && u.id !== me.id && (
                    <>
                      <button className="btn-link" onClick={() => toggleActive(u)}>
                        {u.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn-link" onClick={() => resetPassword(u)}>Reset password</button>
                      {u.locked_until && (
                        <button className="btn-link" onClick={() => unlock(u)}>Unlock</button>
                      )}
                      <button className="btn-link danger" onClick={() => remove(u)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
