import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

export default function SettingsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'superadmin' || user?.role === 'admin';

  return (
    <div className="page">
      <h1>Settings</h1>
      {canEdit && <GeneralSection />}
      {canEdit && <SmtpSection />}
      {canEdit && <NotificationsSection />}
      {canEdit && <NotificationRulesSection />}
    </div>
  );
}

function useSettingsForm(initialKeys) {
  const [values, setValues] = useState(initialKeys);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get('/settings').then((data) => {
      setValues((prev) => ({ ...prev, ...data }));
      setLoaded(true);
    });
  }, []);

  function set(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  return { values, set, loaded };
}

function GeneralSection() {
  const { values, set, loaded } = useSettingsForm({ app_name: '', audit_retention_days: '' });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/settings', { app_name: values.app_name, audit_retention_days: values.audit_retention_days });
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className="card">
      <h2>General</h2>
      <form onSubmit={save} className="form-row">
        <label>
          Application name
          <input value={values.app_name || ''} onChange={(e) => set('app_name', e.target.value)} autoComplete="off" name="app_name_field" />
        </label>
        <label>
          Audit log retention (days)
          <input
            type="number"
            min="0"
            value={values.audit_retention_days || ''}
            onChange={(e) => set('audit_retention_days', e.target.value)}
            placeholder="unlimited"
            autoComplete="off"
            name="audit_retention_field"
          />
        </label>
        <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </form>
      {message && <p className={message.type === 'error' ? 'error' : 'success'}>{message.text}</p>}
    </section>
  );
}

function SmtpSection() {
  const { values, set, loaded } = useSettingsForm({
    smtp_host: '', smtp_port: '', smtp_user: '', smtp_pass: '', smtp_from: '',
  });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.post('/settings', {
        smtp_host: values.smtp_host,
        smtp_port: values.smtp_port,
        smtp_user: values.smtp_user,
        smtp_pass: values.smtp_pass,
        smtp_from: values.smtp_from,
      });
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const data = await api.post('/settings/test/smtp', values);
      setMessage({ type: data.ok ? 'success' : 'error', text: data.ok ? data.message : data.error });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className="card">
      <h2>Email (SMTP)</h2>
      <form onSubmit={save} className="form-row" autoComplete="off">
        <label>
          Host
          <input value={values.smtp_host || ''} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.example.com" autoComplete="off" name="smtp_host_field" />
        </label>
        <label>
          Port
          <input value={values.smtp_port || ''} onChange={(e) => set('smtp_port', e.target.value)} placeholder="587" autoComplete="off" name="smtp_port_field" />
        </label>
        <label>
          Username
          <input value={values.smtp_user || ''} onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" name="smtp_user_field" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={values.smtp_pass || ''}
            onChange={(e) => set('smtp_pass', e.target.value)}
            placeholder={values.smtp_pass === '***' ? 'unchanged' : ''}
            autoComplete="new-password"
            name="smtp_pass_field"
          />
        </label>
        <label>
          From address
          <input value={values.smtp_from || ''} onChange={(e) => set('smtp_from', e.target.value)} placeholder="infraloom@example.com" autoComplete="off" name="smtp_from_field" />
        </label>
        <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button type="button" onClick={test} disabled={testing}>{testing ? 'Testing...' : 'Test connection'}</button>
      </form>
      {message && <p className={message.type === 'error' ? 'error' : 'success'}>{message.text}</p>}
    </section>
  );
}

const CHANNELS = [
  { key: 'telegram', label: 'Telegram', fields: [['telegram_bot_token', 'Bot token', 'password'], ['telegram_chat_id', 'Chat ID', 'text']] },
  { key: 'slack', label: 'Slack', fields: [['slack_webhook_url', 'Webhook URL', 'password']] },
  { key: 'discord', label: 'Discord', fields: [['discord_webhook_url', 'Webhook URL', 'password']] },
  { key: 'ntfy', label: 'ntfy', fields: [['ntfy_url', 'Server URL', 'text'], ['ntfy_topic', 'Topic', 'text']] },
  { key: 'pushover', label: 'Pushover', fields: [['pushover_app_token', 'App token', 'password'], ['pushover_user_key', 'User key', 'password']] },
];

function NotificationsSection() {
  const initial = {};
  CHANNELS.forEach((c) => c.fields.forEach(([key]) => (initial[key] = '')));
  const { values, set, loaded } = useSettingsForm(initial);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState(null);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const payload = {};
      CHANNELS.forEach((c) => c.fields.forEach(([key]) => (payload[key] = values[key])));
      await api.post('/settings', payload);
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function test(channel) {
    setTestingChannel(channel);
    setMessage(null);
    try {
      const data = await api.post('/settings/test/notification', { channel });
      setMessage({ type: data.ok ? 'success' : 'error', text: data.ok ? data.message : data.error });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setTestingChannel(null);
    }
  }

  if (!loaded) return null;

  return (
    <section className="card">
      <h2>Notification channels</h2>
      <p className="muted">Fill in a channel's fields and save to enable it. Leave blank to disable.</p>
      <form onSubmit={save} autoComplete="off">
        {CHANNELS.map((c) => (
          <div key={c.key} className="channel-row">
            <strong>{c.label}</strong>
            <div className="form-row">
              {c.fields.map(([key, label, type]) => (
                <label key={key}>
                  {label}
                  <input
                    type={type}
                    value={values[key] || ''}
                    onChange={(e) => set(key, e.target.value)}
                    placeholder={values[key] === '***' ? 'unchanged' : ''}
                    autoComplete={type === 'password' ? 'new-password' : 'off'}
                    name={`${key}_field`}
                  />
                </label>
              ))}
              <button type="button" onClick={() => test(c.key)} disabled={testingChannel === c.key}>
                {testingChannel === c.key ? 'Sending...' : 'Send test'}
              </button>
            </div>
          </div>
        ))}
        <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save all channels'}</button>
      </form>
      {message && <p className={message.type === 'error' ? 'error' : 'success'}>{message.text}</p>}
    </section>
  );
}

function NotificationRulesSection() {
  const [eventTypes, setEventTypes] = useState([]);
  const [channels, setChannels] = useState([]);
  const [rules, setRules] = useState({});
  const [quietHours, setQuietHours] = useState({ enabled: false, start: '22:00', end: '07:00' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.get('/settings/notification-rules').then((data) => {
      setEventTypes(data.eventTypes);
      setChannels(data.channels);
      setRules(data.rules || {});
      setQuietHours(data.quietHours);
      setLoaded(true);
    });
  }, []);

  function isEnabled(channel, eventId) {
    if (!rules[channel] || rules[channel][eventId] === undefined) return true; // default on
    return !!rules[channel][eventId];
  }

  function toggle(channel, eventId) {
    setRules((prev) => ({
      ...prev,
      [channel]: { ...prev[channel], [eventId]: !isEnabled(channel, eventId) },
    }));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await api.post('/settings/notification-rules', { rules, quietHours });
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className="card">
      <h2>Notification rules</h2>
      <p className="muted">
        Choose which message types go to which channel. Unchecked = that channel never receives
        that type of alert, even if the channel itself is configured.
      </p>

      <table className="table rules-table">
        <thead>
          <tr>
            <th>Event</th>
            {channels.map((c) => (
              <th key={c} className="rules-channel-head">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {eventTypes.map((evt) => (
            <tr key={evt.id}>
              <td>{evt.label}</td>
              {channels.map((c) => (
                <td key={c} className="rules-checkbox-cell">
                  <input type="checkbox" checked={isEnabled(c, evt.id)} onChange={() => toggle(c, evt.id)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="rules-subheading">Quiet hours</h3>
      <p className="muted">Suppress all notifications during this window (local server time).</p>
      <div className="form-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={quietHours.enabled}
            onChange={(e) => setQuietHours({ ...quietHours, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <label>
          From
          <input type="time" value={quietHours.start} onChange={(e) => setQuietHours({ ...quietHours, start: e.target.value })} disabled={!quietHours.enabled} />
        </label>
        <label>
          To
          <input type="time" value={quietHours.end} onChange={(e) => setQuietHours({ ...quietHours, end: e.target.value })} disabled={!quietHours.enabled} />
        </label>
      </div>

      <div className="form-row">
        <button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save notification rules'}</button>
      </div>
      {message && <p className={message.type === 'error' ? 'error' : 'success'}>{message.text}</p>}
    </section>
  );
}
