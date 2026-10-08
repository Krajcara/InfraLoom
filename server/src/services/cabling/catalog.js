'use strict';

// Allowed values for list fields. Validated in the application layer so the lists can grow without database migrations.

const DEVICE_TYPES = [
  { value: 'switch', label: 'Switch' },
  { value: 'router', label: 'Router' },
  { value: 'firewall', label: 'Firewall' },
  { value: 'hypervisor', label: 'Hypervisor' },
  { value: 'server', label: 'Server' },
  { value: 'nas', label: 'NAS' },
  { value: 'patch_panel', label: 'Patch panel' },
  { value: 'fiber_panel', label: 'Fiber panel' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'notebook', label: 'Notebook' },
  { value: 'printer', label: 'Printer' },
  { value: 'access_point', label: 'Access point' },
  { value: 'other', label: 'Other' },
];
const PANEL_TYPES = ['patch_panel', 'fiber_panel'];

const PURPOSES = [
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
  { value: 'on_demand', label: 'On-demand use' },
];

const PORT_TYPES = [
  { value: 'rj45', label: 'RJ45' },
  { value: 'sfp', label: 'SFP' },
  { value: 'sfp_plus', label: 'SFP+' },
  { value: 'sfp28', label: 'SFP28' },
  { value: 'qsfp_plus', label: 'QSFP+' },
  { value: 'console', label: 'Console' },
  { value: 'lc_duplex', label: 'LC duplex' },
  { value: 'sc_duplex', label: 'SC duplex' },
];

const SPEEDS = ['100M', '1G', '2.5G', '5G', '10G', '25G', '40G'];

const PORT_ROLES = [
  { value: 'lan', label: 'LAN' },
  { value: 'wan', label: 'WAN' },
  { value: 'mgmt', label: 'MGMT' },
  { value: 'ha', label: 'HA' },
  { value: 'uplink', label: 'Uplink' },
];

const CONNECTORS = ['LC', 'SC', 'ST', 'MPO'];
const FIBER_TYPES = ['OS2', 'OM3', 'OM4', 'OM5'];

// What InfraLoom can monitor and a cabling device can point at.
const LINK_KINDS = ['router', 'switch', 'access_point', 'hypervisor', 'ups'];

const values = (list) => list.map((x) => (typeof x === 'string' ? x : x.value));
const oneOf = (list, v) => values(list).includes(v);

function catalog() {
  return { device_types: DEVICE_TYPES, panel_types: PANEL_TYPES, purposes: PURPOSES, port_types: PORT_TYPES, speeds: SPEEDS, port_roles: PORT_ROLES, connectors: CONNECTORS, fiber_types: FIBER_TYPES, link_kinds: LINK_KINDS };
}

module.exports = { DEVICE_TYPES, PANEL_TYPES, PURPOSES, PORT_TYPES, SPEEDS, PORT_ROLES, CONNECTORS, FIBER_TYPES, LINK_KINDS, values, oneOf, catalog };
