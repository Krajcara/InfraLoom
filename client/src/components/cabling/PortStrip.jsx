const numberOf = (name) => (/(\d+)$/.exec(name) || [])[1] ?? name;
const prefixOf = (name) => name.replace(/\d+$/, '');
const FIBER = ['lc_duplex', 'sc_duplex'];

/** Short text on a port: the number for copper, a letter plus the number for the rest (Te1/1/3 -> T3). */
export function portLabel(p) {
  const n = numberOf(p.name);
  if (p.port_type === 'rj45' || /^\d+$/.test(p.name)) return n;
  const letter = (prefixOf(p.name).match(/[A-Za-z]/) || [''])[0].toUpperCase();
  return `${letter}${n}`;
}

/** Consecutive ports with the same prefix and type form one block (24 × Gi1/0/, then 4 × Te1/1/). */
function blocks(ports) {
  const out = [];
  for (const p of ports) {
    const key = `${prefixOf(p.name)}|${p.port_type}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.ports.push(p); else out.push({ key, ports: [p] });
  }
  return out;
}

const STATUS_TITLE = { free: 'free', outlet: 'wall outlet recorded' };

/** The front of a device: switches in two rows (odd numbers above even, like the real faceplate), panels in one row. */
export default function PortStrip({ ports, panel = false, selectedId = null, onSelect = null }) {
  const compact = ports.length > 4; // a handful of ports (eth0 on a desktop) is clearer with the full name
  if (!ports.length) return <p className="muted cab-noports">No ports recorded.</p>;
  return (
    <div className={`cab-strip ${panel ? 'cab-strip--panel' : ''}`}>
      {blocks(ports).map((b) => (
        <div key={b.key} className={`cab-block ${panel || b.ports.length < 2 ? 'cab-block--row' : 'cab-block--two'}`}>
          {b.ports.map((p) => (
            <button
              type="button"
              key={p.id ?? p.name}
              className={`cab-port cab-port--${p.status || 'free'}${FIBER.includes(p.port_type) ? ' cab-port--wide' : ''}${selectedId !== null && selectedId === p.id ? ' cab-port--sel' : ''}`}
              title={`${p.name} · ${STATUS_TITLE[p.status || 'free'] || p.status}${p.outlet_label ? ` · ${p.outlet_label}` : ''}`}
              onClick={onSelect ? () => onSelect(p) : undefined}
              tabIndex={onSelect ? 0 : -1}
            >
              {compact ? portLabel(p) : p.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
