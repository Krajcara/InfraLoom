// A library of packet-capture filters (the filter of the capture itself — BPF, as tcpdump, dumpcap, tshark -f, Wireshark's capture
// filter and the FortiGate sniffer read it — and the display filter of Wireshark / tshark -Y) for the usual network problems,
// and the commands that use them. Pure functions: nothing here touches the network.

const octet = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`^${octet}(\\.${octet}){3}$`);
const IPV6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:))$/i;

/** What a field may hold. Each checker returns the cleaned value, or null when it is not valid. */
export const FIELD_KINDS = {
  ip: { label: 'an IP address', example: '10.1.0.5', clean: (v) => { const s = String(v).trim(); return IPV4.test(s) || IPV6.test(s) ? s.toLowerCase() : null; } },
  cidr: { label: 'a network, like 10.1.0.0/24', example: '10.1.0.0/24', clean: (v) => { const m = /^(.+)\/(\d{1,3})$/.exec(String(v).trim()); if (!m) return null; const n = Number(m[2]); return (IPV4.test(m[1]) && n <= 32) || (IPV6.test(m[1]) && n <= 128) ? `${m[1].toLowerCase()}/${n}` : null; } },
  mac: { label: 'a MAC address', example: 'aa:bb:cc:dd:ee:ff', clean: (v) => { const s = String(v).trim().toLowerCase().replace(/-/g, ':'); return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s) ? s : null; } },
  port: { label: 'a port, 1 to 65535', example: '443', clean: (v) => { const s = String(v).trim(); return /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535 ? String(+s) : null; } },
  vlan: { label: 'a VLAN, 1 to 4094', example: '20', clean: (v) => { const s = String(v).trim(); return /^\d{1,4}$/.test(s) && +s >= 1 && +s <= 4094 ? String(+s) : null; } },
  name: { label: 'a name, like example.com', example: 'example.com', clean: (v) => { const s = String(v).trim().toLowerCase(); return /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/.test(s) ? s : null; } },
};

const f = (key, kind, label) => ({ key, kind, label });
const IP = (key = 'ip', label = 'IP address') => f(key, 'ip', label);

// id, group, title, about, bpf (capture filter), display (display filter), fields, mikrotik (the sniffer settings, where they fit)
const E = (id, group, title, about, bpf, display, fields = [], mikrotik = null) => ({ id, group, title, about, bpf, display, fields, mikrotik });

export const GROUPS = ['The basics', 'DNS', 'DHCP', 'ARP and the local network', 'TCP problems', 'ICMP and MTU', 'Services', 'VPN and authentication', 'Security'];

export const FILTERS = [
  // ── the basics
  E('host', 'The basics', 'Everything to and from a host', 'All traffic of one machine, in both directions.', 'host {ip}', 'ip.addr == {ip}', [IP()], { 'filter-ip-address': '{ip}' }),
  E('two-hosts', 'The basics', 'Traffic between two hosts', 'Only the conversation between two machines.', 'host {a} and host {b}', 'ip.addr == {a} && ip.addr == {b}', [IP('a', 'First host'), IP('b', 'Second host')]),
  E('net', 'The basics', 'A whole network', 'Traffic to or from any address of a network.', 'net {net}', 'ip.addr == {net}', [f('net', 'cidr', 'Network')], { 'filter-ip-address': '{net}' }),
  E('port', 'The basics', 'A port, either direction', 'TCP or UDP on one port, whoever is the client.', 'port {port}', 'tcp.port == {port} || udp.port == {port}', [f('port', 'port', 'Port')], { 'filter-port': '{port}' }),
  E('host-port', 'The basics', 'A host and one TCP port', 'One service of one machine.', 'host {ip} and tcp port {port}', 'ip.addr == {ip} && tcp.port == {port}', [IP(), f('port', 'port', 'TCP port')], { 'filter-ip-address': '{ip}', 'filter-port': '{port}', 'filter-ip-protocol': 'tcp' }),
  E('mac', 'The basics', 'A MAC address', 'Everything sent from or to one network card, whatever its IP address.', 'ether host {mac}', 'eth.addr == {mac}', [f('mac', 'mac', 'MAC address')], { 'filter-mac-address': '{mac}' }),
  E('not-ssh', 'The basics', 'Everything except my own SSH session', 'When you capture over SSH, the capture would otherwise record its own transport.', 'not port 22', '!(tcp.port == 22)'),
  E('not-me', 'The basics', 'Everything except one host', 'Leave out a noisy machine (the one you are capturing from, a monitoring server).', 'not host {ip}', '!(ip.addr == {ip})', [IP()]),
  // ── DNS
  E('dns', 'DNS', 'All DNS', 'Queries and answers, over UDP and TCP.', 'port 53', 'dns', [], { 'filter-port': '53' }),
  E('dns-client', 'DNS', 'The DNS queries of one client', 'What a machine asks its DNS server for.', 'src host {ip} and udp dst port 53', 'dns.flags.response == 0 && ip.src == {ip}', [IP('ip', 'Client')]),
  E('dns-name', 'DNS', 'A name that is looked up', 'Queries and answers that mention a name.', 'port 53', 'dns.qry.name contains "{name}"', [f('name', 'name', 'Name (or a part of it)')]),
  E('dns-fail', 'DNS', 'DNS answers that are errors', 'NXDOMAIN, SERVFAIL, REFUSED: any answer whose result code is not "no error".', 'port 53', 'dns.flags.rcode != 0'),
  E('dns-slow', 'DNS', 'Slow DNS answers', 'Answers that took more than half a second.', 'port 53', 'dns.time > 0.5'),
  E('dns-noanswer', 'DNS', 'DNS queries nobody answered', 'A query without a matching answer is shown by Wireshark as "no response seen".', 'port 53', 'dns && !dns.response_in && dns.flags.response == 0'),
  // ── DHCP
  E('dhcp', 'DHCP', 'The whole DHCP conversation', 'Discover, Offer, Request, Acknowledge — and the NAKs.', 'udp port 67 or udp port 68', 'dhcp', [], { 'filter-ip-protocol': 'udp', 'filter-port': '67' }),
  E('dhcp-discover', 'DHCP', 'Clients looking for a DHCP server', 'DHCP Discover broadcasts: if they appear and no Offer follows, nobody answers.', 'udp dst port 67', 'dhcp.option.dhcp == 1'),
  E('dhcp-offer', 'DHCP', 'DHCP offers — who answers?', 'More than one source address here means more than one DHCP server (a rogue one, or a router that was left on).', 'udp src port 67', 'dhcp.option.dhcp == 2'),
  E('dhcp-nak', 'DHCP', 'DHCP NAKs', 'The server refused a request: wrong network, a lease that is gone, a second server.', 'udp port 67 or udp port 68', 'dhcp.option.dhcp == 6'),
  // ── ARP and the local network
  E('arp', 'ARP and the local network', 'All ARP', 'Who has which address.', 'arp', 'arp', [], { 'filter-mac-protocol': 'arp' }),
  E('arp-host', 'ARP and the local network', 'ARP about one address', 'Requests and answers for one IP address.', 'arp host {ip}', 'arp.dst.proto_ipv4 == {ip} || arp.src.proto_ipv4 == {ip}', [IP()]),
  E('arp-dup', 'ARP and the local network', 'Duplicate IP addresses', 'Wireshark marks an address that two MAC addresses claim.', 'arp', 'arp.duplicate-address-detected || arp.duplicate-address-frame'),
  E('arp-requests', 'ARP and the local network', 'ARP requests (look for a storm)', 'Hundreds a second means a loop, a scanner or a misbehaving device.', 'arp[6:2] = 1', 'arp.opcode == 1'),
  E('broadcast', 'ARP and the local network', 'Broadcasts', 'Frames for everybody; a lot of them slows a network down.', 'ether broadcast', 'eth.dst == ff:ff:ff:ff:ff:ff'),
  E('multicast', 'ARP and the local network', 'Multicast', 'Frames for a group; includes mDNS, IPv6 discovery and streaming.', 'ether multicast', 'eth.ig == 1'),
  E('stp', 'ARP and the local network', 'Spanning tree', 'Topology changes and who is root; frequent changes mean a flapping link.', 'stp', 'stp'),
  E('lldp', 'ARP and the local network', 'LLDP', 'What each switch or device announces about itself (name, port, VLAN).', 'ether proto 0x88cc', 'lldp'),
  E('cdp', 'ARP and the local network', 'CDP', 'The same, from Cisco equipment.', 'ether dst 01:00:0c:cc:cc:cc', 'cdp'),
  E('vlan-any', 'ARP and the local network', 'All VLAN-tagged frames', 'Shows whether tagged traffic arrives where you capture.', 'vlan', 'vlan'),
  E('vlan-one', 'ARP and the local network', 'One VLAN', 'Everything tagged with one VLAN id.', 'vlan {vlan}', 'vlan.id == {vlan}', [f('vlan', 'vlan', 'VLAN id')]),
  E('ipv6-ra', 'ARP and the local network', 'IPv6 router advertisements', 'Who tells the network it is an IPv6 router (a rogue one is a classic).', 'icmp6 and ip6[40] == 134', 'icmpv6.type == 134'),
  // ── TCP problems
  E('tcp-retrans', 'TCP problems', 'Retransmissions', 'Packets that had to be sent again: loss, a bad link or an overloaded host.', 'tcp', 'tcp.analysis.retransmission'),
  E('tcp-problems', 'TCP problems', 'Everything Wireshark flags in TCP', 'Retransmissions, duplicate ACKs, lost segments, zero windows, resets — all in one list.', 'tcp', 'tcp.analysis.flags && !tcp.analysis.window_update'),
  E('tcp-reset', 'TCP problems', 'Connections that are reset', 'A reset (RST) is a refusal or an abrupt end: a closed port, a firewall, a crashed service.', 'tcp[tcpflags] & tcp-rst != 0', 'tcp.flags.reset == 1'),
  E('tcp-syn', 'TCP problems', 'Connection attempts (SYN)', 'New connections being opened; lots from one source is a scan.', 'tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn', 'tcp.flags.syn == 1 && tcp.flags.ack == 0'),
  E('tcp-nosyn-ack', 'TCP problems', 'Connections that got no answer', 'A SYN with no SYN-ACK in return: a firewall drops it, or the host is down.', 'tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn', 'tcp.flags.syn == 1 && tcp.flags.ack == 0 && !tcp.analysis.retransmission && tcp.analysis.initial_rtt'),
  E('tcp-zerowin', 'TCP problems', 'Zero window', 'A receiver that cannot keep up tells the sender to stop.', 'tcp', 'tcp.analysis.zero_window'),
  E('frag', 'TCP problems', 'Fragmented packets', 'Packets cut in pieces on the way, usually because of an MTU that is too small.', 'ip[6:2] & 0x3fff != 0', 'ip.flags.mf == 1 || ip.frag_offset > 0'),
  // ── ICMP and MTU
  E('icmp', 'ICMP and MTU', 'All ICMP', 'Ping and the messages routers send about problems.', 'icmp', 'icmp', [], { 'filter-ip-protocol': 'icmp' }),
  E('ping', 'ICMP and MTU', 'Ping requests and replies', 'Is the answer coming back at all.', 'icmp[icmptype] = icmp-echo or icmp[icmptype] = icmp-echoreply', 'icmp.type == 8 || icmp.type == 0'),
  E('icmp-unreach', 'ICMP and MTU', 'Destination unreachable', 'A router or a host says it cannot deliver.', 'icmp[icmptype] = icmp-unreach', 'icmp.type == 3'),
  E('icmp-frag', 'ICMP and MTU', 'Fragmentation needed (MTU)', 'The packet is too big and may not be fragmented: it carries the MTU the router can pass.', 'icmp[icmptype] = icmp-unreach and icmp[icmpcode] = 4', 'icmp.type == 3 && icmp.code == 4'),
  // ── services
  E('ntp', 'Services', 'NTP', 'Time synchronisation.', 'udp port 123', 'ntp', [], { 'filter-ip-protocol': 'udp', 'filter-port': '123' }),
  E('snmp', 'Services', 'SNMP', 'Polling and traps (InfraLoom reads devices this way).', 'udp port 161 or udp port 162', 'snmp'),
  E('syslog', 'Services', 'Syslog', 'Logs sent to a server.', 'udp port 514', 'syslog'),
  E('tls', 'Services', 'TLS handshakes', 'Who connects to what, and the certificate and name they ask for.', 'tcp port 443', 'tls.handshake'),
  E('tls-alert', 'Services', 'TLS alerts', 'A handshake that failed, with the reason (certificate, protocol, cipher).', 'tcp port 443', 'tls.alert_message'),
  E('http', 'Services', 'HTTP requests', 'Plain-text web requests (not HTTPS).', 'tcp port 80', 'http.request'),
  E('smtp', 'Services', 'Mail sending (SMTP)', 'Ports 25, 465 and 587.', 'tcp port 25 or tcp port 465 or tcp port 587', 'smtp'),
  E('rdp', 'Services', 'Remote Desktop', 'RDP sessions.', 'tcp port 3389', 'rdp'),
  E('smb', 'Services', 'File sharing (SMB)', 'Windows file shares.', 'tcp port 445', 'smb || smb2'),
  E('ldap', 'Services', 'Directory (LDAP)', 'Plain LDAP and LDAPS.', 'tcp port 389 or tcp port 636', 'ldap'),
  E('mdns', 'Services', 'mDNS and SSDP chatter', 'The "who is there" noise of printers, TVs and phones.', 'udp port 5353 or udp port 1900', 'mdns || ssdp'),
  E('wol', 'Services', 'Wake-on-LAN', 'The magic packet that wakes a machine.', 'udp port 9 or ether proto 0x0842', 'wol'),
  // ── VPN and authentication
  E('ipsec', 'VPN and authentication', 'IPsec VPN negotiation', 'IKE on ports 500 and 4500; shows which side stops answering.', 'udp port 500 or udp port 4500', 'isakmp || udpencap'),
  E('openvpn', 'VPN and authentication', 'OpenVPN', 'The default port 1194.', 'udp port 1194', 'openvpn'),
  E('radius', 'VPN and authentication', 'RADIUS', 'Authentication of Wi-Fi, VPN and switch ports.', 'udp port 1812 or udp port 1813', 'radius'),
  E('kerberos', 'VPN and authentication', 'Kerberos', 'Windows domain logons.', 'port 88', 'kerberos'),
  // ── security
  E('cleartext', 'Security', 'Passwords sent in the clear', 'FTP, Telnet and basic HTTP authentication: if anything shows up, something old is still in use.', 'port 21 or port 23 or port 80', 'http.authbasic || ftp.request.command == "PASS" || telnet'),
  E('scan', 'Security', 'Port scans', 'Many different ports tried from one source: look at the SYNs and the resets together.', 'tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn', 'tcp.flags.syn == 1 && tcp.flags.ack == 0 && tcp.window_size <= 1024'),
];

// ── filling in the fields ────────────────────────────────────────────────

/** Replaces {field} in a template with the cleaned values. Returns { text, missing: [keys that are empty or wrong] }. */
export function fillTemplate(template, fields, values) {
  if (template == null) return { text: null, missing: [] };
  const missing = [];
  const text = template.replace(/\{(\w+)\}/g, (_, key) => {
    const field = fields.find((x) => x.key === key);
    const v = field ? FIELD_KINDS[field.kind].clean(values[key] ?? '') : null;
    if (v === null) { if (!missing.includes(key)) missing.push(key); return `{${key}}`; }
    return v;
  });
  return { text, missing };
}

/** Does the capture filter only use what the FortiGate sniffer is known to read? Complex expressions (byte offsets) may not work there. */
export const fortigateSimple = (bpf) => !!bpf && !/[[\]]/.test(bpf);

export const INTERFACE_RE = /^[A-Za-z0-9_.:/-]{1,40}$/;
export const FILE_RE = /^[A-Za-z0-9_.-]{1,60}$/;

const q = (s) => `'${s}'`;

/**
 * The commands for one filter. options: { iface, seconds, snap: 'headers' | 'full', file, fgVerbose, fgCount }.
 * Each item: { id, title, lines: [command], note }. A tool that cannot take the filter is left out, with the reason.
 */
export function buildCommands(entry, values, options = {}) {
  const o = { iface: 'any', seconds: 60, snap: 'headers', file: 'capture', fgVerbose: 4, fgCount: 100, ...options };
  const bad = [];
  if (!INTERFACE_RE.test(o.iface)) bad.push('interface');
  if (!FILE_RE.test(o.file)) bad.push('file name');
  if (!Number.isInteger(+o.seconds) || +o.seconds < 1 || +o.seconds > 86400) bad.push('seconds');
  if (bad.length) return { error: `Check: ${bad.join(', ')}`, items: [] };
  const snap = o.snap === 'full' ? 262144 : 96;
  const cap = fillTemplate(entry.bpf, entry.fields, values);
  const dis = fillTemplate(entry.display, entry.fields, values);
  const missing = [...new Set([...cap.missing, ...dis.missing])];
  if (missing.length) return { error: null, missing, items: [] };
  const file = `${o.file}.pcap`;
  const items = [];

  if (cap.text) {
    items.push({ id: 'tcpdump', title: 'tcpdump (Linux)', lines: [`sudo timeout ${o.seconds} tcpdump -i ${o.iface} -nn -s ${snap} -w ${file} ${q(cap.text)}`], note: `Stops after ${o.seconds} s. ${o.snap === 'headers' ? 'Only the first 96 bytes of each packet are kept (headers, not content).' : 'Whole packets are kept: the file contains everything that was sent.'}` });
    items.push({ id: 'tshark', title: 'tshark (capture, then read)', lines: [`sudo tshark -i ${o.iface} -f ${q(cap.text)} -a duration:${o.seconds} -s ${snap} -w ${file}`, ...(dis.text ? [`tshark -r ${file} -Y ${q(dis.text)}`] : []), `tshark -r ${file} -q -z conv,ip`], note: 'The first line captures, the second reads it with the display filter, the third lists who talked to whom.' });
    items.push({ id: 'dumpcap', title: 'dumpcap (capture only, lightest)', lines: [`sudo dumpcap -i ${o.iface} -f ${q(cap.text)} -a duration:${o.seconds} -s ${snap} -w ${file}`], note: 'Part of Wireshark; uses the least memory on a busy link.' });
  }
  items.push({
    id: 'wireshark', title: 'Wireshark (desktop)',
    lines: [...(cap.text ? [`Capture → Capture Filters… → enter: ${cap.text}`] : []), ...(dis.text ? [`Display filter bar: ${dis.text}`] : [])],
    note: 'Choose the interface in the capture options, paste the capture filter there (it limits what is recorded), and the display filter in the bar above the packet list (it only hides).',
  });
  if (cap.text) {
    const fgIface = o.iface;
    items.push({
      id: 'fortigate', title: 'FortiGate sniffer',
      lines: [`diagnose sniffer packet ${fgIface} ${q(cap.text)} ${o.fgVerbose} ${o.fgCount} l`],
      note: `Verbosity ${o.fgVerbose}: ${+o.fgVerbose === 4 ? 'headers with the interface name' : +o.fgVerbose === 6 ? 'whole packets with the interface name' : 'see the FortiOS CLI reference'}; stops after ${o.fgCount} packets, or with Ctrl+C. "l" prints local time.${fortigateSimple(cap.text) ? '' : ' This filter reads bytes at an offset; if the FortiGate refuses it, use a simpler one.'}`,
    });
  } else {
    items.push({ id: 'fortigate', title: 'FortiGate sniffer', lines: [`diagnose sniffer packet ${o.iface} none ${o.fgVerbose} ${o.fgCount} l`], note: 'This filter is a display filter only; the sniffer takes a capture filter, so everything is captured. Capture first and filter later (tshark -Y, or Wireshark).' });
  }
  if (entry.mikrotik) {
    const sets = Object.entries(entry.mikrotik).map(([k, v]) => { const r = fillTemplate(v, entry.fields, values); return `${k}=${r.text}`; });
    items.push({
      id: 'mikrotik', title: 'MikroTik sniffer',
      lines: [`/tool sniffer set filter-interface=${o.iface === 'any' ? 'all' : o.iface} ${sets.join(' ')} file-name=${file} file-limit=10000KiB`, '/tool sniffer start', '/tool sniffer stop'],
      note: 'Start, wait, stop; the file is in Files. The MikroTik sniffer has its own simple fields, not capture-filter text, so this is the closest equivalent.',
    });
  }
  return { error: null, missing: [], items, capture: cap.text, display: dis.text };
}
