# InfraLoom

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22](https://img.shields.io/badge/node-22-339933.svg)

**Self-hosted monitoring for IT infrastructure.** One dashboard for uptime, network devices, UPS units, DNS,
hypervisors, patch status and licence expiry — with alerts to your phone or chat, and public status pages you can
put on a NOC screen.

InfraLoom runs on a single Linux server, stores everything in an encrypted SQLite database, and needs no
cloud account.

> **About this project.** InfraLoom is built mainly for my own needs: it monitors and documents the infrastructure I
> look after, and its features follow what I use. I share it as it is, in case it is useful to someone else — it comes
> with no support and no warranty (see the [MIT license](LICENSE)), and I may not take every feature request or pull
> request. If it almost fits your environment, you are welcome to fork it and change it to suit you. Bug reports are
> welcome, ideally with the steps to reproduce. Most of it was developed and tried against my own setup (FortiGate 100F
> on FortiOS 7.4, Proxmox VE, FortiSwitch and FortiAP over FortiLink, MikroTik over SNMP); other vendors and versions may
> need adjustments, and Hyper-V and VMware ESXi are less proven than Proxmox.

## What it does

InfraLoom **monitors** your infrastructure. It does not provision VMs, run configuration management, or manage
container clusters. The few things it can *change* are deliberately limited and role-restricted: power actions on
hypervisor guests, applying OS updates (Patch Management), Wake-on-LAN, and an in-app SSH terminal.

Next to the monitoring it can **document** the physical network — technical rooms, racks, devices, patch panels, wall
outlets and cables ([Cabling](#cabling-technical-rooms)). That part only records what you tell it and changes nothing
on your network.

### Monitoring and alerting

| Module | What you get |
|---|---|
| **Uptime Monitor** | HTTP(S), TCP, ICMP ping, DNS, keyword, JSON query, Docker and push-heartbeat monitors; SSL certificate expiry tracking |
| **Routers / Switches / Access Points** | Ping-backed status; optional SNMP (v1, v2c, v3) for interface statistics. **FortiGate** integration discovers FortiSwitches and FortiAPs through the REST API and shows the online/offline state the FortiGate itself reports. Opt-in [device health](#network-device-health): FortiGate (CPU/memory, HA, IPsec tunnels, licences, SD-WAN) and any SNMP device such as **MikroTik** (CPU, memory, disk, temperature, restarts, watched uplinks) |
| **UPS** | SNMP (v1, v2c, v3) via the standard UPS-MIB, with an APC PowerNet fallback: battery charge and runtime, load, input/output voltage, history charts, and alerts for power loss, low battery, power restored and unreachable UPS |
| **DNS / DNS Analytics** | Health of local DNS servers (Technitium, Pi-hole, AdGuard Home), SPF/DKIM/DMARC/MX domain checks (asked of public DNS servers by default — see *Domain checks* in Settings), Cloudflare zone integration, Technitium query statistics |
| **Net Speed** | Scheduled internet speed tests (Cloudflare, Ookla CLI, LibreSpeed CLI) with history and retention |
| **DMARC** | Reads the DMARC aggregate reports that mail receivers send to a dedicated Microsoft 365 mailbox and shows who sends mail in the name of your domains, with alerts for unapproved senders — see [DMARC reports](#dmarc-reports) |
| **Traffic** | The load of the interfaces you choose (the WAN of a FortiGate, uplinks, trunk ports), as a history with charts, the average, peak and 95th percentile, and an alert when one stays loaded — see [Traffic](#traffic) |
| **Firewall logs** | FortiGate logs (and MikroTik syslog and NetFlow) received: the traffic summed up by the hour (who uses the most, where it goes, applications, countries, what was blocked), and the security events — failed logins, changes of the configuration, attacks that were stopped, VPN and system events — with alerts, and a warning when the firewall stops sending — see [Firewall logs](#firewall-logs) |
| **Diagnostics** and **Capture helper** | Ping, traceroute, DNS (several servers side by side), TCP ports, TLS certificate, an HTTP request with timings and the path MTU, run from the server; and a library of packet-capture filters with the commands for tcpdump, tshark, Wireshark and the FortiGate and MikroTik sniffers — see [Diagnostics and Capture helper](#diagnostics-and-capture-helper) |
| **MyIP** | Public IP lookup from several sources (the dashboard card shows the location from ip.sb, in full), IP query, DNS resolver check (UDP and DoH) |
| **Hypervisors** | Proxmox VE, Hyper-V and VMware ESXi (7.0+) in one view: node and guest drill-down, usage history, connection health alerts, [usage thresholds](#hypervisor-usage-thresholds) (storage, RAM, CPU, disk, offline nodes), power actions, SSH web terminal |
| **Network Scanner** | `arp-scan` device inventory, on-demand `nmap` deep scan, Wake-on-LAN, new/offline device alerts |
| **Patch Management** | See pending OS updates per guest (dry run), approve, apply with live output. Debian/Ubuntu (apt), RHEL/Fedora (dnf/yum), Alpine (apk) and Windows Update, across Proxmox VMs and LXC and Hyper-V VMs. Waits for other package managers, explains why a run failed, and tells you when a machine needs a restart — see [What a patch run does](#what-a-patch-run-does) |

### Network device health

Opt-in, per device: press **Health** on a router, switch or access point, then **Start collecting health data**. InfraLoom reads it every
couple of minutes and alerts with the same discipline as the hypervisor thresholds (a level must hold for two readings, no repeats,
"back to normal" is announced; a [maintenance window](#maintenance-windows) on the device mutes it).

- **FortiGate** (brand `fortigate`, over the REST API token you already use for switch/AP sync): CPU and memory (also disk and session
  count are shown), **IPsec tunnels** (site-to-site tunnels only — dial-up templates are ignored; a configured tunnel that never came up is
  reported as down; some phase-2 selectors down is a warning), **HA** (a cluster that has fewer members than it had), **licences and
  support** (any entitlement with an expiry date: warning 30 days before, critical 7 days before or expired), and **SD-WAN** health-check members that are down.
- **Any SNMP device** — built for **MikroTik** RouterOS, but it uses the standard HOST-RESOURCES and IF-MIB objects, so Cisco, HP and Linux
  work too: CPU, memory, disk (RouterOS's small system flash is shown but never alerted — it is normally nearly full and does not grow), **temperature** (MikroTik health sensors, where the model has them), voltage (shown), **restarts**
  (uptime went backwards), and the **interface links you tick** as must-stay-up (uplinks). Links you do not tick are never alerted — unplugged
  desk ports are not incidents.
- **FortiLink-managed switches and access points** — read through the FortiGate that manages them, with the same API token: no route to the FortiLink
  network and no SNMP needed. Turn on **Also read the health of the switches and access points this FortiGate manages** in the FortiGate's Health panel; every
  managed device then gets its own Health button. Switches: CPU, memory, temperature, **PoE budget** (watts used of the maximum), fans and power supplies, uptime,
  and **FortiGate's own rating** (good / fair / poor). Access points: CPU, memory, clients, uplink, which switch and port they hang on (LLDP), radios, firmware, and the same rating.
  Alerts: CPU / memory / temperature / PoE budget over a level, a failed fan or power supply, FortiGate rating the device worse than good, an AP uplink rated worse than good, and
  **every restart** — a switch whose uptime went backwards, an AP whose last-reboot time moved forward. A single restart is reported by name; several found in the same
  reading are combined into one message that names every device, so a power cut does not send twelve messages. An AP that is not connected is not judged (its
  numbers are stale); a device missing from the reply is left as it was.
- **Health data cannot be read** (the FortiGate API or SNMP stops answering) is itself an alert, so a silent device is not mistaken for a healthy one.
- Each FortiGate section is read on its own: one that this FortiOS version does not offer, or that the API token may not read, shows its
  reason (`HTTP 403`, `404`) and the others carry on. **Raw reply** shows exactly what the device answered, so a value that looks wrong
  can be checked against the field names it was read from.
- Default levels (**Health thresholds** on the page, administrators): CPU 90 / 98 %, memory 82 / 90 % (FortiOS enters conserve mode at 88 %),
  disk 85 / 95 %, temperature 70 / 85 °C, PoE budget 80 / 90 %, licences 30 / 7 days.

Setting up the devices:

- **FortiGate:** the REST API administrator needs read access to system, VPN and network information. If a section shows `HTTP 403`, its profile
  lacks that. The FortiGate is reached on HTTPS port 443 and the API must be allowed from the InfraLoom server (Trusted Hosts).
- **MikroTik:** enable SNMP (`/snmp set enabled=yes`), add a read-only community (`/snmp community add name=<community> addresses=<InfraLoom IP>/32`),
  then put the same community on the device in InfraLoom. RouterOS reports temperature in tenths of a degree; InfraLoom converts it.

Limits: FortiOS field names differ between versions and the parsers accept several shapes, but they were written against the
documented API, not against every release — use **Raw reply** when something looks off. Levels are global (not per device), and
there are no repeat reminders.

### Cabling (technical rooms)

**Cabling** documents your network equipment room by room: rooms and offices, racks, devices (switch, router, firewall, hypervisor, server, NAS,
patch panel, fibre panel, desktop, notebook, printer, access point), and the **ports** of each device. It is documentation only — nothing here changes your network.

- **Port groups and templates.** A device is created from groups (`Gi1/0/` 1–24 RJ45 1G PoE, `Te1/1/` 1–4 SFP+ 10G…) and the ports are generated; save a set of groups as a
  template (for example *FortiSwitch 124F-POE*) and the next switch is one click. Ports can be edited one by one afterwards, and more can be added later.
- **Room view.** Racks with their devices from the top unit down, each device's faceplate with its ports (switches in two rows like the real thing, panels in one),
  a panel with the selected port's details, and a table of the other devices in the room.
- **Wall outlets.** On a patch-panel port, record the office and the outlet label its rear side runs to, and the permanent cable (type, length) between the port and the outlet;
  every office (a corridor or a hall works as well) lists its outlets with their **state** — *in use* when patched on the panel, *free* when not — the **type** (LAN or telephone), what is patched to
  them, the device recorded at the outlet if any (flagged *not patched* when a device is recorded but the outlet is not patched), and the panel, port, room and rack. The list filters by in use, free, LAN
  and telephone, shows the counts per office, and downloads as a CSV of all outlets.
- **Links and trace.** Connect one side of a port to a free side of another (**Connect…** in the port panel, or **New link**). A device port has one side; a patch-panel or fibre-panel
  port has two: *front* (patch cords in the room) and *rear* (the permanent installation). Select any port and the **trace** shows where it goes — switch → patch cord → panel →
  permanent cable → wall outlet → patch cord → desktop — with the cable type, length and colour of every step, and it reads the same from either end. Ports are coloured by where they
  lead: to an office, straight to a device, fibre, a wall outlet without a patch cord yet, or free. The rules keep the documentation honest: only panels have a rear side, two rear sides
  are a permanent installation, a patch cord reaches a rear side only as the cord from a recorded wall outlet to a device, and a port side holds one cable (the message says who has it).
  A ring of cables or an absurdly long chain ends the trace with a note instead of hanging. Operators can edit and unplug cables (patching changes all the time); administrators delete devices.
- **Telephone lines.** Some patch-panel ports lead to a telephone exchange, not to the network. The port stays RJ45; give it the **Telephone** service (per port, per port group or template, or for a run of
  outlets in *Label wall outlets*) and use the **Telephone** cable for the patch cord and for the cable to the wall socket. Add the exchange as a *Telephone exchange (PBX)* with RJ11/RJ12, RJ21 or LSA/Krone ports.
  Telephone lines have their own colour (magenta) on ports, in the legend, in the trace (*Telephone outlet T-05*) and in an office's outlet list; a path with a telephone port, a telephone cable or an exchange on it is a
  telephone line, and that colour wins over the others. A telephone outlet nobody has patched yet keeps the dashed outlet look, with a telephone border.
- **Links between rooms.** A *trunk* is a fibre or copper run between two rooms (fibre type, strands, length). The permanent link between the two panels uses strands of it: a duplex fibre
  link takes a pair, assigned automatically (1-2, 3-4…) or chosen by you, and a strand cannot be used twice. The page shows each trunk's strands in use, and every room lists the trunks that
  reach it and counts them in its KPIs. A trunk that links use cannot be deleted, shrunk below the strands in use, or moved to other rooms.
- **Rack view.** Switch the room between *Ports* and *Rack view*: every rack unit by unit (U1 at the bottom by default, or at the top for a rack that is labelled that way — set per rack, so the numbers match the ones printed on the rack; a device's position is the lowest unit number it covers), devices as blocks as tall as their height in U, free units with a **+** that opens the
  new-device form already placed at that unit, and a live dot on devices linked to monitoring. A device records its height in U; two devices cannot use the same unit, and a device cannot reach past the top of the rack.
- **What is connected.** For any device: everything that is reached through it (switch → panel → wall outlet → desktop, or over the fibre to the other room), the wall outlets it reaches and which offices that touches (counted even when no device is recorded behind an outlet yet), and how many of those devices are
  already down — the answer to "what goes quiet if I switch this off?".
- **Bulk work.** *Bulk connect* joins a run of ports to a run of ports (panel 1–24 to switch 1–24, or ODF-1 1–6 to ODF-2 1–6 over a trunk with the strand pairs taken in turn): the preview lists every pair and what is wrong with it, and the
  real run makes all of them or none. On a patch panel, *Label wall outlets* names a run of ports in one go (1–24 → K-01…K-24 in an office, with the cable to the outlet).
- **Maintenance for the room.** One button holds the alerts of everything in the room that InfraLoom monitors, for a chosen time, so nobody is paged for the work; the windows appear in the Maintenance module and can be ended from the room.
- **Map.** The rooms page draws the rooms and the trunks between them with the strands in use (red when a trunk is nearly full).
- **What is missing.** A patch-panel port that is patched on its front but has no office or no outlet label (or only one of the two) is drawn **red**, and so is the switch or router port that leads to it, because
  the whole connection is unfinished; a banner on the room counts them, and selecting a port says exactly what is missing and offers *Go to that port* / *Fill in*. A rear cabled to another panel (a trunk) and fibre panels are never
  flagged, and an untouched, unpatched panel port is simply unused.
- **Reports** (menu *Cabling → Reports*, optionally per room): **Ports in use** for switches, routers and firewalls (or servers and hypervisors) — in use and free per device, where each used port leads, console ports left out;
  **Patch panel gaps** — the list behind the red ports; **Other checks** — devices with no place and devices in a rack without a unit. Each list downloads as a CSV that opens correctly in Excel (UTF-8, `sep=;`).
- **Search** by port, wall outlet, IP address, serial number or device name; a found port says where it leads and a found device where it sits in its rack.
- **Linked to monitoring.** A device can point at something InfraLoom monitors (router, switch, access point, hypervisor, UPS): its live state and alerts show on the room view,
  and **Add from monitored devices** turns an existing item into an inventory device in one click — pick a template and a room first and the ports are created with it (on a device that is already in the inventory, choosing a template loads it under *Add ports*). The link is a soft reference, so FortiGate-discovered switches and APs
  can come and go without taking the documentation with them.
- **Access.** Everyone who can sign in can read; operators and administrators create and edit (including connecting and unplugging cables); only administrators delete devices, ports,
  racks, rooms, templates and trunks. Every change is written to the audit log.
  In **Settings → Cabling module** an administrator can switch the module off or limit it to your own networks (a list that excludes your own address is refused).
  Behind a reverse proxy the address comes from `X-Forwarded-For` (one proxy is trusted).
- CSV/Excel import and export come in the next release.

`npm test` runs the module's tests: validation, port generation, the trace engine (loops, long chains, outlets, fibre paths), triggers, the network matcher, and the whole API with roles on a throw-away database.

### DMARC reports

Mail receivers (Google, Microsoft, Yahoo, ...) send a daily *aggregate report* for every domain that publishes a DMARC record, to the address in its `rua=` tag. InfraLoom reads those reports from a dedicated Microsoft 365 mailbox through Microsoft Graph (read-only, and limited to that one mailbox), keeps them, and shows **who sends mail in the name of your domains**: which senders pass DMARC and which fail, grouped by provider (Microsoft 365, Google, Amazon SES, ...; without a PTR record, by network prefix).

- **Network → DMARC** shows a **table of your domains** (the DMARC record of each, the volume, the share that is DMARC compliant as a donut, and DKIM and SPF each split into *aligned*, *passed but not aligned with the From domain* and *failed*; click a domain to look at it alone), an **authentication overview** (a pair of bars per day — compliant and invalid, as messages or as percent — and SPF, DKIM and DMARC as a whole), the totals, and three tabs: **Senders** (approve a whole provider with one click; open it to see the addresses, who reported them and how DKIM and SPF did), **Reports** (one report in a side panel, with a link to the original XML) and **Mailbox** (what was read, and what was not a report — with the reason: no attachment, an attachment that holds no report, an attached message that could not be read). It filters by domain and by period (7 days to a year).
- **Domains.** The list can be read from **Cloudflare** (an API token with *Zone → Zone → Read* and *Zone → DNS → Read*, both read-only, limited to the zones you want; **Settings → DMARC → Test Cloudflare**), so that every domain you own is on the page — including those that never sent a report — and the page shows what the `_dmarc` record of each says: *Protected* (quarantine or reject for all mail), *Partly enforced* (pct below 100), *Monitoring only* (p=none), *No DMARC record*, *Several records* (receivers ignore them all), *Invalid record*, and whether `rua` points to your mailbox. Domains outside Cloudflare are added by hand (their record is looked up in public DNS). A domain that is not mail-sending can be **muted**. The list is refreshed every night and with **Refresh from Cloudflare**; without a token nothing is read from Cloudflare.
- **Reports that arrive as an attached message.** Some senders — Google — attach the report as a *message* that has the archive inside. For such mail (and for a message whose subject is a report's even when Graph lists no attachment) the source of the message is read with one extra call and unpacked, up to three messages deep. Ordinary mail is not opened.
- **DNS servers for the checks** (*Settings → Domain checks*): the checks of a domain — MX, SPF, DKIM and DMARC on the DNS page, and the record of a domain added by hand — ask **public DNS servers (1.1.1.1 and 8.8.8.8)** by default, or this server's own DNS, or addresses you give. If your own DNS keeps a copy of a zone (split-horizon), it may lack records that exist outside, and a check through it shows the inside view; receivers use the outside one.
- **Import files** takes `.xml`, `.zip` and `.gz` reports by hand, so the page is useful before the mailbox is set up, or without Microsoft 365 at all.
- **Alerts**, through the usual [notification channels](#notifications) (each can be switched off per channel): a DMARC failure from a sender that is not approved (once a day per sender, not with every report), a new sender, an SPF permerror for your domain, failures the receiver let through anyway (forwarding, mailing lists — off by default), a domain whose DMARC record got worse (gone, weaker, invalid, doubled, or `rua` no longer pointing to your mailbox; the first look at a domain is only a starting point, and muted domains are left alone), the mailbox that cannot be read (after three failed reads in a row), and the client secret that is about to expire (30 days, 7 days, and when it has). A failure in a report older than three days is history and raises nothing; the first read of the mailbox is a quiet backfill that does not announce new senders.
- **Approving** is by group or by single address. Groups named in *Trusted senders* (default *Microsoft 365*) are approved the first time they are seen.
- The **Dashboard** card (offered once the module is on) shows the pass rate for the last 30 days, the failures, and whether any sender still needs a decision, a domain's record needs a look, or the mailbox cannot be read.
- **Operators** can approve senders, import files and read the mailbox; **admins** change the settings; viewers read.
- Reports are kept 400 days and the original XML 90 days (both set in **Settings → DMARC**), and so is the log of processed mail.

The module is **off until you switch it on** in **Settings → DMARC**, where you also enter the mailbox and the Microsoft 365 application's details. The client secret (and the Cloudflare token, if you use one) is stored in the encrypted database in a table of the module's own, and neither the settings screen nor any API ever returns it again.

#### Microsoft 365 setup

You need a mailbox that receives the reports, an *app registration* that may read **only that mailbox**, and then the DNS record.

1. **The mailbox.** A *shared mailbox* is enough (no licence, nobody signs in), e.g. `dmarc@example.com`. It must accept mail from outside.
2. **App registration** (Entra admin centre → *Identity → Applications → App registrations → New registration*): name `InfraLoom DMARC`, *single tenant*, no redirect URI. Note the **Application (client) ID** and the **Directory (tenant) ID**. Under *Certificates & secrets* create a **client secret** and copy its value at once (it is shown once); note when it expires. **Do not add any API permission** and do not grant admin consent: a permission given in Entra applies to *every* mailbox of the tenant, and the secret sits on the InfraLoom server.
3. **Limit it to one mailbox** (Exchange Online PowerShell, as an Exchange administrator; *RBAC for Applications* has no screen in the admin centre). The object ID below is the one of the **Enterprise application** with the same name (open it from the app registration's *Managed application in local directory* link), **not** the one of the app registration:

   ```powershell
   Connect-ExchangeOnline -UserPrincipalName admin@example.com
   New-ServicePrincipal -AppId <CLIENT_ID> -ObjectId <ENTERPRISE_APP_OBJECT_ID> -DisplayName "InfraLoom DMARC"
   New-ManagementScope -Name "DMARC mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'dmarc@example.com'"
   New-ManagementRoleAssignment -App <CLIENT_ID> -Role "Application Mail.Read" -CustomResourceScope "DMARC mailbox"
   # check: InScope must be True for the DMARC mailbox and False for any other
   Test-ServicePrincipalAuthorization -Identity <CLIENT_ID> -Resource dmarc@example.com
   Test-ServicePrincipalAuthorization -Identity <CLIENT_ID> -Resource somebody.else@example.com
   ```

   The assignment can take from a few minutes up to two hours to reach Graph; until then a read answers `403 ErrorAccessDenied`.
4. **In InfraLoom**: *Settings → DMARC* — tenant ID, client ID, client secret, the secret's expiry date (for the reminder) and the mailbox; **Save**, then **Test connection**.
5. **DNS**: only when the page shows that the mailbox can be read, change `rua` in the `_dmarc` TXT record of each domain, for a while to both the old and the new address, e.g. `rua=mailto:dmarc@example.com,mailto:old@example.com`. Reports for a domain *other than* the mailbox's own need a record at the receiving side: `other-domain.example._report._dmarc.example.com TXT "v=DMARC1"`.

The module only ever reads: it does not delete, move or mark mail as read, and the access it has cannot do more. A report, an archive or a mail that is not what it should be is recorded and skipped; archives are unpacked with limits (30 MB per file, 20 files), and XML that defines entities is refused. `DMARC_PTR_LOOKUP=false` in `.env` turns off the reverse-DNS lookup of sender addresses, and `DMARC_DNS_LOOKUP=false` the public-DNS lookup of the records of domains added by hand. The Cloudflare token is only ever used to read zones and DNS records; make it read-only and limit it to the zones you want.

### Diagnostics and Capture helper

**Network → Diagnostics** runs the usual first checks from the InfraLoom server, so you see the network the way the server does:

- **Ping** (with packet size and *don't fragment*), **Traceroute**, **MTU** (the largest packet that passes without fragmentation, found by trying sizes),
- **DNS** — a name and a record type, asked of up to four servers at once (this server's own DNS, public ones, the local DNS servers of the DNS page, or any address), side by side, with a warning when they do not give the same answer — the quickest way to see a split-horizon zone that lacks records which exist outside,
- **Ports** — which TCP ports of a host answer: *open*, *closed* (refused) or *no answer* (filtered),
- **Certificate** — who a TLS certificate is for, the names, who issued it, until when, whether it is trusted and whether the name matches, the protocol and the chain,
- **HTTP** — a request with the time of DNS, connect, TLS, first byte and total, and the redirects followed.

Only operators and administrators can run them (the server can reach what a viewer's computer cannot), every run is written to the audit log, at most four run at once and each has a time limit. Targets are host names and IP addresses only. `ping` and `traceroute` (or `tracepath`) must be installed on the server: `sudo apt install iputils-ping traceroute`.

**Network → Capture helper** holds about sixty ready-made filters for the usual problems — DNS failures, DHCP (including a second, rogue server), duplicate IP addresses, ARP storms, spanning tree, VLANs, TCP retransmissions and resets, MTU, fragmentation, VPN negotiation, cleartext passwords, scans — each with a **capture filter** (limits what is recorded: tcpdump, dumpcap, `tshark -f`, the FortiGate sniffer) and a **display filter** (Wireshark and `tshark -Y`), fields for the address, port, MAC or VLAN (checked, so nothing odd ends up in a command), and the commands ready to copy: tcpdump, tshark, dumpcap, Wireshark's menus, the FortiGate `diagnose sniffer packet` and the MikroTik `/tool sniffer`. It captures nothing itself. Every filter in the library is checked against the real `tcpdump` and `tshark` by the tests.

### Firewall logs

**Network → Firewall logs** receives the logs of a **FortiGate** as **syslog** (UDP and/or TCP) and of a **MikroTik** as syslog and **NetFlow**, and turns them into two things. It sits next to the FortiCloud logging, not instead of it: a FortiGate can send its logs to several places at once.

- **Traffic, by the hour.** The finished sessions are summed up — sessions, bytes out and in, what was blocked — by source, destination, application, country, service, policy and user, for 1 hour, 24 hours, 7 or 30 days, or a year, with the biggest in each list. **The logs themselves are not kept**, only these sums (400 days by default), so a busy firewall does not fill the disk. The sums of an hour that is going on are written every few seconds, so a restart loses little.
- **Security events**, kept 90 days by default with the log line itself: failed and successful administrator logins, changes of the configuration, VPN logins and failures, IPS and anomaly detections, malware, blocked web sites, and system events (memory conserve mode, HA, restarts). They are recognised by the description the firewall writes, not by log ids, which differ between versions. A flood of one kind is capped at 200 a minute.
- **Alerts.** Failed administrator or VPN logins: **one** alert for a burst (3 within 10 minutes from one address by default), not one for every attempt, and not again for half an hour. A **change of the configuration** is said once, when it is over, with what was changed and by whom. An **attack or malware that was stopped** (severity high or critical): once for each attack in an hour, at most ten an hour for a firewall. **System events**: at most one of a kind in ten minutes. Every successful administrator login can be switched on. And a firewall that **stops sending** is noticed after 15 minutes, and its return too.
- **Who may send.** Only the FortiGates and MikroTiks of the router list and the addresses given are accepted; anything else is turned away and shown, with a button to allow it. Logs hold addresses, user names and what people reach, so the page is for operators and administrators; only administrators change the settings.
- **MikroTik (RouterOS).** **Syslog** gives who logs in and who fails (`login failure for user ... from ... via ...`), what is changed (`... changed by admin`), links that go down and come back (`ether1 link down`), VPN logins (ppp, l2tp, sstp, ovpn) and the **drops of the firewall**: rules with `log=yes` whose `log-prefix` contains one of the words in the settings (drop, block, deny, ban, ...) are counted as blocked sessions, by who tried and which service, and fill *Most blocked*. The lines are read with or without the time and the name of the router (`bsd-syslog=yes` has them). **NetFlow** (v5, v9 and IPFIX; off until a UDP port is given in the settings, 2055 is the usual one) gives *who uses the traffic and where it goes*, which a MikroTik does not write to its log: each flow is put with the inside address it belongs to — outbound as *out*, inbound as *in*, so one address has one line — and the service is named from the port. A flow has **no application name, country or user**. Flows between two inside addresses, or two outside ones, are left out; which networks are “inside” is a setting (private ranges by default). A router of the router list (brand MikroTik) is accepted and named from the list; otherwise it is named by its address.
- **On the FortiGate** (the page shows the commands with the port and the address of this server): `config log syslogd setting` with `set status enable`, `set server`, `set mode udp`, `set port 5140` and **`set format default`** — the key=value format; CSV, CEF and JSON are not read. Traffic is in the logs of the policies that log (`set logtraffic all`), and the filter must let the traffic, event and utm logs through. A port above 1023 needs no privileges for the service; open it in the firewall of the server if there is one.

### Traffic

**Network → Traffic** keeps a history of the load of the interfaces you choose. Nothing is watched until you pick it: **Add interfaces**, choose a device, read its interfaces and tick the ones that matter (the WAN, the uplinks, the trunk ports).

- **Where the numbers come from.** A **FortiGate** with an API token is read through its REST API (`/api/v2/monitor/system/interface`: the byte counters and the speed of each interface); a **router, switch or access point with SNMP settings** through IF-MIB, with the 64-bit counters (`ifHCInOctets`/`ifHCOutOctets`) when the device has them. The rate is the difference of two readings divided by the time between them, so a restart of the device (a counter that goes down) and a counter that is too fast for the link are skipped instead of drawn as a spike. A device that only has 32-bit counters is marked: on a fast link they can wrap between two readings.
- **The page.** The list shows each interface with its link state and speed, the rate in and out, the load as a percentage of the link, a small chart of the last hour and its state. Click one for the chart — 1 hour, 6 hours, 24 hours, 7 days, 30 days or 1 year, with the numbers of the point under the mouse, and optionally scaled to the link speed — the **average, peak and 95th percentile** of in and out, and the amount **transferred**. The warning and critical levels are drawn on the chart.
- **Alerts** (three events in Notifications: *traffic high*, *traffic very high*, *back to normal*). The larger of in and out has to stay at or above the level (80% and 90% by default) for a number of minutes (10 by default) before an alert is sent, and below it for a few minutes before it ends, so a short burst is no alarm and a load that hovers around the limit is not announced over and over. The levels can be set for each interface, and need the speed of the link: it comes from the device, and can be given by hand (an interface of a 1 Gbps port that the provider limits to 300 Mbps).
- **What is kept.** A reading every minute (1 to 10 minutes) for 7 days, and an hourly summary — average, peak, 95th percentile, bytes — for 400 days. Both are set under *Defaults for all interfaces* on the page (administrators).
- **Who.** Everybody who is signed in sees the history; operators choose and edit the interfaces; administrators change the defaults and see **what the device answered** (a fold-out under the list of interfaces when you add them, `GET /api/traffic/raw/:table/:id`), to find out which field a value comes from when something is off.

### Hypervisor usage thresholds

**Infrastructure → Hypervisors → Usage thresholds** alerts when something gets too full or too busy — before it becomes an outage:

- node **CPU** (averaged over a window, 10 minutes by default), **memory** and **system disk**, for every hypervisor type that reports them
  (ESXi hosts do not report CPU/RAM, so nothing is checked there);
- **storage fill** on Proxmox, plus **storage not active** (for example an NFS share that went away) and a **node offline** in a cluster
  (the connection itself stays reachable through the other nodes, so the ordinary health check never notices).

Defaults: storage 85 % / 95 %, memory 90 % / 97 %, system disk 85 % / 95 %, CPU 90 % / 98 %. Every metric can be switched off.

How it behaves, so it does not cry wolf:

- a level has to hold for **two readings in a row** (about four minutes) before it alerts — one spike does nothing, and a value hovering
  around the line does nothing;
- an alert is **not repeated**; a warning clears only when the value is 3 points below it; critical easing back to warning is silent;
  you get a **back to normal** message when it is over;
- a **shared** storage (NFS, Ceph) is reported once, not once per node; storages that only hold ISO images/templates, and any storages
  you list by name, are ignored;
- connections with the health-check bell turned off are skipped, and a [maintenance window](#maintenance-windows) on the hypervisor mutes
  these alerts — anything still over a level when the window ends is reported once;
- the connection card shows what is over a level right now as badges.

Limits: thresholds are global (not per connection), storage checks are Proxmox-only, and there are no repeat reminders. ZFS counts its
cache as used memory, so a ZFS host can sit above 90 % RAM normally — raise that level for it.

### Maintenance windows

Planned work should not page you. **Infrastructure → Maintenance** mutes the *state-change* alerts — down, recovered,
offline, power loss — of one thing (a monitor, a router/switch/access point, a hypervisor connection, a UPS) or of
everything, now or at a scheduled time. Checks keep running and statuses stay accurate; only the notifications are held
back, and an amber banner on every page reminds you that alerts are muted.

- **Nothing stays silently broken.** When a window ends (or you press *End now*), whatever is still down is reported
  once — a single summary message for "everything" windows.
- **Patch runs mute the patched machine automatically.** Starting a patch run opens a window for the monitors that point
  at that machine (same IP, or its name / FQDN as the host; names shorter than 3 characters are never matched). It ends
  10 minutes after the run finishes so a reboot can complete, and never lasts longer than 3 hours.
- Licence, SSL and Entra expiry reminders and "new device on the network" are never muted.
- Muted alerts are counted per window, and creating or ending a window is written to the audit log.
- The public status pages show the real state even during a window; they do not hide it.

### Inventory

- **Licences** — vendor, type, seats, expiry, stored credentials (revealing a password is audited). Each licence has a
  renewal period that decides how early it warns: **monthly → 5 days** before expiry, **yearly → 35 days**
  (30 days if no period is set).
- **Entra ID Apps** — app registration secret expiry tracking, CSV export.

### Notifications

In-app bell with live toasts, plus Telegram, Slack, Discord, ntfy, Pushover and e-mail. Every event type
(monitor down/up, SSL/licence/Entra expiry, new or offline network device, hypervisor unreachable, UPS on battery,
low battery, power restored, UPS offline/online, network device health and restarts, hypervisor usage above warning/critical level and back to normal, DMARC failures, new senders, SPF permerror, an unreadable DMARC mailbox, an expiring DMARC secret, a DMARC record that got worse, an interface that stays loaded and is back to normal, failed logins and changes of the configuration of a firewall, an attack that was stopped, a firewall that stops sending logs, patch run failed, machine needs a restart after patching) can be switched per channel, with quiet hours, and muted per target by a
[maintenance window](#maintenance-windows).

### Status pages

Public, no login required:

- `/status` — status page listing all enabled uptime monitors (label, type, state, latency, SSL expiry; not the monitored address)
- `/status/dashboard` — NOC dashboard for a wall display: summary counters, uptime monitors, network devices, DNS, UPS (a red banner appears when a UPS runs on battery); refreshes every 30 seconds
- `/status/hypervisors` — hypervisor overview

These pages are unauthenticated. The dashboard lists device names and states, including the IP address of routers,
switches and access points; the UPS section shows name, state, battery and load only (no address, no SNMP details).
The two `/status/...` pages can be switched off under **Settings → Public TV / status pages**; `/status` has no
switch, so restrict it in your reverse proxy if it should not be public.

### Platform

- **Encrypted database** (SQLCipher); the key lives only in `.env`
- **Authentication** — httpOnly session cookie, account lockout after repeated failures, revocable sessions,
  optional two-factor authentication (TOTP), API keys
- **Roles** — `superadmin`, `admin`, `operator`, `viewer` (see [Roles](#roles))
- **Dashboard** — drag-and-reorder widgets, per user. The **Cabling** card shows how many rooms, racks and devices are documented, switch ports in use, wall outlets in use and free, telephone lines, fibre strands
  in use (a trunk that is nearly full is flagged) and what is unfinished (patch-panel ports without an office or outlet label, devices with no place or no unit — each opens the list behind it); it appears only where the
  Cabling module is switched on and can be used from the caller's network
- **Audit log** — filterable, CSV export
- **Backup** — scheduled or on-demand ZIP (database + encrypted copy of `.env`), with retention
- **In-app updates** — check GitHub, update and restart from the UI

## Requirements

- A Debian/Ubuntu-based Linux server (the installer uses `apt`), run as root
- Internet access for the installer (Node.js 22 via nvm, `nmap`, `arp-scan`, build tools)
- Network reachability from the server to whatever you want to monitor

## Installation

```bash
git clone https://github.com/krajcara/InfraLoom.git
cd InfraLoom
sudo bash install.sh
```

The installer:

1. installs system packages (`curl`, `git`, build tools, `nmap`, `arp-scan`, `sqlite3`, ...) and Node.js 22 LTS;
2. clones the repository to `/opt/infraloom` and installs dependencies;
3. generates `.env` with fresh secrets, builds the frontend and creates the encrypted database;
4. creates a **superadmin** account;
5. installs and starts the `infraloom` systemd service (starts on boot);
6. prints the login URL and the generated superadmin credentials — **save them**.

Two-factor authentication is optional; enable it later under **Profile**.

### HTTPS

InfraLoom speaks plain HTTP on port 3000 (`APP_PORT`). Put it behind a reverse proxy that terminates TLS
(Nginx, Nginx Proxy Manager, Caddy, ...) and then set `COOKIE_SECURE=true` in `.env` so the session cookie is only
sent over HTTPS. The SSH web terminal uses WebSockets (`/socket.io`) — enable WebSocket support in the proxy.

## Configuration

All settings are environment variables in `/opt/infraloom/.env` (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `APP_PORT` | Port the app listens on (default `3000`) |
| `APP_SECRET` | Signing secret for session tokens (`openssl rand -hex 64`) |
| `DB_PATH` | Location of the SQLCipher database (default `./data/infraloom.db`) |
| `DB_ENCRYPTION_KEY` | Database encryption key. **Losing it means losing the data — back it up** |
| `BACKUP_ENCRYPTION_PASSWORD` | Encrypts the `.env` copy inside backups (see [Backup and restore](#backup-and-restore)) |
| `COOKIE_SECURE` | `true` once served over HTTPS |
| `API_RATE_LIMIT` | Optional; requests per minute allowed from one address to the API (default `300`) |
| `DMARC_PTR_LOOKUP` | Optional; `false` turns off the reverse-DNS lookup of the addresses in DMARC reports (they are then grouped by network) |
| `DMARC_DNS_LOOKUP` | Optional; `false` turns off the public-DNS lookup of the DMARC record of domains added by hand |
| `GITHUB_TOKEN` | Optional; only needed if the repository is private |

Notification channels, SMTP, quiet hours, TV pages and schedules are configured in the UI under **Settings**.

## Updating

```bash
sudo bash /opt/infraloom/update.sh
```

or **Admin → Update** in the app (live progress). The updater compares the installed version with the latest
GitHub **release** (or, if the repository has no releases, with the latest commit on `main`), pulls, runs database
migrations, rebuilds the frontend and restarts the service. Your `.env` and `data/` directory are never touched.

> If you publish releases, bump `version` in `server/package.json` to match the release tag — that is the version the
> updater reads.

## Service management

```bash
sudo systemctl status infraloom
sudo systemctl restart infraloom
sudo journalctl -u infraloom -f
```

## Setting things up

### Roles

| Role | Can do | Cannot do |
|---|---|---|
| **Viewer** | View everything | Create, edit, run or delete anything; user management |
| **Operator** | Viewer + add devices, monitors and UPS units, start network scans and patch runs, schedule maintenance windows, edit the cabling documentation, approve DMARC senders, import DMARC reports and read the DMARC mailbox, renew licences, reveal stored passwords | Delete things, manage connections and credentials, change Settings, user management |
| **Admin** | Operator + delete, manage all connections and credentials, change Settings, manage Operator/Viewer accounts | Run system updates, manage Admin/Superadmin accounts |
| **Superadmin** | Everything | — |

### FortiGate (switches and access points)

On the FortiGate create a **REST API administrator** (System → Administrators) with a read-only profile and, if you
use Trusted Hosts, allow the InfraLoom server's address. Add the FortiGate under **Routers** with brand `fortigate` and
paste the API token. **Sync switches/APs** discovers FortiSwitches and FortiAPs
(`/api/v2/monitor/switch-controller/managed-switch/status`, `/api/v2/monitor/wifi/managed_ap`) and then refreshes
every minute. Their online/offline state is whatever the FortiGate reports — managed switches are usually not
reachable from the InfraLoom server, so they are not pinged. **Sync log** shows the raw reply if a field looks wrong.

### UPS

Enable SNMP on the UPS network card and allow queries from the InfraLoom server. Use a read-only community for
v1/v2c, or create a read-only user for v3 (MD5/SHA/SHA-2 authentication; DES/AES-128/AES-256 privacy). Add it under
**UPS** and press **Test connection**. InfraLoom polls every minute, and alerts when mains power is lost, the battery
runs low, power returns, or the UPS stops answering (after three failed polls). SNMP traps are not used.

The standard UPS-MIB (RFC 1628) and APC PowerNet are understood. If a card is not recognised it shows "No data";
an admin can use **SNMP walk** on the card to see what the device exposes.

### Hypervisors

Add connections from **Hypervisors → New connection**. What each platform needs:

#### Proxmox VE

- An **API token** (Datacenter → Permissions → API Tokens) is all that monitoring, listing and power actions need.
- **VM patch management** needs the **QEMU Guest Agent** running inside the guest (`qemu-guest-agent`; ships with
  `virtio-win` on Windows). No extra credentials — it goes through the API token.
- **LXC patch management** needs a separate **SSH login to the Proxmox host** (Proxmox has no REST API for running
  commands inside containers, only the node-local `pct exec`). Set it under the connection's *Patch Management (LXC)*
  section. This is broad access (effectively root on the host) — leave it blank if you do not patch containers.
- **Clusters with different root passwords per node:** the connection-level SSH credentials are the default; expand a
  node to set a per-node override.
- **API behind a reverse proxy:** SSH does not follow the proxy. Set an explicit **Host SSH address** so `pct exec`
  reaches the real host.

#### Hyper-V

- **Host-level WinRM** is required for monitoring and power actions:
  ```powershell
  winrm quickconfig -Force
  winrm set winrm/config/service/auth '@{Basic="true"}'
  winrm set winrm/config/service '@{AllowUnencrypted="true"}'
  ```
- **Guest patch management** needs a separate connection into each guest OS. In Patch Management click
  **Credentials** next to a guest: WinRM for Windows guests, SSH for Linux guests.
- **Automatic guest IP detection** needs Hyper-V Integration Services. If a guest shows no IP:
  1. On the host: `Enable-VMIntegrationService -VMName "X" -Name "Guest Service Interface"` and
     `-Name "Key-Value Pair Exchange"`.
  2. Do a full `Stop-VM` then `Start-VM` (not `Restart-VM` — VMBus channels are negotiated at cold boot).
  3. Linux guests also need the KVP daemon: `sudo apt install linux-tools-generic linux-cloud-tools-generic`, then
     `sudo systemctl enable --now hv-kvp-daemon`. On a non-standard kernel the matching `linux-tools-<kernel>` package
     may not exist; switching to the distro's standard kernel resolves it.
  4. Otherwise type the guest's IP into the Patch Management credentials form.

#### VMware ESXi

- **Requires ESXi 7.0 or newer** (the REST API used does not exist on 6.x).
- Standard root/administrative credentials; no extra host setup.
- Host-level CPU/RAM utilisation is not exposed by this API, so those fields show "—".
- Patch management for ESXi guests is not implemented.

### What a patch run does

On a **Proxmox VM** (Linux, Debian/Ubuntu or RHEL family) the update is not run as a child of the QEMU guest agent. The agent only
returns output once a command has finished, and it takes the update down with it if the agent restarts — which an upgrade can
cause. Instead InfraLoom starts the update on the machine as its own systemd unit (`infraloom-patch-<run id>`; a detached
session if systemd is not there), writes it to `/var/tmp/infraloom-patch-<run id>.log`, and follows that file — so the console
shows the output **live**, a slow or restarting agent does not lose the run, and if InfraLoom loses contact for good the update
carries on by itself on the machine. The log of a failed run stays there; a successful one is cleaned up. LXC containers and
Hyper-V guests use the direct path. Whenever a run fails, the reason is shown above the console **and** written into it.

On **Debian/Ubuntu** a run is more than `apt-get upgrade`:

1. **It waits for other package managers.** If unattended-upgrades, PackageKit or a second `apt` holds the apt/dpkg locks,
   InfraLoom waits for it to finish (up to 10 minutes) and says so in the console. It never stops or kills it — killing a
   running `dpkg` is what leaves the package database "interrupted". When the check finds such a process, the approval panel shows it.
2. **It can pause the automatic updaters** (optional, ticked by default when any is running): `unattended-upgrades`,
   PackageKit and the `apt-daily` timers are stopped for the duration of the run so they cannot start in the middle of it, and
   **started again afterwards — also when the update fails.** Those four are the only things InfraLoom will ever stop. If
   starting them again fails, the console prints the exact `systemctl start` command to run. (If InfraLoom itself is restarted
   during a run, for example by an update, it cannot start them again; they come back at the machine's next boot, or start them by hand.)
3. **It repairs an interrupted `dpkg`** (`dpkg --configure -a`) before upgrading, keeps existing configuration files, and lets apt wait up to two minutes for the dpkg lock.
4. **When a run fails, it says why** — above the console: another package manager was running, `dpkg` interrupted, a package's
   install script failed, a service would not restart, disk full, repository/clock problem, mirror unreachable, broken packages —
   with a hint, and a **Patch run failed** notification. The raw output is still there.
5. **After a successful run it checks whether the machine needs a restart** — Ubuntu's `reboot-required` flag, or a newer kernel of
   the running flavour on plain Debian; on RHEL/Fedora `needs-restarting -r` if installed. A **Restart required** badge appears
   in the guest list and you get a **Machine needs a restart** notification. InfraLoom does not restart the machine for you.
   Alpine and Windows guests are not checked.

### Patch Management and the management SSH key

InfraLoom has one SSH key pair of its own (the public half is shown in **Settings → Management SSH key**). In
Patch Management, **Install management key** uses a guest's saved password once to put that key into its
`authorized_keys`, after which InfraLoom logs in with the key. On Debian/Ubuntu, if an earlier run left `dpkg`
half-configured, the next patch run repairs it (`dpkg --configure -a`) before upgrading, and existing
configuration files are kept during upgrades.

## Backup and restore

**Admin → Backup** creates a ZIP containing:

- `infraloom.db` — a consistent snapshot of the live database (safe while the app is running)
- `env.enc` — your `.env`, AES-256-GCM encrypted with `BACKUP_ENCRYPTION_PASSWORD`

The database is already encrypted with `DB_ENCRYPTION_KEY`, but that key lives in `.env`; a plaintext `.env` in the
backup would let anyone with the ZIP open the database. So `.env` is encrypted too, with a **different** password that
never travels inside the backup.

**Store `BACKUP_ENCRYPTION_PASSWORD` somewhere separate from the backups** (a password manager, not this server).
Without it a backup cannot be decrypted, by design.

Backups run on a configurable daily schedule with configurable retention, or on demand.

**To restore:**

1. Decrypt `env.enc` with `BACKUP_ENCRYPTION_PASSWORD` (AES-256-GCM; file layout
   `salt(16) | iv(16) | authTag(16) | ciphertext`) to recover the original `.env`.
2. Place the recovered `.env` and `infraloom.db` (renamed to match your `DB_PATH`) into a fresh or existing install.
3. Restart the service.

## Security notes

- The database is encrypted at rest; `.env` is never committed (see `.env.example`).
- Pre-commit secret scanning (gitleaks) is wired through `.githooks/pre-commit`; run `npm install` once after
  cloning to activate it.
- Security headers (helmet), request rate limiting (300 requests a minute per address by default, `API_RATE_LIMIT`), and no CORS: the
  frontend and API are always served from the same origin.
- The [Cabling](#cabling-technical-rooms) data is a map of your network (rooms, racks, patch panels, outlets). An administrator can switch
  the module off, or limit it to your own networks, in **Settings → Cabling module**.
- Syslog and NetFlow are not encrypted and an open UDP port can be written to by anyone: send them through a VPN (for example WireGuard) when the router is not in the same network as this server, and keep the list of allowed senders short.
- Firewall logs are accepted only from known addresses, one line is never longer than 16 KB, and what is kept is bounded (a limit on the keys of a summary and on the events a minute).
- Diagnostics run commands without a shell, with validated targets, a limit of four at a time and a time limit each, and only for operators and administrators; every run is in the audit log. A capture file holds everything that was not encrypted, so keep it only as long as needed.
- CSV exports (the audit log, and the cabling lists) neutralise formula-injection payloads (values starting with `=`, `+`, `-` or `@`).
- The DMARC client secret and the Cloudflare API token are stored only in the module's own table of the encrypted database and are never returned by any API; the application it belongs to should be limited to the one mailbox, as described in [Microsoft 365 setup](#microsoft-365-setup). The mailbox receives mail from anyone, so attachments are unpacked with size limits.
- Credentials with broad reach — the Proxmox host SSH login used for LXC patching, Hyper-V per-guest credentials, and
  the FortiGate API token — should only be configured where you actually need them. Prefer read-only profiles.
- Serve InfraLoom over HTTPS and set `COOKIE_SECURE=true` (see [HTTPS](#https)).

## Upgrading from versions with Automation / Kubernetes

Version 1.0.0 removed the Automation module (OpenTofu VM provisioning, templates, Ansible playbooks), the Kubernetes
module and the Vulnerability Scan module — InfraLoom is a monitoring tool now. `update.sh` is enough:

- the old files disappear with the update (`git reset --hard`);
- on first start the database migration **drops the tables of the removed modules** (deployments, templates,
  playbooks, Kubernetes connections and tokens). Take a backup first if you want to keep that history;
- everything else — users, monitors, licences, hypervisor connections, saved guest credentials — is kept.

Optional clean-up of things the old versions installed on the server:

```bash
sudo rm -f /usr/local/bin/tofu                                   # OpenTofu
sudo pip uninstall -y ansible-core --break-system-packages       # Ansible
sudo rm -rf /opt/infraloom/data/tofu /opt/infraloom/data/ansible # leftover working data
```

Do **not** remove `/opt/infraloom/data/ssh`: it holds the management key that Patch Management may use.

## Development

```bash
git clone https://github.com/krajcara/InfraLoom.git && cd InfraLoom
cp .env.example .env     # set APP_SECRET, DB_ENCRYPTION_KEY and BACKUP_ENCRYPTION_PASSWORD (openssl rand -hex 32)
npm install
npm run migrate          # create the encrypted database
npm run seed             # create the superadmin account (credentials are printed)
npm run dev              # API on :3000 (nodemon) + Vite dev server with proxy
```

| Script | |
|---|---|
| `npm run dev` | API and frontend with live reload |
| `npm run build` | Production frontend build into `client/dist` |
| `npm start` | Start the API (serves `client/dist`) |
| `npm run migrate` / `npm run seed` | Create/upgrade the schema; create the first superadmin |
| `npm test` | Server tests (`server/tests`): the cabling module — validation, port generation, the trace engine, triggers, the whole API with roles — on a throw-away encrypted database |

```
client/            React 18 + Vite single-page app
server/src/
  routes/          REST API (one file per module)
  services/        Schedulers and background workers (monitors, polling, notifications, backup, patching)
  lib/             Protocol clients (SNMP, SSH, WinRM, Proxmox/Hyper-V/ESXi, FortiGate, nmap, ...)
  db/              SQLCipher schema, migrations, seed (db/cabling: numbered SQL migrations of the cabling module)
install.sh         Installer          update.sh   Updater          infraloom.service   systemd unit
```

Stack: Node.js 22, Express, React 18, Vite, SQLCipher (`better-sqlite3-multiple-ciphers`), Socket.io, node-cron,
net-snmp, ssh2.

## License

MIT — see [LICENSE](LICENSE).

---

Powered by **Krajcara**.
