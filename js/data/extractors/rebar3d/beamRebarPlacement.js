/**
 * @fileoverview RC梁（大梁・小梁）主筋の断面内配置算定（3D配筋用）
 *
 * 1段目・多段筋の位置解決は2D梁断面リストと同じ beamRebarPositionResolver を使用する。
 * ST-Bridgeの center / depth_cover / 段筋重心間距離 / interval を別属性として扱い、
 * 位置sourceをbar factsへ保持する。
 *
 * R4では腹筋も STB明示 > ApplyConditions省略値 > project config > unresolved の順で
 * 解決する。N_web は断面全体の腹筋本数で、左右対向ペアとして2本/段へ展開する。
 *
 * 主筋の1段目位置は2D断面リストと同じ resolver の解釈をそのまま使用する。
 * depth_cover / project cover に対して3DだけSTP径を追加すると2D/3Dの主筋位置がずれるため、
 * せん断補強筋による囲みは hoopPlacement 側でactual main-bar factsから解決する。
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { BEAM_REBAR_PLACEMENT_RULES } from '../../../constants/rebarPlacementRules.js';
import {
  assignBeamLayerGroupsToPositions,
  normalizeBeamRebarLayers,
  resolveBeamFirstLayerFaces,
  resolveBeamLayerCenterSpacingMm,
} from '../beamSectionList/beamRebarPositionResolver.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { resolveBeamAuxiliaryApplyPolicy, resolveBeamWebBar } from './beamAuxiliaryPlacement.js';
import {
  createSegment,
  evenlySpaced,
  isGirderSection,
  orderedPositionKeys,
  resolveDt,
  resolveSpanRanges,
} from './rebarSectionUtils.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';

function defaultMainFaces() {
  const value = Number(BEAM_REBAR_PLACEMENT_RULES.defaultMainCenterMm) || 72;
  return { top: value, bottom: value, left: value, right: value };
}

function createMainBarFact({
  assignment,
  x,
  y,
  width,
  renderDepth,
  side,
  layer,
  positionZone,
  positionSource,
  sidePositionSources,
  positionDepth,
}) {
  const diaName = assignment.dia || BEAM_REBAR_PLACEMENT_RULES.defaultMainBarDia;
  return {
    u: x - width / 2,
    v: renderDepth / 2 - y,
    dia: barDiameterMm(diaName, barDiameterMm(BEAM_REBAR_PLACEMENT_RULES.defaultMainBarDia)),
    diaName,
    role: side === 'TOP' ? 'top' : 'bottom',
    layer: layer.step,
    grade: assignment.grade || null,
    diaEstimated: !!assignment.diaEstimated,
    positionZone,
    positionSource,
    sidePositionSources,
    centerFromTopMm: y,
    sectionDepthMm: positionDepth,
  };
}

function isResolvedFaceValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function buildResolvedSideBars(bar, side, context) {
  const layers = normalizeBeamRebarLayers(bar, BEAM_REBAR_PLACEMENT_RULES.defaultMainBarDia);
  if (layers.length === 0) return { bars: [], layers: [], unresolved: [] };

  const rawLeft = context.positionResolution.faces.left;
  const rawRight = context.positionResolution.faces.right;
  const rawVertical =
    side === 'TOP' ? context.positionResolution.faces.top : context.positionResolution.faces.bottom;
  if (
    !isResolvedFaceValue(rawLeft) ||
    !isResolvedFaceValue(rawRight) ||
    !isResolvedFaceValue(rawVertical)
  ) {
    return {
      bars: [],
      layers: [],
      unresolved: [`missing-${side.toLowerCase()}-first-layer-position`],
    };
  }

  const left = Number(rawLeft);
  const right = Number(rawRight);
  const firstVertical =
    side === 'TOP' ? Number(rawVertical) : context.positionDepth - Number(rawVertical);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(firstVertical)) {
    return {
      bars: [],
      layers: [],
      unresolved: [`missing-${side.toLowerCase()}-first-layer-position`],
    };
  }

  const xStart = left;
  const xEnd = context.width - right;
  if (xEnd < xStart) {
    return {
      bars: [],
      layers: [],
      unresolved: [`invalid-horizontal-main-span:${xStart}:${xEnd}`],
    };
  }

  const bars = [];
  const layerFacts = [];
  const unresolved = [];
  let previousLayer = null;
  let previousY = null;

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    const count = Number(layer.count) || 0;
    if (count <= 0) continue;

    let y;
    let positionSource;
    if (index === 0) {
      y = firstVertical;
      positionSource =
        side === 'TOP'
          ? context.positionResolution.faceSources.top
          : context.positionResolution.faceSources.bottom;
    } else {
      const spacing = resolveBeamLayerCenterSpacingMm({
        previousLayer,
        currentLayer: layer,
        layerSpacing: context.positionResolution.layerSpacing,
        applyDefaults: context.positionResolution.applyDefaults,
      });
      if (!Number.isFinite(spacing.value)) {
        unresolved.push(`unresolved-${side.toLowerCase()}-layer-${layer.step}`);
        break;
      }
      y = side === 'TOP' ? previousY + spacing.value : previousY - spacing.value;
      positionSource = spacing.source;
    }

    if (!Number.isFinite(y) || y < 0 || y > context.positionDepth) {
      unresolved.push(`out-of-section-${side.toLowerCase()}-layer-${layer.step}`);
      break;
    }

    const xPositions = evenlySpaced(xStart, xEnd, count);
    const assignments = assignBeamLayerGroupsToPositions(layer, xPositions);
    const placements = assignments.map((assignment) =>
      createMainBarFact({
        assignment,
        x: assignment.position,
        y,
        width: context.width,
        renderDepth: context.renderDepth,
        side,
        layer,
        positionZone: context.positionZone,
        positionSource,
        sidePositionSources: {
          left: context.positionResolution.faceSources.left,
          right: context.positionResolution.faceSources.right,
        },
        positionDepth: context.positionDepth,
      }),
    );
    bars.push(...placements);
    layerFacts.push({
      step: layer.step,
      count,
      dia: layer.dia,
      y,
      xPositions,
      positionSource,
    });
    previousLayer = layer;
    previousY = y;
  }

  return { bars, layers: layerFacts, unresolved };
}

/**
 * 解決済み腹筋を左右面へ展開する。
 * ST-Bridgeの N_web は断面全体の本数なので、偶数本を左右対向ペアへ分ける。
 * 奇数本は左右への割付情報が無いため、推定せず unresolved とする。
 */
function buildWebBars(webResolution, context) {
  if (webResolution?.status !== 'resolved') return { bars: [], unresolved: [] };
  const webBar = webResolution.value;
  const count = Number(webBar?.count) || 0;
  if (count <= 0 || !webBar?.dia) return { bars: [], unresolved: [] };
  if (!Number.isInteger(count) || count % 2 !== 0) {
    return { bars: [], unresolved: [`web-bar-count-not-pairable:${count}`] };
  }

  const { width, topV, bottomV, stirrupOuter, coverMm, positionZone } = context;
  const diaName = webBar.dia;
  const diaMm = barDiameterMm(diaName, 0);
  if (!(diaMm > 0)) return { bars: [], unresolved: ['web-bar-invalid-diameter'] };
  const outerMm = barOuterDiameterMm(diaName, diaMm);
  const halfSpan = width / 2 - (coverMm + stirrupOuter + outerMm / 2);
  if (halfSpan < 0) return { bars: [], unresolved: ['web-bar-invalid-horizontal-span'] };

  const levelCount = count / 2;
  const bars = [];
  for (let i = 1; i <= levelCount; i += 1) {
    const v = topV + ((bottomV - topV) * i) / (levelCount + 1);
    bars.push(
      {
        u: -halfSpan,
        v,
        dia: diaMm,
        diaName,
        role: 'web',
        layer: null,
        grade: webBar.grade || null,
        positionZone,
        positionSource: webResolution.source,
      },
      {
        u: halfSpan,
        v,
        dia: diaMm,
        diaName,
        role: 'web',
        layer: null,
        grade: webBar.grade || null,
        positionZone,
        positionSource: webResolution.source,
      },
    );
  }
  return { bars, unresolved: [] };
}

function buildPositionBars(position, fallbackCover, options, renderDepth, positionZone) {
  const width = Number(position?.width) || 0;
  const positionDepth = Number(position?.depth) || renderDepth;
  if (width <= 0 || positionDepth <= 0 || renderDepth <= 0) return null;

  const rules = BEAM_REBAR_PLACEMENT_RULES;
  const explicitCoverOverride = Number.isFinite(Number(options.coverMm))
    ? Number(options.coverMm)
    : null;
  const stirrupDiaName = position.stirrup?.dia || rules.defaultStirrupDia;
  const stirrupOuter = barOuterDiameterMm(stirrupDiaName, barDiameterMm(rules.defaultStirrupDia));
  const positionResolution = resolveBeamFirstLayerFaces({
    positionData: position,
    fallbackCover,
    fallbackFaces: explicitCoverOverride === null ? defaultMainFaces() : null,
    fallbackSource: 'compatibility-2d-schedule',
    useSourceCover: explicitCoverOverride === null,
    fallbackCoverMm: explicitCoverOverride,
    allowFallbackWhenNotApplicable: false,
  });

  const mainContext = {
    width,
    positionDepth,
    renderDepth,
    positionZone,
    positionResolution,
  };
  const top = buildResolvedSideBars(position.topBar, 'TOP', mainContext);
  const bottom = buildResolvedSideBars(position.bottomBar, 'BOTTOM', mainContext);
  const mainBars = [...top.bars, ...bottom.bars];

  const compatibilityCover = position.cover || fallbackCover || {};
  const resolveCover = (value) => explicitCoverOverride ?? value ?? rules.defaultCoverMm;
  const coverTop = resolveCover(compatibilityCover.top);
  const coverBottom = resolveCover(compatibilityCover.bottom);
  const coverSide = resolveCover(compatibilityCover.left ?? compatibilityCover.right);
  const topDiaName = position.topBar?.dia || rules.defaultMainBarDia;
  const bottomDiaName = position.bottomBar?.dia || rules.defaultMainBarDia;
  const topOuter = barOuterDiameterMm(topDiaName, barDiameterMm(rules.defaultMainBarDia));

  const topV = top.bars.length
    ? Math.max(...top.bars.map((bar) => bar.v))
    : renderDepth / 2 - (coverTop + stirrupOuter);
  const bottomV = bottom.bars.length
    ? Math.min(...bottom.bars.map((bar) => bar.v))
    : renderDepth / 2 - (positionDepth - (coverBottom + stirrupOuter));
  const webResolution = resolveBeamWebBar(position, options.auxiliaryPolicy);
  const webBuild = buildWebBars(webResolution, {
    width,
    topV,
    bottomV,
    stirrupOuter,
    coverMm: coverSide,
    positionZone,
  });
  const webBars = webBuild.bars;

  const bars = [...mainBars, ...webBars];
  if (bars.length === 0) return null;

  const unresolved = [
    ...positionResolution.unresolved,
    ...top.unresolved,
    ...bottom.unresolved,
    ...(webResolution?.status === 'unresolved' ? webResolution.unresolved : []),
    ...webBuild.unresolved,
  ];
  const estimated =
    unresolved.length > 0 ||
    Object.values(positionResolution.faceSources).some(
      (source) => source !== 'stb-center' && source !== 'stb-cover',
    ) ||
    [...top.layers, ...bottom.layers].some(
      (layer) => layer.positionSource === 'standard-table-2-4',
    ) ||
    (webResolution?.status === 'resolved' &&
      !['stb-direct', 'stb-section', 'stb-apply-default'].includes(webResolution.source));

  return {
    bars,
    mainBars,
    webBars,
    widthMm: width,
    firstLayerFacesMm: {
      left: Number.isFinite(positionResolution.faces.left) ? positionResolution.faces.left : null,
      right: Number.isFinite(positionResolution.faces.right)
        ? positionResolution.faces.right
        : null,
      top: Number.isFinite(positionResolution.faces.top) ? positionResolution.faces.top : null,
      bottom: Number.isFinite(positionResolution.faces.bottom)
        ? positionResolution.faces.bottom
        : null,
    },
    stirrupOuterMm: stirrupOuter,
    webResolution,
    topLayers: top.layers,
    bottomLayers: bottom.layers,
    positionZone,
    positionDepthMm: positionDepth,
    positionSources: positionResolution.faceSources,
    unresolved,
    estimated,
    coverMm: coverTop,
    dt: {
      top: Number.isFinite(positionResolution.faces.top)
        ? positionResolution.faces.top
        : coverTop + stirrupOuter + topOuter / 2,
      side: Number.isFinite(positionResolution.faces.left)
        ? positionResolution.faces.left
        : resolveDt(null, coverSide, stirrupOuter, topOuter).value,
    },
    mainDia: topDiaName,
    bottomDia: bottomDiaName,
    stirrupDia: stirrupDiaName,
  };
}

export function computeBeamRebarSectionLayout(sectionDetail, options = {}) {
  const keys = orderedPositionKeys(sectionDetail);
  if (keys.length === 0) return null;

  const renderDepth = Number(sectionDetail.positions[keys[0]]?.depth) || 0;
  if (renderDepth <= 0) return null;

  const ranges = resolveSpanRanges(keys);
  const segments = [];
  const positionFacts = {};
  let meta = null;

  for (const { key, startRatio, endRatio } of ranges) {
    const built = buildPositionBars(
      sectionDetail.positions[key],
      sectionDetail.cover,
      options,
      renderDepth,
      key,
    );
    if (!built) continue;
    const segment = createSegment(startRatio, endRatio, built.bars);
    segment.positionZone = key;
    segment.positionDepthMm = built.positionDepthMm;
    segment.positionSources = built.positionSources;
    segment.unresolved = built.unresolved;
    segments.push(segment);
    positionFacts[key] = built;
    meta = meta || built;
  }

  if (segments.length === 0) return null;

  return {
    kind: 'beamMain',
    shape: 'RECTANGLE',
    depth: renderDepth,
    segments,
    positionFacts,
    sectionName: sectionDetail.name || null,
    concreteStrength: sectionDetail.concrete?.strength || null,
    positionPattern: sectionDetail.positionPattern || 'SAME',
    coverMm: meta.coverMm,
    dt: meta.dt,
    mainDia: meta.mainDia,
    stirrupDia: meta.stirrupDia,
    estimated: Object.values(positionFacts).some((fact) => fact.estimated),
    unresolved: Object.values(positionFacts).flatMap((fact) =>
      fact.unresolved.map((reason) => `${fact.positionZone}:${reason}`),
    ),
  };
}

export function buildBeamRebarLayoutMaps(xmlDoc, options = {}) {
  const girder = new Map();
  const beam = new Map();
  if (!xmlDoc) return { girder, beam };
  const auxiliaryPolicy = resolveBeamAuxiliaryApplyPolicy(xmlDoc);
  const resolvedOptions = { ...options, auxiliaryPolicy };
  const supportFacts =
    options.includeSupportFacts === true ? buildSmallBeamSupportFacts(xmlDoc) : undefined;

  for (const tagName of ['StbSecGirder_RC', 'StbSecBeam_RC']) {
    for (const element of querySelectorAll(xmlDoc, tagName)) {
      const detail = extractRcBeamSectionDetail(element);
      if (!detail?.id) continue;
      const layout = computeBeamRebarSectionLayout(detail, resolvedOptions);
      if (!layout) continue;
      (isGirderSection(element) ? girder : beam).set(detail.id, layout);
    }
  }
  return supportFacts ? { girder, beam, supportFacts } : { girder, beam };
}
