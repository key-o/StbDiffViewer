/**
 * @fileoverview R6: 仕口折曲げ・別定着と既存柱主筋の置換を同一planで解決する。
 * 両側の主筋本体を特定できる場合だけ原子的に置換する。共有断面は変更しない。
 * R10-Dでは§7-4折曲げ通しを実曲げ半径Arcへ接続する。
 */
import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { parseConcreteFc } from '../../../constants/rebarAnchorageRules.js';
import {
  collectBeamLevelsAtNode,
  createTagScanner,
  extractColumnPlanDimensions,
  findElementById,
} from '../columnSupportUtils.js';
import { resolveMemberConcreteStrength } from '../concreteStrengthResolver.js';
import { buildColumnMainMemberRangeMap } from './columnMainMemberPlacement.js';
import { buildColumnJointTransitionFacts } from './columnJointTransitionPlacement.js';
import {
  buildColumnSeparateAnchorageConstraints,
  columnBarSemanticKey,
} from './columnRebarTransition.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';
import { createLine, createRebarPath } from './rebarPath.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

const EPS = 1e-6;

function samePosition(left, right) {
  return left && right && Math.hypot(left.u - right.u, left.v - right.v) <= EPS;
}

function bodyFor(joint, side, fact, layouts, ranges) {
  const id = joint[`${side}ColumnId`];
  const layout = layouts.get(String(joint[`${side}SectionId`]));
  const geometry = joint[`${side}Geometry`];
  // 未実装の柱内位置遷移を、一律の端部座標で全長に引き延ばさない。
  if (layout?.segments?.length !== 1 || !geometry) return null;
  const segment = layout.segments[0];
  if (segment.startRatio !== 0 || segment.endRatio !== 1) return null;
  const candidates = segment.bars
    .map((bar, index) => ({ bar, index }))
    .filter(
      ({ bar }) =>
        columnBarSemanticKey(bar) === columnBarSemanticKey(fact) &&
        samePosition(bar, fact.localPosition),
    );
  if (candidates.length !== 1) return null;
  const { bar, index } = candidates[0];
  if (
    bar.endpointPosition &&
    (!samePosition(bar.endpointPosition.bottom, bar) ||
      !samePosition(bar.endpointPosition.top, bar))
  )
    return null;
  const length = geometry.top.z - geometry.bottom.z;
  const start = geometry.bottom.z + length * (ranges.get(id)?.startRatio || 0);
  return {
    key: `${id}:${index}`,
    id,
    index,
    bar,
    layout,
    start,
    end: geometry.top.z,
    x: fact.u,
    y: fact.v,
  };
}

function checkRow(joint, transition = null, reason = null, count = 1) {
  const bar = transition?.bottomBar || transition?.topBar;
  return {
    category: '柱仕口納まり',
    kind: '柱',
    elementId: joint.lowerColumnId || joint.lowerColumnIds?.join(',') || '-',
    elementName: `${joint.lowerColumnName || joint.lowerColumnId || '-'} → ${joint.upperColumnName || joint.upperColumnId || '-'}`,
    sectionName: `${joint.lowerSectionName || '-'} → ${joint.upperSectionName || '-'}`,
    position: `節点 ${joint.nodeId}`,
    role: '主筋',
    diaMm: bar?.dia ?? null,
    grade: bar?.grade || null,
    count,
    requiredMm: transition?.eMm > 0 ? transition.eMm * 6 : null,
    availableMm: transition?.jtMm ?? null,
    eMm: transition?.eMm ?? null,
    jtMm: transition?.jtMm ?? null,
    disposition: transition?.disposition || 'SPECIAL',
    identityKey: transition?.identityKey || null,
    standardId: 'NIKKENREN-JSCA-2023',
    exact: false,
    ok: null,
    generationStatus: 'UNRESOLVED',
    unresolvedReason: reason,
    note: `§7-4 未生成: ${reason || 'special-required'}`,
  };
}

function prepareBentRequest(joint, transition, layouts, ranges, check) {
  const lower = bodyFor(joint, 'lower', transition.bottomBar, layouts, ranges);
  const upper = bodyFor(joint, 'upper', transition.topBar, layouts, ranges);
  if (!lower || !upper) return { reason: 'member-endpoint-path-unresolved' };
  const window = transition.bendWindow;
  if (!window || !(window.upperZ > window.lowerZ)) return { reason: 'bend-zone-unresolved' };

  const bar = transition.bottomBar;
  const rounded = buildDoglegTransitionPath({
    sharpStart: { x: lower.x, y: lower.y, z: window.lowerZ },
    sharpEnd: { x: upper.x, y: upper.y, z: window.upperZ },
    incomingDirection: { x: 0, y: 0, z: 1 },
    outgoingDirection: { x: 0, y: 0, z: 1 },
    grade: bar.grade,
    barDiaMm: Number(bar.dia),
    metadata: {
      role: bar.role,
      layer: bar.layer,
      diaName: bar.diaName,
      source: 'column-r6-transition',
      ruleId: 'R6',
      disposition: transition.disposition,
      eMm: transition.eMm,
      jtMm: transition.jtMm,
      ratio: transition.ratio,
      coordinateSpace: 'world',
      identityKey: transition.identityKey,
      nodeId: joint.nodeId,
      memberIds: [lower.id, upper.id],
    },
  });
  if (!rounded.path) return { reason: rounded.reason || 'bend-arc-unresolved' };

  const lowerEndZ = Number(rounded.startCorner?.incomingTangent?.z);
  const upperStartZ = Number(rounded.endCorner?.outgoingTangent?.z);
  if (
    ![lowerEndZ, upperStartZ].every(Number.isFinite) ||
    !(lowerEndZ > lower.start + EPS) ||
    !(upper.end > upperStartZ + EPS) ||
    !(upperStartZ > lowerEndZ + EPS)
  ) {
    return { reason: 'bend-radius-outside-adjacent-members' };
  }

  return {
    lower,
    upper,
    lowerEndZ,
    upperStartZ,
    path: rounded.path,
    bendGeometry: rounded,
    check,
    joint,
    transition,
  };
}

function resolveColumnConcreteFc(scanTag, columnId, index = null) {
  const element = findElementById(scanTag, 'StbColumn', columnId, index);
  if (!element) return { fc: null, source: null };
  const dimensions = extractColumnPlanDimensions(
    scanTag,
    element.getAttribute('id_section'),
    index,
  );
  const strength = resolveMemberConcreteStrength({
    scanTag,
    memberEl: element,
    sectionStrength: dimensions?.strengthConcrete || null,
    storyNodeId: element.getAttribute('id_node_top'),
  });
  return { fc: parseConcreteFc(strength.value), source: strength.source };
}

function prepareSeparateRequest(joint, transition, layouts, ranges, check, scanTag, index = null) {
  const lower = bodyFor(joint, 'lower', transition.bottomBar, layouts, ranges);
  const upper = bodyFor(joint, 'upper', transition.topBar, layouts, ranges);
  if (!lower || !upper) return { reason: 'member-endpoint-path-unresolved' };

  const beamLevels = collectBeamLevelsAtNode(scanTag, joint.nodeId, index);
  if (!beamLevels) return { reason: 'beam-face-levels-unresolved' };

  const lowerConcrete = resolveColumnConcreteFc(scanTag, joint.lowerColumnId, index);
  const upperConcrete = resolveColumnConcreteFc(scanTag, joint.upperColumnId, index);
  if (!(lowerConcrete.fc > 0) || !(upperConcrete.fc > 0)) {
    return { reason: 'column-concrete-strength-unresolved' };
  }

  const built = buildColumnSeparateAnchorageConstraints(transition, {
    beamLevels,
    lowerFc: lowerConcrete.fc,
    upperFc: upperConcrete.fc,
  });
  if (built.unresolvedReason) return { reason: built.unresolvedReason };

  // 柱頭筋・柱脚筋が隣接する上下柱の全長を越えて伸びる場合は自動生成しない。
  if (
    built.lowerEndZ > upper.end + EPS ||
    built.upperStartZ < lower.start - EPS ||
    !(built.lowerEndZ > lower.start + EPS) ||
    !(upper.end > built.upperStartZ + EPS)
  ) {
    return { reason: 'separate-anchorage-outside-adjacent-members' };
  }

  return {
    lower,
    upper,
    lowerEndZ: built.lowerEndZ,
    upperStartZ: built.upperStartZ,
    path: null,
    check,
    joint,
    transition,
    anchorage: {
      ...built,
      lowerFc: lowerConcrete.fc,
      upperFc: upperConcrete.fc,
      lowerFcSource: lowerConcrete.source,
      upperFcSource: upperConcrete.source,
    },
  };
}

function bodyConstraints(requests) {
  const bodies = new Map();
  for (const request of requests) {
    for (const [side, source] of [
      ['lower', request.lower],
      ['upper', request.upper],
    ]) {
      if (!bodies.has(source.key))
        bodies.set(source.key, { ...source, requests: [], startRequests: [], endRequests: [] });
      const body = bodies.get(source.key);
      body.requests.push(request);
      if (side === 'lower') {
        body.end = request.lowerEndZ;
        body.endRequests.push(request);
      } else {
        body.start = request.upperStartZ;
        body.startRequests.push(request);
      }
    }
  }
  return bodies;
}

function setUnresolved(check, reason) {
  check.generationStatus = 'UNRESOLVED';
  check.unresolvedReason = reason;
  check.note = `§7-4 未生成: ${reason}`;
}

/**
 * 複数階にまたがる同一部材筋は両端制約を合成し、本体を1回だけ生成する。
 * 制約が衝突した場合、関係する両側置換を取り消す（片側だけ削除しない）。
 */
function resolveRequests(requests) {
  let active = requests;
  while (true) {
    const bodies = bodyConstraints(active);
    const rejected = new Set();
    for (const body of bodies.values()) {
      if (
        !(body.end > body.start + EPS) ||
        body.startRequests.length > 1 ||
        body.endRequests.length > 1
      ) {
        body.requests.forEach((request) => rejected.add(request));
      }
    }
    if (rejected.size === 0) return { active, bodies };
    rejected.forEach((request) => setUnresolved(request.check, 'conflicting-member-bend-windows'));
    active = active.filter((request) => !rejected.has(request));
  }
}

export function buildColumnJointRenderPlan(xmlDoc, columnLayouts, beamLayouts, options = {}) {
  const scanTag = options.scanTag || (xmlDoc ? createTagScanner(xmlDoc) : null);
  const index =
    options.index || (xmlDoc && scanTag ? buildRebarModelIndex(xmlDoc, { scanTag }) : null);
  const memberRanges =
    options.memberRanges || buildColumnMainMemberRangeMap(xmlDoc, scanTag, index);
  const detailingChoice =
    options.detailingChoice ??
    options.commonConfig?.detailing?.choice ??
    getRebarCommonConfig().detailing?.choice;
  const facts = buildColumnJointTransitionFacts(xmlDoc, columnLayouts, beamLayouts, {
    scanTag,
    index,
    detailingChoice,
    projectDetailing: options.projectDetailing,
    modelSource: options.modelSource,
  });
  const checks = [];
  const requests = [];
  for (const joint of facts.joints) {
    if (!joint.pairResolved) {
      checks.push(checkRow(joint, null, joint.unresolvedReason, 0));
      continue;
    }
    for (const transition of joint.transitions) {
      if (transition.disposition === 'STRAIGHT') continue;
      const check = checkRow(
        joint,
        transition,
        transition.unresolvedReason || 'separate-anchorage-required',
      );
      checks.push(check);
      let request = null;
      if (transition.disposition === 'BENT_CONTINUOUS') {
        request = prepareBentRequest(joint, transition, columnLayouts, memberRanges, check);
      } else if (transition.disposition === 'SEPARATE_ANCHORAGE') {
        request = prepareSeparateRequest(
          joint,
          transition,
          columnLayouts,
          memberRanges,
          check,
          scanTag,
          index,
        );
      } else {
        continue;
      }
      if (request.reason) setUnresolved(check, request.reason);
      else requests.push(request);
    }
    for (const mismatch of joint.unresolvedMatches) {
      const bar = mismatch.leftBars[0] || mismatch.rightBars[0];
      checks.push(
        checkRow(
          joint,
          { bottomBar: bar },
          mismatch.reason,
          Math.max(mismatch.leftBars.length, mismatch.rightBars.length),
        ),
      );
    }
    for (const bars of [joint.unmatchedLowerBars, joint.unmatchedUpperBars]) {
      if (bars.length)
        checks.push(
          checkRow(
            joint,
            { bottomBar: bars[0] },
            'additional-bar-anchorage-unresolved',
            bars.length,
          ),
        );
    }
  }
  facts.unresolvedJoints.forEach((joint) => checks.push(checkRow(joint, null, joint.reason, 0)));
  const { active, bodies } = resolveRequests(requests);
  const memberLayouts = new Map();
  const removed = new Map();
  const paths = [];
  for (const body of bodies.values()) {
    if (!removed.has(body.id)) removed.set(body.id, new Set());
    removed.get(body.id).add(body.index);
    paths.push(
      createRebarPath(
        [
          createLine(
            { x: body.x, y: body.y, z: body.start },
            { x: body.x, y: body.y, z: body.end },
          ),
        ],
        {
          ...body.bar,
          coordinateSpace: 'world',
          memberId: body.id,
          identityKey: `R6:body:${body.key}`,
          source: 'column-r6-body',
          ruleId: 'R6',
          jointDispositions: [
            ...new Set(
              body.requests.map((request) => request.transition?.disposition).filter(Boolean),
            ),
          ],
        },
      ),
    );
    memberLayouts.set(body.id, body.layout);
  }
  for (const [id, layout] of memberLayouts) {
    memberLayouts.set(id, {
      ...layout,
      segments: [
        {
          ...layout.segments[0],
          bars: layout.segments[0].bars.filter((bar, index) => !removed.get(id).has(index)),
        },
      ],
    });
  }
  const firstHoopRequirements = new Map();
  for (const request of active) {
    if (request.path) paths.push(request.path);
    if (request.transition.disposition === 'SEPARATE_ANCHORAGE') {
      Object.assign(request.check, {
        generationStatus: 'CENTERLINE_READY',
        unresolvedReason: null,
        lowerL2Mm: request.anchorage.lowerL2Mm,
        upperL2Mm: request.anchorage.upperL2Mm,
        lowerAnchorageEndZ: request.anchorage.lowerEndZ,
        upperAnchorageStartZ: request.anchorage.upperStartZ,
        lowerFc: request.anchorage.lowerFc,
        upperFc: request.anchorage.upperFc,
        lowerFcSource: request.anchorage.lowerFcSource,
        upperFcSource: request.anchorage.upperFcSource,
        note: '§7-4-2 別定着中心線生成対象。上下主筋を接続せず、§7-1のL2かつ梁面から15dを満足する位置まで個別に延長（適合OK判定ではない）。',
      });
      continue;
    }

    Object.assign(request.check, {
      generationStatus: 'CENTERLINE_READY',
      unresolvedReason: null,
      bendGeometry: 'actual-arc',
      centerlineRadiusMm: request.bendGeometry?.startCorner?.centerlineRadiusMm ?? null,
      note: '§7-4 折曲げ通し中心線を実曲げ半径Arcで生成。梁上第1帯筋2組要求は従来どおり別管理（適合OK判定ではない）。',
    });
    const joint = request.joint;
    firstHoopRequirements.set(`${joint.nodeId}:${joint.upperColumnId}`, {
      nodeId: joint.nodeId,
      upperColumnId: joint.upperColumnId,
      requiredSets: 2,
      generated: false,
      ruleId: '7-4-1',
    });
  }
  return {
    memberLayouts,
    memberRanges,
    paths,
    checks,
    firstHoopRequirements: [...firstHoopRequirements.values()],
    facts,
  };
}
