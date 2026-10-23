import { useMemo, useState } from 'react';
import { FIELD_KINDS, FILTERS, GROUPS, buildCommands, fillTemplate } from '../lib/captureFilters';
import './diagnostics.css';
import './capture.css';

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1500);
  }
  return <button type="button" className="cab-btn-ghost cap-copy" onClick={copy} aria-label={`${label} ${text.slice(0, 30)}`}>{done ? 'Copied' : label}</button>;
}

export default function CaptureHelperPage() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState('host');
  const [values, setValues] = useState({});
  const [o, setO] = useState({ iface: 'any', seconds: 60, snap: 'headers', file: 'capture', fgVerbose: 4, fgCount: 100 });
  const entry = FILTERS.find((x) => x.id === sel) || FILTERS[0];

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return FILTERS.filter((x) => !t || `${x.title} ${x.about} ${x.bpf || ''} ${x.display || ''} ${x.group}`.toLowerCase().includes(t));
  }, [q]);

  const cap = fillTemplate(entry.bpf, entry.fields, values);
  const dis = fillTemplate(entry.display, entry.fields, values);
  const cmds = buildCommands(entry, values, o);
  const setV = (k, v) => setValues((x) => ({ ...x, [k]: v }));
  const setOpt = (k, v) => setO((x) => ({ ...x, [k]: v }));

  return (
    <div className="page cap">
      <h1>Capture helper</h1>
      <p className="muted">Ready-made filters for the usual network problems, and the commands that use them — for tcpdump, tshark, Wireshark, the FortiGate and MikroTik sniffers. Nothing here captures anything: copy a command and run it where the traffic is. A <strong>capture filter</strong> limits what is recorded; a <strong>display filter</strong> only hides what is already recorded.</p>
      <div className="cap-layout">
        <aside className="cap-list">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: dns, retransmission, 443…" aria-label="Search filters" autoComplete="off" />
          {GROUPS.map((g) => {
            const items = list.filter((x) => x.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="cap-group">
                <h3>{g}</h3>
                {items.map((x) => <button key={x.id} type="button" className={sel === x.id ? 'is-active' : ''} onClick={() => setSel(x.id)}>{x.title}</button>)}
              </div>
            );
          })}
          {!list.length && <p className="muted">Nothing matches.</p>}
        </aside>

        <section className="card cap-detail">
          <h2>{entry.title}</h2>
          <p className="muted">{entry.about}</p>
          {entry.fields.length > 0 && (
            <div className="form-row">
              {entry.fields.map((fl) => {
                const v = values[fl.key] ?? '';
                const bad = v !== '' && FIELD_KINDS[fl.kind].clean(v) === null;
                return (
                  <label key={fl.key}>{fl.label}
                    <input value={v} onChange={(e) => setV(fl.key, e.target.value)} placeholder={FIELD_KINDS[fl.kind].example} aria-label={fl.label} autoComplete="off" className={bad ? 'cap-bad' : ''} />
                    {bad && <span className="error cap-err">Needs {FIELD_KINDS[fl.kind].label}</span>}
                  </label>
                );
              })}
            </div>
          )}
          {entry.bpf && <FilterBox title="Capture filter" hint="tcpdump, dumpcap, tshark -f, FortiGate sniffer" text={cap.text} missing={cap.missing} />}
          {entry.display && <FilterBox title="Display filter" hint="Wireshark, tshark -Y" text={dis.text} missing={dis.missing} />}
          {!entry.bpf && <p className="muted">This one is a display filter only. Capture with a broader filter, then filter the file.</p>}

          <h3 className="cap-h3">Commands</h3>
          <div className="form-row cap-opts">
            <label>Interface<input value={o.iface} onChange={(e) => setOpt('iface', e.target.value)} aria-label="Interface" autoComplete="off" /></label>
            <label>Seconds<input type="number" min="1" max="86400" value={o.seconds} onChange={(e) => setOpt('seconds', e.target.value)} className="cab-in-num" aria-label="Seconds" /></label>
            <label>Keep<select value={o.snap} onChange={(e) => setOpt('snap', e.target.value)} aria-label="What to keep"><option value="headers">Headers only (first 96 bytes)</option><option value="full">Whole packets</option></select></label>
            <label>File name<input value={o.file} onChange={(e) => setOpt('file', e.target.value)} aria-label="File name" autoComplete="off" /></label>
            <label>FortiGate: detail<select value={o.fgVerbose} onChange={(e) => setOpt('fgVerbose', e.target.value)} aria-label="FortiGate detail"><option value="1">1 – headers</option><option value="4">4 – headers + interface</option><option value="6">6 – whole packets + interface</option></select></label>
            <label>FortiGate: packets<input type="number" min="0" max="100000" value={o.fgCount} onChange={(e) => setOpt('fgCount', e.target.value)} className="cab-in-num" aria-label="FortiGate packets" /></label>
          </div>
          {cmds.error && <p className="error">{cmds.error}</p>}
          {cmds.missing?.length > 0 && <p className="muted">Fill in {cmds.missing.map((k) => entry.fields.find((x) => x.key === k)?.label || k).join(', ')} to get the commands.</p>}
          {cmds.items.map((it) => (
            <div key={it.id} className="cap-cmd" data-cmd={it.id}>
              <div className="cap-cmd-head"><strong>{it.title}</strong></div>
              {it.lines.map((l) => (<div key={l} className="cap-line"><pre>{l}</pre>{!(it.id === 'wireshark') && <CopyButton text={l} />}</div>))}
              <p className="muted cap-note">{it.note}</p>
            </div>
          ))}
          <p className="muted cap-foot">A capture holds everything that was not encrypted — names of sites, addresses, sometimes passwords. Keep the file only as long as you need it, and capture only what you must.</p>
        </section>
      </div>
    </div>
  );
}

function FilterBox({ title, hint, text, missing }) {
  return (
    <div className="cap-filter">
      <div className="cap-filter-head"><strong>{title}</strong><span className="muted">{hint}</span></div>
      <div className="cap-line"><pre className={missing.length ? 'is-missing' : ''}>{text}</pre>{!missing.length && <CopyButton text={text} />}</div>
    </div>
  );
}
