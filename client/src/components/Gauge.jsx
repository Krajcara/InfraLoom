export default function Gauge({ label, pct, size = 120, subLabel }) {
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const hasValue = pct !== null && pct !== undefined && !Number.isNaN(pct);
  const value = hasValue ? Math.min(Math.max(pct, 0), 100) : 0;
  const offset = circumference - (value / 100) * circumference;
  const color = !hasValue ? '#4a4f5c' : value >= 90 ? '#ff6b6b' : value >= 75 ? '#facc15' : '#22c55e';

  return (
    <div className="tv-gauge">
      <div className="tv-gauge-title">{label}</div>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1f222a" strokeWidth="10" />
        {hasValue && (
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth="10"
            strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="tv-gauge-text" fill={color}>
          {hasValue ? `${Math.round(value)}%` : 'No data'}
        </text>
      </svg>
      {subLabel && <div className="tv-gauge-sub">{subLabel}</div>}
    </div>
  );
}
