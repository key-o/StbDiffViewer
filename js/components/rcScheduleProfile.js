/**
 * RC柱・梁断面リストの共通作図プロファイル。
 *
 * STBの実寸mmを意味モデルとして保持し、SVG/DXFは同じ基準値を投影する。
 * 基準DXFから確認した作図規則をここへ集約し、renderer/exporterごとの
 * ハードコードを避ける。
 */

const freezeFaces = (value) => Object.freeze({ ...value });

const BASE_COLUMN_HOOP_CENTER_FACES = freezeFaces({
  startX: 50,
  endX: 50,
  startY: 50,
  endY: 50,
});

const BASE_COLUMN_MAIN_CENTER_FACES = freezeFaces({
  startX: 72,
  endX: 72,
  startY: 72,
  endY: 72,
});

export const BASELINE_RC_SCHEDULE_PROFILE = Object.freeze({
  scaleDenominator: 40,
  previewDpi: 96,

  // 添付基準DXFから実測した紙面レイアウト。
  layout: Object.freeze({
    normalTextPaperMm: 2.20751953125,
    titleTextPaperMm: 3.686148761913905,
    headerPaperMm: 14,
    headerBandPaperMm: 7,
    floorColumnPaperMm: 10,
    rowLabelColumnPaperMm: 20,
    infoRowPaperMm: 4,
    infoRowCount: 5,
    beamPositionExtraPaperMm: 15,
    beamDiagramExtraPaperMm: 15,
    columnPositionExtraPaperMm: 16,
    columnDiagramExtraPaperMm: 16,
    // 梁の上端/下端本数はコンクリート右面から0.5mm外側、主筋芯Yに置く。
    beamCountLabelGapPaperMm: 0.5,
    // 矩形柱の辺本数はコンクリート面から2.405mm外側に置く。
    columnCountLabelOffsetPaperMm: 2.405,
  }),

  beam: Object.freeze({
    defaultSourceCoverMm: 40,
    defaultHoopCenterMm: 50,
    defaultMainCenterMm: 72,
    mainCenterOffsetFromHoopMm: 22,
  }),

  column: Object.freeze({
    hoopCenterFaces: BASE_COLUMN_HOOP_CENTER_FACES,
    mainCenterFaces: BASE_COLUMN_MAIN_CENTER_FACES,
  }),

  symbols: Object.freeze({
    barPaperDiameterMm: 1.1,
  }),
});

export function resolveRcScheduleProfile(overrides = {}) {
  const base = BASELINE_RC_SCHEDULE_PROFILE;
  return {
    ...base,
    ...overrides,
    layout: { ...base.layout, ...(overrides.layout || {}) },
    beam: { ...base.beam, ...(overrides.beam || {}) },
    column: {
      ...base.column,
      ...(overrides.column || {}),
      hoopCenterFaces: {
        ...base.column.hoopCenterFaces,
        ...(overrides.column?.hoopCenterFaces || {}),
      },
      mainCenterFaces: {
        ...base.column.mainCenterFaces,
        ...(overrides.column?.mainCenterFaces || {}),
      },
    },
    symbols: { ...base.symbols, ...(overrides.symbols || {}) },
  };
}

export function modelMmToSchedulePaperMm(value, profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const denominator = Number(profile?.scaleDenominator) || 40;
  return Number(value) / denominator;
}

export function schedulePaperMmToModelMm(value, profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const denominator = Number(profile?.scaleDenominator) || 40;
  return Number(value) * denominator;
}

export function schedulePaperMmToPx(value, profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const dpi = Number(profile?.previewDpi) || 96;
  return (Number(value) * dpi) / 25.4;
}

export function getScheduleModelToPaperScale(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const denominator = Number(profile?.scaleDenominator) || 40;
  return 1 / denominator;
}

export function getScheduleBarSymbolModelRadius(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const diameterPaper = Number(profile?.symbols?.barPaperDiameterMm) || 1.1;
  return schedulePaperMmToModelMm(diameterPaper / 2, profile);
}

export function getScheduleNormalTextModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.normalTextPaperMm || 2.20751953125, profile);
}

export function getScheduleTitleTextModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.titleTextPaperMm || 3.686148761913905, profile);
}

export function getScheduleHeaderModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.headerPaperMm || 14, profile);
}

export function getScheduleHeaderBandModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.headerBandPaperMm || 7, profile);
}

export function getScheduleFloorColumnModelWidth(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.floorColumnPaperMm || 10, profile);
}

export function getScheduleRowLabelColumnModelWidth(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.rowLabelColumnPaperMm || 20, profile);
}

export function getScheduleInfoRowModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.infoRowPaperMm || 4, profile);
}

export function getScheduleInfoAreaModelHeight(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const rows = Number(profile?.layout?.infoRowCount) || 5;
  return getScheduleInfoRowModelHeight(profile) * rows;
}

export function getBeamCountLabelGapModelMm(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.beamCountLabelGapPaperMm || 0.5, profile);
}

export function getColumnCountLabelOffsetModelMm(profile = BASELINE_RC_SCHEDULE_PROFILE) {
  return schedulePaperMmToModelMm(profile?.layout?.columnCountLabelOffsetPaperMm || 2.405, profile);
}

export function getBeamSchedulePositionModelWidth(
  sectionWidthMm,
  profile = BASELINE_RC_SCHEDULE_PROFILE,
) {
  const extra = schedulePaperMmToModelMm(profile?.layout?.beamPositionExtraPaperMm || 15, profile);
  return Math.max(0, Number(sectionWidthMm) || 0) + extra;
}

export function getBeamScheduleDiagramModelHeight(
  sectionDepthMm,
  profile = BASELINE_RC_SCHEDULE_PROFILE,
) {
  const extra = schedulePaperMmToModelMm(profile?.layout?.beamDiagramExtraPaperMm || 15, profile);
  return Math.max(0, Number(sectionDepthMm) || 0) + extra;
}

export function getColumnSchedulePositionModelWidth(
  sectionDimensionMm,
  profile = BASELINE_RC_SCHEDULE_PROFILE,
) {
  const extra = schedulePaperMmToModelMm(profile?.layout?.columnPositionExtraPaperMm || 16, profile);
  return Math.max(0, Number(sectionDimensionMm) || 0) + extra;
}

export function getColumnScheduleDiagramModelHeight(
  sectionDimensionMm,
  profile = BASELINE_RC_SCHEDULE_PROFILE,
) {
  const extra = schedulePaperMmToModelMm(profile?.layout?.columnDiagramExtraPaperMm || 16, profile);
  return Math.max(0, Number(sectionDimensionMm) || 0) + extra;
}
