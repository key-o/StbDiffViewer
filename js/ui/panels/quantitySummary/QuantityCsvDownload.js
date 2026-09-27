/**
 * Browser-side CSV download helper for Quantity Summary.
 */
export function downloadQuantityCsv(
  csvText,
  filename,
  { documentRef = globalThis.document, URLRef = globalThis.URL, BlobCtor = globalThis.Blob } = {},
) {
  if (typeof csvText !== 'string' || csvText.length === 0) return false;
  if (!documentRef || typeof documentRef.createElement !== 'function') return false;
  if (!URLRef || typeof URLRef.createObjectURL !== 'function') return false;
  if (typeof BlobCtor !== 'function') return false;

  const blob = new BlobCtor([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URLRef.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'quantity.csv';
  anchor.style.display = 'none';

  const parent = documentRef.body || documentRef.documentElement;
  parent?.appendChild?.(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove?.();
    URLRef.revokeObjectURL?.(url);
  }
  return true;
}

export default downloadQuantityCsv;
