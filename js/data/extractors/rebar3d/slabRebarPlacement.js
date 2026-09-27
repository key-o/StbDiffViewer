/**
 * @fileoverview RCスラブ配筋をST-Bridge断面表記から3D中心線へ正規化する。
 *
 * 方針:
 * - ST-Bridgeの明示配筋（径・ピッチ・上/下・短/長辺・端部/中央）を最優先する。
 * - 配筋の切止め形状だけ、日建連・JSCA 2023 §10-2 の Lx/4 + 15d を既定に使う。
 * - 断面/配置から一意に決められないケースは推定せず SPECIAL_REQUIRED とする。
 * - 開口補強はR15の責務なので、開口を持つスラブはここではfail-closedにする。
 *
 * @module data/extractors/rebar3d/slabRebarPlacement
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import {
  numberAttr,
  parseBarDiameters,
  parseSectionMap,
  readNodeMap,
  getNodeIds,
  getOffsets,
} from './slabRebarSectionFacts.js';
import { applySlabBoundaryDetailing } from './slabRebarBoundaryDetailing.js';
import {
  appliedVertices,
  buildRectFrame,
  axisAngleDegrees,
  resolveMainAxis,
  inferCantileverRootTip,
  hasSlabOpening,
  classifyPosition,
  primaryDirectionForLayer,
  maxPrimaryDiameter,
  intervalsForBar,
  appendPathsForBar,
} from './slabRebarGeometry.js';

function makeCheck(slab, status, code, message, extra = {}) {
  return {
    memberType: 'slab',
    memberId: slab.id,
    memberName: slab.name,
    sectionId: slab.sectionId,
    status,
    specialRequired: status !== 'READY',
    code,
    message,
    standardId: REBAR_STANDARD_RULES.standardId,
    ...extra,
  };
}

/**
 * ST-Bridge RCスラブの配筋中心線を構築する。
 *
 * 対応範囲:
 * - 矩形4節点スラブ（傾斜平面可）
 * - Standard / 2Way / 1Way1 / 1Way2
 * - 直スラブ、および片持ち1Way2のTaper/Haunch
 * - D10D13等の複数径指定は、ピッチごとに交互配置する
 *
 * @param {Document} xmlDoc - ST-Bridge XML Document
 * @param {Object} options - {coverMm}
 * @returns {{paths:Array,checks:Array,readyCount:number,specialCount:number}}
 */
function buildSlabRebarRenderPlanInternal(
  xmlDoc,
  options = {},
  smallOpeningSourceMode = false,
  applyBoundary = true,
  includeContexts = false,
) {
  const plan = {
    paths: [],
    checks: [],
    readyCount: 0,
    specialCount: 0,
    throughCount: 0,
    anchoredCount: 0,
    boundaryPartialCount: 0,
  };
  const contexts = new Map();
  const result = () => (includeContexts ? { renderPlan: plan, contexts } : plan);
  if (!xmlDoc) return result();

  const nodes = readNodeMap(xmlDoc);
  const sections = parseSectionMap(xmlDoc, options);
  const slabElements = Array.from(xmlDoc.getElementsByTagName('StbSlab') || []);

  for (const slabEl of slabElements) {
    if ((slabEl.getAttribute('kind_structure') || '').toUpperCase() !== 'RC') continue;
    const slab = {
      id: String(slabEl.getAttribute('id') || ''),
      name: slabEl.getAttribute('name') || '',
      sectionId: String(slabEl.getAttribute('id_section') || ''),
      kindSlab: (slabEl.getAttribute('kind_slab') || 'NORMAL').toUpperCase(),
    };
    const section = sections.get(slab.sectionId);
    if (!section || section.bars.length === 0) continue;

    const hasOpening = hasSlabOpening(xmlDoc, slab.id, slabEl);
    if (hasOpening && !smallOpeningSourceMode) {
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_OPENING_DEFERRED',
          '開口を持つスラブはR15の開口補強と同時にモデル化します。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    if (numberAttr(slabEl, 'thickness_add_top') || numberAttr(slabEl, 'thickness_add_bottom')) {
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_THICKNESS_ADD_UNRESOLVED',
          'ふかし厚さを持つスラブは鉄筋芯位置を一意に決められないため自動配置しません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    if (!(Number.isFinite(section.coverTopMm) && Number.isFinite(section.coverBottomMm))) {
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_COVER_MISSING',
          '上端/下端かぶりがST-Bridgeまたは共通要領から取得できません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    const nodeIds = getNodeIds(slabEl);
    const vertices = appliedVertices(nodeIds, nodes, getOffsets(slabEl));
    const frame = buildRectFrame(vertices);
    if (!frame) {
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_RECTANGULAR_FRAME_REQUIRED',
          'R14-Aでは4節点の矩形スラブのみ自動配置します。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    let mainAxis = frame.shortAxis;
    if (section.pattern === '1WAY1' || section.pattern === '1WAY2') {
      mainAxis = resolveMainAxis(slabEl, frame);
      if (!mainAxis) {
        plan.checks.push(
          makeCheck(
            slab,
            'SPECIAL_REQUIRED',
            'SLAB_MAIN_DIRECTION_UNRESOLVED',
            `主筋方向角度を矩形辺へ解決できません（local X=${axisAngleDegrees(frame, 'x').toFixed(1)}°）。`,
          ),
        );
        plan.specialCount += 1;
        continue;
      }
    }

    let cantilever = null;
    if (section.pattern === '1WAY2') {
      if (slab.kindSlab !== 'CANTI') {
        plan.checks.push(
          makeCheck(
            slab,
            'SPECIAL_REQUIRED',
            'SLAB_1WAY2_REQUIRES_CANTILEVER',
            '1Way2のBASE/TIPを通常スラブへ推定配置しません。',
          ),
        );
        plan.specialCount += 1;
        continue;
      }
      cantilever = inferCantileverRootTip(vertices, mainAxis);
      if (!cantilever) {
        plan.checks.push(
          makeCheck(
            slab,
            'SPECIAL_REQUIRED',
            'SLAB_CANTILEVER_ROOT_TIP_UNRESOLVED',
            '節点kindから片持ちスラブの支持辺/自由辺を一意に特定できません。',
          ),
        );
        plan.specialCount += 1;
        continue;
      }
    } else if (section.shape.type !== 'STRAIGHT') {
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_VARIABLE_DEPTH_REQUIRES_1WAY2',
          '可変厚スラブは片持ち1Way2のみ自動配置します。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    section.primaryAxis = primaryDirectionForLayer(section.pattern, frame, mainAxis);
    section.primaryMaxDiaMm = maxPrimaryDiameter(section, frame, mainAxis);
    contexts.set(slab.id, {
      slab,
      slabEl,
      nodeIds,
      vertices,
      frame,
      section,
      mainAxis,
      cantilever,
    });
    const before = plan.paths.length;
    let failed = false;
    for (const bar of section.bars) {
      const info = classifyPosition(section.pattern, bar.pos);
      if (
        !info ||
        !appendPathsForBar(plan, slab, section, info, frame, bar, mainAxis, cantilever)
      ) {
        failed = true;
        break;
      }
    }
    if (failed) {
      plan.paths.splice(before);
      plan.checks.push(
        makeCheck(
          slab,
          'SPECIAL_REQUIRED',
          'SLAB_BAR_POSITION_UNRESOLVED',
          '配筋位置または可変厚形状を3D中心線へ解決できません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    plan.checks.push(
      makeCheck(
        slab,
        'READY',
        'SLAB_REBAR_READY',
        'ST-Bridge配筋と日建連§10-2切止め規則から3D化しました。',
        {
          pattern: section.pattern,
          barPathCount: plan.paths.length - before,
          mainAxis,
          ...(hasOpening && smallOpeningSourceMode
            ? {
                hasOpening: true,
                smallOpeningSourceMode: true,
              }
            : {}),
        },
      ),
    );
    plan.readyCount += 1;
  }
  if (applyBoundary) {
    const boundary = applySlabBoundaryDetailing(xmlDoc, plan, contexts);
    plan.throughCount = boundary.throughCount;
    plan.anchoredCount = boundary.anchoredCount;
    plan.boundaryPartialCount = boundary.partialCount;
  } else {
    plan.boundaryDetailingPending = true;
  }
  return result();
}

/** Default production-safe slab render plan. Opening slabs remain deferred. */
export function buildSlabRebarRenderPlan(xmlDoc, options = {}) {
  return buildSlabRebarRenderPlanInternal(xmlDoc, options, false);
}

/** O7a source-only plan. This entrypoint is not used by the normal display path. */
export function buildSlabRebarSmallOpeningSourceRenderPlan(xmlDoc, options = {}) {
  return buildSlabRebarRenderPlanInternal(xmlDoc, options, true);
}

/**
 * O7c production-internal raw source state.
 * Opening slab paths are generated, but slab boundary detailing is intentionally deferred.
 * The returned contexts are consumed only by the production boundary re-resolution stage.
 */
export function buildSlabRebarSmallOpeningRawSourceState(xmlDoc, options = {}) {
  return buildSlabRebarRenderPlanInternal(xmlDoc, options, true, false, true);
}

export const _slabRebarPlacementInternals = Object.freeze({
  parseBarDiameters,
  parseSectionMap,
  buildRectFrame,
  classifyPosition,
  intervalsForBar,
  inferCantileverRootTip,
});
