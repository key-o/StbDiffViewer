/**
 * #529 Persistence owned by the live CAD DrawingProject session.
 * A save creates a complete workspace ZIP; neither STB nor supplementary XML is edited.
 */
import { getState } from '../../../data/state/globalState.js';
import { currentDrawingSheetSession } from '../../../data/drawing/drawingSheetSessionBridge.js';
import {
  normalizeDrawingProject,
  serializeDrawingProject,
} from '../../../data/drawing/drawingProjectSchema.js';
import {
  createSlabListState,
  normalizeSlabListState,
} from '../../../data/extractors/slabList/slabListResolver.js';
import { collectDrawingProjectArchiveSources } from '../../../data/drawing/drawingProjectArchiveSources.js';
import { createDrawingProjectArchive } from '../../../data/drawing/drawingProjectArchive.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';

const isSha = (value) => /^[0-9a-f]{64}$/i.test(value || '');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Preserve original STB character encoding when independently validating a
 * legacy DrawingProject revision. XML declaration encoding is ASCII-compatible
 * even when the document body is Shift_JIS / Windows-31J.
 */
export function decodeOriginalStbXmlBytes(bytes) {
  const header = new TextDecoder('utf-8').decode(bytes.subarray(0, 256));
  const declared = /<\?xml\s+[^>]*\bencoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/i
    .exec(header)?.[1]
    ?.toLowerCase();
  let encoding = declared || 'utf-8';
  if (encoding === 'utf8') encoding = 'utf-8';
  if (encoding === 'shift-jis' || encoding === 'sjis') encoding = 'shift_jis';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/** STB DrawingModel revisions identify the DOM serialization, not necessarily original file bytes. */
async function sourceBytesAndHashes(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return null;
  if (typeof file.size === 'number' && file.size > 128 * 1024 * 1024)
    throw new Error('STB原本がサイズ制限を超えています。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 128 * 1024 * 1024) throw new Error('STB原本がサイズ制限を超えています。');
  if (!globalThis.crypto?.subtle || !globalThis.DOMParser || !globalThis.XMLSerializer)
    throw new Error('STB原本のハッシュ検証を実行できません。');
  const sha = async (data) =>
    Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  const rawSha256 = await sha(bytes);
  const xml = decodeOriginalStbXmlBytes(bytes);
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector?.('parsererror') || parsed.documentElement?.localName !== 'ST_BRIDGE')
    throw new Error('STB原本をXMLとして検証できません。');
  const canonicalXml = new XMLSerializer().serializeToString(parsed);
  const canonicalSha256 = await sha(new TextEncoder().encode(canonicalXml));
  return { rawSha256, canonicalSha256 };
}

/**
 * Legacy workspace drafts used the DOM digest for both the revision ID and source
 * byte hash. Only repair the current revision when the *original file* is proven
 * to canonicalize to that exact DOM revision. Other revisions remain fail-closed.
 */
export function reconcileSlabSourceRevisionHashes(
  project,
  { modelRevision, rawSha256, canonicalSha256 } = {},
) {
  const normalized = normalizeDrawingProject(project);
  if (!isSha(modelRevision) || !isSha(rawSha256) || !isSha(canonicalSha256))
    throw new TypeError('STB改訂・原本SHA-256が不正です。');
  const matches = normalized.modelSlots.flatMap((slot, slotIndex) =>
    slot.revisions
      .map((rev, revisionIndex) => ({ slot, slotIndex, rev, revisionIndex }))
      .filter(
        ({ slot, rev }) =>
          slot.currentRevisionId === rev.id &&
          (rev.id.toLowerCase() === modelRevision.toLowerCase() ||
            rev.sha256.toLowerCase() === modelRevision.toLowerCase()),
      ),
  );
  if (matches.length !== 1) throw new Error('現行STB改訂が一意ではありません。');
  const { slotIndex, revisionIndex, rev } = matches[0];
  if (rev.sha256.toLowerCase() === rawSha256.toLowerCase()) return normalized;
  if (
    rev.id.toLowerCase() !== modelRevision.toLowerCase() ||
    rev.sha256.toLowerCase() !== modelRevision.toLowerCase() ||
    canonicalSha256.toLowerCase() !== modelRevision.toLowerCase()
  )
    throw new Error('STB原本とDrawingProjectの改訂が一致しません。');
  return normalizeDrawingProject({
    ...normalized,
    modelSlots: normalized.modelSlots.map((slot, si) =>
      si !== slotIndex
        ? slot
        : {
            ...slot,
            revisions: slot.revisions.map((revision, ri) =>
              ri === revisionIndex ? { ...revision, sha256: rawSha256.toLowerCase() } : revision,
            ),
          },
    ),
  });
}

/** Pure validated update; all other DrawingProject fields and model history survive. */
export function withSlabListProjectState(project, nextState, expectedState) {
  const before = normalizeDrawingProject(project);
  const previous = normalizeSlabListState(before.slabListState ?? createSlabListState());
  if (expectedState !== undefined && !equal(previous, normalizeSlabListState(expectedState)))
    throw new Error('別の操作でスラブリストが更新されました。プロジェクトを再読込してください。');
  return normalizeDrawingProject({
    ...before,
    slabListState: normalizeSlabListState(nextState),
  });
}

/**
 * Resolve the currently opened, uniquely matching STB revision.
 * A workspace selection is not sufficient: the DrawingModel and STB DOM must be current.
 */
async function currentContext({ requireProject = true, modelSide = null } = {}) {
  const panel = currentDrawingSheetSession();
  const session = panel?.sessionUi;
  const project = session?.loadedDrawingProject;
  if (!project) {
    if (!requireProject) return null;
    throw new Error('簡易CADでDrawingProjectまたはworkspace ZIPを開いてください。');
  }
  const drawing = panel?.drawing;
  const source = drawing?.source;
  const side = source?.modelKey;
  const doc = ['A', 'B'].includes(side) ? getState('models.document' + side) : null;
  const services = panel?.services || panel?.getServices?.();
  if (
    !doc ||
    !['A', 'B'].includes(side) ||
    !isSha(source?.modelRevision) ||
    typeof services?.assertDrawingSourceCurrent !== 'function'
  )
    throw new Error('現行STBの伏図または軸組図を簡易CADで生成してください。');
  if (modelSide !== null && modelSide !== side)
    throw new Error('スラブリストのモデルと簡易CADの現行モデルが異なります。');
  await services.assertDrawingSourceCurrent({ source });
  if (
    session.loadedDrawingProject !== project ||
    panel.drawing !== drawing ||
    getState('models.document' + side) !== doc
  )
    throw new Error('確認中にSTBまたはDrawingProjectが切り替わりました。');
  const normalized = normalizeDrawingProject(project);
  const slots = normalized.modelSlots.filter((slot) => {
    const current = slot.revisions.find((rev) => rev.id === slot.currentRevisionId);
    return (
      current &&
      (current.id.toLowerCase() === source.modelRevision.toLowerCase() ||
        current.sha256.toLowerCase() === source.modelRevision.toLowerCase())
    );
  });
  if (slots.length !== 1) throw new Error('DrawingProjectの現行STB改訂を一意に特定できません。');
  return { panel, session, project, drawing, doc, side, services };
}

function assertStillCurrent(context, originalJson) {
  const { panel, session, project, drawing, doc, side } = context;
  if (
    session.loadedDrawingProject !== project ||
    panel.drawing !== drawing ||
    getState('models.document' + side) !== doc ||
    serializeDrawingProject(session.loadedDrawingProject) !== originalJson
  )
    throw new Error('ZIP生成中にSTBまたはDrawingProjectが変更されました。保存を中止しました。');
}

export async function readCurrentSlabListDrawingProjectState() {
  const context = await currentContext({ requireProject: false });
  if (!context) return createSlabListState();
  return normalizeSlabListState(context.project.slabListState ?? createSlabListState());
}

export async function writeCurrentSlabListDrawingProjectState(
  state,
  { expectedState, modelSide = null } = {},
) {
  const context = await currentContext({ modelSide });
  const { panel, session, project, drawing, services } = context;
  const originalJson = serializeDrawingProject(project);
  let updated = withSlabListProjectState(project, state, expectedState);
  // Separate the canonical DrawingModel revision ID from the original STB bytes hash.
  // Repair only legacy single-current-revision metadata after verifying the input file.
  const original = getState('files.originalFile' + context.side);
  const legacySlots = updated.modelSlots.filter((slot) => {
    const current = slot.revisions.find((rev) => rev.id === slot.currentRevisionId);
    return (
      current?.id.toLowerCase() === drawing.source.modelRevision.toLowerCase() &&
      current.sha256.toLowerCase() === drawing.source.modelRevision.toLowerCase()
    );
  });
  // Already-correct archived source SHA is authoritative even if the viewer has
  // a different originalFile selected; never rewrite it from an unrelated file.
  if (original && legacySlots.length === 1) {
    const hashes = await sourceBytesAndHashes(original);
    assertStillCurrent(context, originalJson);
    updated = reconcileSlabSourceRevisionHashes(updated, {
      modelRevision: drawing.source.modelRevision,
      ...hashes,
    });
  }
  // No live-session mutation occurs until both STB source integrity and ZIP are validated.
  const sourceRevisions = await collectDrawingProjectArchiveSources({
    project: updated,
    retainedSourceRevisions: session.archiveSourceRevisions || [],
    originalFiles: [getState('files.originalFileA'), getState('files.originalFileB')],
  });
  assertStillCurrent(context, originalJson);
  const archive = await createDrawingProjectArchive({ project: updated, sourceRevisions });
  await services.assertDrawingSourceCurrent({ source: drawing.source });
  assertStillCurrent(context, originalJson);
  const originalId = session.drawingProjectId;
  session.loadedDrawingProject = updated;
  session.drawingProjectId = updated.projectId;
  try {
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob([archive], { type: 'application/zip' }),
      'drawing-workspace-' + date + '.sdv.zip',
    );
  } catch (error) {
    // A failed download must never be reported as a successful save.
    if (session.loadedDrawingProject === updated) {
      session.loadedDrawingProject = project;
      session.drawingProjectId = originalId;
    }
    throw error;
  }
  ++session.archiveExportSequence;
  session.reviseOpenDrawingProject?.();
  panel.sheetBrowser?.invalidatePreviewSources?.();
  panel.sheetBrowser?.render?.();
  return updated;
}
