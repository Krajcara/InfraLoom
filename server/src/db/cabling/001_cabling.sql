-- Cabling module: rooms, offices, racks, device templates, devices, ports,
-- trunk cables between rooms and links between port sides.
-- All tables carry the cab_ prefix (InfraLoom already uses "connections" for hypervisors and "network_*" for the scanner).
--
-- Value lists (device_type, port_type, speed, role, purpose...) are validated in the application, not with CHECK
-- constraints, so they can grow without rebuilding tables. Only structural values (side, kind, medium) are CHECKed.

CREATE TABLE cab_rooms (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  location   TEXT,
  floor      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cab_offices (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  floor      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cab_racks (
  id         INTEGER PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES cab_rooms(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  height_u   INTEGER NOT NULL DEFAULT 42,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, name)
);

CREATE TABLE cab_device_templates (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  device_type  TEXT NOT NULL,
  manufacturer TEXT,
  model        TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A port group expands to ports named prefix + number, from start_no to end_no.
CREATE TABLE cab_template_port_groups (
  id          INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES cab_device_templates(id) ON DELETE CASCADE,
  prefix      TEXT NOT NULL DEFAULT '',
  start_no    INTEGER NOT NULL,
  end_no      INTEGER NOT NULL,
  port_type   TEXT NOT NULL,
  speed       TEXT,
  poe         INTEGER NOT NULL DEFAULT 0,
  role        TEXT,
  connector   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  CHECK (end_no >= start_no)
);
CREATE INDEX cab_idx_tpg_template ON cab_template_port_groups(template_id);

-- A device lives either in a room (optionally in a rack) or in an office.
-- linked_kind / linked_id is a soft reference to something InfraLoom monitors (router, switch, access_point,
-- hypervisor, ups): it is NOT a foreign key, because FortiGate-discovered switches and APs are created and removed
-- by their sync and the documentation must outlive that.
CREATE TABLE cab_devices (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  device_type   TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'production',
  room_id       INTEGER REFERENCES cab_rooms(id) ON DELETE SET NULL,
  office_id     INTEGER REFERENCES cab_offices(id) ON DELETE SET NULL,
  rack_id       INTEGER REFERENCES cab_racks(id) ON DELETE SET NULL,
  rack_position INTEGER,
  template_id   INTEGER REFERENCES cab_device_templates(id) ON DELETE SET NULL,
  manufacturer  TEXT,
  model         TEXT,
  ip_address    TEXT,
  mac_address   TEXT,
  serial_number TEXT,
  linked_kind   TEXT,
  linked_id     INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (room_id IS NOT NULL AND office_id IS NOT NULL))
);
CREATE INDEX cab_idx_devices_room ON cab_devices(room_id);
CREATE INDEX cab_idx_devices_office ON cab_devices(office_id);
CREATE UNIQUE INDEX cab_ux_devices_link ON cab_devices(linked_kind, linked_id) WHERE linked_kind IS NOT NULL;

-- On patch and fiber panels a port has two sides: 'front' (patch cords in the room) and 'rear' (permanent cabling).
-- office_id / outlet_label record the wall outlet the rear side runs to.
CREATE TABLE cab_ports (
  id           INTEGER PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES cab_devices(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  port_type    TEXT NOT NULL,
  speed        TEXT,
  poe          INTEGER NOT NULL DEFAULT 0,
  role         TEXT,
  transceiver  TEXT,
  connector    TEXT,
  office_id    INTEGER REFERENCES cab_offices(id) ON DELETE SET NULL,
  outlet_label TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, name)
);
CREATE INDEX cab_idx_ports_device ON cab_ports(device_id, sort_order);
CREATE INDEX cab_idx_ports_office ON cab_ports(office_id);

CREATE TABLE cab_trunk_cables (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  room_a_id    INTEGER NOT NULL REFERENCES cab_rooms(id) ON DELETE CASCADE,
  room_b_id    INTEGER NOT NULL REFERENCES cab_rooms(id) ON DELETE CASCADE,
  medium       TEXT NOT NULL CHECK (medium IN ('fiber', 'copper')),
  fiber_type   TEXT,
  strand_count INTEGER,
  length_m     REAL,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (room_a_id <> room_b_id)
);

-- Links between port sides (used from the next release on: patch cords, permanent installation, trunk strands).
CREATE TABLE cab_links (
  id             INTEGER PRIMARY KEY,
  port_a_id      INTEGER NOT NULL REFERENCES cab_ports(id) ON DELETE CASCADE,
  side_a         TEXT NOT NULL DEFAULT 'front' CHECK (side_a IN ('front', 'rear')),
  port_b_id      INTEGER NOT NULL REFERENCES cab_ports(id) ON DELETE CASCADE,
  side_b         TEXT NOT NULL DEFAULT 'front' CHECK (side_b IN ('front', 'rear')),
  kind           TEXT NOT NULL DEFAULT 'patch' CHECK (kind IN ('patch', 'permanent')),
  trunk_cable_id INTEGER REFERENCES cab_trunk_cables(id) ON DELETE SET NULL,
  strands        TEXT,
  cable_type     TEXT,
  color          TEXT,
  length_m       REAL,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (port_a_id = port_b_id AND side_a = side_b))
);
CREATE UNIQUE INDEX cab_ux_links_a ON cab_links(port_a_id, side_a);
CREATE UNIQUE INDEX cab_ux_links_b ON cab_links(port_b_id, side_b);
CREATE INDEX cab_idx_links_trunk ON cab_links(trunk_cable_id);

-- A port side may take part in at most one link, whichever end it is on.
CREATE TRIGGER cab_trg_links_unique_end_insert
BEFORE INSERT ON cab_links
WHEN EXISTS (
  SELECT 1 FROM cab_links
  WHERE (port_a_id = NEW.port_b_id AND side_a = NEW.side_b)
     OR (port_b_id = NEW.port_a_id AND side_b = NEW.side_a)
)
BEGIN
  SELECT RAISE(ABORT, 'port side already connected');
END;

CREATE TRIGGER cab_trg_links_unique_end_update
BEFORE UPDATE OF port_a_id, side_a, port_b_id, side_b ON cab_links
WHEN EXISTS (
  SELECT 1 FROM cab_links
  WHERE id <> NEW.id
    AND ((port_a_id = NEW.port_b_id AND side_a = NEW.side_b)
      OR (port_b_id = NEW.port_a_id AND side_b = NEW.side_a))
)
BEGIN
  SELECT RAISE(ABORT, 'port side already connected');
END;
