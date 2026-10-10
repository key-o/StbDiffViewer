/**
 * @fileoverview 詳細タグのbuilt-in TagFamily定義(STB XPathキー)。
 * 紙面寸法の正本は config/drawingTagTemplates.js の DRAWING_DETAIL_TAG_PAPER_METRICS。
 */
import {
  DRAWING_DETAIL_TAG_PAPER_METRICS,
  DRAWING_DETAIL_TAG_TEMPLATE_VERSIONS,
  DRAWING_TAG_TYPOGRAPHY,
} from '../../../config/drawingTagTemplates.js';
import {
  RC_BEAM_SECTION_FIGURE_XPATH,
  RC_COLUMN_SECTION_FIGURE_XPATH,
  STB_TAG_XPATHS,
} from './tagXPathCatalog.js';

const BEAM = DRAWING_DETAIL_TAG_PAPER_METRICS.beam;
const SLAB = DRAWING_DETAIL_TAG_PAPER_METRICS.slab;
const COLUMN = DRAWING_DETAIL_TAG_PAPER_METRICS.column;
const BEAM_FIGURE = DRAWING_DETAIL_TAG_PAPER_METRICS.beamFigure;

const style = (haloWidth, strokeWidth) => ({
  fontFamily: DRAWING_TAG_TYPOGRAPHY.fontFamily,
  fontSize: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
  align: 'center',
  padding: 0,
  strokeWidth,
  haloWidth,
});

const parameterText = (id, x, y, fontSize, align = 'center') => ({
  id,
  kind: 'parameter-text',
  x,
  y,
  parameterId: id,
  fontSize,
  align,
});

function beamDetailFamily(category) {
  const w = BEAM.frameWidth / 2;
  const h = BEAM.frameHeight / 2;
  const fs = BEAM.fontSize.standard;
  const dimension = (id, key, decoration) => ({ id, key, format: 'dimension', ...decoration });
  return {
    category,
    templateId: 'beam-detail-v1',
    name: '標準詳細',
    parameters: [
      dimension('beam-add-left', STB_TAG_XPATHS.addition(category, 'left'), {
        suffix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      }),
      dimension('beam-width', STB_TAG_XPATHS.beam.width, { prefix: '(', suffix: ')' }),
      dimension('beam-add-right', STB_TAG_XPATHS.addition(category, 'right'), {
        prefix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      }),
      { id: 'beam-section-mark', key: STB_TAG_XPATHS.sectionName(category), format: 'text' },
      dimension('beam-add-top', STB_TAG_XPATHS.addition(category, 'top'), {
        suffix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      }),
      dimension('beam-depth', STB_TAG_XPATHS.beam.depth, { prefix: '(', suffix: ')' }),
      dimension('beam-add-bottom', STB_TAG_XPATHS.addition(category, 'bottom'), {
        prefix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      }),
    ],
    primitives: [
      {
        id: 'beam-frame',
        kind: 'rounded-rectangle',
        x: -w,
        y: -h,
        width: BEAM.frameWidth,
        height: BEAM.frameHeight,
        radius: BEAM.frameRadius,
        strokeWidth: BEAM.frameStrokeWidth,
      },
      ...[
        ['beam-rule-top', -BEAM.rowBoundaryY],
        ['beam-rule-bottom', BEAM.rowBoundaryY],
      ].map(([id, y]) => ({
        id,
        kind: 'line',
        x1: -w + BEAM.ruleInsetX,
        y1: y,
        x2: w - BEAM.ruleInsetX,
        y2: y,
        strokeWidth: BEAM.frameStrokeWidth,
      })),
      {
        id: 'beam-rule-middle',
        kind: 'line',
        x1: 0,
        y1: -BEAM.rowBoundaryY,
        x2: 0,
        y2: BEAM.rowBoundaryY,
        strokeWidth: BEAM.frameStrokeWidth,
      },
      {
        id: 'beam-width-label',
        kind: 'text',
        x: BEAM.widthLabelX,
        y: BEAM.topRowY,
        text: 'W',
        fontSize: fs,
      },
      parameterText('beam-add-left', BEAM.leftValueX, BEAM.topRowY, fs),
      parameterText('beam-width', 0, BEAM.topRowY, fs),
      parameterText('beam-add-right', BEAM.rightValueX, BEAM.topRowY, fs),
      parameterText('beam-section-mark', BEAM.sectionMarkX, 0, BEAM.fontSize.mark),
      {
        id: 'beam-depth-label',
        kind: 'text',
        x: BEAM.widthLabelX,
        y: BEAM.bottomRowY,
        text: 'h',
        fontSize: fs,
      },
      parameterText('beam-add-top', BEAM.leftValueX, BEAM.bottomRowY, fs),
      parameterText('beam-depth', 0, BEAM.bottomRowY, fs),
      parameterText('beam-add-bottom', BEAM.rightValueX, BEAM.bottomRowY, fs),
    ],
    style: style(BEAM.textHaloWidth, BEAM.frameStrokeWidth),
  };
}

function slabDetailFamily() {
  const w = SLAB.frameWidth / 2;
  const h = SLAB.frameHeight / 2;
  return {
    category: 'Slab',
    templateId: 'slab-detail-v1',
    name: '標準スラブ詳細',
    parameters: [
      { id: 'slab-section-mark', key: STB_TAG_XPATHS.sectionName('Slab'), format: 'text' },
      {
        id: 'slab-add-top',
        key: STB_TAG_XPATHS.addition('Slab', 'top'),
        format: 'dimension',
        suffix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      },
      { id: 'slab-thickness', key: STB_TAG_XPATHS.slab.thickness, format: 'dimension' },
      {
        id: 'slab-add-bottom',
        key: STB_TAG_XPATHS.addition('Slab', 'bottom'),
        format: 'dimension',
        prefix: '+',
        omitKnownZero: true,
        missingText: '',
        notApplicableText: '',
      },
    ],
    primitives: [
      {
        id: 'slab-frame',
        kind: 'rectangle',
        x: -w,
        y: -h,
        width: SLAB.frameWidth,
        height: SLAB.frameHeight,
        strokeWidth: SLAB.frameStrokeWidth,
      },
      ...[
        ['slab-rule-top', -SLAB.rowBoundaryY],
        ['slab-rule-bottom', SLAB.rowBoundaryY],
      ].map(([id, y]) => ({
        id,
        kind: 'line',
        x1: -w,
        y1: y,
        x2: w,
        y2: y,
        strokeWidth: SLAB.frameStrokeWidth,
      })),
      parameterText('slab-section-mark', 0, SLAB.sectionMarkY, SLAB.fontSize.mark),
      parameterText('slab-add-top', -SLAB.bottomValueX, SLAB.bottomRowY, SLAB.fontSize.addition),
      parameterText('slab-thickness', 0, SLAB.bottomRowY, SLAB.fontSize.thickness),
      parameterText('slab-add-bottom', SLAB.bottomValueX, SLAB.bottomRowY, SLAB.fontSize.addition),
    ],
    style: style(SLAB.textHaloWidth, SLAB.frameStrokeWidth),
  };
}

function columnSectionFigureFamily() {
  const rebar = STB_TAG_XPATHS.columnRebar;
  const fs = COLUMN.fontSize;
  const shownWhenPresent = (parameterId) => ({
    parameterId,
    statusIn: ['known', 'missing', 'invalid'],
  });
  // 本数(右揃え)と径(左揃え)を突き合わせて「主筋X 4-D25」の1行にする。
  const mainBarRow = (id, countParameterId, y) => [
    {
      ...parameterText(countParameterId, -COLUMN.joinGap, y, fs, 'right'),
      id: `${id}-count`,
      condition: shownWhenPresent(countParameterId),
    },
    {
      ...parameterText('column-main-diameter', 0, y, fs, 'left'),
      id: `${id}-diameter`,
      condition: shownWhenPresent(countParameterId),
    },
  ];
  const countParameter = (id, key, prefix) => ({ id, key, format: 'text', prefix });
  return {
    category: 'Column',
    templateId: 'column-section-figure-v1',
    name: 'RC柱断面豆図',
    parameters: [
      { id: 'column-section-mark', key: STB_TAG_XPATHS.sectionName('Column'), format: 'text' },
      countParameter('column-main-count-x', rebar.mainCountX, '主筋X '),
      countParameter('column-main-count-y', rebar.mainCountY, '主筋Y '),
      countParameter('column-main-count-circle', rebar.mainCountCircle, '主筋 '),
      { id: 'column-main-diameter', key: rebar.mainDiameter, format: 'text', prefix: '-' },
      { id: 'column-hoop-diameter', key: rebar.hoopDiameter, format: 'text', prefix: '帯筋 ' },
      { id: 'column-hoop-pitch', key: rebar.hoopPitch, format: 'dimension', prefix: '@' },
      { id: 'column-figure', key: RC_COLUMN_SECTION_FIGURE_XPATH, format: 'section-figure' },
    ],
    primitives: [
      parameterText('column-section-mark', 0, COLUMN.markY, fs),
      ...mainBarRow('column-main-x', 'column-main-count-x', COLUMN.mainBarXY),
      ...mainBarRow('column-main-y', 'column-main-count-y', COLUMN.mainBarYY),
      ...mainBarRow('column-main-circle', 'column-main-count-circle', COLUMN.mainBarXY),
      parameterText('column-hoop-diameter', -COLUMN.joinGap, COLUMN.hoopY, fs, 'right'),
      parameterText('column-hoop-pitch', 0, COLUMN.hoopY, fs, 'left'),
      {
        id: 'column-figure',
        kind: 'section-figure',
        x: 0,
        y: 0,
        parameterId: 'column-figure',
        scaleDenominator: COLUMN.figureScaleDenominator,
        strokeWidth: COLUMN.figureStrokeWidth,
        fontSize: fs,
      },
    ],
    style: style(COLUMN.textHaloWidth, COLUMN.figureStrokeWidth),
  };
}

/** 梁断面リストと同じ位置列の断面図を並べ、断面符号を上に置く。 */
function beamSectionFigureFamily(category) {
  return {
    category,
    templateId: 'beam-section-figure-v1',
    name: 'RC梁断面豆図',
    parameters: [
      { id: 'beam-section-mark', key: STB_TAG_XPATHS.sectionName(category), format: 'text' },
      { id: 'beam-figure', key: RC_BEAM_SECTION_FIGURE_XPATH, format: 'section-figure' },
    ],
    primitives: [
      parameterText('beam-section-mark', 0, BEAM_FIGURE.markY, BEAM_FIGURE.fontSize),
      {
        id: 'beam-figure',
        kind: 'section-figure',
        x: 0,
        y: 0,
        parameterId: 'beam-figure',
        scaleDenominator: BEAM_FIGURE.figureScaleDenominator,
        strokeWidth: BEAM_FIGURE.figureStrokeWidth,
        fontSize: BEAM_FIGURE.fontSize,
      },
    ],
    style: style(BEAM_FIGURE.textHaloWidth, BEAM_FIGURE.figureStrokeWidth),
  };
}

/** built-in TagFamilyの生定義。registryが builtIn として正規化する。 */
export const BUILTIN_TAG_FAMILY_SOURCES = Object.freeze(
  [
    beamDetailFamily('Girder'),
    beamDetailFamily('Beam'),
    beamSectionFigureFamily('Girder'),
    beamSectionFigureFamily('Beam'),
    slabDetailFamily(),
    columnSectionFigureFamily(),
  ].map(({ category, templateId, name, parameters, primitives, style: familyStyle }) =>
    Object.freeze({
      templateId,
      family: {
        schemaVersion: 2,
        id: `builtin:${category.toLowerCase()}:${templateId}`,
        name,
        category,
        version: DRAWING_DETAIL_TAG_TEMPLATE_VERSIONS[templateId],
        paperScale: 1,
        orientationMode: 'model',
        parameters,
        primitives,
        style: familyStyle,
      },
    }),
  ),
);
