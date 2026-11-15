/**
 * Persistent sheet index (#516). Views live in DrawingProject.drawingDocuments;
 * sheets only reference their IDs and store paper-mm placement intent.
 * RenderPlan/SVG/DXF and camera/viewport state must never become source data.
 */
import { getSheetPaperSize, isSheetPaperName } from './drawingSheetPaper.js';
import { getSheetFrameLayout, normalizeSheetFrame } from './drawingSheetFrame.js';

export class DrawingSheetCollectionError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'DrawingSheetCollectionError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, detail) {
  throw new DrawingSheetCollectionError(code, path, path + ': ' + detail);
}

function obj(value, path, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_TYPE', path, 'object required');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail('UNKNOWN_FIELD', path + '.' + key, 'unsupported persistent field');
  }
}

function str(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100)
    fail('INVALID_STRING', path, 'non-empty string up to 100 characters required');
  return value.trim();
}

function num(value, path, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0))
    fail('INVALID_NUMBER', path, 'finite number required' + (positive ? ' (> 0)' : ''));
  return value;
}

function unique(items, keyOf, path, code) {
  const seen = new Set();
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) fail(code, path + '[' + index + ']', 'duplicate: ' + key);
    seen.add(key);
  });
}

/** Shared validation for legacy section-list pages and CAD list placements. */
function assertSectionSource(modelSlots, modelSlotId, sourceRevisionId, path) {
  const slot = modelSlots.find((entry) => entry.id === modelSlotId);
  if (!slot || !slot.revisions.some((rev) => rev.id === sourceRevisionId))
    fail('UNKNOWN_SECTION_SOURCE', path + '.sourceRevisionId', 'known model revision required');
}

function normalizeScaleDenominator(value, path) {
  const scale = num(value, path, { positive: true });
  if (scale < 1) fail('INVALID_SCALE', path, 'denominator must be >= 1');
  return scale;
}

const SHEET_KEYS = [
  'id',
  'number',
  'name',
  'paper',
  'orientation',
  'placements',
  'listPlacements',
  'frame',
];
const SECTION_SHEET_KEYS = [
  'kind',
  'id',
  'number',
  'name',
  'paper',
  'orientation',
  'listType',
  'modelSlotId',
  'sourceRevisionId',
  'scaleDenominator',
  'compactColumns',
  'layoutId',
  'pageIndex',
  'regions',
  'viewSpec',
];
const SECTION_REGION_KEYS = [
  'id',
  'symbols',
  'storyIds',
  'xMm',
  'yMm',
  'widthMm',
  'heightMm',
  'label',
  'autoLabel',
];

/** Typed slate of intended RC slab rows, never derived geometry or an SVG cache. */
export function normalizeSlabListViewSpec(value, path = 'viewSpec') {
  obj(value, path, ['type', 'zone', 'rowIds']);
  if (value.type !== 'slab-list')
    fail('INVALID_SLAB_VIEW', path + '.type', 'slab-list view intent required');
  if (!['END', 'CENTER'].includes(value.zone))
    fail('INVALID_SLAB_VIEW_ZONE', path + '.zone', 'END or CENTER required');
  if (!Array.isArray(value.rowIds) || value.rowIds.length === 0)
    fail('INVALID_SLAB_VIEW_ROWS', path + '.rowIds', 'nonempty ordered row IDs required');
  const rowIds = value.rowIds.map((item, index) => str(item, path + '.rowIds[' + index + ']'));
  unique(rowIds, (id) => id, path + '.rowIds', 'DUPLICATE_SLAB_VIEW_ROW');
  return { type: 'slab-list', zone: value.zone, rowIds };
}

/** List pages share the A3 sheet index, but cannot masquerade as CAD ViewSpecs. */
export function isSectionListDrawingSheet(sheet) {
  return sheet?.kind === 'section-list';
}

function normalizeSectionListSheet(item, path, modelSlots) {
  obj(item, path, SECTION_SHEET_KEYS);
  const paper = item.paper ?? 'A3';
  if (paper !== 'A3')
    fail('INVALID_PAPER', path + '.paper', 'section-list common sheets require A3');
  const orientation = item.orientation ?? 'landscape';
  if (!['landscape', 'portrait'].includes(orientation))
    fail('INVALID_ORIENTATION', path + '.orientation', 'landscape or portrait required');
  const listType = str(item.listType, path + '.listType');
  if (!['beam', 'column', 'slab', 'steel-column', 'steel-beam', 'src-column', 'src-beam'].includes(listType))
    fail(
      'INVALID_SECTION_LIST_TYPE',
      path + '.listType',
      'beam, column, slab, steel-column, steel-beam, src-column or src-beam required',
    );
  if (item.viewSpec != null && listType !== 'slab')
    fail(
      'INVALID_SECTION_LIST_VIEW',
      path + '.viewSpec',
      'only slab sheets support slab-list view intent',
    );
  const viewSpec =
    item.viewSpec == null ? null : normalizeSlabListViewSpec(item.viewSpec, path + '.viewSpec');
  const modelSlotId = str(item.modelSlotId, path + '.modelSlotId');
  const sourceRevisionId = str(item.sourceRevisionId, path + '.sourceRevisionId');
  assertSectionSource(modelSlots, modelSlotId, sourceRevisionId, path);
  const scaleDenominator = normalizeScaleDenominator(
    item.scaleDenominator,
    path + '.scaleDenominator',
  );
  if (typeof item.compactColumns !== 'boolean')
    fail('INVALID_COLUMNS', path + '.compactColumns', 'boolean required');
  if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0)
    fail('INVALID_PAGE_INDEX', path + '.pageIndex', 'nonnegative page index required');
  if (!Array.isArray(item.regions) || item.regions.length === 0)
    fail('INVALID_SECTION_REGIONS', path + '.regions', 'nonempty regions required');
  const regions = item.regions.map((region, i) => {
    const p = path + '.regions[' + i + ']';
    obj(region, p, SECTION_REGION_KEYS);
    const symbols = region.symbols;
    const storyIds = region.storyIds;
    if (!Array.isArray(symbols) || !symbols.length || !Array.isArray(storyIds) || !storyIds.length)
      fail('INVALID_SECTION_REGION', p, 'symbols and storyIds required');
    const normalized = {
      id: str(region.id, p + '.id'),
      symbols: symbols.map((value, j) => str(value, p + '.symbols[' + j + ']')),
      storyIds: storyIds.map((value, j) => str(value, p + '.storyIds[' + j + ']')),
      xMm: num(region.xMm, p + '.xMm'),
      yMm: num(region.yMm, p + '.yMm'),
      widthMm: num(region.widthMm, p + '.widthMm', { positive: true }),
      heightMm: num(region.heightMm, p + '.heightMm', { positive: true }),
      label: typeof region.label === 'string' ? region.label : '',
      autoLabel: region.autoLabel === true,
    };
    if (
      typeof region.label !== 'string' ||
      region.label.length > 200 ||
      typeof region.autoLabel !== 'boolean'
    )
      fail('INVALID_SECTION_LABEL', p, 'label and autoLabel required');
    unique(normalized.symbols, (x) => x, p + '.symbols', 'DUPLICATE_SECTION_SYMBOL');
    unique(normalized.storyIds, (x) => x, p + '.storyIds', 'DUPLICATE_SECTION_STORY');
    return normalized;
  });
  unique(regions, (region) => region.id, path + '.regions', 'DUPLICATE_SECTION_REGION');
  if (viewSpec) {
    const ids = regions.flatMap((region) => region.symbols);
    if (ids.some((id) => !viewSpec.rowIds.includes(id)))
      fail(
        'SLAB_VIEW_ROW_MISMATCH',
        path + '.viewSpec.rowIds',
        'region rows must belong to the declared view',
      );
  }
  const width = orientation === 'portrait' ? 297 : 420;
  const height = orientation === 'portrait' ? 420 : 297;
  for (const [i, a] of regions.entries()) {
    if (a.xMm < 0 || a.yMm < 0 || a.xMm + a.widthMm > width || a.yMm + a.heightMm > height)
      fail('SECTION_REGION_OUTSIDE_PAPER', path + '.regions[' + i + ']', 'A3 overflow');
    for (const b of regions.slice(0, i)) {
      if (
        a.xMm < b.xMm + b.widthMm &&
        b.xMm < a.xMm + a.widthMm &&
        a.yMm < b.yMm + b.heightMm &&
        b.yMm < a.yMm + a.heightMm
      )
        fail('SECTION_REGION_OVERLAP', path + '.regions[' + i + ']', 'overlapping regions');
    }
  }
  return {
    kind: 'section-list',
    id: str(item.id, path + '.id'),
    number: str(item.number, path + '.number'),
    name: str(item.name, path + '.name'),
    paper,
    orientation,
    listType,
    modelSlotId,
    sourceRevisionId,
    scaleDenominator,
    compactColumns: item.compactColumns,
    layoutId: str(item.layoutId, path + '.layoutId'),
    pageIndex: item.pageIndex,
    regions,
    ...(viewSpec ? { viewSpec } : {}),
  };
}
const PLACEMENT_KEYS = [
  'id',
  'drawingDocumentId',
  'xMm',
  'yMm',
  'widthMm',
  'heightMm',
  'scaleDenominator',
  'rotationDeg',
  'viewOffsetXMm',
  'viewOffsetYMm',
];

const LIST_PLACEMENT_KEYS = [
  'id',
  'listType',
  'modelSlotId',
  'sourceRevisionId',
  'symbols',
  'storyIds',
  'zone',
  'xMm',
  'yMm',
  'widthMm',
  'heightMm',
  'scaleDenominator',
  'label',
  'autoLabel',
  'compactColumns',
];

/**
 * 断面リスト領域（柱/梁の階×符号の切り出し）をビューと同じ紙面mm・縮尺で置く配置。
 * ビュー配置(placements)とは別配列に保持し、drawingDocumentId前提の既存処理を壊さない。
 * 図形はSVG/DXF/PDFの再生成元であり、保存対象はこの意図のみ。
 */
function normalizeListPlacements(value, path, modelSlots) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_PLACEMENTS', path, 'array required');
  const result = value.map((placement, j) => {
    const p = path + '[' + j + ']';
    obj(placement, p, LIST_PLACEMENT_KEYS);
    const listType = str(placement.listType, p + '.listType');
    if (!['beam', 'column', 'slab', 'steel-column', 'steel-beam', 'src-column', 'src-beam'].includes(listType))
      fail(
        'INVALID_SECTION_LIST_TYPE',
        p + '.listType',
        'beam, column, slab, steel-column, steel-beam, src-column or src-beam required',
      );
    // スラブ領域は保存済みスラブリストViewSpecの行ID(symbols)と配筋表示位置(zone)を参照する。
    if (
      listType === 'slab'
        ? !['END', 'CENTER'].includes(placement.zone)
        : placement.zone !== undefined
    )
      fail('INVALID_SLAB_VIEW_ZONE', p + '.zone', 'END or CENTER required for slab only');
    const modelSlotId = str(placement.modelSlotId, p + '.modelSlotId');
    const sourceRevisionId = str(placement.sourceRevisionId, p + '.sourceRevisionId');
    assertSectionSource(modelSlots, modelSlotId, sourceRevisionId, p);
    const names = (items, label) => {
      if (!Array.isArray(items) || items.length === 0)
        fail('INVALID_SECTION_REGION', p + '.' + label, 'nonempty array required');
      const normalized = items.map((item, k) => str(item, p + '.' + label + '[' + k + ']'));
      unique(normalized, (x) => x, p + '.' + label, 'DUPLICATE_SECTION_SYMBOL');
      return normalized;
    };
    const scaleDenominator = normalizeScaleDenominator(
      placement.scaleDenominator,
      p + '.scaleDenominator',
    );
    if (
      placement.label !== undefined &&
      (typeof placement.label !== 'string' || placement.label.length > 200)
    )
      fail('INVALID_SECTION_LABEL', p + '.label', 'label must be a string up to 200 characters');
    if (placement.autoLabel !== undefined && typeof placement.autoLabel !== 'boolean')
      fail('INVALID_SECTION_LABEL', p + '.autoLabel', 'autoLabel must be boolean');
    if (placement.compactColumns !== undefined && placement.compactColumns !== true)
      fail('INVALID_COLUMNS', p + '.compactColumns', 'only compact columns are supported');
    return {
      id: str(placement.id, p + '.id'),
      listType,
      ...(placement.label === undefined ? {} : { label: placement.label }),
      ...(placement.autoLabel === undefined ? {} : { autoLabel: placement.autoLabel }),
      ...(placement.compactColumns === undefined ? {} : { compactColumns: true }),
      modelSlotId,
      sourceRevisionId,
      symbols: names(placement.symbols, 'symbols'),
      storyIds: names(placement.storyIds, 'storyIds'),
      ...(listType === 'slab' ? { zone: placement.zone } : {}),
      xMm: num(placement.xMm, p + '.xMm'),
      yMm: num(placement.yMm, p + '.yMm'),
      widthMm: num(placement.widthMm, p + '.widthMm', { positive: true }),
      heightMm: num(placement.heightMm, p + '.heightMm', { positive: true }),
      scaleDenominator,
    };
  });
  unique(result, (item) => item.id, path, 'DUPLICATE_PLACEMENT');
  return result;
}

/** Backward compatible: omitted collection means no sheets, not an implicit auto-generated sheet. */
export function normalizeDrawingSheets(value, drawingDocuments = [], modelSlots = []) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_SHEETS', 'drawingSheets', 'array required');
  const documentIds = new Set(drawingDocuments.map((doc) => doc.id));
  const result = value.map((item, i) => {
    const path = 'drawingSheets[' + i + ']';
    if (isSectionListDrawingSheet(item)) return normalizeSectionListSheet(item, path, modelSlots);
    obj(item, path, SHEET_KEYS);
    const paper = item.paper ?? 'A3';
    const orientation = item.orientation ?? 'landscape';
    if (!isSheetPaperName(paper))
      fail('INVALID_PAPER', path + '.paper', 'unsupported paper size: ' + paper);
    if (!['landscape', 'portrait'].includes(orientation))
      fail('INVALID_ORIENTATION', path + '.orientation', 'landscape or portrait required');
    if (!Array.isArray(item.placements))
      fail('INVALID_PLACEMENTS', path + '.placements', 'array required');
    const placements = item.placements.map((placement, j) => {
      const p = path + '.placements[' + j + ']';
      obj(placement, p, PLACEMENT_KEYS);
      const drawingDocumentId = str(placement.drawingDocumentId, p + '.drawingDocumentId');
      if (!documentIds.has(drawingDocumentId))
        fail(
          'UNKNOWN_DRAWING_DOCUMENT',
          p + '.drawingDocumentId',
          'referenced view does not exist',
        );
      const rotationDeg = placement.rotationDeg ?? 0;
      if (![0, 90, 180, 270].includes(rotationDeg))
        fail('INVALID_ROTATION', p + '.rotationDeg', '0, 90, 180 or 270 required');
      return {
        id: str(placement.id, p + '.id'),
        drawingDocumentId,
        xMm: num(placement.xMm, p + '.xMm'),
        yMm: num(placement.yMm, p + '.yMm'),
        widthMm: num(placement.widthMm, p + '.widthMm', { positive: true }),
        heightMm: num(placement.heightMm, p + '.heightMm', { positive: true }),
        scaleDenominator: normalizeScaleDenominator(
          placement.scaleDenominator,
          p + '.scaleDenominator',
        ),
        rotationDeg,
        ...(placement.viewOffsetXMm === undefined
          ? {}
          : { viewOffsetXMm: num(placement.viewOffsetXMm, p + '.viewOffsetXMm') }),
        ...(placement.viewOffsetYMm === undefined
          ? {}
          : { viewOffsetYMm: num(placement.viewOffsetYMm, p + '.viewOffsetYMm') }),
      };
    });
    unique(placements, (p) => p.id, path + '.placements', 'DUPLICATE_PLACEMENT');
    const listPlacements = normalizeListPlacements(
      item.listPlacements,
      path + '.listPlacements',
      modelSlots,
    );
    let frame;
    try {
      frame = normalizeSheetFrame(item.frame, path + '.frame');
    } catch (error) {
      fail(error.code ?? 'INVALID_SHEET_FRAME', error.path ?? path + '.frame', error.message);
    }
    unique(
      [...placements, ...listPlacements],
      (p) => p.id,
      path + '.placements',
      'DUPLICATE_PLACEMENT',
    );
    return {
      id: str(item.id, path + '.id'),
      number: str(item.number, path + '.number'),
      name: str(item.name, path + '.name'),
      paper,
      orientation,
      placements,
      // 旧データのJSON往復を変えないため、空のときは出力しない。
      ...(listPlacements.length ? { listPlacements } : {}),
      ...(frame ? { frame } : {}),
    };
  });
  unique(result, (sheet) => sheet.id, 'drawingSheets', 'DUPLICATE_SHEET');
  unique(result, (sheet) => sheet.number.toLowerCase(), 'drawingSheets', 'DUPLICATE_SHEET_NUMBER');
  unique(
    result.filter(isSectionListDrawingSheet),
    (sheet) => sheet.layoutId + ':' + sheet.pageIndex,
    'drawingSheets',
    'DUPLICATE_SECTION_LIST_PAGE',
  );
  // Every stored slab-list ViewSpec must describe the exact ordered rows across
  // its A3 pages. An omitted or duplicated row must not silently disappear.
  const slabLayouts = new Map();
  for (const section of result) {
    if (!isSectionListDrawingSheet(section) || section.listType !== 'slab') continue;
    const key = JSON.stringify([section.modelSlotId, section.sourceRevisionId, section.layoutId]);
    if (!slabLayouts.has(key)) slabLayouts.set(key, []);
    slabLayouts.get(key).push(section);
  }
  for (const sheets of slabLayouts.values()) {
    const specs = sheets.map((sheet) => sheet.viewSpec ?? null);
    if (specs.every((spec) => spec == null)) continue; // legacy layout
    const canonical = specs[0];
    if (!canonical || specs.some((spec) => JSON.stringify(spec) !== JSON.stringify(canonical)))
      fail('SLAB_VIEW_SPEC_MISMATCH', 'drawingSheets', 'slab pages must share one ViewSpec');
    const pageRows = sheets
      .sort((a, b) => a.pageIndex - b.pageIndex)
      .flatMap((sheet) => sheet.regions.flatMap((region) => region.symbols));
    if (JSON.stringify(pageRows) !== JSON.stringify(canonical.rowIds))
      fail(
        'SLAB_VIEW_ROW_MISMATCH',
        'drawingSheets',
        'stored page row order differs from ViewSpec',
      );
  }
  return result;
}

/** Validate the entire proposed collection before publishing a new project object. */
function withNormalizedSheets(project, sheets) {
  return {
    ...project,
    drawingSheets: normalizeDrawingSheets(sheets, project.drawingDocuments, project.modelSlots),
  };
}

/** Diagnostics do not alter placement coordinates; unpublishable layouts stay editable. */
export function inspectDrawingSheetPlacements(sheet) {
  const { widthMm: width, heightMm: height } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const issues = [];
  const all = [...sheet.placements, ...(sheet.listPlacements ?? [])];
  const layout = getSheetFrameLayout(sheet);
  all.forEach((p, i) => {
    if (p.xMm < 0 || p.yMm < 0 || p.xMm + p.widthMm > width || p.yMm + p.heightMm > height)
      issues.push({ code: 'SHEET_OUT_OF_BOUNDS', sheetId: sheet.id, placementId: p.id });
    else if (layout) {
      const { inner, titleBlock } = layout;
      if (
        p.xMm < inner.minX ||
        p.yMm < inner.minY ||
        p.xMm + p.widthMm > inner.maxX ||
        p.yMm + p.heightMm > inner.maxY
      )
        issues.push({ code: 'SHEET_OUTSIDE_FRAME', sheetId: sheet.id, placementId: p.id });
      else if (
        p.xMm < titleBlock.maxX &&
        p.xMm + p.widthMm > titleBlock.minX &&
        p.yMm < titleBlock.maxY &&
        p.yMm + p.heightMm > titleBlock.minY
      )
        issues.push({ code: 'SHEET_OVERLAPS_TITLE_BLOCK', sheetId: sheet.id, placementId: p.id });
    }
    for (const other of all.slice(0, i)) {
      if (
        p.xMm < other.xMm + other.widthMm &&
        p.xMm + p.widthMm > other.xMm &&
        p.yMm < other.yMm + other.heightMm &&
        p.yMm + p.heightMm > other.yMm
      )
        issues.push({
          code: 'SHEET_OVERLAP',
          sheetId: sheet.id,
          placementId: p.id,
          otherId: other.id,
        });
    }
  });
  return issues;
}

/**
 * Shared edit path for placed drawing views and section-list regions.
 * Identity and STB source fields are immutable; callers validate the allowed changes.
 * Removing the last list region also removes the optional listPlacements key.
 */
function mutateSheetPlacement(
  project,
  { sheetId, placementId, collection, changes, remove = false, missingDetail },
) {
  let found = false;
  const drawingSheets = (project.drawingSheets ?? []).map((sheet) => {
    if (sheet.id !== sheetId || isSectionListDrawingSheet(sheet)) return sheet;
    const entries = sheet[collection] ?? [];
    if (!entries.some((entry) => entry.id === placementId)) return sheet;
    found = true;
    const nextEntries = remove
      ? entries.filter((entry) => entry.id !== placementId)
      : entries.map((entry) => (entry.id === placementId ? { ...entry, ...changes } : entry));
    if (remove && collection === 'listPlacements' && nextEntries.length === 0) {
      const next = { ...sheet };
      delete next.listPlacements;
      return next;
    }
    return { ...sheet, [collection]: nextEntries };
  });
  if (!found) fail('UNKNOWN_PLACEMENT', 'placementId', missingDetail);
  return withNormalizedSheets(project, drawingSheets);
}

/** Atomic mutations; caller persists through normalizeDrawingProject before committing. */
export function addDrawingSheet(project, sheet) {
  return withNormalizedSheets(project, [...(project.drawingSheets ?? []), sheet]);
}

export function placeDrawingDocumentOnSheet(project, sheetId, placement) {
  if (!project.drawingSheets?.some((s) => s.id === sheetId && !isSectionListDrawingSheet(s)))
    fail('UNKNOWN_SHEET', 'sheetId', 'CAD sheet not found');
  return withNormalizedSheets(
    project,
    project.drawingSheets.map((s) =>
      s.id === sheetId ? { ...s, placements: [...s.placements, placement] } : s,
    ),
  );
}

/** Place a section-list region (beam/column) on a CAD sheet at the same paper-mm scale as views. */
export function placeSectionListRegionOnSheet(project, sheetId, placement) {
  if (!project.drawingSheets?.some((s) => s.id === sheetId && !isSectionListDrawingSheet(s)))
    fail('UNKNOWN_SHEET', 'sheetId', 'CAD sheet not found');
  return withNormalizedSheets(
    project,
    project.drawingSheets.map((s) =>
      s.id === sheetId ? { ...s, listPlacements: [...(s.listPlacements ?? []), placement] } : s,
    ),
  );
}

/** Update one list's paper placement without changing its STB source or row selection. */
export function updateSectionListRegionOnSheet(project, sheetId, placementId, changes) {
  obj(changes, 'changes', ['xMm', 'yMm', 'widthMm', 'heightMm', 'scaleDenominator', 'label']);
  return mutateSheetPlacement(project, {
    sheetId,
    placementId,
    collection: 'listPlacements',
    changes,
    missingDetail: 'target list placement not found',
  });
}

export function removeSectionListRegionFromSheet(project, sheetId, placementId) {
  return mutateSheetPlacement(project, {
    sheetId,
    placementId,
    collection: 'listPlacements',
    remove: true,
    missingDetail: 'target placement not found',
  });
}

/**
 * #565 P3: 旧「リスト専用シート」(kind: section-list) を通常シート＋listPlacementsへ互換変換する。
 * スラブのViewSpec行順検証がレイアウト全ページで成立するため、同一layoutIdの全ページを不可分に変換する。
 * 紙面位置・縮尺・シートID/番号/名称、領域ラベルを保持する。
 * 旧HTML列幅の非圧縮モードはCADで再現できないため変換しない。
 * 変換できない旧データ(ViewSpecのない旧スラブ等)は元のプロジェクトを変えずに拒否する。
 */
export function convertSectionListLayoutToCadSheets(project, layoutId) {
  const pages = (project.drawingSheets ?? []).filter(
    (sheet) => isSectionListDrawingSheet(sheet) && sheet.layoutId === layoutId,
  );
  if (!pages.length) fail('UNKNOWN_LAYOUT', 'layoutId', 'section-list layout not found');
  const ordered = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  const first = ordered[0];
  if (
    ordered.some(
      (page, index) =>
        page.pageIndex !== index ||
        page.listType !== first.listType ||
        page.modelSlotId !== first.modelSlotId ||
        page.sourceRevisionId !== first.sourceRevisionId ||
        page.scaleDenominator !== first.scaleDenominator ||
        page.orientation !== first.orientation ||
        page.compactColumns !== first.compactColumns ||
        JSON.stringify(page.viewSpec ?? null) !== JSON.stringify(first.viewSpec ?? null),
    )
  )
    fail(
      'INVALID_SECTION_LAYOUT_PAGES',
      'layoutId',
      'section-list layout has missing pages or inconsistent settings',
    );
  // Slab lists use their own vector producer, independent of the legacy
  // beam/column HTML column-width mode. Standard slab saves use false.
  if (!first.compactColumns && first.listType !== 'slab')
    fail(
      'UNSUPPORTED_SECTION_COLUMNS',
      'layoutId',
      '画面と同じ列幅はCADのベクター描画で再現できません。旧リストの列幅を「内容に合わせる」にして保存してください。',
    );
  const converted = new Map(
    pages.map((page) => {
      if (page.listType === 'slab' && !page.viewSpec)
        fail(
          'LEGACY_SLAB_ZONE_UNKNOWN',
          'layoutId',
          'legacy slab list without ViewSpec cannot be converted',
        );
      return [
        page.id,
        {
          id: page.id,
          number: page.number,
          name: page.name,
          paper: page.paper,
          orientation: page.orientation,
          placements: [],
          listPlacements: page.regions.map((region) => ({
            id: region.id,
            listType: page.listType,
            modelSlotId: page.modelSlotId,
            sourceRevisionId: page.sourceRevisionId,
            symbols: [...region.symbols],
            storyIds: [...region.storyIds],
            ...(page.listType === 'slab' ? { zone: page.viewSpec.zone } : {}),
            label: region.label,
            autoLabel: region.autoLabel,
            compactColumns: true,
            xMm: region.xMm,
            yMm: region.yMm,
            widthMm: region.widthMm,
            heightMm: region.heightMm,
            scaleDenominator: page.scaleDenominator,
          })),
        },
      ];
    }),
  );
  return withNormalizedSheets(
    project,
    project.drawingSheets.map((sheet) => converted.get(sheet.id) ?? sheet),
  );
}

export function removeDrawingSheet(project, sheetId) {
  if (!project.drawingSheets?.some((s) => s.id === sheetId))
    fail('UNKNOWN_SHEET', 'sheetId', 'target sheet not found');
  return { ...project, drawingSheets: project.drawingSheets.filter((s) => s.id !== sheetId) };
}

/** Changing a sheet name/number never alters its placements or persisted view identities. */
export function updateDrawingSheet(project, sheetId, changes) {
  if (
    !project.drawingSheets?.some(
      (sheet) => sheet.id === sheetId && !isSectionListDrawingSheet(sheet),
    )
  )
    fail('UNKNOWN_SHEET', 'sheetId', 'CAD sheet not found');
  obj(changes, 'changes', ['number', 'name', 'orientation', 'paper', 'frame']);
  // `frame: null` removes the frame and title block.
  const { frame, ...rest } = changes;
  const apply = (sheet) => {
    const next = { ...sheet, ...rest };
    if (frame === null) delete next.frame;
    else if (frame !== undefined) next.frame = frame;
    return next;
  };
  // Changing paper dimensions never moves/crops the saved viewport positions.
  // The sheet outline defines the printable area, not the editable workspace.
  return withNormalizedSheets(
    project,
    project.drawingSheets.map((sheet) => (sheet.id === sheetId ? apply(sheet) : sheet)),
  );
}

/** Move an existing placement; errors cannot partially mutate the source project. */
export function updateDrawingSheetPlacement(project, sheetId, placementId, changes) {
  obj(changes, 'changes', [
    'xMm',
    'yMm',
    'widthMm',
    'heightMm',
    'scaleDenominator',
    'rotationDeg',
    'viewOffsetXMm',
    'viewOffsetYMm',
  ]);
  return mutateSheetPlacement(project, {
    sheetId,
    placementId,
    collection: 'placements',
    changes,
    missingDetail: 'target placement not found',
  });
}

/** Explicit preflight required before exporting an occupied sheet. */
export function assertDrawingSheetPublishable(sheet) {
  if (isSectionListDrawingSheet(sheet))
    fail('INVALID_SHEET_KIND', 'sheet.kind', 'CAD RenderPlan cannot export a section-list page');
  if (sheet.placements.length === 0 && !sheet.listPlacements?.length)
    fail('SHEET_EMPTY', 'sheet.placements', 'sheet has no placed views');
  // Out-of-paper, overlapping and title-block placements are editable/publishable.
  // inspectDrawingSheetPlacements still reports them as non-blocking warnings.
  return sheet;
}

/** Remove a placed view without deleting its source DrawingDocument. */
export function removeDrawingSheetPlacement(project, sheetId, placementId) {
  return mutateSheetPlacement(project, {
    sheetId,
    placementId,
    collection: 'placements',
    remove: true,
    missingDetail: 'target placement not found',
  });
}
