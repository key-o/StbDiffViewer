/**
 * #516 Composite a persistent CAD sheet from explicit DrawingModels.
 * Paper-space matrices are owned by drawingSheetComposition. The same compiled
 * DrawingRenderPlans can later be passed to the PDF/DXF adapters; SVG rendering
 * does not infer plan/elevation geometry from a camera or browser viewport.
 */
import { createDrawingSheetComposition } from '../../data/drawing/drawingSheetComposition.js';
import { normalizeDrawingProject } from '../../data/drawing/drawingProjectSchema.js';
import { compilePersistedDrawingDimensions } from '../../data/drawing/drawingProjectDimensionAdapter.js';
import { createCadSheetPersistedTagOptions } from '../../data/drawing/drawingProjectTagAdapter.js';
import { resolvePersistedElevationReviews } from '../../data/drawing/drawingProjectElevationReviews.js';
import { compileDrawingRenderPlan } from '../../data/drawing/drawingRenderPlan.js';
import { assertCutSheetAnnotationsFit } from '../../data/drawing/drawingSheetCutAnnotationBounds.js';
import { getSheetPaperSize } from '../../data/drawing/drawingSheetPaper.js';
import { getDrawingSheetWorkspaceBounds } from '../../data/drawing/drawingSheetWorkspaceBounds.js';
import { buildSheetFramePlan } from '../../data/drawing/drawingSheetFrame.js';
import { renderDrawingSvg } from './svgDrawingRenderer.js';
import { createStbMemberTagFactsFromDocument } from './stbTagFactsAdapter.js';
import { DEFAULT_ELEMENT_COLORS } from '../../config/colorConfig.js';
import { formatLevelElevationDimensionValue } from './levelElevationDimensions.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function sameStoredView(expected, context) {
  if (expected.type !== context?.type) return false;
  if (expected.type === 'plan') return expected.storyId === context.storyId;
  return (
    expected.axisDirection === context.axisDirection &&
    expected.axisId === context.axisId &&
    expected.depth === context.depth
  );
}

/**
 * Only current-revision model-mm text annotations are publishable. Historical
 * notes stay in DrawingProject but do not silently become current annotations.
 * Current elevation reviews are independently validated project metadata.
 * Saved mark tags and revision-bound dimensions are native RenderPlan groups.
 */
export function resolveCadSheetTextAnnotations(document) {
  const result = [];
  for (const annotation of document.annotations || []) {
    if (annotation.context.sourceRevisionId !== document.sourceRevisionId) continue;
    if (!sameStoredView(document.view, annotation.context.view))
      throw new Error('現行注記のビューがDrawingDocumentと一致しません: ' + annotation.id);
    result.push(
      Object.freeze({
        id: 'drawing-project:' + document.id + ':' + annotation.id,
        kind: 'text',
        role: 'annotation-text',
        point: Object.freeze([...annotation.anchor.xy]),
        text: annotation.text,
        anchor: 'start',
      }),
    );
  }
  return Object.freeze(result);
}

export { createCadSheetPersistedTagOptions } from '../../data/drawing/drawingProjectTagAdapter.js';

/** Resolve every placed view before compiling any geometry. Fail closed on missing/stale data. */
export function createDrawingSheetRenderPlans({
  project,
  sheetId,
  drawingsById,
  sourceDocument = null,
  listReferencesByPlacementId = {},
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const composition = createDrawingSheetComposition({
    project: normalized,
    sheetId,
    drawingsById,
    listReferencesByPlacementId,
  });
  const sheet = normalized.drawingSheets.find((entry) => entry.id === sheetId);
  const { widthMm: paperWidthMm, heightMm: paperHeightMm } = getSheetPaperSize(
    sheet.paper,
    sheet.orientation,
  );
  const views = composition.views.map((entry) => {
    const placement = sheet.placements.find((item) => item.id === entry.placementId);
    if (!placement) throw new Error('シート配置IDが解決できません: ' + entry.placementId);
    const drawing = drawingsById[entry.drawingDocumentId];
    const drawingDocument = normalized.drawingDocuments.find(
      (document) => document.id === entry.drawingDocumentId,
    );
    if (!drawingDocument)
      throw new Error('DrawingDocumentがありません: ' + entry.drawingDocumentId);
    const elevationReviews =
      drawingDocument.view.type === 'elevation' && drawingDocument.memberReviews.length > 0
        ? resolvePersistedElevationReviews({
            project: normalized,
            document: drawingDocument,
            drawing,
          })
        : null;
    const renderPlan = compileDrawingRenderPlan({
      drawing,
      additionalAnnotations: resolveCadSheetTextAnnotations(drawingDocument),
      additionalDimensions: compilePersistedDrawingDimensions({
        project: normalized,
        document: drawingDocument,
        drawing,
        modelToPaper: entry.modelToPaper,
      }),
      ...(drawing.view?.type === 'elevation'
        ? { formatDimensionValue: formatLevelElevationDimensionValue }
        : {}),
      // The old saved views had no color snapshot. Preserve the normal CAD
      // member palette; explicit per-view colors always override the defaults.
      displaySettings: {
        ...drawingDocument.display,
        colors: { ...DEFAULT_ELEMENT_COLORS, ...drawingDocument.display.colors },
      },
      profile: {
        id: 'sdv-sheet-' + entry.placementId,
        modelToPaper: [...entry.modelToPaper],
        output: {
          preferredSpace: 'paper',
          editableText: true,
          dimensionRepresentation: 'exploded-line-text',
        },
      },
      tagOptions: createCadSheetPersistedTagOptions({
        project: normalized,
        document: drawingDocument,
        drawing,
        modelToPaper: entry.modelToPaper,
        resolveTagFacts: sourceDocument
          ? (ref, keys) =>
              createStbMemberTagFactsFromDocument({
                document: sourceDocument,
                source: drawing.source,
                ref,
                keys,
              })
          : null,
      }),
    });
    if (drawing.cutBoundsMm) assertCutSheetAnnotationsFit({ renderPlan, placement, paperHeightMm });
    return Object.freeze({
      placementId: entry.placementId,
      drawingDocumentId: entry.drawingDocumentId,
      placement: Object.freeze({ ...placement }),
      drawing,
      renderPlan,
      elevationReviews,
    });
  });
  const sheetOutput = {
    output: {
      preferredSpace: 'paper',
      editableText: true,
      dimensionRepresentation: 'exploded-line-text',
    },
  };
  for (const entry of composition.listViews) {
    const placement = sheet.listPlacements.find((item) => item.id === entry.placementId);
    const renderPlan = compileDrawingRenderPlan({
      referenceDrawings: [entry.reference],
      profile: {
        id: 'sdv-sheet-' + entry.placementId,
        modelToPaper: [...entry.modelToPaper],
        ...sheetOutput,
      },
    });
    views.push(
      Object.freeze({
        placementId: entry.placementId,
        drawingDocumentId: 'section-list:' + entry.placementId,
        placement: Object.freeze({ ...placement }),
        drawing: null,
        renderPlan,
        elevationReviews: null,
      }),
    );
  }
  return Object.freeze({
    sheetId,
    paper: sheet.paper,
    orientation: sheet.orientation,
    widthMm: paperWidthMm,
    heightMm: paperHeightMm,
    units: 'paper-mm',
    // 図枠・表題欄はシート単位の共通planで、SVG/PDFとDXFが同じ線と文字を出す。
    frame: buildSheetFramePlan(sheet),
    views: Object.freeze(views),
  });
}

/** Render one sheet's actual geometry. Nested SVG viewports clip to placement boxes. */
export function renderDrawingSheetCompositeSvg({
  project,
  sheetId,
  drawingsById,
  sourceDocument = null,
  document: domDocument = globalThis.document,
  selectedPlacementId = null,
  listReferencesByPlacementId = {},
  clipToPaper = false,
  onTagPointerDown = null,
  onPersistedDimensionSelect = null,
} = {}) {
  // Preflight and RenderPlan compilation happen before any DOM is created.
  const sheet = createDrawingSheetRenderPlans({
    project,
    sheetId,
    drawingsById,
    sourceDocument,
    listReferencesByPlacementId,
  });
  if (typeof domDocument?.createElementNS !== 'function')
    throw new TypeError('SVG生成用Documentが必要です。');
  const element = (name, attributes = {}) => {
    const node = domDocument.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const storedSheet = project.drawingSheets.find((item) => item.id === sheetId);
  const bounds = clipToPaper
    ? { minX: 0, minY: 0, widthMm: sheet.widthMm, heightMm: sheet.heightMm }
    : getDrawingSheetWorkspaceBounds(storedSheet);
  const root = element('svg', {
    viewBox: `${bounds.minX} ${bounds.minY} ${bounds.widthMm} ${bounds.heightMm}`,
    width: '100%',
    role: 'img',
    'aria-label': `${sheet.paper}シート実図形プレビュー ${sheet.views.length}ビュー`,
    'data-paper': sheet.paper,
    'data-orientation': sheet.orientation,
    'data-render-source': 'DrawingRenderPlan',
  });
  root.append(
    element('rect', {
      x: 0,
      y: 0,
      width: sheet.widthMm,
      height: sheet.heightMm,
      fill: '#ffffff',
      stroke: '#777777',
      'stroke-width': 0.5,
    }),
  );
  const paperToSvg = [1, 0, 0, -1, 0, sheet.heightMm];
  let content = root;
  if (clipToPaper) {
    // Explicit clip is required for vector PDF converters; a root viewBox by
    // itself is not a reliable page intersection when the viewport overflows.
    const defs = element('defs');
    const clip = element('clipPath', { id: 'cad-sheet-paper-clip' });
    clip.append(element('rect', { x: 0, y: 0, width: sheet.widthMm, height: sheet.heightMm }));
    defs.append(clip);
    root.append(defs);
    content = element('g', { 'clip-path': 'url(#cad-sheet-paper-clip)' });
    root.append(content);
    root.setAttribute('overflow', 'hidden');
  }
  if (sheet.frame) appendSheetFrame(content, sheet, element);
  for (const item of sheet.views) {
    const p = item.placement;
    const view = renderDrawingSvg({
      drawing: item.drawing,
      renderPlan: item.renderPlan,
      pdfToCss: paperToSvg,
      width: sheet.widthMm,
      height: sheet.heightMm,
      document: domDocument,
      showLabels: false,
      paperMmToCss: 1,
      onTagPointerDown:
        !clipToPaper && onTagPointerDown && item.drawing
          ? (event, context) =>
              onTagPointerDown(event, {
                ...context,
                placementId: item.placementId,
                drawingDocumentId: item.drawingDocumentId,
                modelToPaper: [...item.renderPlan.profile.modelToPaper],
              })
          : null,
      onPersistedDimensionSelect:
        !clipToPaper && onPersistedDimensionSelect && item.drawing
          ? (event, context) =>
              onPersistedDimensionSelect(event, {
                ...context,
                placementId: item.placementId,
                drawingDocumentId: item.drawingDocumentId,
              })
          : null,
    });
    // The child viewBox retains absolute sheet-mm coordinates, while the SVG
    // viewport clips its content to this placement's own rectangle.
    view.setAttribute('x', String(p.xMm));
    view.setAttribute('y', String(p.yMm));
    view.setAttribute('width', String(p.widthMm));
    view.setAttribute('height', String(p.heightMm));
    view.setAttribute('viewBox', `${p.xMm} ${p.yMm} ${p.widthMm} ${p.heightMm}`);
    view.setAttribute('class', 'cad-sheet-composite-view');
    view.setAttribute('data-placement-id', item.placementId);
    view.setAttribute('data-drawing-document-id', item.drawingDocumentId);
    content.append(view);
    content.append(
      element('rect', {
        x: p.xMm,
        y: p.yMm,
        width: p.widthMm,
        height: p.heightMm,
        fill: 'none',
        stroke: selectedPlacementId === item.placementId ? '#2465a5' : '#8a8a8a',
        'stroke-width': selectedPlacementId === item.placementId ? 1 : 0.25,
        'pointer-events': 'none',
      }),
    );
  }
  return root;
}

/** Draw the shared frame plan. Plan coordinates are Y-up; the SVG sheet is Y-down. */
function appendSheetFrame(root, sheet, element) {
  const flip = (y) => sheet.heightMm - y;
  const group = element('g', { class: 'cad-sheet-frame', 'data-drawing-layer': 'SDV_SHEET_FRAME' });
  for (const polyline of sheet.frame.polylines) {
    group.append(
      element('polygon', {
        points: polyline.points.map((point) => point.x + ',' + flip(point.y)).join(' '),
        fill: 'none',
        stroke: '#222222',
        'stroke-width': polyline.layer === 'SDV_SHEET_FRAME' ? 0.7 : 0.35,
        'data-drawing-layer': polyline.layer,
      }),
    );
  }
  for (const line of sheet.frame.lines) {
    group.append(
      element('line', {
        x1: line.start.x,
        y1: flip(line.start.y),
        x2: line.end.x,
        y2: flip(line.end.y),
        stroke: '#222222',
        'stroke-width': 0.25,
        'data-drawing-layer': line.layer,
      }),
    );
  }
  for (const entry of sheet.frame.texts) {
    const node = element('text', {
      x: entry.x,
      y: flip(entry.y),
      'text-anchor': entry.anchor === 'center' ? 'middle' : 'start',
      'font-size': entry.height,
      fill: '#222222',
      'data-drawing-layer': entry.layer,
    });
    node.textContent = entry.text;
    group.append(node);
  }
  root.append(group);
}

/**
 * Serialize the very same RenderPlan-backed SVG as the visual sheet preview.
 * Explicit millimetre page dimensions make the result independent of browser
 * viewport pixels and preserve A3 physical scale on standalone SVG import.
 */
export function serializeDrawingSheetCompositeSvg(options = {}) {
  const document = options.document ?? globalThis.document;
  // Selection highlight belongs to the editor, never to the published sheet.
  const svg = renderDrawingSheetCompositeSvg({
    ...options,
    document,
    selectedPlacementId: null,
    clipToPaper: true,
  });
  const [, , widthMm, heightMm] = svg.getAttribute('viewBox').split(' ').map(Number);
  svg.setAttribute('width', widthMm + 'mm');
  svg.setAttribute('height', heightMm + 'mm');
  const Serializer = document?.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
  if (typeof Serializer !== 'function') throw new Error('SVGのXMLシリアライザーが利用できません。');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new Serializer().serializeToString(svg);
}
