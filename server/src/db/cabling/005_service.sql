-- What a port carries: 'data' (the default) or 'voice' (a telephone line). A patch-panel port keeps its RJ45 connector for a telephone
-- line; the service says that the rear cable and the wall socket are telephone ones and the front goes towards the exchange.
-- Validated in the application like the other value lists.
ALTER TABLE cab_ports ADD COLUMN service TEXT NOT NULL DEFAULT 'data';
ALTER TABLE cab_template_port_groups ADD COLUMN service TEXT NOT NULL DEFAULT 'data';
