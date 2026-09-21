import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [stage, setStage] = useState('credentials'); // credentials | totp | totp_setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState(null);
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleCredentialsSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api.post('/auth/login', { username, password });
      if (data.requiresTotp) {
        setPendingToken(data.pendingToken);
        setStage('totp');
      } else if (data.requiresTotpSetup) {
        setPendingToken(data.pendingToken);
        setQrCode(data.qrCode);
        setSecret(data.secret);
        setStage('totp_setup');
      } else {
        setUser(data.user);
        navigate('/');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleTotpSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = stage === 'totp' ? '/auth/login/totp' : '/auth/login/totp-setup';
      const data = await api.post(path, { pendingToken, code });
      setUser(data.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form
        className="auth-card"
        onSubmit={stage === 'credentials' ? handleCredentialsSubmit : handleTotpSubmit}
      >
        <h1>InfraLoom</h1>

        {stage === 'credentials' && (
          <>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </>
        )}

        {stage === 'totp' && (
          <>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <label>
              Authentication code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                autoFocus
                required
              />
            </label>
          </>
        )}

        {stage === 'totp_setup' && (
          <>
            <p className="muted">
              Your role requires two-factor authentication. Scan this QR code with your
              authenticator app (Google Authenticator, Authy, 1Password, ...), then enter the
              6-digit code it generates.
            </p>
            {qrCode && <img src={qrCode} alt="TOTP QR code" className="totp-qr" />}
            {secret && (
              <p className="muted totp-secret">
                Can't scan it? Enter this key manually: <code>{secret}</code>
              </p>
            )}
            <label>
              Authentication code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                autoFocus
                required
              />
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Please wait...' : stage === 'credentials' ? 'Log in' : 'Verify'}
        </button>
      </form>
      <footer className="auth-footer">Powered by Krajcara</footer>
    </div>
  );
}
