-- Which way a rack's unit numbers run: 0 = U1 at the bottom (the usual EIA-310 way), 1 = U1 at the top (as some racks are labelled).
-- The numbers are always the ones printed on the rack: a device's position is the lowest unit number it covers, so nothing
-- else (overlaps, height, limits) depends on the direction.
ALTER TABLE cab_racks ADD COLUMN units_from_top INTEGER NOT NULL DEFAULT 0;
