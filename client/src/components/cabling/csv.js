/** Downloads rows as a CSV that Excel opens correctly: UTF-8 with a byte-order mark, and a "sep=;" line so a Serbian (or any
 * European) Excel, whose list separator is a semicolon, splits the columns instead of showing one. */
export function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = `\ufeffsep=;\r\n${rows.map((r) => r.map(esc).join(';')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
