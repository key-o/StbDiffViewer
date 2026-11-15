/** @fileoverview #455 Level-only DXF batch, separate from legacy structural axis export. */
import {
  getPlanDrawingSourceInternal,
  getLoadedFilenameInternal,
  compileLevelElevationRenderPlanInternal,
} from './DxfProviders.js';
import { sha256 } from '../../../utils/sha256.js';
import { parseAxes, parseElements } from '../../../common-stb/import/parser/stbParserCore.js';
import { generateDrawingRenderPlanDxf } from '../DrawingRenderPlanDxfWriter.js';
import { downloadDxf } from './DxfFormatWriter.js';
import { eventBus, ToastEvents } from '../../../data/events/index.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('LevelElevationBatchExporter');

function resolveLevelSource() {
  const source = getPlanDrawingSourceInternal();
  if (
    source?.modelKey !== 'A' ||
    source.document?.nodeType !== 9 ||
    source.document.documentElement?.localName !== 'ST_BRIDGE'
  ) {
    return { canExport: false, reason: source?.reason || 'STB-Aの有効な原本Documentが必要です。' };
  }
  return { canExport: true, source };
}

function serializeLevelDocument(document) {
  if (typeof XMLSerializer !== 'function')
    throw new Error('XMLSerializerが利用できないためLevel立面DXFを生成できません。');
  return new XMLSerializer().serializeToString(document);
}

async function pickLevelDirectoryHandle() {
  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    try {
      return {
        handle: await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' }),
        cancelled: false,
      };
    } catch (error) {
      if (error.name === 'AbortError') return { handle: null, cancelled: true };
      throw new Error(`Level立面DXFの保存先フォルダを選択できません: ${error.message}`);
    }
  }
  return { handle: null, cancelled: false };
}

/**
 * parseAxes is intentionally tolerant for the interactive viewer: it silently
 * drops malformed axes and synthesizes missing IDs. A batch exporter must not
 * treat that lossy result as the complete source of truth.
 *
 * The current Level view contract uses axis.distance as the global X/Y
 * coordinate. Until rotated/offset grids have their own projection contract,
 * accept only the canonical STB grid orientation and zero depth-axis origin.
 */
function validateLevelAxisSource(document, axisDirection, parsedAxes) {
  const ids = new Set();
  const rawAxes = [];
  const selected = (name) => name === axisDirection || name?.endsWith(`_${axisDirection}`);
  for (const [groupTag, axisTag] of [
    ['StbParallelAxes', 'StbParallelAxis'],
    ['StbArcAxes', 'StbArcAxis'],
    ['StbRadialAxes', 'StbRadialAxis'],
  ]) {
    for (const group of parseElements(document, groupTag)) {
      if (!selected(group.getAttribute('group_name'))) continue;
      if (axisTag !== 'StbParallelAxis')
        throw new Error('円弧・放射通り芯のLevel立面DXFは未対応です。');
      const angleText = group.getAttribute('angle');
      const angle = angleText === null || angleText.trim() === '' ? NaN : Number(angleText);
      const expected = axisDirection === 'X' ? 270 : 0;
      const delta = (((angle - expected) % 360) + 360) % 360;
      if (!Number.isFinite(angle) || Math.min(delta, 360 - delta) > 1e-8)
        throw new Error('標準直交方向以外の通り芯はLevel立面DXFに未対応です。');
      const originAxis = axisDirection === 'X' ? 'X' : 'Y';
      for (const coordinate of ['X', 'Y']) {
        const attr = group.getAttribute(coordinate);
        if (attr === null || attr.trim() === '' || !Number.isFinite(Number(attr)))
          throw new Error('Level立面DXFの通り芯原点が不正です。');
      }
      if (Math.abs(Number(group.getAttribute(originAxis))) > 1e-8)
        throw new Error('原点がオフセットされた通り芯のLevel立面DXFは未対応です。');

      for (const axis of parseElements(group, axisTag)) {
        const id = axis.getAttribute('id');
        const name = axis.getAttribute('name');
        const distance = axis.getAttribute('distance');
        if (
          !id ||
          id.trim() !== id ||
          !name ||
          !name.trim() ||
          distance === null ||
          !distance.trim() ||
          !Number.isFinite(Number(distance))
        )
          throw new Error('Level立面DXFの通り芯ID・名称・距離が欠落または不正です。');
        if (ids.has(id)) throw new Error('Level立面DXFの通り芯IDが重複しています。');
        ids.add(id);
        rawAxes.push({ id, name, distance: Number(distance) });
      }
    }
  }
  if (rawAxes.length !== parsedAxes.length)
    throw new Error('STB通り芯の生XMLと解析結果の件数が一致しません。');
  const parsedById = new Map(parsedAxes.map((axis) => [String(axis.id), axis]));
  for (const raw of rawAxes) {
    const parsed = parsedById.get(raw.id);
    if (
      !parsed ||
      parsed.axisKind !== 'parallel' ||
      parsed.name !== raw.name ||
      parsed.distance !== raw.distance
    )
      throw new Error('STB通り芯の生XMLと解析結果が一致しません。');
  }
}

function validateLevelFilename(filename, used) {
  if (/[<>:"\/\\|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename))
    throw new Error('Level立面DXFのファイル名に使用できない文字が含まれています。');
  const key = filename.normalize('NFC').toLowerCase();
  if (used.has(key)) throw new Error('Level立面DXFのファイル名が重複しています。');
  used.add(key);
  return filename;
}

/**
 * #455 Level stage 2 (explicit opt-in): a scene-independent Level-only
 * axis-elevation batch. This does not change the existing axis/member DXF UI
 * or the legacy includeLevels fallback. A+B is safe because only STB-A XML is read.
 *
 * All requested axes are compiled and DXF-validated before the first download,
 * so malformed/unsupported axes never silently produce an incomplete batch.
 * The browser's downloads are not atomic: changes during writing are detected
 * and stop subsequent files, but already written files cannot be recalled.
 */
export async function exportLevelElevationsToDxf(axisDirection = 'X', options = {}) {
  const batchOptions = /** @type {any} */ (options);
  const resolved = resolveLevelSource();
  if (!resolved.canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `Level立面DXFを出力できません: ${resolved.reason}`,
    });
    return false;
  }

  try {
    if (axisDirection !== 'X' && axisDirection !== 'Y')
      throw new TypeError('Level立面の通り芯方向はXまたはYに限定します。');

    const { source } = resolved;
    const sourceXml = serializeLevelDocument(source.document);
    const modelRevision = await sha256(new TextEncoder().encode(sourceXml));
    if (typeof modelRevision !== 'string' || !/^[0-9a-f]{64}$/.test(modelRevision))
      throw new Error('Level立面DXFのモデル改訂SHA-256が不正です。');
    const snapshot = source.document.cloneNode(true);
    const assertSourceUnchanged = () => {
      const current = resolveLevelSource();
      if (
        !current.canExport ||
        current.source.modelKey !== 'A' ||
        serializeLevelDocument(current.source.document) !== sourceXml
      ) {
        throw new Error('Level立面DXF生成中にSTB-Aが変更・編集されました。再実行してください。');
      }
    };

    const axesData = parseAxes(snapshot);
    const allAxes = axisDirection === 'X' ? axesData?.xAxes : axesData?.yAxes;
    if (!Array.isArray(allAxes) || allAxes.length === 0)
      throw new Error(`${axisDirection}方向のSTB通り芯がありません。`);
    validateLevelAxisSource(snapshot, axisDirection, allAxes);

    const axisIds = batchOptions.axisIds;
    if (axisIds !== undefined && (!Array.isArray(axisIds) || axisIds.length === 0))
      throw new TypeError('axisIdsは1つ以上の通り芯ID配列で指定してください。');
    const requested = axisIds === undefined ? null : new Set(axisIds.map(String));
    if (requested && requested.size !== axisIds.length)
      throw new TypeError('axisIdsに重複があります。');
    const axes = requested ? allAxes.filter((axis) => requested.has(String(axis.id))) : allAxes;
    if (requested && axes.length !== requested.size)
      throw new Error('指定した通り芯IDがSTB-Aに存在しません。');

    const seen = new Set();
    const usedFilenames = new Set();
    const sourceMeta = { modelKey: 'A', modelRevision };
    const prepared = axes.map((axis) => {
      const id = String(axis?.id ?? '').trim();
      if (!id || seen.has(id)) throw new Error('Level立面の通り芯IDが欠落または重複しています。');
      seen.add(id);
      const compiled = compileLevelElevationRenderPlanInternal({
        document: snapshot,
        source: sourceMeta,
        axisDirection,
        axisId: id,
        depth: batchOptions.depth,
        scaleDenominator: batchOptions.scaleDenominator,
        labelHeightModelMm: batchOptions.labelHeight,
      });
      const result = generateDrawingRenderPlanDxf(compiled.renderPlan);
      if (result.exportLog?.modelKey !== 'A' || result.exportLog?.modelRevision !== modelRevision)
        throw new Error('Level立面DXFのsource provenanceが一致しません。');
      return {
        filename: validateLevelFilename(
          `${getLoadedFilenameInternal()}_${axisDirection}${axis.name || id}_Level`,
          usedFilenames,
        ),
        content: result.content,
      };
    });
    assertSourceUnchanged();

    let directoryHandle;
    if ('directoryHandle' in batchOptions) {
      directoryHandle = batchOptions.directoryHandle;
    } else {
      const picked = await pickLevelDirectoryHandle();
      if (picked.cancelled) return false;
      directoryHandle = picked.handle;
    }

    const downloadDelay = batchOptions.downloadDelay ?? 100;
    for (const [index, item] of prepared.entries()) {
      assertSourceUnchanged();
      const saved = await downloadDxf(item.content, item.filename, directoryHandle, {
        fallbackToBrowserOnDirectoryError: false,
      });
      if (saved !== true) throw new Error('Level立面DXFの保存が完了しませんでした。');
      assertSourceUnchanged();
      if (index < prepared.length - 1 && !directoryHandle && downloadDelay > 0)
        await new Promise((resolve) => setTimeout(resolve, downloadDelay));
    }
    eventBus.emit(ToastEvents.SHOW_SUCCESS, {
      message: `${prepared.length}通り芯のLevel立面DXFを出力しました`,
    });
    return true;
  } catch (error) {
    log.error('Level立面DXFバッチ出力エラー:', error);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `Level立面DXFを出力できません: ${error.message}`,
    });
    return false;
  }
}
