/** Formats a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS", no timezone
 * marker) as a locale-formatted local date+time string. Passing that
 * string straight to `new Date()` gets parsed as LOCAL time by JS (not
 * UTC), which silently shows the wrong time — this fixes that by marking
 * it as UTC explicitly before parsing. */
export function formatDbDate(dbString, options) {
  if (!dbString) return '';
  const isoUtc = dbString.includes('T') ? dbString : `${dbString.replace(' ', 'T')}Z`;
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return dbString; // not a recognizable date — show as-is rather than "Invalid Date"
  return options ? d.toLocaleString([], options) : d.toLocaleString();
}

/** Same idea, time-of-day only (no date portion). */
export function formatDbTime(dbString) {
  if (!dbString) return '';
  const isoUtc = dbString.includes('T') ? dbString : `${dbString.replace(' ', 'T')}Z`;
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return dbString;
  return d.toLocaleTimeString();
}
