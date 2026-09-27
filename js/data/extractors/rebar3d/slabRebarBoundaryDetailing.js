/**
 * @fileoverview R14-B: RCスラブ筋の隣接スラブ引通し・梁内定着を解決する。
 *
 * 日建連標準図 §10-1 の「梁左右で同じ配筋は通し筋としてよい」を優先し、
 * 引通しできない梁端では上端筋を L2/Lb の90°折曲げ定着、下端筋を L3直線定着とする。
 * ST-Bridge だけでは支持梁断面や鉄筋強度を一意に解けない場合は、既存中心線を残しつつ
 * PARTIAL / specialRequired の check を返して、未解決を黙って定着済みにしない。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { parseConcreteFc } from '../../../constants/rebarAnchorageRules.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { resolveMemberConcreteStrength } from '../concreteStrengthResolver.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { createArc, createLine, createRebarPath } from './rebarPath.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const EPS = 1e-7;
const POINT_TOLERANCE_MM = 2;
const COLLINEAR_TOLERANCE = 0.995;
const SLAB_THROUGH_RULE = rebarRuleTraceMetadata('SLAB-SAME-REBAR-THROUGH-CANDIDATE');

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}
function normalize(v) {
  const size = length(v);
  return size > EPS ? scale(v, 1 / size) : null;
}
function distance(a, b) {
  return length(subtract(a, b));
}

function edgeKey(a, b) {
  const first = String(a);
  const second = String(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function edgeKeyForIndex(context, edgeIndex) {
  const ids = context?.nodeIds || [];
  if (ids.length !== 4 || !(edgeIndex >= 0 && edgeIndex < 4)) return null;
  return edgeKey(ids[edgeIndex], ids[(edgeIndex + 1) % 4]);
}

function memberNodeSequence(member) {
  const result = [];
  const start = member.getAttribute('id_node_start');
  const end = member.getAttribute('id_node_end');
  if (start) result.push(String(start));
  const via =
    member.getElementsByTagName('StbGirderViaNode')?.[0] ||
    member.getElementsByTagName('StbBeamViaNode')?.[0];
  const order = via?.getElementsByTagName('StbNodeIdOrder')?.[0];
  if (order?.textContent) {
    result.push(...order.textContent.trim().split(/\s+/).filter(Boolean).map(String));
  }
  if (end) result.push(String(end));
  return result;
}

function buildBeamEdgeIndex(xmlDoc) {
  const index = new Map();
  for (const tagName of ['StbGirder', 'StbBeam']) {
    for (const member of Array.from(xmlDoc.getElementsByTagName(tagName) || [])) {
      const sequence = memberNodeSequence(member);
      for (let i = 0; i + 1 < sequence.length; i += 1) {
        const key = edgeKey(sequence[i], sequence[i + 1]);
        const entries = index.get(key) || [];
        entries.push({ member, tagName, segmentIndex: i, segmentCount: sequence.length - 1 });
        index.set(key, entries);
      }
    }
  }
  return index;
}

function uniquePositive(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))];
}

function resolveUniformBeamContext(scanTag, candidate) {
  const member = candidate?.member;
  if (!member) return { resolved: false, reason: 'support-member-missing' };
  const kindStructure = String(member.getAttribute('kind_structure') || '').toUpperCase();
  if (kindStructure && kindStructure !== 'RC') {
    return { resolved: false, reason: `support-member-not-rc:${kindStructure}` };
  }

  const sectionId = member.getAttribute('id_section');
  if (!sectionId) return { resolved: false, reason: 'support-section-id-missing' };
  const preferred = candidate.tagName === 'StbGirder' ? 'StbSecGirder_RC' : 'StbSecBeam_RC';
  const fallback = candidate.tagName === 'StbGirder' ? 'StbSecBeam_RC' : 'StbSecGirder_RC';
  const section =
    findElementById(scanTag, preferred, String(sectionId)) ||
    findElementById(scanTag, fallback, String(sectionId));
  if (!section) return { resolved: false, reason: 'support-section-not-found' };

  const detail = extractRcBeamSectionDetail(section);
  const widths = uniquePositive(
    Object.values(detail?.positions || {}).map((position) => Number(position?.width)),
  );
  const depths = uniquePositive(
    Object.values(detail?.positions || {}).map((position) => Number(position?.depth)),
  );
  if (widths.length !== 1) {
    return {
      resolved: false,
      reason: widths.length === 0 ? 'support-width-missing' : 'support-width-varies',
    };
  }
  if (depths.length !== 1) {
    return {
      resolved: false,
      reason: depths.length === 0 ? 'support-depth-missing' : 'support-depth-varies',
    };
  }

  const strength = resolveMemberConcreteStrength({
    scanTag,
    memberEl: member,
    sectionStrength: detail?.concrete?.strength || null,
    storyNodeId: member.getAttribute('id_node_start') || null,
  });

  return {
    resolved: true,
    reason: null,
    memberId: String(member.getAttribute('id') || ''),
    memberTag: candidate.tagName,
    sectionId: String(sectionId),
    widthMm: widths[0],
    depthMm: depths[0],
    fc: parseConcreteFc(strength.value),
    strengthConcrete: strength.value,
  };
}

function reinforcementGradeMap(xmlDoc) {
  const map = new Map();
  for (const element of Array.from(xmlDoc.getElementsByTagName('StbReinforcementStrength') || [])) {
    const designation = String(element.getAttribute('D') || '').toUpperCase();
    const strength = String(element.getAttribute('strength') || '').trim();
    if (designation && strength) map.set(designation, strength);
  }
  return map;
}

function resolvePathGrade(path, gradeMap) {
  const explicit = String(path?.metadata?.strength || '').trim();
  if (explicit) return REBAR_STANDARD_RULES.normalizeGrade(explicit);
  const dia = Number(path?.metadata?.dia);
  if (!(dia > 0)) return null;
  return REBAR_STANDARD_RULES.normalizeGrade(gradeMap.get(`D${dia}`) || '');
}

function boundaryLine(path, side) {
  const primitives = path?.primitives || [];
  if (primitives.length === 0) return null;
  const index = side === 'start' ? 0 : primitives.length - 1;
  const primitive = primitives[index];
  return primitive?.type === 'line' ? { line: primitive, index } : null;
}

function edgeIndexAtPoint(context, point) {
  const frame = context?.frame;
  if (!frame || !point) return null;
  const rel = subtract(point, frame.origin);
  const x = dot(rel, frame.xAxis);
  const y = dot(rel, frame.yAxis);
  const candidates = [];
  if (Math.abs(y) <= POINT_TOLERANCE_MM) candidates.push(0);
  if (Math.abs(x - frame.width) <= POINT_TOLERANCE_MM) candidates.push(1);
  if (Math.abs(y - frame.height) <= POINT_TOLERANCE_MM) candidates.push(2);
  if (Math.abs(x) <= POINT_TOLERANCE_MM) candidates.push(3);
  return candidates.length === 1 ? candidates[0] : null;
}

function endpointFact(path, pathIndex, context, side) {
  const boundary = boundaryLine(path, side);
  if (!boundary) return null;
  const line = boundary.line;
  const point = side === 'start' ? line.start : line.end;
  const edgeIndex = edgeIndexAtPoint(context, point);
  if (!(edgeIndex >= 0 && edgeIndex < 4)) return null;
  const key = edgeKeyForIndex(context, edgeIndex);
  if (!key) return null;
  const interior = side === 'start' ? line.end : line.start;
  const outward = normalize(subtract(point, interior));
  if (!outward) return null;
  return {
    pathIndex,
    path,
    context,
    side,
    edgeIndex,
    edgeKey: key,
    point,
    interior,
    outward,
    slabId: String(path.metadata?.memberId || ''),
  };
}

function buildEndpointFacts(paths, contexts) {
  const byEdge = new Map();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (path?.metadata?.memberType !== 'slab') continue;
    const context = contexts.get(String(path.metadata.memberId));
    if (!context) continue;
    for (const side of ['start', 'end']) {
      const fact = endpointFact(path, index, context, side);
      if (!fact) continue;
      const list = byEdge.get(fact.edgeKey) || [];
      list.push(fact);
      byEdge.set(fact.edgeKey, list);
    }
  }
  return byEdge;
}

function sameStrength(a, b) {
  const aa = String(a || '')
    .trim()
    .toUpperCase();
  const bb = String(b || '')
    .trim()
    .toUpperCase();
  return !aa || !bb || aa === bb;
}

function compatibleThrough(a, b) {
  if (a.slabId === b.slabId) return false;
  if (distance(a.point, b.point) > POINT_TOLERANCE_MM) return false;
  if (dot(a.outward, b.outward) > -COLLINEAR_TOLERANCE) return false;
  if (a.path.metadata?.face !== b.path.metadata?.face) return false;
  if (Number(a.path.metadata?.dia) !== Number(b.path.metadata?.dia)) return false;
  if (Math.abs(Number(a.path.metadata?.pitchMm) - Number(b.path.metadata?.pitchMm)) > 0.1)
    return false;
  return sameStrength(a.path.metadata?.strength, b.path.metadata?.strength);
}

function sideMetadata(side, mode, extra = {}) {
  const prefix = side === 'start' ? 'boundaryStart' : 'boundaryEnd';
  return {
    [`${prefix}Mode`]: mode,
    ...extra,
  };
}

function markThrough(plan, a, b, support) {
  for (const [current, other] of [
    [a, b],
    [b, a],
  ]) {
    const path = plan.paths[current.pathIndex];
    plan.paths[current.pathIndex] = createRebarPath(path.primitives, {
      ...path.metadata,
      ...sideMetadata(current.side, 'THROUGH', {
        [`${current.side === 'start' ? 'boundaryStart' : 'boundaryEnd'}ThroughSlabId`]:
          other.slabId,
        [`${current.side === 'start' ? 'boundaryStart' : 'boundaryEnd'}EdgeKey`]:
          current.edgeKey,
        [`${current.side === 'start' ? 'boundaryStart' : 'boundaryEnd'}SupportMemberId`]:
          support?.memberId || null,
      }),
      throughRuleId: SLAB_THROUGH_RULE.ruleId,
      throughRuleSource: SLAB_THROUGH_RULE.source,
      throughRuleMaturity: SLAB_THROUGH_RULE.maturity,
      throughRulePrecedence: SLAB_THROUGH_RULE.precedence,
    });
  }
}

function replaceBoundaryLine(path, side, line, metadata, extraPrimitives = []) {
  const boundary = boundaryLine(path, side);
  if (!boundary) return null;
  const primitives = [...path.primitives];
  primitives[boundary.index] = line;
  if (side === 'start') primitives.unshift(...extraPrimitives);
  else primitives.push(...extraPrimitives);
  return createRebarPath(primitives, { ...path.metadata, ...metadata });
}

function makePartialCheck(fact, code, message, extra = {}) {
  return {
    memberType: 'slab',
    memberId: fact.slabId,
    memberName: fact.context?.slab?.name || '',
    sectionId: fact.context?.slab?.sectionId || null,
    status: 'PARTIAL',
    specialRequired: true,
    code,
    message,
    standardId: REBAR_STANDARD_RULES.standardId,
    edgeKey: fact.edgeKey,
    ...extra,
  };
}

function extendBottom(plan, fact, support) {
  const path = plan.paths[fact.pathIndex];
  const boundary = boundaryLine(path, fact.side);
  if (!boundary) return { ok: false, reason: 'non-line-slab-boundary' };
  const line = boundary.line;
  const dia = Number(path.metadata?.dia);
  const cantilever = fact.context?.slab?.kindSlab === 'CANTI';
  const rule = REBAR_STANDARD_RULES.defaults.lengths.smallBeamAndSlabBottom?.slab || {};
  const factor = cantilever ? rule.cantileverL3DiaFactor : rule.l3DiaFactor;
  if (!(dia > 0) || !(factor > 0)) return { ok: false, reason: 'slab-l3-rule-unresolved' };
  const requiredMm = cantilever ? factor * dia : Math.max(factor * dia, Number(rule.l3MinMm) || 0);
  const halfWidth = support.widthMm / 2;
  const extensionMm = Math.max(0, requiredMm - halfWidth);
  const maxExtension = Math.max(0, halfWidth - dia / 2);
  if (extensionMm > maxExtension + EPS) {
    return { ok: false, reason: 'slab-l3-support-width-insufficient', requiredMm, extensionMm };
  }

  const anchoredPoint = add(fact.point, scale(fact.outward, extensionMm));
  const nextLine =
    fact.side === 'start'
      ? createLine(anchoredPoint, line.end)
      : createLine(line.start, anchoredPoint);
  plan.paths[fact.pathIndex] = replaceBoundaryLine(
    path,
    fact.side,
    nextLine,
    sideMetadata(fact.side, 'ANCHOR_L3', {
      supportMemberId: support.memberId,
      supportMemberTag: support.memberTag,
      supportWidthMm: support.widthMm,
      anchorageRequiredMm: requiredMm,
      anchorageExtensionMm: extensionMm,
    }),
  );
  return { ok: true, requiredMm, extensionMm };
}

function topHookGeometry(path, fact, support, grade) {
  const dia = Number(path.metadata?.dia);
  const l2 = REBAR_STANDARD_RULES.resolveLengthFactor({ kind: 'l2', fc: support.fc, grade });
  const lb = REBAR_STANDARD_RULES.resolveLengthFactor({ kind: 'lb', fc: support.fc, grade });
  const bend = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
    grade,
    barDiaMm: dia,
    bendAngle: 90,
  });
  const tailFactor = REBAR_STANDARD_RULES.resolveHookTailFactor(90);
  if (!l2.ok || !lb.ok || !bend.ok || !(tailFactor > 0)) {
    return { ok: false, reason: 'slab-top-anchorage-rule-unresolved', l2, lb, bend };
  }

  const insideDiameterMm = bend.factor * dia;
  const radius = (insideDiameterMm + dia) / 2;
  const l2RequiredMm = l2.factor * dia;
  const projectionRequiredMm = Math.max(lb.factor * dia, support.widthMm / 2);
  const maxProjectionMm = support.widthMm - dia / 2;
  if (projectionRequiredMm > maxProjectionMm + EPS) {
    return {
      ok: false,
      reason: 'slab-top-projection-support-width-insufficient',
      l2RequiredMm,
      projectionRequiredMm,
      maxProjectionMm,
    };
  }

  const deltaFromCenter = projectionRequiredMm - support.widthMm / 2;
  const sharp = add(fact.point, scale(fact.outward, deltaFromCenter));
  const down = { x: 0, y: 0, z: -1 };
  const incomingTangent = add(sharp, scale(fact.outward, -radius));
  const outgoingTangent = add(sharp, scale(down, radius));
  const center = add(incomingTangent, scale(down, radius));
  const radialStart = scale(down, -1);
  const radialEnd = fact.outward;
  const planeNormal = normalize(cross(radialStart, radialEnd));
  if (!planeNormal) return { ok: false, reason: 'slab-top-hook-plane-unresolved' };

  const horizontalBeforeArc = Math.max(0, projectionRequiredMm - radius);
  const arcLength = (Math.PI / 2) * radius;
  const minimumTailMm = tailFactor * dia;
  const tailMm = Math.max(minimumTailMm, l2RequiredMm - horizontalBeforeArc - arcLength);
  const availableVerticalMm = support.depthMm - fact.context.section.coverTopMm - dia;
  if (!(availableVerticalMm > radius + tailMm)) {
    return {
      ok: false,
      reason: 'slab-top-hook-depth-insufficient',
      l2RequiredMm,
      projectionRequiredMm,
      tailMm,
      availableVerticalMm,
    };
  }

  const tailEnd = add(outgoingTangent, scale(down, tailMm));
  const forwardArc = createArc({
    center,
    radius,
    planeNormal,
    startDirection: radialStart,
    sweepAngleRad: Math.PI / 2,
  });
  const reverseArc = createArc({
    center,
    radius,
    planeNormal,
    startDirection: radialEnd,
    sweepAngleRad: -Math.PI / 2,
  });
  return {
    ok: true,
    radius,
    l2RequiredMm,
    projectionRequiredMm,
    minimumTailMm,
    tailMm,
    incomingTangent,
    outgoingTangent,
    tailEnd,
    forwardArc,
    reverseArc,
  };
}

function extendTop(plan, fact, support, grade) {
  const path = plan.paths[fact.pathIndex];
  const boundary = boundaryLine(path, fact.side);
  if (!boundary) return { ok: false, reason: 'non-line-slab-boundary' };
  const line = boundary.line;
  if (!(support.fc > 0) || !grade) {
    return { ok: false, reason: !grade ? 'slab-rebar-grade-unresolved' : 'support-fc-unresolved' };
  }
  // R14-Bは一般水平スラブを対象とする。高低差は§10-3の別納まりなので後続に分離する。
  if (Math.abs(Number(fact.context?.frame?.normal?.z) - 1) > 1e-3) {
    return { ok: false, reason: 'inclined-slab-anchorage-deferred' };
  }

  const hook = topHookGeometry(path, fact, support, grade);
  if (!hook.ok) return hook;

  const dia = Number(path.metadata?.dia);
  const metadata = sideMetadata(fact.side, 'ANCHOR_TOP_90', {
    supportMemberId: support.memberId,
    supportMemberTag: support.memberTag,
    supportWidthMm: support.widthMm,
    supportDepthMm: support.depthMm,
    anchorageGrade: grade,
    anchorageRequiredMm: hook.l2RequiredMm,
    anchorageProjectionRequiredMm: hook.projectionRequiredMm,
    bendAngleDeg: 90,
    centerlineRadiusMm: hook.radius,
    hookTailLengthMm: hook.tailMm,
    dia,
  });

  if (fact.side === 'end') {
    const nextLine = createLine(line.start, hook.incomingTangent);
    plan.paths[fact.pathIndex] = replaceBoundaryLine(path, fact.side, nextLine, metadata, [
      hook.forwardArc,
      createLine(hook.outgoingTangent, hook.tailEnd),
    ]);
  } else {
    const nextLine = createLine(hook.incomingTangent, line.end);
    plan.paths[fact.pathIndex] = replaceBoundaryLine(path, fact.side, nextLine, metadata, [
      createLine(hook.tailEnd, hook.outgoingTangent),
      hook.reverseArc,
    ]);
  }
  return { ok: true, ...hook };
}

/**
 * @param {Document} xmlDoc
 * @param {{paths:Array,checks:Array}} plan
 * @param {Map<string,Object>} contexts buildSlabRebarRenderPlanで作成したスラブcontext
 * @returns {{throughCount:number,anchoredCount:number,partialCount:number,checks:Array}}
 */
export function applySlabBoundaryDetailing(xmlDoc, plan, contexts) {
  const result = { throughCount: 0, anchoredCount: 0, partialCount: 0, checks: [] };
  if (!xmlDoc || !plan || !Array.isArray(plan.paths) || !contexts?.size) return result;

  const scanTag = createTagScanner(xmlDoc);
  const beamEdges = buildBeamEdgeIndex(xmlDoc);
  const gradeMap = reinforcementGradeMap(xmlDoc);
  const endpointsByEdge = buildEndpointFacts(plan.paths, contexts);
  const handled = new Set();

  for (const [key, endpoints] of endpointsByEdge) {
    const supportCandidates = beamEdges.get(key) || [];
    const uniqueSupports = supportCandidates.filter(
      (candidate, index, array) =>
        array.findIndex(
          (other) =>
            other.tagName === candidate.tagName &&
            other.member.getAttribute('id') === candidate.member.getAttribute('id'),
        ) === index,
    );
    const support =
      uniqueSupports.length === 1 ? resolveUniformBeamContext(scanTag, uniqueSupports[0]) : null;

    // 同一点・同径・同ピッチ・同レベルの相手が隣接スラブにあれば、梁をまたぐ通し筋を優先する。
    for (let i = 0; i < endpoints.length; i += 1) {
      const a = endpoints[i];
      const aKey = `${a.pathIndex}:${a.side}`;
      if (handled.has(aKey)) continue;
      const b = endpoints.find((candidate, j) => {
        if (j === i) return false;
        const bKey = `${candidate.pathIndex}:${candidate.side}`;
        return !handled.has(bKey) && compatibleThrough(a, candidate);
      });
      if (!b) continue;
      const bKey = `${b.pathIndex}:${b.side}`;
      markThrough(plan, a, b, support?.resolved ? support : null);
      handled.add(aKey);
      handled.add(bKey);
      result.throughCount += 1;
    }

    for (const fact of endpoints) {
      const factKey = `${fact.pathIndex}:${fact.side}`;
      if (handled.has(factKey)) continue;
      if (uniqueSupports.length === 0) continue; // 自由辺、壁支持等はこのstageで梁定着とはみなさない。
      if (uniqueSupports.length !== 1) {
        result.checks.push(
          makePartialCheck(
            fact,
            'SLAB_BOUNDARY_SUPPORT_AMBIGUOUS',
            'スラブ辺に複数の梁候補があるため定着先を一意に決められません。',
            { supportCandidateCount: uniqueSupports.length },
          ),
        );
        result.partialCount += 1;
        continue;
      }
      if (!support?.resolved) {
        result.checks.push(
          makePartialCheck(
            fact,
            'SLAB_BOUNDARY_SUPPORT_SECTION_UNRESOLVED',
            `梁断面を定着計算へ解決できません: ${support?.reason || 'unknown'}`,
          ),
        );
        result.partialCount += 1;
        continue;
      }

      const face = fact.path.metadata?.face;
      const grade = resolvePathGrade(fact.path, gradeMap);
      const anchored =
        face === 'BOTTOM'
          ? extendBottom(plan, fact, support)
          : face === 'TOP'
            ? extendTop(plan, fact, support, grade)
            : { ok: false, reason: 'slab-face-unresolved' };
      if (anchored.ok) {
        handled.add(factKey);
        result.anchoredCount += 1;
      } else {
        result.checks.push(
          makePartialCheck(
            fact,
            'SLAB_BOUNDARY_ANCHORAGE_UNRESOLVED',
            `梁への定着形状を解決できません: ${anchored.reason || 'unknown'}`,
            {
              supportMemberId: support.memberId,
              supportWidthMm: support.widthMm,
              supportDepthMm: support.depthMm,
              face,
              grade,
            },
          ),
        );
        result.partialCount += 1;
      }
    }
  }

  plan.checks.push(...result.checks);
  return result;
}

export const _slabRebarBoundaryDetailingInternals = Object.freeze({
  edgeKey,
  buildBeamEdgeIndex,
  reinforcementGradeMap,
  boundaryLine,
  edgeIndexAtPoint,
  compatibleThrough,
  resolveUniformBeamContext,
});
