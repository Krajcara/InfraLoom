import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import './dmarc.css';

const fmtNum = (n) => (n ?? 0).toLocaleString();
const fmtPct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '—');
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

const RESULT_HINTS = {
  permerror: 'The SPF record has a permanent error (for example more than 10 DNS lookups, or two v=spf1 records).',
  local_policy: 'The receiver let the message through under its own policy, most often because of a valid ARC chain (forwarding, mailing list).',
  forwarded: 'The message was forwarded.',
  mailing_list: 'The message went through a mailing list.',
};

const errText = (e) => (e && e.message) || 'Something went wrong';
const dmarcApi = {
  summary: (days, domain) => api.get(`/dmarc/summary?days=${days}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`),
  reports: (days, domain) => api.get(`/dmarc/reports?days=${days}&limit=300${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`),
  report: (id) => api.get(`/dmarc/reports/${id}`),
  messages: () => api.get('/dmarc/messages'),
  sync: () => api.post('/dmarc/sync'),
  setGroup: (name, data) => api.patch('/dmarc/groups', { name, ...data }),
  setSource: (ip, data) => api.patch('/dmarc/sources', { ip, ...data }),
  upload: (file) => api.upload('/dmarc/upload', file),
};

export default function DmarcPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const [days, setDays] = useState(30);
  const [domain, setDomain] = useState('');
  const [tab, setTab] = useState('sources');
  const [data, setData] = useState(null);
  const [reports, setReports] = useState([]);
  const [messages, setMessages] = useState([]);
  const [openReport, setOpenReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([dmarcApi.summary(days, domain), dmarcApi.reports(days, domain)]);
      setData(s); setReports(r);
    } catch (e) {
      setNotice({ type: 'error', text: `Could not load: ${errText(e)}` });
    } finally {
      setLoading(false);
    }
  }, [days, domain]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'messages') dmarcApi.messages().then(setMessages).catch(() => setMessages([])); }, [tab]);

  async function handleSync() {
    setBusy('sync'); setNotice(null);
    try {
      const r = await dmarcApi.sync();
      setNotice(r.skipped ? { type: 'info', text: 'A read of the mailbox is already running.' }
        : { type: 'ok', text: `Read ${r.messages} message${r.messages === 1 ? '' : 's'}, ${r.reports} new report${r.reports === 1 ? '' : 's'}${r.errors ? `, ${r.errors} error${r.errors === 1 ? '' : 's'}` : ''}.` });
      await load();
    } catch (e) {
      setNotice({ type: 'error', text: `Reading the mailbox failed: ${errText(e)}` });
      load();
    } finally { setBusy(''); }
  }

  async function handleUpload(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy('upload');
    let added = 0; let dup = 0; const failed = [];
    for (const f of files) {
      try { const r = await dmarcApi.upload(f); added += r.reports; dup += r.duplicates; } catch (err) { failed.push(`${f.name}: ${errText(err)}`); }
    }
    setBusy('');
    setNotice({ type: failed.length ? 'error' : 'ok', text: `Imported ${added} report${added === 1 ? '' : 's'}${dup ? `, ${dup} already there` : ''}.${failed.length ? ` Failed: ${failed.join('; ')}` : ''}` });
    load();
  }

  async function toggleGroup(g) { try { await dmarcApi.setGroup(g.name, { approved: !g.approved }); } catch (e) { setNotice({ type: 'error', text: errText(e) }); } load(); }
  async function toggleIp(s) { try { await dmarcApi.setSource(s.ip, { approved: !s.ip_approved }); } catch (e) { setNotice({ type: 'error', text: errText(e) }); } load(); }

  const t = data?.totals;
  const sync = data?.sync;
  const pol = data?.latestPolicy;

  return (
    <div className="dmarc">
      <header className="dmarc-head">
        <div>
          <h1>DMARC reports</h1>
          <p className="dmarc-sub">
            {pol ? (
              <>
                <strong>{pol.domain}</strong> — policy p={pol.policy_p}
                {pol.policy_sp && `, sp=${pol.policy_sp}`}
                {pol.policy_pct !== 100 && `, pct=${pol.policy_pct}`}
                , DKIM alignment {pol.policy_adkim === 's' ? 'strict' : 'relaxed'}, SPF {pol.policy_aspf === 's' ? 'strict' : 'relaxed'}
              </>
            ) : 'No reports yet.'}
          </p>
        </div>

        <div className="dmarc-actions">
          {data?.domains?.length > 1 && (
            <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
              <option value="">All domains</option>
              {data.domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
          {canEdit && (
            <>
              <input ref={fileRef} type="file" accept=".xml,.zip,.gz" multiple hidden onChange={handleUpload} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy === 'upload' ? 'Importing…' : 'Import files'}</button>
              {sync?.enabled && (
                <button type="button" className="dmarc-primary" onClick={handleSync} disabled={!!busy || sync.running}>
                  {busy === 'sync' || sync.running ? 'Reading the mailbox…' : 'Check mailbox'}
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {sync && (
        <p className={`dmarc-syncline ${sync.lastError ? 'is-error' : ''}`}>
          {sync.enabled
            ? <>Mailbox {sync.mailbox}, checked every {sync.pollMinutes} min. Last: {fmtDateTime(sync.lastSync)}{sync.lastError && <> — error: {sync.lastError}</>}</>
            : 'Microsoft Graph is not set up (Settings → DMARC). You can import reports by hand.'}
        </p>
      )}

      {notice && (
        <div className={`dmarc-notice is-${notice.type}`} role="status">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Close">×</button>
        </div>
      )}

      {loading && !data ? <p className="dmarc-empty">Loading…</p> : t?.total === 0 ? (
        <div className="dmarc-empty">
          <p>No reports in the selected period.</p>
          <p>{sync?.enabled && canEdit ? 'Check the mailbox, or ' : ''}{canEdit ? 'import XML, ZIP or GZ reports by hand.' : 'Reports show up here once they arrive.'}</p>
        </div>
      ) : t && (
        <>
          <section className="dmarc-stats" aria-label="Summary">
            <Stat label="Messages in reports" value={fmtNum(t.total)} />
            <Stat label="Passed DMARC" value={fmtPct(t.pass, t.total)} tone={t.fail ? undefined : 'ok'} />
            <Stat label="Failed DMARC" value={fmtNum(t.fail)} tone={t.fail ? 'bad' : undefined} />
            <Stat label="SPF permerror" value={fmtNum(t.spf_permerror)} tone={t.spf_permerror ? 'warn' : undefined} hint={t.spf_permerror ? RESULT_HINTS.permerror : undefined} />
            <Stat label={`reports from ${t.reporters} receiver${t.reporters === 1 ? '' : 's'}`} value={fmtNum(t.reports)} />
          </section>

          <DailyChart daily={data.daily} />

          <nav className="dmarc-tabs" role="tablist">
            {[['sources', 'Senders'], ['reports', 'Reports'], ['messages', 'Mailbox']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </nav>

          {tab === 'sources' && <SourcesTable groups={data.groups} sources={data.sources} canEdit={canEdit} onToggleGroup={toggleGroup} onToggleIp={toggleIp} />}
          {tab === 'reports' && <ReportsTable reports={reports} onOpen={setOpenReport} />}
          {tab === 'messages' && <MessagesTable messages={messages} />}
        </>
      )}

      {openReport && <ReportDrawer id={openReport} onClose={() => setOpenReport(null)} />}
    </div>
  );
}

function Stat({ label, value, tone, hint }) {
  return (
    <div className={`dmarc-stat ${tone ? `is-${tone}` : ''}`} title={hint}>
      <span className="dmarc-stat-value">{value}</span>
      <span className="dmarc-stat-label">{label}</span>
    </div>
  );
}

function DailyChart({ daily }) {
  const max = Math.max(1, ...daily.map((d) => d.pass + d.fail));
  if (daily.length < 2) return null;
  return (
    <figure className="dmarc-chart" aria-label="Messages per day">
      <div className="dmarc-bars">
        {daily.map((d) => (
          <div key={d.day} className="dmarc-bar" title={`${d.day}: ${d.pass} passed, ${d.fail} failed`}>
            <span className="is-fail" style={{ height: `${(d.fail / max) * 100}%` }} />
            <span className="is-pass" style={{ height: `${(d.pass / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <figcaption>
        <span>{daily[0].day}</span>
        <span><i className="dot is-pass" /> passed <i className="dot is-fail" /> failed</span>
        <span>{daily[daily.length - 1].day}</span>
      </figcaption>
    </figure>
  );
}

function SourcesTable({ groups, sources, canEdit, onToggleGroup, onToggleIp }) {
  const [open, setOpen] = useState(() => new Set());
  const byGroup = useMemo(() => {
    const m = new Map();
    for (const s of sources) { const k = s.provider || 'unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
    return m;
  }, [sources]);
  const toggle = (name) => setOpen((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const yesNo = (v) => (v ? 'yes' : 'no');

  return (
    <div className="dmarc-tablewrap">
      <table className="dmarc-table">
        <thead>
          <tr><th>Sender</th><th className="num">IP addresses</th><th className="num">Messages</th><th className="num">Passed</th><th className="num">Failed</th><th className="num">SPF permerror</th><th>Approved</th></tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = open.has(g.name);
            const ips = byGroup.get(g.name) || [];
            return (
              <Fragment key={g.name}>
                <tr className={`is-group ${g.fail && !g.approved ? 'is-alert' : ''}`}>
                  <td><button type="button" className="dmarc-expand" aria-expanded={isOpen} onClick={() => toggle(g.name)}><span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {g.name}</button></td>
                  <td className="num">{g.ips}</td><td className="num">{fmtNum(g.total)}</td><td className="num">{fmtNum(g.pass)}</td>
                  <td className={`num ${g.fail ? 'txt-bad' : ''}`}>{fmtNum(g.fail)}</td><td className={`num ${g.spf_permerror ? 'txt-warn' : ''}`}>{fmtNum(g.spf_permerror)}</td>
                  <td>
                    {canEdit
                      ? <label className="dmarc-switch"><input type="checkbox" checked={!!g.approved} onChange={() => onToggleGroup(g)} aria-label={`Approve ${g.name}`} /><span>{yesNo(g.approved)}</span></label>
                      : <span className="dmarc-muted">{yesNo(g.approved)}</span>}
                  </td>
                </tr>
                {isOpen && ips.map((s) => (
                  <tr key={`${g.name}-${s.ip}`} className="is-ip">
                    <td>
                      <code>{s.ip}</code>
                      {s.ptr && <span className="dmarc-ptr">{s.ptr}</span>}
                      {s.reporters && <span className="dmarc-reporters">reported by: {s.reporters.split(',').join(', ')}</span>}
                    </td>
                    <td />
                    <td className="num">{fmtNum(s.total)}</td>
                    <td className="num">{fmtNum(s.pass)}<span className="dmarc-mini">DKIM {fmtNum(s.dkim_pass)} SPF {fmtNum(s.spf_pass)}</span></td>
                    <td className={`num ${s.fail ? 'txt-bad' : ''}`}>{fmtNum(s.fail)}</td>
                    <td className={`num ${s.spf_permerror ? 'txt-warn' : ''}`}>{fmtNum(s.spf_permerror)}</td>
                    <td>
                      {s.group_approved ? <span className="dmarc-muted">via the group</span> : canEdit
                        ? <label className="dmarc-switch"><input type="checkbox" checked={!!s.ip_approved} onChange={() => onToggleIp(s)} aria-label={`Approve ${s.ip}`} /><span>{yesNo(s.ip_approved)}</span></label>
                        : <span className="dmarc-muted">{yesNo(s.ip_approved)}</span>}
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportsTable({ reports, onOpen }) {
  if (!reports.length) return <p className="dmarc-empty">No reports.</p>;
  return (
    <div className="dmarc-tablewrap">
      <table className="dmarc-table is-clickable">
        <thead><tr><th>Period</th><th>Reporter</th><th>Domain</th><th className="num">Messages</th><th className="num">Failed</th><th>Source</th></tr></thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id} onClick={() => onOpen(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.id)}>
              <td>{fmtDate(r.date_begin)}{r.date_end - r.date_begin > 90000 ? ` – ${fmtDate(r.date_end)}` : ''}</td>
              <td>{r.org_name}</td><td>{r.domain}</td>
              <td className="num">{fmtNum(r.total_count)}</td>
              <td className={`num ${r.fail_count ? 'txt-bad' : ''}`}>{fmtNum(r.fail_count)}</td>
              <td className="dmarc-muted">{{ graph: 'mailbox', upload: 'imported' }[r.origin] || r.origin}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessagesTable({ messages }) {
  if (!messages.length) return <p className="dmarc-empty">No mail has been read from the mailbox yet.</p>;
  const label = { ok: 'processed', 'no-report': 'no report', error: 'error' };
  return (
    <div className="dmarc-tablewrap">
      <table className="dmarc-table">
        <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Status</th></tr></thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.graph_id}>
              <td>{fmtDateTime(m.received_at)}</td><td>{m.from_addr}</td>
              <td className="dmarc-clip" title={m.subject}>{m.subject}</td>
              <td className={m.status === 'error' ? 'txt-bad' : ''} title={m.error || undefined}>{label[m.status] || m.status}{m.error ? `: ${m.error}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportDrawer({ id, onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const closeRef = useRef(null);

  useEffect(() => {
    dmarcApi.report(id).then(setR).catch((e) => setErr(errText(e)));
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  return (
    <div className="dmarc-overlay" onClick={onClose}>
      <aside className="dmarc-drawer" role="dialog" aria-modal="true" aria-label="Report details" onClick={(e) => e.stopPropagation()}>
        <div className="dmarc-drawer-head">
          <h2>{r ? `${r.org_name} — ${fmtDate(r.date_begin)}` : 'Report'}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {err && <p className="txt-bad">{err}</p>}
        {r && (
          <>
            <dl className="dmarc-meta">
              <dt>Domain</dt><dd>{r.domain}</dd>
              <dt>Policy</dt><dd>p={r.policy_p}, sp={r.policy_sp || '—'}, pct={r.policy_pct}, adkim={r.policy_adkim}, aspf={r.policy_aspf}</dd>
              <dt>Report ID</dt><dd><code>{r.report_id}</code></dd>
              <dt>Contact</dt><dd>{r.org_email || '—'}</dd>
            </dl>
            {r.raw_xml && <a className="dmarc-link" href={`/api/dmarc/reports/${r.id}/xml`} target="_blank" rel="noreferrer">Open the original XML</a>}

            <div className="dmarc-records">
              {r.records.map((rec) => (
                <article key={rec.id} className={`dmarc-record ${rec.dmarc_pass ? '' : 'is-fail'}`}>
                  <header>
                    <span className={`dmarc-badge ${rec.dmarc_pass ? 'is-pass' : 'is-fail'}`}>{rec.dmarc_pass ? 'DMARC passed' : 'DMARC failed'}</span>
                    <code>{rec.source_ip}</code>
                    <span className="dmarc-muted">messages: {rec.count}</span>
                  </header>
                  {rec.ptr && <p className="dmarc-ptr">{rec.ptr}</p>}
                  <dl className="dmarc-meta is-compact">
                    <dt>Header From</dt><dd>{rec.header_from}</dd>
                    {rec.envelope_from && <><dt>Envelope From</dt><dd>{rec.envelope_from}</dd></>}
                    <dt>Outcome</dt><dd>{rec.disposition === 'none' ? 'delivered' : rec.disposition}</dd>
                    <dt>DKIM</dt>
                    <dd>
                      {rec.dkim_results.length ? rec.dkim_results.map((d, i) => (
                        <span key={i} className={`res is-${d.result}`}>{d.domain}{d.selector ? ` (${d.selector})` : ''}: {d.result}</span>
                      )) : 'no signature'}
                    </dd>
                    <dt>SPF</dt>
                    <dd>{rec.spf_results.map((s, i) => <span key={i} className={`res is-${s.result}`} title={RESULT_HINTS[s.result]}>{s.domain}: {s.result}</span>)}</dd>
                    {rec.reasons.length > 0 && (
                      <>
                        <dt>Note</dt>
                        <dd>
                          {rec.reasons.map((x, i) => <span key={i} title={RESULT_HINTS[x.type]}>{x.type}{x.comment ? ` (${x.comment})` : ''}</span>)}
                          {RESULT_HINTS[rec.reasons[0].type] && <p className="dmarc-hint">{RESULT_HINTS[rec.reasons[0].type]}</p>}
                        </dd>
                      </>
                    )}
                  </dl>
                </article>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
