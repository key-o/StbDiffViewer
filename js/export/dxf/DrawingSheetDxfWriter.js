/**
 * #516: Paper-mm DXF output from the exact RenderPlans used by the A3 sheet SVG.
 * The caller owns source-revision validation and compiles the sheet before calling.
 * Never infer geometry from an SVG DOM, camera, or zoom state.
 */
import { getSheetPaperSize, isSheetPaperName } from '../../data/drawing/drawingSheetPaper.js';
import { resolveDxfLayerTable } from '../../data/drawing/drawingDxfLayerSettings.js';
import { ELEMENT_TYPE_COLORS } from '../../constants/dxfElementTypes.js';
import { collectDrawingRenderPlanDxfEntities } from './DrawingRenderPlanDxfWriter.js';
import { generatePlanDxfContent, downloadDxf } from './stb-to-dxf/DxfPlanFormatWriter.js';
import { DXF_OUTPUT_PROFILES, normalizeDxfOutputProfile } from './stb-to-dxf/DxfFormatWriter.js';

const ENTITY_ARRAYS = ['lines2D', 'polylines2D', 'texts2D', 'circles2D', 'arcs2D'];

function assertPlacement(placement, viewId) {
  const { xMm, yMm, widthMm, heightMm } = placement;
  if (![xMm, yMm, widthMm, heightMm].every(Number.isFinite) || widthMm <= 0 || heightMm <= 0) {
    throw new Error('DXFシート配置が不正です: ' + viewId);
  }
}

/**
 * Combine fully resolved view plans without recomputing their affine matrices.
 * R12 DXF has no native clipping region: geometry stays editable in model space,
 * including outside the paper/viewport, while the paper frame shows print bounds.
 */
export function generateDrawingSheetDxf(sheetPlans, options = {}) {
  if (
    !isSheetPaperName(sheetPlans?.paper) ||
    sheetPlans.units !== 'paper-mm' ||
    !['landscape', 'portrait'].includes(sheetPlans.orientation) ||
    sheetPlans.widthMm !== getSheetPaperSize(sheetPlans.paper, sheetPlans.orientation).widthMm ||
    sheetPlans.heightMm !== getSheetPaperSize(sheetPlans.paper, sheetPlans.orientation).heightMm ||
    !Array.isArray(sheetPlans.views) ||
    sheetPlans.views.length === 0
  ) {
    throw new TypeError('用紙サイズ(A0〜A4)付きのシートDrawingRenderPlansが必要です。');
  }
  const { widthMm, heightMm } = sheetPlans;
  const geometry = Object.fromEntries(ENTITY_ARRAYS.map((key) => [key, []]));
  const layers = new Set();
  const lineTypes = [];
  const diagnostics = [];
  for (const [index, view] of sheetPlans.views.entries()) {
    if (!view.placement || !view.renderPlan)
      throw new TypeError('未解決のシートビューがあります。');
    assertPlacement(view.placement, view.drawingDocumentId);
    const output = collectDrawingRenderPlanDxfEntities(view.renderPlan);
    if (output.space !== 'paper' || output.units !== 'mm') {
      throw new Error('シートDXFには紙面mmのRenderPlanが必要です。');
    }
    // DXF model space retains geometry outside the page and viewport;
    // the paper frame delineates printing. PDF/SVG clip those regions.
    // Namespace line types to prevent per-view SDV_DASH_1 conflicts.
    const names = new Map();
    for (const lineType of output.lineTypes) {
      const name = 'SH' + (index + 1) + '_' + lineType.name;
      names.set(lineType.name, name);
      lineTypes.push({ ...lineType, name });
    }
    for (const key of ENTITY_ARRAYS) {
      for (const entity of output[key]) {
        const lineType = names.get(entity.lineType) || entity.lineType;
        geometry[key].push({ ...entity, ...(lineType ? { lineType } : {}) });
      }
    }
    for (const layer of output.layers) layers.add(layer);
    // Export the same placement frames that the standalone sheet SVG draws.
    // DXF coordinates are mathematical Y-up; stored placement Y is top-down.
    const { xMm, yMm, widthMm: w, heightMm: h } = view.placement;
    const top = heightMm - yMm;
    geometry.polylines2D.push({
      id: 'sheet:viewport:' + view.placementId,
      layer: 'SDV_SHEET_VIEWPORT',
      closed: true,
      points: [
        { x: xMm, y: top - h },
        { x: xMm + w, y: top - h },
        { x: xMm + w, y: top },
        { x: xMm, y: top },
      ],
    });
    layers.add('SDV_SHEET_VIEWPORT');
    for (const diagnostic of output.diagnostics) {
      diagnostics.push({ ...diagnostic, drawingDocumentId: view.drawingDocumentId });
    }
  }
  // 図枠・表題欄: SVG/PDFと同じplanから出力する。
  if (sheetPlans.frame) {
    for (const polyline of sheetPlans.frame.polylines) {
      layers.add(polyline.layer);
      geometry.polylines2D.push({ ...polyline, points: polyline.points.map((p) => ({ ...p })) });
    }
    for (const line of sheetPlans.frame.lines) {
      layers.add(line.layer);
      geometry.lines2D.push({ ...line });
    }
    for (const entry of sheetPlans.frame.texts) {
      layers.add(entry.layer);
      geometry.texts2D.push({
        id: entry.id,
        position: { x: entry.x, y: entry.y },
        text: entry.text,
        layer: entry.layer,
        height: entry.height,
        rotation: 0,
        obliqueDeg: 0,
        widthFactor: 1,
        generationFlags: 0,
        anchor: entry.anchor,
        verticalAlign: 'baseline',
      });
    }
  }
  // Physical A3 outline, matching the exported SVG paper background border.
  layers.add('SDV_SHEET_FRAME');
  geometry.polylines2D.push({
    id: 'sheet:paper-frame',
    layer: 'SDV_SHEET_FRAME',
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: heightMm },
      { x: 0, y: heightMm },
    ],
  });
  // プロジェクトのDXFレイヤー設定: 名前・色・線種を適用する。未設定なら従来どおり。
  let layerTable = [...layers];
  if (options.layerSettings?.length) {
    const resolved = resolveDxfLayerTable({
      layerIds: [...layers],
      settings: options.layerSettings,
      defaultColor: (layerId) => ELEMENT_TYPE_COLORS[layerId],
    });
    for (const key of ENTITY_ARRAYS)
      geometry[key] = geometry[key].map((entity) => ({
        ...entity,
        layer: resolved.nameOf.get(entity.layer) ?? entity.layer,
      }));
    lineTypes.push(...resolved.lineTypes);
    layerTable = resolved.layers;
  }
  const profile = normalizeDxfOutputProfile(options.profile);
  const bounds = { min: { x: 0, y: 0 }, max: { x: widthMm, y: heightMm } };
  const content = generatePlanDxfContent(
    bounds,
    layerTable,
    geometry.lines2D,
    geometry.polylines2D,
    geometry.texts2D,
    geometry.circles2D,
    lineTypes,
    geometry.arcs2D,
    {
      textStyle: {
        fontFile: options.textStyle?.fontFile || 'txt',
        bigFontFile:
          options.textStyle?.bigFontFile ??
          (profile === DXF_OUTPUT_PROFILES.JWCAD_R12 ? '' : 'extfont2.shx'),
      },
    },
  );
  return Object.freeze({
    content,
    bounds,
    outputProfile: profile,
    paper: sheetPlans.paper,
    units: 'paper-mm',
    views: sheetPlans.views.length,
    diagnostics: Object.freeze(diagnostics),
    stats: Object.freeze(
      Object.fromEntries(ENTITY_ARRAYS.map((key) => [key, geometry[key].length])),
    ),
  });
}

export async function downloadDrawingSheetDxf(
  sheetPlans,
  filename,
  directoryHandle = null,
  options = {},
) {
  const result = generateDrawingSheetDxf(sheetPlans, options);
  await downloadDxf(result.content, filename, directoryHandle, {
    profile: result.outputProfile,
    assertBeforeSave: options.assertBeforeSave,
  });
  return result;
}
