/**
 * Resolve all immutable STB source revisions before exporting a DrawingProject ZIP.
 * Never regenerate the originals from the DOM or a WorkingDocument.
 */
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const sourceKey = (slotId, revisionId) => JSON.stringify([slotId, revisionId]);

async function originalBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source && typeof source.arrayBuffer === 'function') {
    if (typeof source.size === 'number' && source.size > MAX_SOURCE_BYTES)
      throw new Error('STB原本がサイズ制限を超えています。');
    return new Uint8Array(await source.arrayBuffer());
  }
  throw new TypeError('STB原本はFile、Blobまたはバイト列で指定してください。');
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256が利用できません。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Object} options
 * @param {Object} options.project DrawingProject with modelSlots
 * @param {Array} options.retainedSourceRevisions ZIP-imported or rebind-staged original sources
 * @param {Array} options.originalFiles original A/B file objects, never parsed XML
 * @returns {Promise<Array<{modelSlotId:string,sourceRevisionId:string,bytes:Uint8Array}>>}
 */
export async function collectDrawingProjectArchiveSources({
  project,
  retainedSourceRevisions = [],
  originalFiles = [],
  inspectOriginalStb = null,
} = {}) {
  if (!Array.isArray(project?.modelSlots)) throw new TypeError('DrawingProjectが不正です。');
  const expected = new Map();
  for (const slot of project.modelSlots) {
    for (const revision of slot.revisions || []) {
      const key = sourceKey(slot.id, revision.id);
      if (expected.has(key)) throw new Error(`STB改訂の重複: ${slot.id}/${revision.id}`);
      expected.set(key, {
        modelSlotId: slot.id,
        sourceRevisionId: revision.id,
        sha256: revision.sha256,
        originalSha256: revision.originalSha256 || null,
      });
    }
  }
  const resolved = new Map();
  const inspectedHash = async (bytes) => {
    if (typeof inspectOriginalStb !== 'function') return null;
    const result = await inspectOriginalStb({ bytes: new Uint8Array(bytes) });
    const hash = typeof result === 'string' ? result : result?.sha256;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error('STB原本の描画改訂SHA-256を検証できません。');
    return hash;
  };
  const verifyRevision = async (bytes, revision, rawHash) => {
    if (revision.originalSha256 != null && revision.originalSha256 !== rawHash) return false;
    // A raw checksum matching the declared DrawingModel hash is not proof of
    // semantic identity: inspect the XML whenever the inspector is available.
    if (typeof inspectOriginalStb === 'function')
      return (await inspectedHash(bytes)) === revision.sha256;
    // Legacy archives without originalSha256 can only be trusted by raw hash.
    return revision.originalSha256 != null || revision.sha256 === rawHash;
  };
  for (const retained of retainedSourceRevisions) {
    const key = sourceKey(retained.modelSlotId, retained.sourceRevisionId);
    if (!expected.has(key)) continue; // Ignore cached sources for unrelated projects.
    if (resolved.has(key)) throw new Error('保持中のSTB原本が重複しています。');
    const bytes = await originalBytes(retained.bytes);
    if (bytes.length > MAX_SOURCE_BYTES)
      throw new Error('保持しているSTB原本がサイズ制限を超えています。');
    const rawHash = await sha256(bytes);
    if (!(await verifyRevision(bytes, expected.get(key), rawHash)))
      throw new Error(`保持しているSTB原本のSHA-256が一致しません: ${key}`);
    resolved.set(key, { bytes, originalSha256: rawHash });
  }
  for (const file of originalFiles.filter(Boolean)) {
    const bytes = await originalBytes(file);
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('STB原本がサイズ制限を超えています。');
    const hash = await sha256(bytes);
    // Resolve each unlabelled A/B file only when it identifies exactly one
    // unresolved revision. Even an explicit originalSha256 is not a slot ID:
    // identical STB bytes may be referenced by several model slots.
    const candidates = [];
    let canonicalHash = null;
    for (const [key, revision] of expected) {
      if (resolved.has(key)) continue;
      if (revision.originalSha256 != null && revision.originalSha256 !== hash) continue;
      if (!inspectOriginalStb) {
        if (revision.originalSha256 === hash || revision.sha256 === hash) candidates.push(key);
        continue;
      }
      canonicalHash ??= await inspectedHash(bytes);
      if (canonicalHash === revision.sha256) candidates.push(key);
    }
    if (candidates.length > 1)
      throw new Error('同一STBに一致する改訂が複数あります。原本との対応を指定してください。');
    if (candidates.length === 1) resolved.set(candidates[0], { bytes, originalSha256: hash });
  }
  const missing = [...expected].filter(([key]) => !resolved.has(key));
  if (missing.length) {
    const revisions = missing.map(
      ([, revision]) => `${revision.modelSlotId}/${revision.sourceRevisionId}`,
    );
    throw new Error(
      `ZIP保存に必要なSTB原本がありません: ${revisions.join(', ')}。改訂原本を含むZIPから読み込むか、対応するSTB原本を用意してください。`,
    );
  }
  return [...expected].map(([key, revision]) => ({
    modelSlotId: revision.modelSlotId,
    sourceRevisionId: revision.sourceRevisionId,
    bytes: resolved.get(key).bytes,
    originalSha256: resolved.get(key).originalSha256,
  }));
}
