/**
 * @fileoverview STB RC柱/RC梁断面→タグ用断面図(豆図)。
 * 断面リストと同じ抽出・描画幾何(columnScheduleModel / beamScheduleModel)と
 * 梁の位置列まとめ(beamSchedulePresentation)を使い、配置規則を複製しない。
 */
import {
  buildBeamScheduleGeometry,
  parseBeamBarDiameterMm,
} from '../../components/rcBeamVisual/beamScheduleModel.js';
import {
  formatBeamBarCountText,
  formatBeamStirrupText,
  resolveBeamSchedulePositionEntries,
} from '../../components/rcBeamVisual/beamSchedulePresentation.js';
import {
  buildColumnScheduleGeometry,
  columnScheduleInputFromSection,
  parseColumnBarDiameterMm,
} from '../../components/rcColumnVisual/columnScheduleModel.js';
import { extractRcColumnSectionFigureSource } from '../../data/extractors/columnSectionListExtractor.js';
import { extractRcBeamSectionDetail } from '../../data/extractors/beamSectionList/sectionDetail.js';

function barShapes(bars, role, offsetX, offsetY, diameterOf = parseColumnBarDiameterMm) {
  const shapes = [];
  for (const bar of bars || []) {
    const diameter = diameterOf(bar.dia);
    if (!(diameter > 0)) return null;
    shapes.push({
      type: 'circle',
      role,
      cx: bar.x - offsetX,
      cy: bar.y - offsetY,
      r: diameter / 2,
      filled: true,
    });
  }
  return shapes;
}

/**
 * @param {Element} section StbSecColumn_RC
 * @returns {{status:'known', value:object} | {status:'invalid', reason:string}}
 */
export function resolveRcColumnSectionFigure(section) {
  const { sectionData, arrangement } = extractRcColumnSectionFigureSource(section);
  const geometry = buildColumnScheduleGeometry(
    columnScheduleInputFromSection(sectionData, arrangement),
  );
  if (!geometry) return { status: 'invalid', reason: 'COLUMN_FIGURE_DIMENSION_UNRESOLVED' };

  const offsetX = geometry.width / 2;
  const offsetY = geometry.height / 2;
  const shapes = [];
  if (geometry.kind === 'CIRCLE') {
    shapes.push({ type: 'circle', role: 'concrete', cx: 0, cy: 0, r: geometry.concrete.radius });
    if (geometry.hoop?.radius > 0)
      shapes.push({ type: 'circle', role: 'hoop', cx: 0, cy: 0, r: geometry.hoop.radius });
  } else {
    const { concrete, hoop } = geometry;
    shapes.push({
      type: 'rect',
      role: 'concrete',
      x: concrete.left - offsetX,
      y: concrete.top - offsetY,
      width: concrete.right - concrete.left,
      height: concrete.bottom - concrete.top,
    });
    if (hoop && hoop.right > hoop.left && hoop.bottom > hoop.top) {
      shapes.push({
        type: 'rect',
        role: 'hoop',
        x: hoop.left - offsetX,
        y: hoop.top - offsetY,
        width: hoop.right - hoop.left,
        height: hoop.bottom - hoop.top,
      });
      for (const leg of hoop.innerLegs || [])
        shapes.push({
          type: 'line',
          role: 'tie',
          x1: leg.x1 - offsetX,
          y1: leg.y1 - offsetY,
          x2: leg.x2 - offsetX,
          y2: leg.y2 - offsetY,
        });
    }
  }

  const mainBars = barShapes(geometry.mainBars, 'main-bar', offsetX, offsetY);
  const coreBars = barShapes(geometry.coreBars, 'core-bar', offsetX, offsetY);
  if (!mainBars || !coreBars) return { status: 'invalid', reason: 'BAR_DIAMETER_UNRESOLVED' };
  shapes.push(...mainBars, ...coreBars);

  return {
    status: 'known',
    value: {
      panels: [
        {
          key: arrangement?.position ?? 'SAME',
          label: null,
          width: geometry.width,
          height: geometry.height,
          shapes,
        },
      ],
    },
  };
}

function beamPanelShapes(geometry) {
  const offsetX = geometry.width / 2;
  const offsetY = geometry.depth / 2;
  const shapes = [
    {
      type: 'rect',
      role: 'concrete',
      x: -offsetX,
      y: -offsetY,
      width: geometry.width,
      height: geometry.depth,
    },
  ];
  const stirrup = geometry.stirrup;
  if (stirrup && stirrup.right > stirrup.left && stirrup.bottom > stirrup.top) {
    shapes.push({
      type: 'rect',
      role: 'hoop',
      x: stirrup.left - offsetX,
      y: stirrup.top - offsetY,
      width: stirrup.right - stirrup.left,
      height: stirrup.bottom - stirrup.top,
    });
    for (const leg of stirrup.innerLegs || [])
      shapes.push({
        type: 'line',
        role: 'tie',
        x1: leg.x - offsetX,
        y1: leg.top - offsetY,
        x2: leg.x - offsetX,
        y2: leg.bottom - offsetY,
      });
  }
  // 径の扱い(未指定時の作図既定径を含む)は断面リストの梁描画と同じ規則に従う。
  const diameterOf = (dia) => parseBeamBarDiameterMm(dia);
  shapes.push(
    ...barShapes(geometry.mainBars, 'main-bar', offsetX, offsetY, diameterOf),
    ...barShapes(geometry.webBars, 'web-bar', offsetX, offsetY, diameterOf),
  );
  return shapes;
}

/** 梁断面リストの行(上端筋/下端筋/STP/腹筋)と同じ表記の配筋文字。該当なしの行は省く。 */
function beamPanelCaptions(positionData) {
  return [
    ['上端筋', formatBeamBarCountText(positionData?.topBar)],
    ['下端筋', formatBeamBarCountText(positionData?.bottomBar)],
    ['STP', formatBeamStirrupText(positionData?.stirrup)],
    ['腹筋', formatBeamBarCountText(positionData?.webBar)],
  ]
    .filter(([, text]) => text && text !== '-')
    .map(([label, text]) => `${label} ${text}`);
}

/**
 * 梁断面リストと同じ位置列(全断面/両端部・中央/左端・中央・右端など)ごとに1パネルを作る。
 * @param {Element} section StbSecBeam_RC
 * @returns {{status:'known', value:object} | {status:'invalid', reason:string}}
 */
export function resolveRcBeamSectionFigure(section) {
  const detail = extractRcBeamSectionDetail(section);
  const entries = resolveBeamSchedulePositionEntries(detail.positions, detail.positionPattern);
  if (entries.length === 0) return { status: 'invalid', reason: 'BEAM_FIGURE_POSITION_UNRESOLVED' };
  const panels = [];
  for (const entry of entries) {
    const geometry = buildBeamScheduleGeometry({
      ...entry.data,
      cover: entry.data?.cover || detail.cover || null,
    });
    if (!geometry) return { status: 'invalid', reason: 'BEAM_FIGURE_DIMENSION_UNRESOLVED' };
    panels.push({
      key: entry.key,
      label: entries.length > 1 ? entry.label : null,
      width: geometry.width,
      height: geometry.depth,
      shapes: beamPanelShapes(geometry),
      captions: beamPanelCaptions(entry.data),
    });
  }
  return { status: 'known', value: { panels } };
}
