'use strict';

// What a log line means for a person who looks after the firewall: a failed login, a change of the configuration, an attack that was stopped, a VPN, a system event.
// Matching is on the description the firewall writes (logdesc) and on type, subtype, status and level — not on log ids, which differ between versions.

const trim = (v, n = 160) => (v == null ? '' : String(v).slice(0, n));
const LEVEL = { emergency: 'critical', alert: 'critical', critical: 'critical', error: 'warning', warning: 'warning' };
const SEVERITY = { critical: 'critical', high: 'warning' };

/** @returns {{ kind, level, summary, user?, srcip? } | null} */
function classify(f) {
  const type = String(f.type || '').toLowerCase(); const sub = String(f.subtype || '').toLowerCase();
  const desc = String(f.logdesc || ''); const d = desc.toLowerCase();
  const src = f.srcip || f.remip || null; const user = f.user && f.user !== 'N/A' ? f.user : null;

  if (type === 'event') {
    if (/admin login fail/.test(d)) return { kind: 'admin_login_failed', level: 'warning', user, srcip: src, summary: `Admin login failed: ${trim(user || '?')} from ${trim(src || '?')}${f.ui ? ` (${trim(f.ui, 60)})` : ''}${f.reason ? `, ${trim(f.reason, 60)}` : ''}` };
    if (/admin login success/.test(d)) return { kind: 'admin_login', level: 'info', user, srcip: src, summary: `Admin ${trim(user || '?')} logged in from ${trim(src || '?')}${f.ui ? ` (${trim(f.ui, 60)})` : ''}` };
    if (sub === 'vpn') {
      if (/fail|denied|reject/.test(`${d} ${f.action || ''} ${f.reason || ''}`.toLowerCase()) && !/tunnel (up|down)/.test(d)) return { kind: 'vpn_login_failed', level: 'warning', user, srcip: src, summary: `VPN login failed: ${trim(user || '?')} from ${trim(src || '?')}${f.reason ? `, ${trim(f.reason, 60)}` : ''}` };
      if (/tunnel up|tunnel-up|login success|phase1 .*up|ssl-new-con/.test(`${d} ${f.action || ''}`.toLowerCase())) return { kind: 'vpn_login', level: 'info', user, srcip: src, summary: `VPN up: ${trim(user || f.vpntunnel || '?')} from ${trim(src || '?')}` };
      if (/tunnel down|tunnel-down/.test(`${d} ${f.action || ''}`.toLowerCase())) return { kind: 'vpn_logout', level: 'info', user, srcip: src, summary: `VPN down: ${trim(user || f.vpntunnel || '?')} from ${trim(src || '?')}` };
    }
    if (f.cfgpath || /attribute configured|object (attribute )?(configured|created|edited|deleted)|configuration (changed|saved)/.test(d)) {
      return { kind: 'config_change', level: 'info', user, srcip: null, summary: `${trim(f.action || 'Change')} ${trim(f.cfgpath || '')}${f.cfgobj ? ` ${trim(f.cfgobj, 60)}` : ''}${f.cfgattr ? ` (${trim(f.cfgattr, 80)})` : ''}${user ? ` by ${trim(user)}` : ''}${f.ui ? ` via ${trim(f.ui, 60)}` : ''}`.trim() };
    }
    if (/conserve mode|\bha (state|member|device|failover|primary|master|cluster|sync)|hbdev|(system|unit|device) (reboot|restart|shut ?down)|rebooted|power (supply|failure)|disk (error|failure)|fan (fail|error)|temperature/.test(d)
        || (/crash|panic|reboot|restart|conserve/.test(d) && (LEVEL[String(f.level).toLowerCase()]))) {
      return { kind: 'system_event', level: LEVEL[String(f.level).toLowerCase()] || 'warning', user, srcip: null, summary: `${trim(desc || f.msg || 'System event', 120)}${f.msg && desc ? `: ${trim(f.msg, 120)}` : ''}` };
    }
    return null;
  }

  if (type === 'utm') {
    if (sub === 'ips' || sub === 'anomaly') {
      const sev = String(f.severity || '').toLowerCase();
      const level = SEVERITY[sev] || (LEVEL[String(f.level).toLowerCase()] ? 'warning' : 'info');
      return { kind: 'ips', level, user, srcip: src, attack: f.attack || f.msg || null, summary: `${sub === 'anomaly' ? 'Anomaly' : 'IPS'}: ${trim(f.attack || f.msg || 'attack', 100)} from ${trim(src || '?')} to ${trim(f.dstip || '?')}${sev ? `, severity ${sev}` : ''}${f.action ? `, ${trim(f.action, 30)}` : ''}` };
    }
    if (sub === 'virus' || sub === 'emailfilter' && /virus|malware/.test(d)) {
      return { kind: 'malware', level: /blocked|quarantin|dropped|reset/.test(String(f.action || '').toLowerCase()) ? 'warning' : 'info', user, srcip: src, attack: f.virus || null, summary: `Malware: ${trim(f.virus || f.msg || 'virus', 100)} ${f.dstip ? `${trim(src || '?')} → ${trim(f.dstip)}` : ''}${f.action ? `, ${trim(f.action, 30)}` : ''}`.trim() };
    }
    if (sub === 'webfilter' && /block/.test(String(f.action || '').toLowerCase())) return { kind: 'web_blocked', level: 'info', user, srcip: src, summary: `Web blocked: ${trim(f.hostname || f.url || '?', 100)}${f.catdesc ? ` (${trim(f.catdesc, 40)})` : ''} for ${trim(user || src || '?')}` };
  }
  return null;
}

/** The numbers of a traffic log that go into the hourly summary, or null when the line is not a finished session or a block. */
function trafficOf(f) {
  if (String(f.type).toLowerCase() !== 'traffic') return null;
  const action = String(f.action || '').toLowerCase();
  const denied = /^(deny|blocked|block|dropped|drop)$/.test(action) || /^block/.test(String(f.utmaction || '').toLowerCase());
  const sent = Number(f.sentbyte); const rcvd = Number(f.rcvdbyte);
  const hasBytes = Number.isFinite(sent) || Number.isFinite(rcvd);
  if (!denied && !hasBytes) return null; // the start of a session: it is counted when it ends
  if (!denied && /^(start|accept)$/.test(action) && !hasBytes) return null;
  const name = (v) => (v && v !== 'N/A' && v !== 'unknown' ? String(v).slice(0, 80) : null);
  return {
    blocked: denied, out: Number.isFinite(sent) ? sent : 0, in: Number.isFinite(rcvd) ? rcvd : 0,
    src: f.srcip || null, srcName: name(f.srcname), dst: name(f.hostname) || f.dstip || null, dstIp: f.dstip || null,
    app: name(f.app) || name(f.service), country: name(f.dstcountry), service: name(f.service), policy: f.policyid ? `${f.policyid}${name(f.policyname) ? ` ${f.policyname}` : ''}` : null, user: name(f.user) || name(f.unauthuser),
  };
}

module.exports = { classify, trafficOf };
