/** @fileoverview 部材タグの宣言的定義。値取得・描画・状態を持たない。 */

/**
 * 図面タグの標準文字仕様。
 * Revitへ持ち込む図面注記との見た目差を抑えるため、Windows標準のTrueType系を優先する。
 * 文字高はモデル寸法ではなくpaper-mmで保持する。
 */
export const DRAWING_TAG_TYPOGRAPHY = Object.freeze({
  primaryFontFamily: 'Meiryo UI',
  fallbackFontFamily: 'MS Gothic',
  fontFamily: '"Meiryo UI", "MS Gothic", sans-serif',
  standardTextHeightMm: 1.5,
});

export const DRAWING_TAG_ORIENTATION_MODES = Object.freeze({
  FOLLOW_DRAWING: 'follow-drawing',
  FOLLOW_MEMBER: 'follow-member',
  KEEP_SCREEN_DOWN: 'keep-screen-down',
});

export const DEFAULT_DRAWING_TAG_ORIENTATION_MODE = DRAWING_TAG_ORIENTATION_MODES.FOLLOW_MEMBER;

export function normalizeDrawingTagOrientationMode(value = DEFAULT_DRAWING_TAG_ORIENTATION_MODE) {
  if (!Object.values(DRAWING_TAG_ORIENTATION_MODES).includes(value))
    throw new RangeError(
      '符号方向は follow-drawing、follow-member、keep-screen-down のいずれかにしてください。',
    );
  return value;
}

/**
 * #402 詳細タグの紙面寸法キャリブレーション正本。
 * 値はすべて paper-mm。モデル縮尺 / PDF registration / zoom / DPR とは独立させる。
 * 実図面比較で既定寸法を変更するときは、散在した座標ではなくこの定義を更新する。
 */
export const DRAWING_DETAIL_TAG_PAPER_METRICS = Object.freeze({
  beam: Object.freeze({
    frameWidth: 48,
    frameHeight: 24,
    frameRadius: 8,
    rowBoundaryY: 4,
    ruleInsetX: 1.4,
    frameStrokeWidth: 0.35,
    textHaloWidth: 0.55,
    topRowY: -8,
    bottomRowY: 8,
    widthLabelX: -20,
    leftValueX: -11,
    rightValueX: 11,
    sectionMarkX: -10,
    levelX: 10,
    concreteLevelY: -1.35,
    structuralLevelY: 1.45,
    fontSize: Object.freeze({
      standard: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      mark: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      concreteTop: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      structuralTop: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
    }),
  }),
  slab: Object.freeze({
    frameWidth: 30,
    frameHeight: 24,
    rowBoundaryY: 4,
    frameStrokeWidth: 0.35,
    textHaloWidth: 0.55,
    concreteTopY: -8.7,
    structuralTopY: -6,
    sectionMarkY: 0,
    bottomRowY: 8,
    bottomValueX: 8,
    insulationX: 20,
    insulationRadius: 4,
    fontSize: Object.freeze({
      concreteTop: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      structuralTop: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      mark: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      addition: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      thickness: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
      insulation: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
    }),
  }),
  // RC柱断面豆図。断面図は上辺中央を原点(0,0)とし、文字行はその上に置く。
  // 縮尺は断面リスト(A3)と同じ1/40を紙面上で固定し、平面図の縮尺に追従させない。
  column: Object.freeze({
    figureScaleDenominator: 40,
    figureStrokeWidth: 0.35,
    textHaloWidth: 0.55,
    markY: -12.7,
    // 矩形柱は主筋をX方向・Y方向の2行に分ける。円形柱はX方向の行位置に総本数を出す。
    mainBarXY: -9.5,
    mainBarYY: -6.3,
    hoopY: -3.1,
    // 本数/径のように2つの値を突き合わせる行で、右側文字の白縁が左側文字へ掛からない間隔。
    joinGap: 0.3,
    fontSize: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
  }),
  // RC梁断面豆図。断面リストと同じ位置列(両端部/中央など)を横に並べ、位置名を図の下に置く。
  beamFigure: Object.freeze({
    figureScaleDenominator: 40,
    figureStrokeWidth: 0.35,
    textHaloWidth: 0.55,
    markY: -2.5,
    fontSize: DRAWING_TAG_TYPOGRAPHY.standardTextHeightMm,
  }),
});

const markItem = Object.freeze({
  id: 'member-mark',
  kind: 'text',
  point: Object.freeze([0, 0]),
  field: 'drawing.mark',
  // 既存符号表示だけの明示fallback。構造数値の欠損補完には使わない。
  fallbackField: 'member.identity',
  format: 'text',
});

/** 図面符号(DrawingModel.mark)をそのまま表示する既定タグ。STB XPathの詳細タグとは別契約。 */
export const DRAWING_TAG_TEMPLATES = Object.freeze({
  'member-mark-v1': Object.freeze({
    schemaVersion: 1,
    id: 'member-mark-v1',
    version: 1,
    fontFamily: DRAWING_TAG_TYPOGRAPHY.fontFamily,
    units: 'css-px',
    overflow: 'visible',
    items: Object.freeze([markItem]),
  }),
});

/**
 * 詳細タグ(built-in TagFamily)の配置identity。保存済み配置は template id/version で照合するため、
 * built-in TagFamilyで描画する現在も旧テンプレートIDを維持する。
 */
export const DRAWING_DETAIL_TAG_TEMPLATE_VERSIONS = Object.freeze({
  'beam-detail-v1': 1,
  'slab-detail-v1': 1,
  'column-section-figure-v1': 1,
  'beam-section-figure-v1': 1,
});

/** 詳細タグを持つDrawingModelのcanonical elementType→template。 */
export const DRAWING_DETAIL_TAG_TEMPLATE_BY_ELEMENT_TYPE = Object.freeze({
  Girder: 'beam-detail-v1',
  Beam: 'beam-detail-v1',
  Slab: 'slab-detail-v1',
  Column: 'column-section-figure-v1',
});
