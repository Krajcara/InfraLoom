import { useNavigate } from 'react-router-dom';

const W = 640, H = 340, BOX_W = 128, BOX_H = 46;

/** Rooms as boxes, trunks as lines labelled with the strands in use — the whole building at a glance. */
export default function RoomsMap({ rooms, trunks }) {
  const navigate = useNavigate();
  if (!trunks.length || rooms.length < 2) return null;
  const used = rooms.filter((r) => trunks.some((t) => t.room_a_id === r.id || t.room_b_id === r.id));
  const n = used.length;
  const cx = W / 2, cy = H / 2, rx = Math.min(W / 2 - BOX_W / 2 - 14, 100 + n * 30), ry = Math.min(H / 2 - BOX_H / 2 - 12, 70 + n * 14);
  const pos = new Map(used.map((r, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    return [r.id, n === 1 ? { x: cx, y: cy } : { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }];
  }));
  const seen = new Map();
  return (
    <svg className="cab-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the rooms and the trunks between them">
      {trunks.map((t) => {
        const a = pos.get(t.room_a_id), b = pos.get(t.room_b_id);
        if (!a || !b) return null;
        const key = [t.room_a_id, t.room_b_id].sort().join('-');
        const k = seen.get(key) || 0; seen.set(key, k + 1);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const bend = (k % 2 ? -1 : 1) * Math.ceil(k / 2 + (k ? 0 : 0)) * 26 * (k ? 1 : 0);
        const qx = mx + (-dy / len) * bend, qy = my + (dx / len) * bend;
        const pct = t.strand_count ? t.used_strands / t.strand_count : 0;
        const colour = pct >= 0.9 ? '#e5534b' : pct >= 0.7 ? '#e0a82e' : '#1f9e90';
        return (
          <g key={t.id} className="cab-map-trunk" onClick={() => navigate('/cabling/trunks')}>
            <path d={`M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}`} stroke={colour} strokeWidth="3" fill="none" strokeDasharray={t.medium === 'copper' ? '6 4' : undefined} />
            <rect x={qx / 2 + mx / 2 - 26} y={qy / 2 + my / 2 - 10} width="52" height="20" rx="6" fill="#14161b" stroke={colour} />
            <text x={qx / 2 + mx / 2} y={qy / 2 + my / 2 + 4} textAnchor="middle" fill="#e6e6e6" fontSize="11" fontFamily="monospace">{t.used_strands}/{t.strand_count}</text>
            <title>{`${t.name}: ${t.used_strands} of ${t.strand_count} ${t.medium === 'fiber' ? 'strands' : 'pairs'} in use`}</title>
          </g>
        );
      })}
      {used.map((r) => {
        const p = pos.get(r.id);
        return (
          <g key={r.id} className="cab-map-room" onClick={() => navigate(`/cabling/rooms/${r.id}`)}>
            <rect x={p.x - BOX_W / 2} y={p.y - BOX_H / 2} width={BOX_W} height={BOX_H} rx="8" fill="#1a1d24" stroke="#3a3f4b" />
            <text x={p.x} y={p.y - 3} textAnchor="middle" fill="#fff" fontSize="13" fontFamily="monospace" fontWeight="600">{r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name}</text>
            <text x={p.x} y={p.y + 13} textAnchor="middle" fill="#8b8f99" fontSize="11">{r.devices} device{r.devices === 1 ? '' : 's'}</text>
          </g>
        );
      })}
    </svg>
  );
}
