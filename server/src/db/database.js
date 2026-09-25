'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');

// Anchored to the project root (not process.cwd()) so the resolved path is
// identical whether the process is started via `npm run` from a workspace,
// directly with `node server/src/index.js`, or via systemd with a different
// WorkingDirectory. A relative DB_PATH in .env is always relative to the
// project root, matching the comment in .env.example.
const PROJECT_ROOT = path.join(__dirname, '../../..');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(PROJECT_ROOT, process.env.DB_PATH)
  : path.join(PROJECT_ROOT, 'data/infraloom.db');
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

if (!DB_ENCRYPTION_KEY) {
  console.error('[db] FATAL: DB_ENCRYPTION_KEY is not set in .env — refusing to start.');
  console.error('[db] Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// Ensure the data directory exists before SQLite tries to create the file.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── SQLCipher encryption ────────────────────────────────────────────────
// better-sqlite3-multiple-ciphers defaults to the sqlcipher cipher scheme,
// which is what we want. The key PRAGMA must be the very first statement
// run against the connection, before any table access.
db.pragma(`key='${DB_ENCRYPTION_KEY}'`);

// Sanity check: if the key is wrong (or the file isn't encrypted with it),
// this simple query will throw immediately rather than silently failing later.
try {
  db.prepare('SELECT count(*) FROM sqlite_master').get();
} catch (err) {
  console.error('[db] FATAL: could not open the encrypted database — wrong DB_ENCRYPTION_KEY?');
  console.error(err.message);
  process.exit(1);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Additive, non-destructive column helper — used when a later phase needs to
// extend a table that already shipped. Never used for DROP/ALTER-modify.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Phase 0 — base schema ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('superadmin','admin','operator','viewer')),
    totp_secret   TEXT,
    totp_enabled  INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    module      TEXT,
    details     TEXT,
    ip_address  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_module  ON audit_log(module);
  CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_log(user_id);
`);

// ── Phase 1 — Auth & Users ──────────────────────────────────────────────
ensureColumn('users', 'failed_attempts', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('users', 'locked_until', "TEXT");
ensureColumn('users', 'full_name', "TEXT");
ensureColumn('users', 'email', "TEXT");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    ip_address   TEXT,
    user_agent   TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user  ON api_keys(user_id);
`);

// ── Phase 3 — Dashboard shell ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dashboard_layouts (
    user_id    INTEGER PRIMARY KEY,
    layout     TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── Phase 4-5 — Inventory: Licences & Entra ID Apps ─────────────────────
// NOTE: no cost/savings fields (price, currency, billing cycle, tax) —
// deliberately dropped from the v1 design per project decision.
db.exec(`
  CREATE TABLE IF NOT EXISTS licences (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor            TEXT NOT NULL,
    licence_type      TEXT NOT NULL,
    licence_count     INTEGER DEFAULT 1,
    licence_used      INTEGER DEFAULT 0,
    purchase_date     TEXT,
    expiry_date       TEXT,
    assigned_to       TEXT DEFAULT '[]',
    url               TEXT,
    licence_username  TEXT,
    licence_password  TEXT,
    licence_mfa       INTEGER DEFAULT 0,
    notes             TEXT,
    hidden            INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entra_apps (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name       TEXT NOT NULL,
    app_id         TEXT,
    client_secret  TEXT,
    secret_expiry  TEXT,
    assigned_to    TEXT,
    project        TEXT,
    notes          TEXT,
    hidden         INTEGER DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_licences_expiry ON licences(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_entra_apps_expiry ON entra_apps(secret_expiry);
`);

// ── Phase 6 — Network: Uptime Monitor ───────────────────────────────────
// Types: http, https, tcp, icmp, dns (v1 base) + keyword, json_query, push,
// docker (v2 additions, per Uptime Kuma).
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT 'http',
    target           TEXT NOT NULL,
    port             INTEGER,
    interval_s       INTEGER DEFAULT 60,
    timeout_s        INTEGER DEFAULT 10,
    keyword          TEXT,
    json_path        TEXT,
    json_expected    TEXT,
    expected_status  INTEGER DEFAULT 200,
    push_token       TEXT UNIQUE,
    push_interval_s  INTEGER DEFAULT 60,
    docker_container TEXT,
    enabled          INTEGER DEFAULT 1,
    last_status      TEXT DEFAULT 'unknown',
    last_latency_ms  INTEGER,
    last_checked_at  TEXT,
    last_push_at     TEXT,
    ssl_expiry       TEXT,
    ssl_days         INTEGER,
    ssl_error        TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS monitor_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id  INTEGER NOT NULL,
    status      TEXT NOT NULL,
    latency_ms  INTEGER,
    status_code INTEGER,
    error_msg   TEXT,
    checked_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor ON monitor_checks(monitor_id, checked_at);
`);

// ── Phase 7 — Network: Routers / Switches / Access Points ───────────────
// Identical schema for all three device types (separate tables per project
// decision). Each device is backed by an 'icmp' row in `monitors` (ping is
// mandatory) — this reuses the Uptime Monitor worker/history/notifications
// instead of building a second polling system. SNMP is optional metadata
// fetched on demand, not continuously polled.
for (const table of ['routers', 'switches', 'access_points']) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      brand                TEXT DEFAULT 'other',
      model                TEXT,
      ip_address           TEXT NOT NULL,
      username             TEXT,
      device_password      TEXT,
      notes                TEXT,
      monitor_id           INTEGER,
      snmp_version         TEXT DEFAULT '2c',
      snmp_community       TEXT DEFAULT 'public',
      snmp_port            INTEGER DEFAULT 161,
      snmp_username        TEXT,
      snmp_auth_protocol   TEXT DEFAULT 'SHA',
      snmp_auth_password   TEXT,
      snmp_priv_protocol   TEXT DEFAULT 'AES',
      snmp_priv_password   TEXT,
      snmp_security_level  TEXT DEFAULT 'authPriv',
      created_at           TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE SET NULL
    );
  `);
}

// ── Phase 8 — Network: DNS + DNS Analytics ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dns_local (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL DEFAULT 'primary',
    type       TEXT NOT NULL DEFAULT 'technitium',
    ip         TEXT NOT NULL,
    api_key    TEXT,
    label      TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dns_domains (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain     TEXT UNIQUE NOT NULL,
    notes      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Phase 9 — Network: Net Speed ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS speed_tests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL DEFAULT 'cloudflare',
    download     REAL,
    upload       REAL,
    ping         REAL,
    jitter       REAL,
    server       TEXT,
    triggered_by TEXT DEFAULT 'auto',
    status       TEXT DEFAULT 'done',
    error        TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_speed_tests_created ON speed_tests(created_at);
`);

// ── Phase 11 — Infrastructure: Hypervisors ──────────────────────────────
// Generic connection table (type-based) so VMware/Hyper-V (later phases)
// slot in without a schema change. Multiple connections supported from
// day one, per project decision — even though Phase 11 only implements
// the 'proxmox' type.
db.exec(`
  CREATE TABLE IF NOT EXISTS hypervisor_connections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL DEFAULT 'proxmox',
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    username   TEXT DEFAULT 'root@pam',
    token_id   TEXT,
    api_token  TEXT,
    enabled    INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
ensureColumn('hypervisor_connections', 'password', 'TEXT');
ensureColumn('hypervisor_connections', 'port', 'INTEGER');
// SSH access to the Proxmox HOST itself (not a guest) — needed only for LXC
// patch management, since Proxmox's REST API has no exec endpoint for
// containers the way it does for QEMU's guest agent; `pct exec` is a
// node-local command, so LXC patching requires shelling into the host.
ensureColumn('hypervisor_connections', 'patch_ssh_username', 'TEXT');
ensureColumn('hypervisor_connections', 'patch_ssh_password', 'TEXT');
ensureColumn('hypervisor_connections', 'patch_ssh_port', 'INTEGER');
// Optional — if the API URL goes through a reverse proxy (e.g. Nginx Proxy
// Manager) that doesn't forward SSH, the real host for `pct exec` needs to
// be entered separately here; falls back to the API URL's host if blank.
ensureColumn('hypervisor_connections', 'patch_ssh_host', 'TEXT');

// ── Saved SSH credentials for Hypervisors VM terminal ───────────────────
// Per (connection, vmid) — optional defaults; a session can always override
// with a one-off username/password/key instead of using these.
db.exec(`
  CREATE TABLE IF NOT EXISTS ssh_credentials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    vmid          INTEGER NOT NULL,
    port          INTEGER DEFAULT 22,
    username      TEXT,
    password      TEXT,
    private_key   TEXT,
    passphrase    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(connection_id, vmid),
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
`);

// Saved WinRM credentials for patching a Windows guest directly (Hyper-V
// VMs need this — our host-level WinRM connection manages the VM itself,
// but patching needs a SEPARATE connection into the guest OS). vmid is TEXT
// here since Hyper-V identifies guests by name, not a numeric id.
db.exec(`
  CREATE TABLE IF NOT EXISTS guest_winrm_credentials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    vmid          TEXT NOT NULL,
    host          TEXT,
    port          INTEGER DEFAULT 5985,
    username      TEXT,
    password      TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(connection_id, vmid),
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
`);
// Optional manual host override — used when a guest's IP can't be
// auto-detected (e.g. Hyper-V Integration Services not reporting it).
// The SSH Terminal feature ignores this (it always gets the live IP from
// the caller); Patch Management falls back to it when no live IP is known.
ensureColumn('ssh_credentials', 'host', 'TEXT');

// ── Phase 12 — Infrastructure: Network Scanner ──────────────────────────
// Pi.Alert-style persistent MAC-based inventory. `network_devices` is the
// durable inventory (one row per MAC, survives across scan cycles);
// `network_scan_events` logs connect/disconnect/new-device transitions;
// `network_scan_results` holds on-demand nmap deep-scan output per device.
db.exec(`
  CREATE TABLE IF NOT EXISTS network_devices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    mac            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    ip             TEXT,
    name           TEXT,
    vendor         TEXT,
    first_seen     TEXT DEFAULT (datetime('now')),
    last_seen      TEXT DEFAULT (datetime('now')),
    is_online      INTEGER DEFAULT 1,
    is_new         INTEGER DEFAULT 1,
    is_favorite    INTEGER DEFAULT 0,
    is_archived    INTEGER DEFAULT 0,
    notes          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_network_devices_mac ON network_devices(mac);
  CREATE INDEX IF NOT EXISTS idx_network_devices_online ON network_devices(is_online);

  CREATE TABLE IF NOT EXISTS network_scan_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  INTEGER NOT NULL,
    mac        TEXT NOT NULL,
    event_type TEXT NOT NULL, -- new_device | connected | disconnected
    ip         TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scan_events_device ON network_scan_events(device_id);
  CREATE INDEX IF NOT EXISTS idx_scan_events_created ON network_scan_events(created_at);

  CREATE TABLE IF NOT EXISTS network_scan_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    INTEGER NOT NULL,
    ports        TEXT, -- JSON array: [{port, protocol, state, service, product, version}]
    os_guess     TEXT,
    scanned_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scan_results_device ON network_scan_results(device_id);
`);

// ── Phase 13 — Infrastructure: Patch Management ─────────────────────────
// One row per dry-run/apply cycle. `packages_affected` is a JSON snapshot
// captured at dry-run time: [{name, current_version, new_version}]. Applying
// patches re-uses that same snapshot rather than re-simulating, so what the
// admin approved is exactly what runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS patch_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id      INTEGER NOT NULL,
    node               TEXT NOT NULL,
    guest_type         TEXT NOT NULL, -- qemu | lxc
    vmid               TEXT NOT NULL,
    vm_name            TEXT,
    os_family          TEXT,          -- debian | rhel | unknown
    status             TEXT NOT NULL DEFAULT 'dry_run', -- dry_run | awaiting_approval | approved | running | completed | failed | cancelled
    packages_affected  TEXT,          -- JSON array
    dry_run_output     TEXT,
    apply_output       TEXT,
    error              TEXT,
    triggered_by       TEXT,
    approved_by        TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    started_at         TEXT,
    completed_at       TEXT,
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_patch_runs_connection ON patch_runs(connection_id);
  CREATE INDEX IF NOT EXISTS idx_patch_runs_status ON patch_runs(status);
  CREATE INDEX IF NOT EXISTS idx_patch_runs_created ON patch_runs(created_at);
`);
// The guest's IP at dry-run time — needed to reach a Hyper-V guest directly
// (Proxmox VM/LXC exec doesn't need this, it goes through the host).
ensureColumn('patch_runs', 'guest_host', 'TEXT');

// Periodic CPU/RAM/Disk snapshots per hypervisor node — powers the TV
// Hypervisors page's historical charts. A background service (see
// hypervisorMetricsService.js) writes one row per node on each tick.
db.exec(`
  CREATE TABLE IF NOT EXISTS hypervisor_node_metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    node          TEXT NOT NULL,
    cpu_usage     REAL,
    mem_usage     REAL,
    disk_usage    REAL,
    recorded_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_hv_node_metrics_recorded ON hypervisor_node_metrics(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_hv_node_metrics_conn_node ON hypervisor_node_metrics(connection_id, node);
`);

// ── Automation: Ansible playbooks ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ansible_playbooks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT,
    content      TEXT NOT NULL,
    is_builtin   INTEGER DEFAULT 0,
    created_by   TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ansible_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    playbook_id   INTEGER,
    playbook_name TEXT NOT NULL,
    target_guests TEXT NOT NULL,  -- JSON: [{connectionId, node, vmid, name, ip}]
    status        TEXT NOT NULL DEFAULT 'checking', -- checking | awaiting_approval | applying | completed | failed
    check_output  TEXT,
    apply_output  TEXT,
    error         TEXT,
    triggered_by  TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    completed_at  TEXT,
    FOREIGN KEY (playbook_id) REFERENCES ansible_playbooks(id) ON DELETE SET NULL
  );
`);

// ── Automation: OpenTofu-provisioned infrastructure ──────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS template_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    node          TEXT NOT NULL,
    name          TEXT NOT NULL,
    vmid          TEXT,
    status        TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
    output        TEXT,
    error         TEXT,
    triggered_by  TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    completed_at  TEXT,
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS iac_deployments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    guest_type    TEXT NOT NULL,          -- vm | lxc
    connection_id INTEGER NOT NULL,
    node          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'planning', -- planning | awaiting_approval | applying | completed | failed | destroyed
    tf_vars       TEXT,                   -- JSON snapshot of the form inputs used to generate the config
    tf_config     TEXT,                   -- the generated main.tf, for audit/reference
    state_dir     TEXT NOT NULL,          -- this deployment's isolated working directory (holds .tfstate)
    plan_output   TEXT,
    apply_output  TEXT,
    result_vmid   TEXT,                   -- populated once the real vmid is known post-apply
    error         TEXT,
    triggered_by  TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    applied_at    TEXT,
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_iac_deployments_connection ON iac_deployments(connection_id);
  CREATE INDEX IF NOT EXISTS idx_iac_deployments_status ON iac_deployments(status);
`);

// ── Per-node SSH override for LXC patch management — a Proxmox cluster can
// have multiple nodes with different root passwords, so one connection-level
// credential isn't always enough. A node without a row here falls back to
// the connection's own patch_ssh_* fields.
db.exec(`
  CREATE TABLE IF NOT EXISTS hypervisor_node_ssh (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    node          TEXT NOT NULL,
    ssh_host      TEXT,
    ssh_username  TEXT,
    ssh_password  TEXT,
    ssh_port      INTEGER,
    UNIQUE(connection_id, node),
    FOREIGN KEY (connection_id) REFERENCES hypervisor_connections(id) ON DELETE CASCADE
  );
`);

// ── In-app notifications (bell icon / toast) ─────────────────────────────
// Every notify() call (external channels or not) also lands here, so
// alerts are visible inside the app even with no Telegram/Slack/etc
// configured.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    severity   TEXT NOT NULL DEFAULT 'warning', -- info | warning | critical
    message    TEXT NOT NULL,
    is_read    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_app_notifications_read ON app_notifications(is_read);
  CREATE INDEX IF NOT EXISTS idx_app_notifications_created ON app_notifications(created_at);
`);

// Tracks last-known reachability per hypervisor connection so the health
// checker only notifies on state CHANGES (up->down, down->up), not every
// single check cycle.
ensureColumn('hypervisor_connections', 'last_health_status', 'TEXT');
// Per-connection opt-out — e.g. a Hyper-V test machine that's intentionally
// powered off shouldn't keep generating "unreachable" alerts.
ensureColumn('hypervisor_connections', 'health_check_enabled', 'INTEGER DEFAULT 1');
db.prepare("UPDATE hypervisor_connections SET health_check_enabled = 1 WHERE health_check_enabled IS NULL").run();

// Seed default settings only if they don't already exist.
const defaultSettings = {
  app_name: 'InfraLoom',
  netspeed_provider: 'cloudflare',
  netspeed_cron: '0 * * * *',
  netspeed_retention_days: '90',
  netscan_cron: '*/5 * * * *',
  netscan_subnet: '',
  netscan_last_run: '',
  hypervisor_health_cron: '*/5 * * * *',
  tv_dashboard_enabled: '1',
  tv_hypervisors_enabled: '1',
  hypervisor_metrics_cron: '*/2 * * * *',
  hypervisor_metrics_retention_hours: '24',
  backup_cron: '0 3 * * *',
  backup_retention_count: '14',
};
const insertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

const builtinPlaybooks = [
  {
    name: 'Install Docker',
    description: 'Installs Docker Engine + Compose plugin on a Debian/Ubuntu host via the official apt repository.',
    content: `---
- name: Install Docker
  hosts: all
  become: true
  tasks:
    - name: Install prerequisite packages
      apt:
        name: ["ca-certificates", "curl", "gnupg"]
        state: present
        update_cache: true

    - name: Create keyrings directory
      file:
        path: /etc/apt/keyrings
        state: directory
        mode: "0755"

    - name: Add Docker GPG key
      get_url:
        url: https://download.docker.com/linux/{{ ansible_distribution | lower }}/gpg
        dest: /etc/apt/keyrings/docker.asc
        mode: "0644"

    - name: Add Docker apt repository
      apt_repository:
        repo: "deb [arch={{ 'arm64' if ansible_architecture == 'aarch64' else 'amd64' }} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/{{ ansible_distribution | lower }} {{ ansible_distribution_release }} stable"
        state: present

    - name: Install Docker packages
      apt:
        name: ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"]
        state: present
        update_cache: true

    - name: Ensure Docker is running and enabled
      systemd:
        name: docker
        state: started
        enabled: true
`,
  },
  {
    name: 'Install Node Exporter',
    description: 'Installs the Prometheus Node Exporter monitoring agent as a systemd service (listens on :9100).',
    content: `---
- name: Install Node Exporter
  hosts: all
  become: true
  vars:
    node_exporter_version: "1.8.2"
  tasks:
    - name: Download node_exporter
      unarchive:
        src: "https://github.com/prometheus/node_exporter/releases/download/v{{ node_exporter_version }}/node_exporter-{{ node_exporter_version }}.linux-amd64.tar.gz"
        dest: /tmp
        remote_src: true

    - name: Install binary
      copy:
        src: "/tmp/node_exporter-{{ node_exporter_version }}.linux-amd64/node_exporter"
        dest: /usr/local/bin/node_exporter
        mode: "0755"
        remote_src: true

    - name: Create systemd service
      copy:
        dest: /etc/systemd/system/node_exporter.service
        content: |
          [Unit]
          Description=Prometheus Node Exporter
          After=network.target

          [Service]
          User=nobody
          ExecStart=/usr/local/bin/node_exporter

          [Install]
          WantedBy=multi-user.target

    - name: Start and enable node_exporter
      systemd:
        name: node_exporter
        state: started
        enabled: true
        daemon_reload: true
`,
  },
];
const insertBuiltinPlaybook = db.prepare(
  'INSERT INTO ansible_playbooks (name, description, content, is_builtin) SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM ansible_playbooks WHERE name = ? AND is_builtin = 1)'
);
for (const pb of builtinPlaybooks) {
  insertBuiltinPlaybook.run(pb.name, pb.description, pb.content, pb.name);
}

module.exports = db;
