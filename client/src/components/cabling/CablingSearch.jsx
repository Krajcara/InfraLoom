import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';

/** One search box for ports, wall outlets, IP addresses and devices. */
export default function CablingSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const box = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return undefined; }
    const t = setTimeout(() => { api.get(`/cabling/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes(null)); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setRes(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const go = (path) => { setRes(null); setQ(''); navigate(path); };
  const empty = res && !res.devices.length && !res.ports.length;

  return (
    <div className="cab-search" ref={box}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search port, wall outlet, IP, device" aria-label="Search cabling" />
      {res && (
        <div className="cab-search-results">
          {empty && <div className="cab-search-empty muted">Nothing found</div>}
          {res.devices.map((d) => (
            <button type="button" key={`d${d.id}`} className="cab-search-item" onClick={() => go(d.room_id ? `/cabling/rooms/${d.room_id}?device=${d.id}` : `/cabling/devices/${d.id}/edit`)}>
              <strong className="mono">{d.name}</strong>
              <span className="muted">{[d.ip_address, d.room_name || d.office_name].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {res.ports.map((p) => (
            <button type="button" key={`p${p.id}`} className="cab-search-item" onClick={() => go(p.room_id ? `/cabling/rooms/${p.room_id}?port=${p.id}` : `/cabling/devices/${p.device_id}/edit`)}>
              <strong className="mono">{p.outlet_label || p.name}</strong>
              <span className="muted">{p.device_name} · port {p.name}{p.office_name ? ` · ${p.office_name}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
