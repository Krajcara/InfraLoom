import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

export default function UpdatePage() {
  const { user } = useAuth();

  return (
    <div className="page">
      <h1>Update</h1>
      <UpdateSection canInstall={user?.role === 'superadmin'} />
    </div>
  );
}

const STEP_PROGRESS = {
  'Starting update': 5,
  'Checking for updates': 10,
  'Pulling latest code': 20,
  'Installing dependencies': 40,
  'Running database migration': 65,
  'Rebuilding frontend': 80,
  'Restarting service': 92,
  'Waiting for server to respond': 96,
};

function UpdateSection({ canInstall }) {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | running | waiting | done | error
  const [message, setMessage] = useState(null);
  const [currentStep, setCurrentStep] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef(null);
  const pollAttempts = useRef(0);
  const progressPollRef = useRef(null);
  const elapsedRef = useRef(null);
  const startTimeRef = useRef(null);

  useSocket({
    'system:updating': ({ message: msg }) => {
      setPhase('waiting');
      setMessage({ type: 'info', text: msg || 'Update in progress. Waiting for server to restart...' });
      startPolling();
    },
  });

  function startElapsedTimer() {
    stopElapsedTimer();
    startTimeRef.current = Date.now();
    setElapsed(0);
    elapsedRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }
  }

  function startProgressPolling() {
    stopProgressPolling();
    progressPollRef.current = setInterval(async () => {
      try {
        const data = await api.get('/update/progress');
        if (data.step) setCurrentStep(data.step);
      } catch {
        // Server may be mid-restart right now — just keep showing the last known step.
      }
    }, 2000);
  }

  function stopProgressPolling() {
    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAttempts.current = 0;
  }

  function startPolling() {
    stopPolling();
    startProgressPolling();
    // Wait 10s before the first health check — the service needs time to go down and come back.
    setTimeout(() => {
      pollRef.current = setInterval(async () => {
        pollAttempts.current += 1;
        try {
          await api.get('/health');
          stopPolling();
          stopProgressPolling();
          stopElapsedTimer();
          setPhase('done');
          setUpdating(false);
          setInfo(null);
          setCurrentStep('Done');
          setMessage({ type: 'success', text: 'Update complete! Page will reload in 3 seconds...' });
          setTimeout(() => window.location.reload(), 3000);
        } catch {
          // Still down — keep polling. Give up after ~3.5 minutes (40 attempts).
          if (pollAttempts.current > 40) {
            stopPolling();
            stopProgressPolling();
            stopElapsedTimer();
            setPhase('error');
            setUpdating(false);
            setMessage({ type: 'error', text: 'Update timed out. Check server logs: sudo journalctl -u infraloom -n 50' });
          }
        }
      }, 5000);
    }, 10000);
  }

  useEffect(() => () => {
    stopPolling();
    stopProgressPolling();
    stopElapsedTimer();
  }, []);

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
    setCurrentStep('Starting update');
    startElapsedTimer();
    startProgressPolling();
    try {
      await api.post('/update/run');
      setMessage({ type: 'info', text: 'Update started. Waiting for the server to restart...' });
      setInfo(null);
      // Start polling in case the Socket.io event is missed (server may restart before it emits).
      setTimeout(startPolling, 5000);
    } catch (err) {
      setPhase('error');
      setUpdating(false);
      stopProgressPolling();
      stopElapsedTimer();
      setMessage({ type: 'error', text: err.message || 'Update failed' });
    }
  }

  const isActive = phase === 'running' || phase === 'waiting';
  const progressPct = currentStep ? STEP_PROGRESS[currentStep] || 5 : 5;

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
        <div className="update-progress-block">
          <div className="update-progress-bar-track">
            <div className="update-progress-bar-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="update-progress-status-row">
            <span>{currentStep || 'Working...'}</span>
            <span className="mono muted">{elapsed}s elapsed</span>
          </div>
          <p className="muted">The server will restart automatically. This page will reload when the update is complete.</p>
        </div>
      )}

      <p className="muted mono update-manual">
        Manual: <code>sudo bash /opt/infraloom/update.sh</code>
      </p>
    </section>
  );
}
