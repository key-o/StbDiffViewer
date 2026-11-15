/** @fileoverview Read-only TrueType embedding-rights and Unicode coverage checks. */

function invalidFont() {
  throw new Error('TrueTypeフォントのテーブルが不正、または未対応の形式です。');
}

/** Locate bounded SFNT tables; reject a corrupt directory before jsPDF parses it. */
function readTables(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 12 ||
    bytes[0] !== 0 ||
    bytes[1] !== 1 ||
    bytes[2] !== 0 ||
    bytes[3] !== 0
  )
    invalidFont();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  if (!count || count > 256 || 12 + count * 16 > bytes.length) invalidFont();
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8);
    const size = view.getUint32(at + 12);
    if (offset > bytes.length || size > bytes.length - offset || tables.has(tag)) invalidFont();
    tables.set(tag, { offset, size });
  }
  return { view, tables };
}

function fontGlyphMapper(view, table) {
  if (!table || table.size < 4) invalidFont();
  const start = table.offset;
  if (view.getUint16(start) !== 0) invalidFont();
  const count = view.getUint16(start + 2);
  if (count > 1024 || 4 + count * 8 > table.size) invalidFont();
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const record = start + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const relative = view.getUint32(record + 4);
    if (relative > table.size - 4) continue;
    const at = start + relative;
    const format = view.getUint16(at);
    if (format !== 4 && format !== 12) continue;
    const length =
      format === 12
        ? relative + 16 <= table.size
          ? view.getUint32(at + 4)
          : 0
        : view.getUint16(at + 2);
    if (!length || length > table.size - relative) continue;
    candidates.push({ at, end: at + length, format, priority: format === 12 ? 0 : 1 });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  if (!candidates.length) invalidFont();
  // Some TTFs contain both Unicode cmap 12 and BMP cmap 4 with
  // incomplete overlap. Avoid rejecting a glyph supported by either map.
  const mappers = candidates.map((selected) => {
    const { at, end, format } = selected;
    if (format === 12) {
      if (at + 16 > end) invalidFont();
      const countGroups = view.getUint32(at + 12);
      if (countGroups > Math.floor((end - at - 16) / 12)) invalidFont();
      return (codepoint) => {
        let low = 0;
        let high = countGroups - 1;
        while (low <= high) {
          const middle = (low + high) >>> 1;
          const index = at + 16 + middle * 12;
          const first = view.getUint32(index);
          const last = view.getUint32(index + 4);
          if (codepoint < first) high = middle - 1;
          else if (codepoint > last) low = middle + 1;
          else return view.getUint32(index + 8) + codepoint - first !== 0;
        }
        return false;
      };
    }
    if (at + 16 > end) invalidFont();
    const segments = view.getUint16(at + 6) / 2;
    if (!Number.isInteger(segments) || segments < 1) invalidFont();
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    if (ranges + segments * 2 > end) invalidFont();
    return (codepoint) => {
      if (codepoint > 0xffff) return false;
      for (let i = 0; i < segments; i++) {
        if (codepoint > view.getUint16(ends + i * 2)) continue;
        if (codepoint < view.getUint16(starts + i * 2)) return false;
        const delta = view.getInt16(deltas + i * 2);
        const range = view.getUint16(ranges + i * 2);
        if (!range) return ((codepoint + delta) & 0xffff) !== 0;
        const pos = ranges + i * 2 + range + 2 * (codepoint - view.getUint16(starts + i * 2));
        if (pos + 2 > end) return false;
        const glyph = view.getUint16(pos);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
      return false;
    };
  });
  return (codepoint) => mappers.some((mapper) => mapper(codepoint));
}

/**
 * OS/2 fsType is an additional restriction, not a substitute for reading the
 * font's license. jsPDF subsetting means no-subsetting fonts are rejected.
 */
export function verifyPdfPrintFont(bytes, text) {
  const { view, tables } = readTables(bytes);
  const os2 = tables.get('OS/2');
  if (!os2 || os2.size < 10) invalidFont();
  const fsType = view.getUint16(os2.offset + 8);
  const level = fsType & 0x000f;
  if (level !== 0 && level !== 4 && level !== 8 && level !== 12)
    throw new Error('指定TTFにはPDFへの埋め込みが制限されています（OS/2 fsType）。');
  if (fsType & 0x0200)
    throw new Error('ビットマップのみ埋め込み可能なTTFはベクターPDFに利用できません。');
  if (fsType & 0x0100) throw new Error('サブセット埋め込み禁止のTTFは利用できません。');
  const hasGlyph = fontGlyphMapper(view, tables.get('cmap'));
  const missing = [];
  for (const char of new Set(Array.from(String(text || '')))) {
    const cp = char.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (!hasGlyph(cp)) missing.push(char);
    if (missing.length >= 6) break;
  }
  if (missing.length)
    throw new Error(
      `選択TTFに図面で必要な文字がありません: ${missing.join(' ')}。別の日本語フォントを選択してください。`,
    );
  return true;
}
