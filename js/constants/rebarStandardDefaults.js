/**
 * @fileoverview 日建連・JSCA「鉄筋コンクリート造配筋標準図」2023.04.01 改定の既定値。
 *
 * このモジュールは標準図の値をデータとして保持するだけとし、自治体・発注者・社内標準の
 * 差分は後続の共通設定 override で解決する。生成コード側に標準名による分岐を持ち込まない。
 */

const LENGTH_FC_BANDS = [
  { key: '18', min: 18, max: 18 },
  { key: '21', min: 21, max: 21 },
  { key: '24-27', min: 24, max: 27 },
  { key: '30-36', min: 30, max: 36 },
  { key: '39-45', min: 39, max: 45 },
  { key: '48-60', min: 48, max: 60 },
];

const LENGTH_FACTORS = {
  SD295: {
    18: { l1: 45, l1h: 35, l2: 40, l2h: 30, la: 20, lb: 15 },
    21: { l1: 40, l1h: 30, l2: 35, l2h: 25, la: 15, lb: 15 },
    '24-27': { l1: 35, l1h: 25, l2: 30, l2h: 20, la: 15, lb: 15 },
    '30-36': { l1: 35, l1h: 25, l2: 30, l2h: 20, la: 15, lb: 15 },
    '39-45': { l1: 30, l1h: 20, l2: 25, l2h: 15, la: 15, lb: 15 },
    '48-60': { l1: 30, l1h: 20, l2: 25, l2h: 15, la: 15, lb: 15 },
  },
  SD345: {
    18: { l1: 50, l1h: 35, l2: 40, l2h: 30, la: 20, lb: 20 },
    21: { l1: 45, l1h: 30, l2: 35, l2h: 25, la: 20, lb: 20 },
    '24-27': { l1: 40, l1h: 30, l2: 35, l2h: 25, la: 20, lb: 15 },
    '30-36': { l1: 35, l1h: 25, l2: 30, l2h: 20, la: 15, lb: 15 },
    '39-45': { l1: 35, l1h: 25, l2: 30, l2h: 20, la: 15, lb: 15 },
    '48-60': { l1: 30, l1h: 20, l2: 25, l2h: 15, la: 15, lb: 15 },
  },
  SD390: {
    21: { l1: 50, l1h: 35, l2: 40, l2h: 30, la: 20, lb: 20 },
    '24-27': { l1: 45, l1h: 35, l2: 40, l2h: 30, la: 20, lb: 20 },
    '30-36': { l1: 40, l1h: 30, l2: 35, l2h: 25, la: 20, lb: 15 },
    '39-45': { l1: 40, l1h: 30, l2: 35, l2h: 25, la: 15, lb: 15 },
    '48-60': { l1: 35, l1h: 25, l2: 30, l2h: 20, la: 15, lb: 15 },
  },
  SD490: {
    '24-27': { l1: 55, l1h: 40, l2: 45, l2h: 35, la: 25, lb: null },
    '30-36': { l1: 50, l1h: 35, l2: 40, l2h: 30, la: 25, lb: null },
    '39-45': { l1: 45, l1h: 35, l2: 40, l2h: 30, la: 20, lb: null },
    '48-60': { l1: 40, l1h: 30, l2: 35, l2h: 25, la: 20, lb: null },
  },
};

const MAIN_BAR_SPACING_BY_DESIGNATION = {
  D10: { outsideDiameterMm: 11, clearMinMm: 32, layer2MinMm: 43 },
  D13: { outsideDiameterMm: 15, clearMinMm: 32, layer2MinMm: 47 },
  D16: { outsideDiameterMm: 19, clearMinMm: 32, layer2MinMm: 51 },
  D19: { outsideDiameterMm: 22, clearMinMm: 32, layer2MinMm: 54 },
  D22: { outsideDiameterMm: 26, clearMinMm: 33, layer2MinMm: 59 },
  D25: { outsideDiameterMm: 29, clearMinMm: 38, layer2MinMm: 67 },
  D29: { outsideDiameterMm: 33, clearMinMm: 44, layer2MinMm: 77 },
  D32: { outsideDiameterMm: 37, clearMinMm: 48, layer2MinMm: 85 },
  D35: { outsideDiameterMm: 40, clearMinMm: 53, layer2MinMm: 93 },
  D38: { outsideDiameterMm: 43, clearMinMm: 57, layer2MinMm: 100 },
  D41: { outsideDiameterMm: 47, clearMinMm: 62, layer2MinMm: 109 },
};

export const NIKKENREN_2023_REBAR_STANDARD_DEFAULTS = Object.freeze({
  standardId: 'nikkenren-jsca-2023-04-01',
  standardLabel: '日建連・JSCA 鉄筋コンクリート造配筋標準図 2023.04.01',

  bend: {
    hookTailDiaFactor: Object.freeze({ 180: 4, 135: 6, 90: 8 }),
    insideDiameterRules: Object.freeze([
      { grades: ['SD295', 'SD345'], maxDiaMm: 16, factor: 3, bendAngles: [180, 135, 90] },
      {
        grades: ['SD295', 'SD345'],
        minDiaMm: 19,
        maxDiaMm: 41,
        factor: 4,
        bendAngles: [180, 135, 90],
      },
      { grades: ['SD390'], maxDiaMm: 41, factor: 5, bendAngles: [180, 135, 90] },
      { grades: ['SD490'], maxDiaMm: 25, factor: 5, bendAngles: [90] },
      { grades: ['SD490'], minDiaMm: 29, maxDiaMm: 41, factor: 6, bendAngles: [90] },
    ]),
  },

  spacing: {
    coarseAggregateFactor: 1.25,
    adjacentNominalAverageFactor: 1.5,
    assumedCoarseAggregateMaxMm: 25,
    byDesignation: Object.freeze(MAIN_BAR_SPACING_BY_DESIGNATION),
  },

  lengths: {
    fcBands: Object.freeze(LENGTH_FC_BANDS),
    factors: Object.freeze(LENGTH_FACTORS),
    lightweightConcreteAddDiaFactor: 5,
    smallBeamAndSlabBottom: Object.freeze({
      smallBeam: { l3DiaFactor: 20, cantileverL3DiaFactor: 25, l3hDiaFactor: 10 },
      slab: { l3DiaFactor: 10, l3MinMm: 150, cantileverL3DiaFactor: 25, l3hDiaFactor: null },
    }),
    beamColumnProjectionDepthRatio: 0.75,
    beamColumnHookTailDiaFactor: 8,
  },

  column: {
    jointHoop: Object.freeze({
      rangeRule: 'all-attached-beam-depth-overlap',
      firstHoopRule: 'same-as-adjacent-column-hoop',
      pitchRule: 'structural-drawing',
      detailRule: 'structural-drawing',
      noOrthogonalBeamRule: 'no-joint-hoop-default',
    }),
  },

  girder: {
    firstStirrupFromFaceMm: 30,
  },

  slab: {
    // §10-2: 支持部から第1筋まで100mm以下。切止めは短辺内法Lx/4を基準に15d延長する。
    firstBarFromSupportMaxMm: 100,
    cutoff: Object.freeze({ supportZoneByShortSpanRatio: 0.25, extensionDiaFactor: 15 }),
  },

  cover: {
    mainBarMinimumDiaFactorForColumnBeam: 1.5,
    durableFinishReductionMm: 10,
    columnBeam: Object.freeze({
      noSoilIndoor: { designMm: 40, minimumMm: 30, category: 'c' },
      noSoilOutdoor: { designMm: 50, minimumMm: 40, category: 'd' },
      soilContact: { designMm: 50, minimumMm: 40, category: 'i' },
    }),
  },
});
