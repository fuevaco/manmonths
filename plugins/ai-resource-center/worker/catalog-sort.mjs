const names = new Intl.Collator('zh-TW', { sensitivity: 'accent' });
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function sortCatalog(data, field, direction) {
  const sign = direction === 'asc' ? 1 : -1;
  const value = p => field === 'owner' ? (p.owner?.trim() ? p.owner.toUpperCase() : null)
    : field === 'uploadedAt' ? (p.lastUploadedAt ? Date.parse(p.lastUploadedAt) : null) : p[field];
  return data.sort((a, b) => {
    const x = value(a), y = value(b);
    const primary = x == null || y == null ? (x == null ? (y == null ? 0 : 1) : -1)
      : sign * (field === 'name' ? names.compare(x, y) : ordinal(x, y));
    return primary || names.compare(a.name, b.name) || ordinal(a.packageKey, b.packageKey);
  });
}
