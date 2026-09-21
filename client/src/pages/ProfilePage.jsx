import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function loadAll() {
    try {
      const [p, s, k] = await Promise.all([
        api.get('/profile'),
        api.get('/profile/sessions'),
        api.get('/profile/api-keys'),
      ]);
      setProfile(p.user);
      setSessions(s.sessions);
      setApiKeys(k.apiKeys);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  }

  return (
    <div className="page">
      <h1>Profile</h1>
      {profile && (
        <p className="muted">
          {profile.username} · {profile.role}
          {profile.totpMandatory && !profile.totpEnabled && ' · ⚠ two-factor setup incomplete'}
        </p>
      )}
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <PasswordSection onDone={() => flash('Password updated.')} onError={setError} />
      <TotpSection
        profile={profile}
        onChanged={async () => {
          await loadAll();
          await refresh();
        }}
        onDone={flash}
        onError={setError}
      />
      <SessionsSection sessions={sessions} onChanged={loadAll} onDone={flash} onError={setError} />
      <ApiKeysSection apiKeys={apiKeys} onChanged={loadAll} onDone={flash} onError={setError} />
    </div>
  );
}

function PasswordSection({ onDone, onError }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/profile/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      onDone();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Change password</h2>
      <form onSubmit={submit} className="form-row">
        <label>
          Current password
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </label>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={10}
            required
          />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Update password'}</button>
      </form>
    </section>
  );
}

function TotpSection({ profile, onChanged, onDone, onError }) {
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  async function startSetup() {
    try {
      const data = await api.post('/profile/totp/setup');
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setEnrolling(true);
    } catch (err) {
      onError(err.message);
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    try {
      await api.post('/profile/totp/verify', { code });
      setEnrolling(false);
      setCode('');
      onChanged();
      onDone('Two-factor authentication enabled.');
    } catch (err) {
      onError(err.message);
    }
  }

  async function disable(e) {
    e.preventDefault();
    try {
      await api.post('/profile/totp/disable', { currentPassword });
      setCurrentPassword('');
      onChanged();
      onDone('Two-factor authentication disabled.');
    } catch (err) {
      onError(err.message);
    }
  }

  if (!profile) return null;

  return (
    <section className="card">
      <h2>Two-factor authentication</h2>
      {profile.totpEnabled ? (
        <>
          <p className="muted">Enabled.</p>
          {profile.totpMandatory ? (
            <p className="muted">Mandatory for your role — cannot be disabled.</p>
          ) : (
            <form onSubmit={disable} className="form-row">
              <label>
                Current password
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
              </label>
              <button type="submit">Disable two-factor</button>
            </form>
          )}
        </>
      ) : enrolling ? (
        <form onSubmit={confirmSetup} className="form-row">
          {qrCode && <img src={qrCode} alt="TOTP QR code" className="totp-qr" />}
          {secret && (
            <p className="muted totp-secret">
              Manual key: <code>{secret}</code>
            </p>
          )}
          <label>
            Authentication code
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} required />
          </label>
          <button type="submit">Confirm</button>
        </form>
      ) : (
        <>
          <p className="muted">Not enabled.</p>
          <button onClick={startSetup}>Enable two-factor authentication</button>
        </>
      )}
    </section>
  );
}

function SessionsSection({ sessions, onChanged, onDone, onError }) {
  async function revoke(id) {
    try {
      await api.del(`/profile/sessions/${id}`);
      onChanged();
      onDone('Session revoked.');
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Active sessions</h2>
      <table className="table">
        <thead>
          <tr>
            <th>IP</th>
            <th>User agent</th>
            <th>Last active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>{s.ip_address}</td>
              <td className="truncate">{s.user_agent}</td>
              <td>{s.last_seen_at}</td>
              <td>
                {s.isCurrent ? (
                  <span className="muted">this session</span>
                ) : (
                  <button className="btn-link" onClick={() => revoke(s.id)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ApiKeysSection({ apiKeys, onChanged, onDone, onError }) {
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState(null);

  async function create(e) {
    e.preventDefault();
    try {
      const data = await api.post('/profile/api-keys', { name });
      setNewKey(data.key);
      setName('');
      onChanged();
    } catch (err) {
      onError(err.message);
    }
  }

  async function revoke(id) {
    try {
      await api.del(`/profile/api-keys/${id}`);
      onChanged();
      onDone('API key revoked.');
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>API keys</h2>
      {newKey && (
        <p className="success">
          New key (copy it now — it won't be shown again): <code>{newKey}</code>
        </p>
      )}
      <form onSubmit={create} className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. monitoring-script" required />
        </label>
        <button type="submit">Create key</button>
      </form>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><code>{k.key_prefix}...</code></td>
              <td>{k.created_at}</td>
              <td>{k.last_used_at || '—'}</td>
              <td>
                {k.revoked_at ? (
                  <span className="muted">revoked</span>
                ) : (
                  <button className="btn-link" onClick={() => revoke(k.id)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
