-- How many rack units a device occupies; rack_position is the lowest unit it uses (U1 is the bottom of the rack).
ALTER TABLE cab_devices ADD COLUMN height_u INTEGER NOT NULL DEFAULT 1;
