/**
 * @fileoverview R11の実折曲げRebarPathを既存R4帯筋・あばら筋layoutへ付与する。
 *
 * 配置fact（loop/tieの座標・径・grade）と施工詳細ruleをdata層で合成し、viewerには
 * 解決済みRebarPathだけを渡す。解決不能時はactualBendRequired=trueのままpathを
 * 付与せず、旧sharp geometryへfallbackさせない。
 *
 * 中子筋・副帯筋・副あばら筋は閉鎖タガへ変換せず、直筋の両端に135°フックを持つ
 * 独立した開放筋として実形状化する。フックは拘束対象主筋の側へ固定し、材軸方向に
 * 交互反転させない。
 *
 * 外周STP/HOOPは主筋を囲う閉鎖筋とし、actual-main-barsが解けている135°HOOKでは
 * TOP_RIGHT / BOTTOM_LEFTの角主筋をanchorにして、隣接2辺からそれぞれ主筋を抱く。
 * 角主筋factがない一般geometryだけの場合は従来の非重複closureを維持する。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { resolveShearRebarChoiceForMember } from '../../../config/rebarDetailingChoice.js';
import { buildHookedOpenTiePath, buildRoundedRectShearPath } from './shearRebarPathGeometry.js';
import { buildInnerCrosstie135Path } from './shearRebarInnerCrosstieGeometry.js';
import { buildMainBarWrappedRectShearPath } from './shearRebarOuterHookGeometry.js';

const DEFAULT_HOOK_ANGLE_DEG = 135;
const POSITION_EPS = 1e-6;
const INNER_RESTRAINT_ROLES = new Set([
  'column-hoop-inner-x',
  'column-hoop-inner-y',
  'beam-stirrup-inner',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeClosure(value) {
  const normalized = String(value || 'HOOK').toUpperCase();
  return ['HOOK', 'WELDED'].includes(normalized) ? normalized : null;
}

function detailingRule(memberType) {
  const config = getRebarCommonConfig();
  const raw =
    memberType === 'column' ? config.column?.hoopHookRule : config.girder?.stirrupHookRule;

  if (isPlainObject(raw)) {
    const closureType =
      raw.closureType === undefined || raw.closureType === null
        ? 'HOOK'
        : normalizeClosure(raw.closureType);
    return {
      source: 'project-config',
      supported: Boolean(closureType),
      unsupportedReason: closureType ? null : 'unsupported-shear-closure-type',
      choice: null,
      closureType,
      hookAngleDeg: finiteOrNull(raw.hookAngleDeg) ?? DEFAULT_HOOK_ANGLE_DEG,
      innerTieHookAngleDeg:
        finiteOrNull(raw.innerTieHookAngleDeg) ??
        finiteOrNull(raw.hookAngleDeg) ??
        DEFAULT_HOOK_ANGLE_DEG,
      widthTieHookAngleDeg:
        finiteOrNull(raw.widthTieHookAngleDeg) ??
        finiteOrNull(raw.innerTieHookAngleDeg) ??
        finiteOrNull(raw.hookAngleDeg) ??
        DEFAULT_HOOK_ANGLE_DEG,
      tailLengthMm: finiteOrNull(raw.tailLengthMm),
      innerTieTailLengthMm: finiteOrNull(raw.innerTieTailLengthMm),
      widthTieTailLengthMm: finiteOrNull(raw.widthTieTailLengthMm),
      allowConditional90: raw.allowConditional90 === true,
    };
  }

  const resolved = resolveShearRebarChoiceForMember(config.detailing?.choice, memberType);
  return {
    source: resolved.source,
    supported: resolved.supported,
    unsupportedReason: resolved.reason,
    choice: resolved.choice,
    closureType: resolved.geometry?.closureType ?? null,
    hookAngleDeg: resolved.geometry?.closureType === 'HOOK' ? resolved.geometry.hookAngleDeg : null,
    innerTieHookAngleDeg: DEFAULT_HOOK_ANGLE_DEG,
    widthTieHookAngleDeg: DEFAULT_HOOK_ANGLE_DEG,
    tailLengthMm: null,
    innerTieTailLengthMm: null,
    widthTieTailLengthMm: null,
    allowConditional90: false,
  };
}

function unresolvedEntry(kind, role, result, source) {
  return {
    kind,
    role,
    reason: result?.reason || 'actual-bend-unresolved',
    specialRequired: result?.specialRequired !== false,
    source,
  };
}

function decorateRectLoop(loop, segment, memberType, rule, unresolved) {
  if (loop?.type !== 'RECT') return loop;
  const grade = loop.grade || segment.grade || null;

  if (memberType === 'beam' && segment?.stirrupLegsResolved === false) {
    const reason = segment.stirrupUnresolved?.[0] || 'stirrup-inner-leg-pair-unresolved';
    unresolved.push({
      kind: memberType,
      role: 'outer-loop',
      reason,
      specialRequired: true,
      source: 'R4-stirrup-leg-resolution',
    });
    return {
      ...loop,
      grade,
      actualBendRequired: true,
      bendStatus: 'SPECIAL',
      bendReason: reason,
      specialRequired: true,
      actualBendShape: 'CLOSED_LOOP',
      mainBarEnclosure: true,
      mainBarEnclosureResolved: false,
    };
  }

  const closureType = rule.closureType || 'HOOK';
  const shouldWrapActualMainBar =
    closureType === 'HOOK' &&
    Number(rule.hookAngleDeg) === 135 &&
    loop.restraintGeometrySource === 'actual-main-bars';
  const metadata = {
    source: 'R11-hoop-stirrup-outer',
    ruleId: 'R11',
    role: memberType === 'column' ? 'column-hoop-outer' : 'beam-stirrup-outer',
    detailingSource: rule.source,
    mainBarEnclosure: true,
    restraintGeometrySource: loop.restraintGeometrySource || null,
  };
  const result = shouldWrapActualMainBar
    ? buildMainBarWrappedRectShearPath({
        uMin: loop.uMin,
        uMax: loop.uMax,
        vMin: loop.vMin,
        vMax: loop.vMax,
        barDiaMm: loop.dia,
        grade,
        hookAnchorBars: loop.hookAnchorBars,
        tailLengthMm: rule.tailLengthMm,
        metadata,
      })
    : buildRoundedRectShearPath({
        uMin: loop.uMin,
        uMax: loop.uMax,
        vMin: loop.vMin,
        vMax: loop.vMax,
        barDiaMm: loop.dia,
        grade,
        closureType,
        hookAngleDeg: rule.hookAngleDeg,
        tailLengthMm: rule.tailLengthMm,
        allowConditional90: rule.allowConditional90,
        metadata,
      });

  if (!result.ok) {
    unresolved.push(unresolvedEntry(memberType, 'outer-loop', result, rule.source));
    return {
      ...loop,
      grade,
      actualBendRequired: true,
      bendStatus: 'SPECIAL',
      bendReason: result.reason,
      specialRequired: true,
      actualBendShape: 'CLOSED_LOOP',
      mainBarEnclosure: true,
      mainBarEnclosureResolved: false,
    };
  }

  const hookedClosure = ['hook-closure', 'main-bar-wrapped-hook-closure'].includes(result.source);
  const wrappedMainBar = result.source === 'main-bar-wrapped-hook-closure';
  return {
    ...loop,
    grade,
    actualBendRequired: true,
    bendStatus: 'RESOLVED',
    specialRequired: false,
    path: result.path,
    paths: result.paths,
    actualBendShape: hookedClosure ? 'CLOSED_HOOKED_LOOP' : 'CLOSED_WELDED_LOOP',
    mainBarEnclosure: true,
    mainBarEnclosureResolved: wrappedMainBar || loop.restraintGeometrySource !== 'actual-main-bars',
    hookOverlapAtCorner: false,
    hookPairGeometry: hookedClosure ? (result.hookPairGeometry ?? null) : null,
    hookPairCornerSetbackMm: hookedClosure ? (result.hookPairCornerSetbackMm ?? null) : null,
    hookPairCenterlineSeparationMm: hookedClosure
      ? (result.hookPairCenterlineSeparationMm ?? null)
      : null,
    hookAngleDeg: hookedClosure ? (result.hookRule?.angleDeg ?? null) : null,
    hookPositions: hookedClosure
      ? (result.paths || []).map((path) => path?.metadata?.hookPosition).filter(Boolean)
      : [],
    hookAnchorSource: wrappedMainBar ? loop.hookAnchorSource || 'actual-main-bars' : null,
    actualBendSource: result.source,
    alternateHookPosition: result.alternateHookPosition === true,
  };
}

function tieHookAngle(tie, rule) {
  return tie?.role === 'beam-width-tie' ? rule.widthTieHookAngleDeg : rule.innerTieHookAngleDeg;
}

function tieTailLength(tie, rule) {
  return tie?.role === 'beam-width-tie'
    ? (rule.widthTieTailLengthMm ?? rule.tailLengthMm)
    : (rule.innerTieTailLengthMm ?? rule.tailLengthMm);
}

function restraintHookSide(tie) {
  if (!INNER_RESTRAINT_ROLES.has(tie?.role) || tie?.type !== 'LINE') return null;
  if (tie.axis === 'v') {
    const tieU = finiteOrNull(tie.u);
    const anchorU = finiteOrNull(tie.anchorU);
    if (tieU === null || anchorU === null || Math.abs(anchorU - tieU) <= POSITION_EPS) return null;
    return {
      sideSign: anchorU > tieU ? 1 : -1,
      anchorAxis: 'u',
      anchorValue: anchorU,
      tieValue: tieU,
    };
  }
  if (tie.axis === 'u') {
    const tieV = finiteOrNull(tie.v);
    const anchorV = finiteOrNull(tie.anchorV);
    if (tieV === null || anchorV === null || Math.abs(anchorV - tieV) <= POSITION_EPS) return null;
    return {
      sideSign: anchorV > tieV ? 1 : -1,
      anchorAxis: 'v',
      anchorValue: anchorV,
      tieValue: tieV,
    };
  }
  return null;
}

function openTieFailure(reason) {
  return { ok: false, specialRequired: true, reason, path: null, paths: [] };
}

function restraintSpan(tie) {
  const axis = tie?.axis === 'v' ? 'v' : tie?.axis === 'u' ? 'u' : null;
  if (!axis) return { startMm: null, endMm: null };
  return {
    startMm: finiteOrNull(tie?.restrainedStartBar?.[axis]),
    endMm: finiteOrNull(tie?.restrainedEndBar?.[axis]),
  };
}

/**
 * 中子筋は専用shape contractへ流し、1本の直筋＋両端135°フックを同じ拘束対象主筋側へ向ける。
 * 端部Arcは外周cover envelopeではなく、placementが保持する拘束対象主筋中心・径から解く。
 */
function buildRestrainingOpenTie(tie, segment, rule) {
  const restraint = restraintHookSide(tie);
  if (!restraint) return openTieFailure('inner-tie-restraint-side-unresolved');
  const grade = tie.grade || segment.grade || null;
  const span = restraintSpan(tie);
  const result = buildInnerCrosstie135Path({
    tie,
    grade,
    barDiaMm: tie.dia,
    hookSideSign: restraint.sideSign,
    tailLengthMm: tieTailLength(tie, rule),
    metadata: {
      source: 'R11-shear-inner-restraint',
      ruleId: 'R11',
      role: tie.role,
      detailingSource: rule.source,
      restrainsMainBar: true,
      restraintAnchorAxis: restraint.anchorAxis,
      restraintAnchorValue: restraint.anchorValue,
      restraintTieValue: restraint.tieValue,
      restraintSpanSource: 'restrained-main-bars',
      restraintSpanStartMm: span.startMm,
      restraintSpanEndMm: span.endMm,
    },
  });
  if (!result.ok) return result;
  return {
    ...result,
    restraintSpanSource: 'restrained-main-bars',
    restraintSpanStartMm: span.startMm,
    restraintSpanEndMm: span.endMm,
  };
}

function decorateTie(tie, segment, memberType, rule, unresolved) {
  if (tie?.type !== 'LINE') return tie;
  const grade = tie.grade || segment.grade || null;
  const restrainsMainBar = INNER_RESTRAINT_ROLES.has(tie.role);
  const result = restrainsMainBar
    ? buildRestrainingOpenTie(tie, segment, rule)
    : buildHookedOpenTiePath({
        tie,
        grade,
        barDiaMm: tie.dia,
        hookAngleDeg: tieHookAngle(tie, rule),
        tailLengthMm: tieTailLength(tie, rule),
        allowConditional90: rule.allowConditional90,
        metadata: {
          source: 'R11-shear-auxiliary',
          ruleId: 'R11',
          role: tie.role || 'shear-auxiliary',
          detailingSource: rule.source,
        },
      });

  if (!result.ok) {
    unresolved.push(unresolvedEntry(memberType, tie.role || 'auxiliary-tie', result, rule.source));
    return {
      ...tie,
      grade,
      actualBendRequired: true,
      bendStatus: 'SPECIAL',
      bendReason: result.reason,
      specialRequired: true,
      actualBendShape: 'OPEN_TIE',
      restrainsMainBar,
      shapeContract: restrainsMainBar ? 'INNER_CROSSTIE_135' : null,
    };
  }

  return {
    ...tie,
    grade,
    actualBendRequired: true,
    bendStatus: 'RESOLVED',
    specialRequired: false,
    path: result.path,
    paths: result.paths,
    actualBendShape: 'OPEN_TIE',
    restrainsMainBar,
    shapeContract: result.shapeContract ?? null,
    hookEndsSameSide: result.hookEndsSameSide === true,
    restraintHookSideSign: result.hookSideSign ?? null,
    restraintSpanSource: result.restraintSpanSource ?? null,
    restraintSpanStartMm: result.restraintSpanStartMm ?? null,
    restraintSpanEndMm: result.restraintSpanEndMm ?? null,
    terminalMainBarAligned: result.terminalMainBarAligned === true,
    terminalMainBarClearanceStartMm: result.terminalMainBarClearanceStartMm ?? null,
    terminalMainBarClearanceEndMm: result.terminalMainBarClearanceEndMm ?? null,
    terminalMainBarRequiredClearanceStartMm: result.terminalMainBarRequiredClearanceStartMm ?? null,
    terminalMainBarRequiredClearanceEndMm: result.terminalMainBarRequiredClearanceEndMm ?? null,
    alternateHookSide: result.alternateHookSide === true,
  };
}

function decorateSegment(segment, memberType, rule, unresolved) {
  return {
    ...segment,
    loops: (segment.loops || []).map((loop) =>
      decorateRectLoop(loop, segment, memberType, rule, unresolved),
    ),
    ties: (segment.ties || []).map((tie) =>
      decorateTie(tie, segment, memberType, rule, unresolved),
    ),
  };
}

function markUnsupportedChoiceSegment(segment, reason) {
  return {
    ...segment,
    loops: (segment.loops || []).map((loop) =>
      loop?.type === 'RECT'
        ? {
            ...loop,
            actualBendRequired: true,
            bendStatus: 'SPECIAL',
            bendReason: reason,
            specialRequired: true,
          }
        : loop,
    ),
    ties: (segment.ties || []).map((tie) =>
      tie?.type === 'LINE'
        ? {
            ...tie,
            actualBendRequired: true,
            bendStatus: 'SPECIAL',
            bendReason: reason,
            specialRequired: true,
          }
        : tie,
    ),
  };
}

/**
 * 1レイアウトをR11実折曲げgeometryで装飾する。
 */
export function decorateShearRebarLayout(layout, { memberType = 'beam' } = {}) {
  if (!layout) return layout;
  const normalizedMemberType = memberType === 'column' ? 'column' : 'beam';
  const rule = detailingRule(normalizedMemberType);
  const unresolved = [];

  if (rule.supported === false) {
    const reason = rule.unsupportedReason || 'unsupported-shear-detailing-choice';
    unresolved.push({
      kind: normalizedMemberType,
      role: 'detailing-choice',
      reason,
      specialRequired: true,
      source: rule.source,
    });
    return {
      ...layout,
      segments: (layout.segments || []).map((segment) =>
        markUnsupportedChoiceSegment(segment, reason),
      ),
      auxiliarySegments: (layout.auxiliarySegments || []).map((segment) =>
        markUnsupportedChoiceSegment(segment, reason),
      ),
      r11ActualBend: true,
      r11DetailingRule: rule,
      r11Unresolved: unresolved,
      r11SpecialRequired: true,
    };
  }

  if (!rule.closureType) {
    unresolved.push({
      kind: normalizedMemberType,
      role: 'outer-loop',
      reason: 'unsupported-shear-closure-type',
      specialRequired: true,
      source: rule.source,
    });
  }

  const segments = (layout.segments || []).map((segment) =>
    decorateSegment(segment, normalizedMemberType, rule, unresolved),
  );
  const auxiliarySegments = (layout.auxiliarySegments || []).map((segment) =>
    decorateSegment(segment, normalizedMemberType, rule, unresolved),
  );

  return {
    ...layout,
    segments,
    auxiliarySegments,
    r11ActualBend: true,
    r11DetailingRule: rule,
    r11Unresolved: unresolved,
    r11SpecialRequired: unresolved.length > 0,
  };
}

/**
 * MapのlookupKey等の付加propertyを保持したまま全layoutを装飾する。
 */
export function decorateShearRebarLayoutMap(layoutMap, { memberType = 'beam' } = {}) {
  if (!layoutMap?.size) return layoutMap || new Map();
  const result = new Map();
  for (const [key, layout] of layoutMap) {
    result.set(key, decorateShearRebarLayout(layout, { memberType }));
  }
  for (const key of Object.keys(layoutMap)) result[key] = layoutMap[key];
  return result;
}
