import { useEffect, useState } from 'react';

export default function LiveClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <div className="tv-clock">
      <div className="tv-clock-time">{time}</div>
      <div className="tv-clock-date">{date}</div>
    </div>
  );
}
