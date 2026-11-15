/**
 * #510: Persist beam/column A3 list-region pages in the shared DrawingProject
 * drawingSheets collection, without fabricating a plan/elevation DrawingModel.
 * Existing A4 and legacy region-PDF workflows remain independent.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';
import { isSectionListDrawingSheet } from './drawingSheetCollection.js';

const types = new Set(['beam', 'column', 'slab', 'steel-column', 'steel-beam', 'src-column', 'src-beam']);
const keys = Object.freeze({
  'a3-landscape': 'landscape',
  'a3-portrait': 'portrait',
});

function checkType(listType) {
  if (!types.has(listType)) throw new Error('梁・柱・スラブの断面リスト種別が必要です。');
}
function sourceSlot(project, modelSlotId, revisionId) {
  const slot = project.modelSlots.find((s) => s.id === modelSlotId);
  if (!slot || slot.currentRevisionId !== revisionId)
    throw new Error('断面リストのSTB-A現行改訂が一致しません。');
  return slot;
}
function pageArray(pages) {
  if (!Array.isArray(pages) || pages.length === 0)
    throw new Error('保存する断面リストのページがありません。');
  const nonEmpty = pages.filter((page) => Array.isArray(page.regions) && page.regions.length);
  if (!nonEmpty.length) throw new Error('断面リストの配置領域がありません。');
  return nonEmpty;
}
function nonemptyId(id, label) {
  if (typeof id !== 'string' || !id.trim() || id.length > 100)
    throw new Error(label + 'のIDが不正です。');
  return id;
}

export function findCurrentSectionListLayout(project, { listType, modelSlotId } = {}) {
  checkType(listType);
  const normalized = normalizeDrawingProject(project);
  const slot = normalized.modelSlots.find((item) => item.id === modelSlotId);
  if (!slot) throw new Error('断面リストのSTB-Aモデルスロットがありません。');
  const sheets = (normalized.drawingSheets ?? [])
    .filter(
      (sheet) =>
        isSectionListDrawingSheet(sheet) &&
        sheet.listType === listType &&
        sheet.modelSlotId === modelSlotId &&
        sheet.sourceRevisionId === slot.currentRevisionId,
    )
    .sort((a, b) => a.pageIndex - b.pageIndex);
  if (!sheets.length) return null;
  const ids = new Set();
  for (const sheet of sheets) {
    for (const region of sheet.regions) {
      if (ids.has(region.id)) throw new Error('断面リストの領域IDが複数ページで重複しています。');
      ids.add(region.id);
    }
  }
  const layoutIds = new Set(sheets.map((sheet) => sheet.layoutId));
  if (layoutIds.size !== 1 || sheets.some((sheet, i) => sheet.pageIndex !== i))
    throw new Error('断面リストの保存ページが重複・欠落しています。');
  const { layoutId, orientation, scaleDenominator, compactColumns } = sheets[0];
  if (
    sheets.some(
      (sheet) =>
        JSON.stringify(sheet.viewSpec ?? null) !== JSON.stringify(sheets[0].viewSpec ?? null),
    )
  )
    throw new Error('断面リストの保存ViewSpecが複数ページで一致しません。');
  if (
    sheets.some(
      (sheet) =>
        sheet.orientation !== orientation ||
        sheet.scaleDenominator !== scaleDenominator ||
        sheet.compactColumns !== compactColumns,
    )
  )
    throw new Error('断面リストの用紙・縮尺の保存状態が一致しません。');
  return Object.freeze({
    layoutId,
    listType,
    modelSlotId,
    sourceRevisionId: slot.currentRevisionId,
    paperKey: orientation === 'landscape' ? 'a3-landscape' : 'a3-portrait',
    scaleDenominator,
    compactColumns,
    ...(sheets[0].viewSpec ? { viewSpec: sheets[0].viewSpec } : {}),
    pages: sheets.map((sheet) => ({
      regions: sheet.regions.map((region) => ({
        id: region.id,
        symbols: [...region.symbols],
        storyIds: [...region.storyIds],
        x: region.xMm,
        y: region.yMm,
        widthMm: region.widthMm,
        heightMm: region.heightMm,
        label: region.label,
        autoLabel: region.autoLabel,
      })),
    })),
  });
}

/** Returns an updated, normalized immutable-by-convention project; never mutates input. */
export function saveSectionListLayoutToDrawingProject({
  project: input,
  modelSlotId,
  sourceRevisionId,
  listType,
  layout,
  idFactory,
} = {}) {
  checkType(listType);
  const project = normalizeDrawingProject(input);
  sourceSlot(project, modelSlotId, sourceRevisionId);
  const orientation = keys[layout?.paperKey];
  if (!orientation) throw new Error('共通DrawingProjectシートへの保存はA3のみ対応します。');
  if (!Number.isFinite(layout.scaleDenominator) || layout.scaleDenominator < 1)
    throw new Error('断面リストの縮尺が不正です。');
  if (typeof layout.compactColumns !== 'boolean')
    throw new Error('断面リストの列幅設定が不正です。');
  if (typeof idFactory !== 'function') throw new Error('シートID生成関数が必要です。');
  const pages = pageArray(layout.pages);
  const regionIds = new Set();
  for (const page of pages) {
    for (const region of page.regions) {
      nonemptyId(region.id, '領域');
      if (regionIds.has(region.id))
        throw new Error('断面リストの領域IDが複数ページで重複しています。');
      regionIds.add(region.id);
    }
  }
  const existing = (project.drawingSheets ?? []).filter(
    (sheet) =>
      isSectionListDrawingSheet(sheet) &&
      sheet.listType === listType &&
      sheet.modelSlotId === modelSlotId &&
      sheet.sourceRevisionId === sourceRevisionId,
  );
  // Keep historical source-revision layouts intact. Only the active revision's
  // pages may be replaced, so an STB update cannot silently erase old sheets.
  const layoutId = existing[0]?.layoutId || nonemptyId(idFactory('layout'), 'レイアウト');
  const retained = (project.drawingSheets ?? []).filter((sheet) => !existing.includes(sheet));
  const usedNumbers = new Set(retained.map((sheet) => sheet.number.toLowerCase()));
  let numberSequence = 1;
  const allocateNumber = () => {
    let number;
    do {
      number =
        { beam: 'BL-', column: 'CL-', slab: 'SL-', 'steel-beam': 'SBL-', 'steel-column': 'SCL-', 'src-column': 'SRCCL-', 'src-beam': 'SRCBL-' }[
          listType
        ] + String(numberSequence++).padStart(3, '0');
    } while (usedNumbers.has(number.toLowerCase()));
    usedNumbers.add(number.toLowerCase());
    return number;
  };
  const sheets = pages.map((page, pageIndex) => {
    let number = existing[pageIndex]?.number;
    if (!number || usedNumbers.has(number.toLowerCase())) {
      number = allocateNumber();
    } else {
      usedNumbers.add(number.toLowerCase());
    }
    return {
      kind: 'section-list',
      id: existing[pageIndex]?.id || nonemptyId(idFactory('sheet'), 'シート'),
      number,
      name:
        { beam: '梁', column: '柱', slab: 'スラブ', 'steel-beam': 'S梁', 'steel-column': 'S柱', 'src-column': 'SRC柱', 'src-beam': 'SRC梁' }[
          listType
        ] +
        'リスト ' +
        (pageIndex + 1),
      paper: 'A3',
      orientation,
      listType,
      modelSlotId,
      sourceRevisionId,
      scaleDenominator: layout.scaleDenominator,
      compactColumns: layout.compactColumns,
      layoutId,
      pageIndex,
      ...(listType === 'slab' && layout.viewSpec ? { viewSpec: layout.viewSpec } : {}),
      regions: page.regions.map((region) => ({
        id: nonemptyId(region.id, '領域'),
        symbols: [...region.symbols],
        storyIds: [...region.storyIds],
        xMm: region.x,
        yMm: region.y,
        widthMm: region.widthMm,
        heightMm: region.heightMm,
        label: region.label,
        autoLabel: region.autoLabel,
      })),
    };
  });
  return normalizeDrawingProject({
    ...project,
    drawingSheets: [...retained, ...sheets],
  });
}
