/**
 * @fileoverview 簡易CADシートに置く柱/梁リスト領域の図形生成（#559 c-2）。
 *
 * 配置が保存するのは種別・STB改訂・階/符号の意図だけ。図形は現行STB-Aの断面リスト
 * 抽出結果から毎回再生成し、ReferenceDrawingとして共通のDrawingRenderPlanへ渡す。
 */
import { isSectionListDrawingSheet } from '../../../data/drawing/drawingSheetCollection.js';
import { extractBeamSectionGrid } from '../../../data/extractors/beamSectionList/index.js';
import { extractColumnSectionGrid } from '../../../data/extractors/columnSectionListExtractor.js';
import {
  extractSteelColumnSectionGrid,
  extractSteelBeamSectionGrid,
} from '../../../data/extractors/steelSectionListExtractor.js';
import { extractSrcColumnSectionGrid, extractSrcBeamSectionGrid } from '../../../data/extractors/srcSectionListExtractor.js';
import { BASELINE_RC_SCHEDULE_PROFILE } from '../../../components/rcScheduleProfile.js';
import { buildBeamSectionListEntities } from '../sectionList/BeamSectionListDxfExporter.js';
import { buildConfiguredColumnSectionListEntities } from '../sectionList/ConfiguredColumnSectionListDxfExporter.js';
import { buildSteelSectionListEntities } from '../sectionList/SteelSectionListDxfExporter.js';
import { extractSlabSectionFacts } from '../../../data/extractors/slabList/slabSectionFacts.js';
import {
  normalizeSlabListState,
  resolveSlabList,
} from '../../../data/extractors/slabList/slabListResolver.js';
import { readSlabListXmlSource } from '../../../data/extractors/slabList/slabListSourceArchive.js';
import { parseSlabDesignXml } from '../../../data/extractors/slabList/slabDesignXmlAdapter.js';
import { buildSlabListRows } from '../sectionList/slabListViewModel.js';
import { buildSlabDxfEntities, produceSlabListView } from '../sectionList/slabListOutput.js';
import { createSectionListReferenceDrawing } from '../sectionList/sectionListReferenceDrawing.js';

export const CAD_SHEET_LIST_TYPES = Object.freeze({
  beam: Object.freeze({ label: '梁リスト', extract: extractBeamSectionGrid }),
  column: Object.freeze({ label: '柱リスト', extract: extractColumnSectionGrid }),
  'steel-column': Object.freeze({ label: 'S柱リスト', extract: extractSteelColumnSectionGrid }),
  'steel-beam': Object.freeze({ label: 'S梁リスト', extract: extractSteelBeamSectionGrid }),
  'src-column': Object.freeze({ label: 'SRC柱リスト', extract: extractSrcColumnSectionGrid }),
  'src-beam': Object.freeze({ label: 'SRC梁リスト', extract: extractSrcBeamSectionGrid }),
  // スラブは階×符号の格子ではなく、保存済みスラブリストViewSpecの行(rowIds)+配筋位置(zone)で指す。
  slab: Object.freeze({ label: 'スラブリスト', extract: null }),
});

const BUILDERS = Object.freeze({
  beam: buildBeamSectionListEntities,
  column: buildConfiguredColumnSectionListEntities,
  'steel-column': buildSteelSectionListEntities,
  'steel-beam': buildSteelSectionListEntities,
  'src-column': buildSteelSectionListEntities,
  'src-beam': buildSteelSectionListEntities,
});

/** 配置の既定縮尺（断面リスト画面・DXFの基準作図縮尺）。 */
export const DEFAULT_LIST_REGION_SCALE = BASELINE_RC_SCHEDULE_PROFILE.scaleDenominator;

function definition(listType) {
  const def = CAD_SHEET_LIST_TYPES[listType];
  if (!def?.extract) throw new RangeError('未対応の断面リスト種別です: ' + listType);
  return def;
}

/** STB文書から階・符号の候補を取り出す。 */
export function extractCadListGrid(listType, sourceDocument) {
  if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
  return definition(listType).extract(sourceDocument);
}

/** 階ID・符号で領域に絞る。存在しない指定は黙って落とさず拒否する。 */
export function sliceListGrid(gridData, storyIds, symbols) {
  const stories = storyIds.map((id) => {
    const story = gridData.stories?.find((entry) => entry.id === id);
    if (!story) throw new Error('断面リストに存在しない階です: ' + id);
    return story;
  });
  const known = new Set(gridData.symbols ?? []);
  for (const symbol of symbols)
    if (!known.has(symbol)) throw new Error('断面リストに存在しない符号です: ' + symbol);
  return { ...gridData, stories, symbols: [...symbols] };
}

/**
 * Rehydrate the source archived in DrawingProject, validating the original
 * bytes against SHA-256 before parsing. Never fetch or replace external XML.
 */
export async function verifySavedSlabListXml(project, { Parser = globalThis.DOMParser } = {}) {
  const state = normalizeSlabListState(project?.slabListState ?? undefined);
  const sources = state.xmlSources.filter((source) => source.modelSide === 'A');
  if (sources.length > 1) throw new Error('複数のSTB-A補助XMLが保存されています。');
  if (!sources.length) return null;
  const hash = sources[0].sha256;
  const bytes = await readSlabListXmlSource(state, { modelSide: 'A', sha256: hash });
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const facts = parseSlabDesignXml(xml, { Parser });
  if (!facts.ok) throw new Error('保存済みスラブ補助XMLの形式が不正です。');
  return { hash, facts };
}

/** Recreate a saved slab ViewSpec from current STB and verified auxiliary XML. */
function slabEntitiesForPlacement({ placement, project, sourceDocument, xmlContext = null }) {
  if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
  const slot = project?.modelSlots?.find((entry) => entry.id === placement.modelSlotId);
  const revision = slot?.revisions.find((entry) => entry.id === placement.sourceRevisionId);
  const sha = revision?.sha256?.toLowerCase();
  if (!sha) throw new Error('スラブ領域のSTB改訂が見つかりません: ' + placement.id);
  const state = normalizeSlabListState(project.slabListState ?? undefined);
  const links = state.mappings.filter(
    (m) => m.modelSide === 'A' && m.stbRevision === sha && m.decision === 'LINK',
  );
  if (links.some((mapping) => mapping.xmlSourceHash !== xmlContext?.hash))
    throw new Error('補助XML照合の保存元が一致しません。保存XMLを再検証してください。');
  const facts = extractSlabSectionFacts(sourceDocument, { modelSide: 'A', revision: sha });
  const rows = buildSlabListRows(
    resolveSlabList({
      stbFacts: facts,
      state,
      xmlFacts: xmlContext?.facts ?? null,
      xmlSourceHash: xmlContext?.hash ?? null,
    }),
    {
      auxiliaryRows: state.auxiliaryRows || [],
      modelSide: 'A',
      stbRevision: sha,
    },
  );
  const { pages } = produceSlabListView(
    rows,
    { type: 'slab-list', zone: placement.zone, rowIds: placement.symbols },
    { side: 'A', revision: sha },
  );
  if (pages.length !== 1)
    throw new Error(
      'スラブ領域がA3の1ページに収まりません。行数を減らしてください: ' + placement.id,
    );
  return normalizeSlabListPlacementEntities(
    buildSlabDxfEntities(pages),
    placement.scaleDenominator,
  );
}

function buildEntities(listType, gridData, stbName = '') {
  const built = BUILDERS[listType](gridData, stbName, {});
  if (!built) throw new Error('断面リスト領域に描画できるデータがありません。');
  return built;
}

/**
 * Slab DXF produces paper-mm. Sheet ReferenceDrawing expects model-mm and
 * divides by the placement scale. Scale once and use actual content bounds,
 * not the producer's full A3 page bounds (including empty margins).
 */
export function normalizeSlabListPlacementEntities(entities, scaleDenominator) {
  if (!Number.isFinite(scaleDenominator) || scaleDenominator < 1)
    throw new Error('スラブ領域の縮尺が不正です。');
  const factor = scaleDenominator;
  const point = (p) => ({ x: p.x * factor, y: p.y * factor });
  const lines2D = (entities.lines2D ?? []).map((line) => ({
    ...line,
    start: point(line.start),
    end: point(line.end),
  }));
  const circles2D = (entities.circles2D ?? []).map((circle) => ({
    ...circle,
    center: point(circle.center),
    radius: circle.radius * factor,
  }));
  const texts2D = (entities.texts2D ?? []).map((text) => {
    // A text insertion point alone does not bound the rendered glyphs. Use a
    // conservative estimate so long slab labels cannot bypass sheet preflight.
    // Slab DXF text is left-aligned and expressed in source paper-mm.
    const glyphUnits = Array.from(String(text.text ?? '')).reduce(
      (total, char) => total + (char.codePointAt(0) < 0x80 ? 1 : 1.2),
      0,
    );
    const widthFactor = text.widthFactor ?? 1;
    const boundsWidthMm =
      (text.boundsWidthMm > 0 ? text.boundsWidthMm : glyphUnits * text.height * widthFactor) *
      factor;
    return {
      ...text,
      position: point(text.position),
      height: text.height * factor,
      ...(text.text ? { boundsWidthMm } : {}),
    };
  });
  const bounds = {
    min: { x: Infinity, y: Infinity },
    max: { x: -Infinity, y: -Infinity },
  };
  const include = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error('スラブリストの図形座標が不正です。');
    bounds.min.x = Math.min(bounds.min.x, x);
    bounds.min.y = Math.min(bounds.min.y, y);
    bounds.max.x = Math.max(bounds.max.x, x);
    bounds.max.y = Math.max(bounds.max.y, y);
  };
  for (const line of lines2D) {
    include(line.start.x, line.start.y);
    include(line.end.x, line.end.y);
  }
  for (const circle of circles2D) {
    include(circle.center.x - circle.radius, circle.center.y - circle.radius);
    include(circle.center.x + circle.radius, circle.center.y + circle.radius);
  }
  for (const text of texts2D) {
    include(text.position.x, text.position.y);
    include(text.position.x, text.position.y + text.height);
    if (text.text) include(text.position.x + text.boundsWidthMm, text.position.y);
  }
  if (!Number.isFinite(bounds.min.x)) throw new Error('スラブリストに有効な図形がありません。');
  return { ...entities, bounds, lines2D, circles2D, texts2D };
}

/** 旧HTMLの領域見出しをベクターTEXTとして再生成する。元の図形は変更しない。 */
export function withListPlacementHeading(entities, placement) {
  if (!placement.label) return entities;
  const top = entities.bounds?.max?.y;
  const left = entities.bounds?.min?.x;
  if (!Number.isFinite(top) || !Number.isFinite(left))
    throw new Error('リスト見出しの配置範囲が取得できません: ' + placement.id);
  // 旧CSS: 見出し12px + 余白2px。紙面mmから配置縮尺でモデルmmへ変換。
  const height = (12 * 25.4 * placement.scaleDenominator) / 96;
  const margin = (2 * 25.4 * placement.scaleDenominator) / 96;
  // 長い見出しも実寸幅をboundsへ反映し、紙面/枠の超過をfail-closedする。
  const glyphUnits = Array.from(placement.label).reduce(
    (total, char) => total + (char.codePointAt(0) < 0x80 ? 0.7 : 1.2),
    0,
  );
  const boundsWidthMm = glyphUnits * height;
  return {
    ...entities,
    texts2D: [
      ...(entities.texts2D ?? []),
      {
        position: { x: left, y: top + height + margin },
        text: placement.label,
        boundsWidthMm,
        layer: 'LABEL',
        height,
        anchor: 'left',
        verticalAlign: 'top',
      },
    ],
  };
}

/** @returns {Object} ReferenceDrawing（モデルmm。紙面への変換は配置縮尺が担う） */
export function buildListRegionReference({
  placement,
  sheetId,
  sourceDocument,
  gridData = null,
  project = null,
  xmlContext = null,
}) {
  if (placement.listType === 'slab')
    return createSectionListReferenceDrawing({
      entities: withListPlacementHeading(
        slabEntitiesForPlacement({ placement, project, sourceDocument, xmlContext }),
        placement,
      ),
      documentId: sheetId + ':' + placement.id,
      revision: placement.sourceRevisionId,
    });
  const grid = gridData ?? extractCadListGrid(placement.listType, sourceDocument);
  const region = sliceListGrid(grid, placement.storyIds, placement.symbols);
  return createSectionListReferenceDrawing({
    entities: withListPlacementHeading(buildEntities(placement.listType, region), placement),
    documentId: sheetId + ':' + placement.id,
    revision: placement.sourceRevisionId,
  });
}

/** シート上の全リスト領域の図形。抽出は種別ごとに1回。 */
export function buildListReferencesForSheet({
  sheet,
  sourceDocument,
  project = null,
  xmlContext = null,
}) {
  const grids = new Map();
  const result = Object.create(null);
  for (const placement of sheet.listPlacements ?? []) {
    if (placement.listType === 'slab') {
      result[placement.id] = buildListRegionReference({
        placement,
        sheetId: sheet.id,
        sourceDocument,
        project,
        xmlContext,
      });
      continue;
    }
    if (!grids.has(placement.listType))
      grids.set(placement.listType, extractCadListGrid(placement.listType, sourceDocument));
    result[placement.id] = buildListRegionReference({
      placement,
      sheetId: sheet.id,
      sourceDocument,
      gridData: grids.get(placement.listType),
    });
  }
  return result;
}

/** Async verified boundary used by actual sheet preview and SVG/DXF/PDF exports. */
export async function buildVerifiedListReferencesForSheet(args) {
  const { Parser, ...rest } = args;
  const usesSlab = (args.sheet?.listPlacements ?? []).some((p) => p.listType === 'slab');
  const xmlContext = usesSlab ? await verifySavedSlabListXml(args.project, { Parser }) : null;
  return buildListReferencesForSheet({ ...rest, xmlContext });
}

/** 指定縮尺で紙面に出したときの外形(mm)。組成時の収容判定と同じ図形範囲で測る。 */
export function measureListRegion({ listType, gridData, storyIds, symbols, scaleDenominator }) {
  const reference = createSectionListReferenceDrawing({
    entities: buildEntities(listType, sliceListGrid(gridData, storyIds, symbols)),
    documentId: 'measure',
    revision: 'measure',
  });
  const { bounds } = reference;
  if (!bounds) throw new Error('断面リスト領域に描画できるデータがありません。');
  const scale = 1 / scaleDenominator;
  return {
    widthMm: (bounds.maxX - bounds.minX) * scale,
    heightMm: (bounds.maxY - bounds.minY) * scale,
  };
}

/**
 * 旧スラブ専用シートの各領域を、通常シートへの独立した配置候補として列挙する。
 * 1ページに複数領域がある場合も先頭だけを採用しない。
 * 過去のSTB改訂や未登録のViewSpecは選択候補へ出さない。
 */
export function listCurrentSlabListRegions(project) {
  const regions = [];
  for (const sheet of project?.drawingSheets ?? []) {
    if (!isSectionListDrawingSheet(sheet) || sheet.listType !== 'slab' || !sheet.viewSpec) continue;
    const slot = project.modelSlots?.find((entry) => entry.id === sheet.modelSlotId);
    if (!slot || slot.currentRevisionId !== sheet.sourceRevisionId) continue;
    for (const [index, region] of sheet.regions.entries()) regions.push({ sheet, region, index });
  }
  return regions;
}

/** リスト配置が依拠するSTB-A改訂（重複排除）。assertDrawingSourceCurrentへそのまま渡せる。 */
export function listRevisionSources(project, sheet) {
  const sources = new Map();
  for (const placement of sheet?.listPlacements ?? []) {
    const slot = project.modelSlots.find((entry) => entry.id === placement.modelSlotId);
    const revision = slot?.revisions.find((entry) => entry.id === placement.sourceRevisionId);
    if (!revision?.sha256) throw new Error('リスト領域のSTB改訂が見つかりません: ' + placement.id);
    sources.set(revision.sha256.toLowerCase(), {
      modelKey: 'A',
      modelRevision: revision.sha256.toLowerCase(),
    });
  }
  return [...sources.values()];
}

/** スラブ領域を指定縮尺で紙面に出したときの外形(mm)。 */
export function measureSlabRegion({
  placement,
  project,
  sourceDocument,
  scaleDenominator,
  xmlContext = null,
}) {
  const { bounds } = createSectionListReferenceDrawing({
    entities: withListPlacementHeading(
      slabEntitiesForPlacement({
        placement: { ...placement, scaleDenominator },
        project,
        sourceDocument,
        xmlContext,
      }),
      { ...placement, scaleDenominator },
    ),
    documentId: 'measure',
    revision: 'measure',
  });
  if (!bounds) throw new Error('スラブ領域に描画できるデータがありません。');
  const scale = 1 / scaleDenominator;
  return {
    widthMm: (bounds.maxX - bounds.minX) * scale,
    heightMm: (bounds.maxY - bounds.minY) * scale,
  };
}

/** Async verified boundary before placing a slab list region on a CAD sheet. */
export async function measureVerifiedSlabRegion(args) {
  const { Parser, ...rest } = args;
  const xmlContext = await verifySavedSlabListXml(args.project, { Parser });
  return measureSlabRegion({ ...rest, xmlContext });
}
