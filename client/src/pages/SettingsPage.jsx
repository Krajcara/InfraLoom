import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="page">
      <h1>Settings</h1>
      {(user?.role === 'superadmin' || user?.role === 'admin') && <UpdateSection canInstall={user.role === 'superadmin'} />}
    </div>
  );
}

function UpdateSection({ canInstall }) {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | running | waiting | done | error
  const [message, setMessage] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef(null);
  const pollAttempts = useRef(0);

  useSocket({
    'system:updating': ({ message: msg }) => {
      setPhase('waiting');
      setMessage({ type: 'info', text: msg || 'Update in progress. Waiting for server to restart...' });
      startPolling();
    },
  });

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAttempts.current = 0;
    setPollCount(0);
  }

  function startPolling() {
    stopPolling();
    // Wait 10s before the first check — the service needs time to go down and come back.
    setTimeout(() => {
      pollRef.current = setInterval(async () => {
        pollAttempts.current += 1;
        setPollCount(pollAttempts.current);
        try {
          await api.get('/health');
          stopPolling();
          setPhase('done');
          setUpdating(false);
          setInfo(null);
          setMessage({ type: 'success', text: 'Update complete! Page will reload in 3 seconds...' });
          setTimeout(() => window.location.reload(), 3000);
        } catch {
          // Still down — keep polling. Give up after ~3.5 minutes (40 attempts).
          if (pollAttempts.current > 40) {
            stopPolling();
            setPhase('error');
            setUpdating(false);
            setMessage({ type: 'error', text: 'Update timed out. Check server logs: sudo journalctl -u infraloom -n 50' });
          }
        }
      }, 5000);
    }, 10000);
  }

  useEffect(() => () => stopPolling(), []);

  async function check() {
    setChecking(true);
    setMessage(null);
    try {
      const data = await api.get('/update/check');
      setInfo(data);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Could not reach GitHub. Check internet connection.' });
    } finally {
      setChecking(false);
    }
  }

  async function runUpdate() {
    setUpdating(true);
    setMessage(null);
    setPhase('running');
    try {
      await api.post('/update/run');
      setMessage({ type: 'info', text: 'Update started. Waiting for the server to restart...' });
      setInfo(null);
      // Start polling in case the Socket.io event is missed (server may restart before it emits).
      setTimeout(startPolling, 5000);
    } catch (err) {
      setPhase('error');
      setUpdating(false);
      setMessage({ type: 'error', text: err.message || 'Update failed' });
    }
  }

  const isActive = phase === 'running' || phase === 'waiting';

  return (
    <section className="card">
      <h2>System update</h2>
      <p className="muted">
        Check GitHub for new commits. If an update is available, the server will pull the latest
        code, rebuild the frontend, and restart automatically.
      </p>

      {message && (
        <p className={message.type === 'error' ? 'error' : message.type === 'success' ? 'success' : 'muted'}>
          {message.text}
        </p>
      )}

      {info && !isActive && (
        <div className={`update-info ${info.up_to_date ? 'ok' : 'available'}`}>
          <p className="update-info-title">{info.up_to_date ? 'Already up to date' : 'Update available'}</p>
          <p className="muted mono">
            Installed: {info.local_sha}
            {!info.up_to_date && <> → Latest: {info.remote_sha}</>}
          </p>
          {info.current_version && <p className="muted">Version: {info.current_version}</p>}
        </div>
      )}

      {!isActive && phase !== 'done' && (
        <div className="form-row">
          <button onClick={check} disabled={checking}>
            {checking ? 'Checking...' : 'Check for updates'}
          </button>
          {canInstall && info && !info.up_to_date && (
            <button onClick={runUpdate} disabled={updating}>
              {updating ? 'Installing...' : 'Install update'}
            </button>
          )}
        </div>
      )}

      {isActive && (
        <div className="muted">
          <p>The server will restart automatically. This page will reload when the update is complete.</p>
          <p className="mono">Polling for server... ({pollCount} attempts)</p>
        </div>
      )}

      <p className="muted mono update-manual">
        Manual: <code>sudo bash /opt/infraloom/update.sh</code>
      </p>
    </section>
  );
}
