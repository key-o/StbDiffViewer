/**
 * Input integrity and save-checkpoint helpers for #529 slab-list editor.
 * Pure functions are kept separate from DOM UI to allow Node unit coverage.
 */
export const SLAB_XML_MAX_BYTES = 2 * 1024 * 1024;
// Two maximum-sized XML sources expand by 4/3 in Base64; 4 MiB is insufficient.
export const SLAB_JSON_BACKUP_MAX_BYTES = 8 * 1024 * 1024;

/** Verify every archive before any imported or loaded ledger replaces live state. */
export async function verifySlabXmlSources(sources, parseXml, subtle = globalThis.crypto?.subtle) {
  if (!sources.length) return;
  if (!subtle) throw new TypeError('保存XMLのSHA-256を検証できません');
  const seenSides = new Set();
  for (const source of sources) {
    if (seenSides.has(source.modelSide))
      throw new TypeError('同じモデル側に複数の保存XMLがあります: ' + source.modelSide);
    seenSides.add(source.modelSide);
    const bytes = Uint8Array.from(globalThis.atob(source.bytesBase64), (char) =>
      char.charCodeAt(0),
    );
    if (bytes.byteLength > SLAB_XML_MAX_BYTES)
      throw new TypeError('保存XMLが2MiBを超えています: ' + source.modelSide);
    const actual = [...new Uint8Array(await subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (actual !== source.sha256)
      throw new TypeError('保存XMLのハッシュが一致しません: ' + source.modelSide);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (parseXml(xml)?.ok !== true)
      throw new TypeError('保存XMLの形式が不正です: ' + source.modelSide);
  }
}

/**
 * Async JSON validation must not overwrite edits, model-side switches or a later
 * import. Ledger identity changes on every immutable edit/undo operation.
 */
export function isSlabImportCurrent(target, current) {
  return (
    target.ledger === current.ledger &&
    target.side === current.side &&
    target.ticket === current.ticket
  );
}

/** Persisted snapshot does not imply that concurrent edits have been saved. */
export function completedSlabSaveState(current, written, undoStack, undoDepth) {
  return {
    dirty: JSON.stringify(current) !== JSON.stringify(written),
    undoStack: undoStack.slice(undoDepth),
  };
}
