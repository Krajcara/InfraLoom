export default function LineChart({ points, color = '#4ade80', height = 90, unit = '%' }) {
  if (!points || points.length < 2) {
    return <div className="tv-chart-empty">Not enough data yet</div>;
  }
  const width = 600;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 10);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => [
    Number((i * stepX).toFixed(1)),
    Number((height - ((p.value - min) / range) * (height - 10) - 5).toFixed(1)),
  ]);
  const linePoints = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`;
  const gradientId = `tv-chart-fill-${color.replace('#', '')}`;
  const last = values[values.length - 1];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  return (
    <div className="tv-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="tv-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline points={linePoints} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="tv-chart-legend">
        <span>Min: {Math.round(min)}{unit}</span>
        <span>Max: {Math.round(max)}{unit}</span>
        <span>Avg: {Math.round(avg)}{unit}</span>
        <span>Current: {Math.round(last)}{unit}</span>
      </div>
    </div>
  );
}
