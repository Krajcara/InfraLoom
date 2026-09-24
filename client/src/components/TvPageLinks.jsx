import { useEffect, useState } from 'react';
import { Tv, Server } from 'lucide-react';
import { api } from '../api';

export default function TvPageLinks() {
  const [enabled, setEnabled] = useState({ dashboard: true, hypervisors: true });

  useEffect(() => {
    api.get('/settings').then((d) => {
      setEnabled({
        dashboard: d.tv_dashboard_enabled !== '0',
        hypervisors: d.tv_hypervisors_enabled !== '0',
      });
    }).catch(() => {});
  }, []);

  if (!enabled.dashboard && !enabled.hypervisors) return null;

  return (
    <div className="tv-page-links">
      {enabled.dashboard && (
        <a href="/status/dashboard" target="_blank" rel="noreferrer" className="icon-btn" title="Public TV Dashboard">
          <Tv size={16} />
        </a>
      )}
      {enabled.hypervisors && (
        <a href="/status/hypervisors" target="_blank" rel="noreferrer" className="icon-btn" title="Public TV Hypervisors">
          <Server size={16} />
        </a>
      )}
    </div>
  );
}
