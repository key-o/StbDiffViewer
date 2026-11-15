/**
 * #510: All-sheet export is a single transaction. Generate and validate every
 * SVG/DXF/PDF before offering a ZIP download; no partial files on failure.
 */
import { strToU8, zipSync } from 'fflate';
import {
  createDrawingSheetRenderPlans,
  serializeDrawingSheetCompositeSvg,
} from '../../../viewer/drawing/drawingSheetCompositeSvg.js';
import { generateDrawingSheetDxf } from '../../../export/dxf/DrawingSheetDxfWriter.js';
import { createDxfBlob } from '../../../export/dxf/stb-to-dxf/DxfFormatWriter.js';
import { exportCompositeCadSheetPdf } from './cadSheetPdfExporter.js';

function sheetFilename(sheet, used) {
  const source = String(sheet.number || sheet.id || 'sheet').replace(/[^A-Za-z0-9_-]/g, '_');
  let name = 'sheet-' + (source || 'unnamed');
  // Windows file systems are generally case-insensitive, while ZIP entries
  // are not. Resolve collisions on the normalized, case-folded disk name.
  if (used.has(name.toLowerCase())) name += '-' + String(sheet.id).replace(/[^A-Za-z0-9_-]/g, '_');
  if (used.has(name.toLowerCase())) throw new Error('出力ファイル名が重複しています: ' + name);
  used.add(name.toLowerCase());
  return name;
}

/**
 * A3 composite sheet output archive: all preflight succeeds before any save.
 * sourcesBySheetId must be produced by collectDrawingSheetModels for the
 * current STB-A revision. assertBeforeSave checks that revision again.
 */
export async function buildCadSheetBatchArchive({
  project,
  sourcesBySheetId,
  sourceDocument = null,
  listReferencesBySheetId = {},
  document,
  mode = 'vector',
  fontFile = null,
  printOptions = {},
  assertBeforeSave,
  JsPdf = null,
  renderVectorOverride = null,
  captureOverride = null,
} = {}) {
  const sheets = project?.drawingSheets?.filter((sheet) => sheet.kind !== 'section-list');
  if (!Array.isArray(sheets) || sheets.length === 0)
    throw new Error('出力するシートがありません。');
  if (typeof assertBeforeSave !== 'function')
    throw new TypeError('一括出力にはSTB改訂・プロジェクトの最終検証が必要です。');

  // Complete layout/source preflight first. A failed sheet cannot leave ZIP
  // entries from earlier pages on disk because nothing is downloaded yet.
  const prepared = sheets.map((sheet) => {
    const sources = sourcesBySheetId?.[sheet.id];
    if (!sources) throw new Error('未生成のシートがあります: ' + sheet.id);
    const layout = createDrawingSheetRenderPlans({
      project,
      sheetId: sheet.id,
      drawingsById: sources,
      sourceDocument,
      listReferencesByPlacementId: listReferencesBySheetId[sheet.id] ?? {},
    });
    if (layout.views.length === 0) throw new Error('配置ビューがありません: ' + sheet.id);
    return { sheet, sources, layout };
  });

  const entries = Object.create(null);
  const names = new Set();
  for (const { sheet, sources, layout } of prepared) {
    const base = sheetFilename(sheet, names);
    const common = {
      project,
      sheetId: sheet.id,
      drawingsById: sources,
      sourceDocument,
      document,
      listReferencesByPlacementId: listReferencesBySheetId[sheet.id] ?? {},
    };
    const svg = serializeDrawingSheetCompositeSvg(common);
    const dxf = generateDrawingSheetDxf(layout, { layerSettings: project.dxfLayerSettings });
    const dxfBlob = await createDxfBlob(dxf.content, { profile: dxf.outputProfile });
    const pdf = await exportCompositeCadSheetPdf({
      ...common,
      filename: base + '.pdf',
      output: 'bytes',
      mode,
      fontFile,
      printOptions,
      JsPdf,
      renderVectorOverride,
      captureOverride,
      assertBeforeSave,
    });
    entries[base + '.svg'] = strToU8(svg);
    entries[base + '.dxf'] = new Uint8Array(await dxfBlob.arrayBuffer());
    entries[base + '.pdf'] = pdf.bytes;
  }
  await assertBeforeSave();
  return Object.freeze({
    bytes: zipSync(entries, { level: 4 }),
    sheets: prepared.length,
    files: Object.freeze(Object.keys(entries)),
    format: 'zip',
  });
}
