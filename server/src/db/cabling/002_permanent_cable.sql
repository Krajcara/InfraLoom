-- The permanent cable from a patch-panel port's rear side to its wall outlet (the outlet itself is the port's
-- office_id / outlet_label). Recorded on the port, because it is not a link between two ports.
ALTER TABLE cab_ports ADD COLUMN rear_cable_type TEXT;
ALTER TABLE cab_ports ADD COLUMN rear_length_m REAL;
