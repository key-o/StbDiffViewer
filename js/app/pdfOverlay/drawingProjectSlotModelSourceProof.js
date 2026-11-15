/**
 * #650: cryptographic handoff from a fully staged DrawingProject modelSlot
 * revision to the formal model loader's parsed STB-A candidate.
 *
 * This preflight must complete BEFORE beginModelLoadReplacement(). The returned
 * synchronous callback is valid only for the exact document and File verified
 * here; it cannot rehash bytes after an irreversible scene publication.
 */
import { sha256 } from '../../utils/sha256.js';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_STB_BYTES = 128 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function assertLease({ isStageCurrent, getCurrentStage, staged, getSelectedFile, file }) {
  if (isStageCurrent() !== true || getCurrentStage() !== staged || getSelectedFile() !== file)
    fail('STB-A原本、登録ビューまたは承認状態が変更されました。再検証してください。');
}

/**
 * Verify one immutable model candidate against the same file already used to
 * stage every drawing view. No global model or drawing state is mutated.
 */
export async function prepareDrawingProjectSlotModelSourceProof({
  staged,
  file,
  candidateDocument,
  getCurrentStage,
  getSelectedFile,
  getCurrentOriginalFile,
  isStageCurrent,
  serialize = (document) => new XMLSerializer().serializeToString(document),
  digest = sha256,
} = {}) {
  const revision = staged?.inspection?.revision;
  if (
    !staged?.slotMode ||
    staged.phase !== 'slot' ||
    staged.plan?.status !== 'ready' ||
    staged.file !== file ||
    staged.modelSlotId == null ||
    !SHA256.test(revision?.sha256 || '') ||
    revision.id !== revision.sha256 ||
    !SHA256.test(revision?.originalSha256 || '')
  )
    fail('全ビュー検証済みのSTB-A原本・改訂SHAがありません。');
  if (
    !candidateDocument ||
    candidateDocument.nodeType !== 9 ||
    candidateDocument.documentElement?.localName !== 'ST_BRIDGE'
  )
    fail('正式モデルローダーのSTB-A XML文書が不正です。');
  if (
    typeof file?.arrayBuffer !== 'function' ||
    typeof getCurrentStage !== 'function' ||
    typeof getSelectedFile !== 'function' ||
    typeof getCurrentOriginalFile !== 'function' ||
    typeof isStageCurrent !== 'function' ||
    typeof serialize !== 'function' ||
    typeof digest !== 'function'
  )
    throw new TypeError('STB-A原本・stage・SHAの確認サービスがありません。');

  assertLease({ isStageCurrent, getCurrentStage, staged, getSelectedFile, file });
  if (typeof file.size === 'number' && file.size > MAX_STB_BYTES)
    fail('STB-A原本は128MiB以下にしてください。');
  const bytes = await file.arrayBuffer();
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength > MAX_STB_BYTES)
    fail('STB-A原本は128MiB以下のバイト列である必要があります。');
  assertLease({ isStageCurrent, getCurrentStage, staged, getSelectedFile, file });
  const rawSha = await digest(new Uint8Array(bytes));
  if (rawSha !== revision.originalSha256)
    fail('STB-A原本のバイトSHA-256がstaging済み改訂と一致しません。');

  const candidateXml = serialize(candidateDocument);
  if (typeof candidateXml !== 'string' || !candidateXml)
    fail('正式STB-AモデルのXMLを取得できません。');
  const semanticSha = await digest(new TextEncoder().encode(candidateXml));
  if (semanticSha !== revision.sha256)
    fail('正式STB-AモデルのXML SHA-256が全ビューstagingと一致しません。');
  assertLease({ isStageCurrent, getCurrentStage, staged, getSelectedFile, file });
  if (serialize(candidateDocument) !== candidateXml)
    fail('検証中に正式STB-AモデルのXMLが変更されました。');

  const proof = Object.freeze({
    file,
    modelDocument: candidateDocument,
    revisionSha256: revision.sha256,
    originalSha256: revision.originalSha256,
    verifyPublishedModelSource({
      modelDocument,
      drawingSource,
      revision: actualRevision,
      file: actualFile,
    } = {}) {
      // Runs after formal model publication, when the old model document
      // legitimately differs and the original preflight lease is no longer valid.
      return (
        modelDocument === candidateDocument &&
        actualFile === file &&
        getCurrentOriginalFile() === file &&
        getSelectedFile() === file &&
        getCurrentStage() === staged &&
        actualRevision?.id === revision.id &&
        actualRevision?.sha256 === revision.sha256 &&
        actualRevision?.originalSha256 === revision.originalSha256 &&
        drawingSource?.modelKey === 'A' &&
        drawingSource.modelRevision === revision.sha256 &&
        serialize(candidateDocument) === candidateXml
      );
    },
  });
  return proof;
}
