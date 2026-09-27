/**
 * @fileoverview R13: RC布基礎のMAIN_BASE / MAIN_TIP切替をproduction RebarPathへ接続するadapter。
 *
 * 通常のContinuous配置は stripFootingRebarPlacementBase.js に委譲し、ST-Bridgeで
 * length / main_type が明示されたREVERSE_T主筋切替だけを分割して追加する。
 */
import {
  buildStripFootingRebarRenderPlan as buildBaseStripFootingRebarRenderPlan,
  _stripFootingRebarPlacementInternals as baseInternals,
} from './stripFootingRebarPlacementBase.js';
import {
  parseFoundationBeamReferenceMap,
  parseStripFootingMembers,
  parseStripFootingSectionMap,
  readStripFootingNodeMap,
} from './stripFootingRebarSectionFacts.js';
import {
  MAIN_SWITCH_FACES,
  SWITCH_LEGACY_CODES,
  hasMainSwitchIntent,
  resolveFaceSwitch,
  validateNonMainSwitchAttributes,
} from './stripFootingMainSwitchContract.js';
import {
  clipGeneratedMainPaths,
  clipLineToYInterval,
  transformSwitchDocument,
} from './stripFootingMainSwitchGeometry.js';

function makeCheck(member, status, code, message, extra = {}) {
  return {
    memberType: 'stripFooting',
    memberId: member.id,
    memberName: member.name,
    sectionId: member.sectionId,
    status,
    specialRequired: status !== 'READY',
    code,
    message,
    ...extra,
  };
}

function sameMemberId(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function memberCheck(plan, memberId) {
  return plan?.checks?.find((check) => sameMemberId(check.memberId, memberId)) || null;
}

function memberPaths(plan, memberId) {
  return (plan?.paths || []).filter((path) => sameMemberId(path?.metadata?.memberId, memberId));
}

function checkExtra(check) {
  if (!check) return {};
  const extra = { ...check };
  for (const key of [
    'memberType',
    'memberId',
    'memberName',
    'sectionId',
    'status',
    'specialRequired',
    'code',
    'message',
  ]) {
    delete extra[key];
  }
  return extra;
}

function unresolvedContract(member, resolved) {
  const defaultLength = resolved.reason === 'MAIN_SWITCH_LENGTH_DEFAULT_UNRESOLVED';
  return makeCheck(
    member,
    'SPECIAL_REQUIRED',
    defaultLength
      ? 'STRIP_FOOTING_MAIN_SWITCH_LENGTH_DEFAULT_UNRESOLVED'
      : 'STRIP_FOOTING_MAIN_SWITCH_CONTRACT_UNRESOLVED',
    defaultLength
      ? '主筋切替があるのにlengthが省略され、StbCommonから既定切替長を一意に解決できないため推定しません'
      : 'MAIN_BASE / MAIN_TIP の切替契約を一意に解決できません',
    resolved,
  );
}

function buildSwitchMember(xmlDoc, member, section, references, originalCheck) {
  if (!section?.shape?.valid || !section?.bars?.length) {
    return {
      check:
        originalCheck ||
        makeCheck(
          member,
          'SPECIAL_REQUIRED',
          'STRIP_FOOTING_SECTION_UNRESOLVED',
          'RC連続基礎断面を解決できません',
        ),
      paths: [],
    };
  }
  if (section.invalidBarCount > 0 || section.duplicatePositions.length > 0) {
    return {
      check:
        originalCheck ||
        makeCheck(
          member,
          'SPECIAL_REQUIRED',
          'STRIP_FOOTING_BAR_DATA_INVALID',
          '主筋切替対象の径・本数・pitchまたは重複posを一意に解決できません',
        ),
      paths: [],
    };
  }
  if (
    originalCheck &&
    originalCheck.status !== 'READY' &&
    !SWITCH_LEGACY_CODES.has(originalCheck.code)
  ) {
    return { check: originalCheck, paths: [] };
  }

  const nonMain = validateNonMainSwitchAttributes(section);
  if (nonMain.status !== 'READY') {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_ATTRIBUTE_INVALID',
        'length / main_type の指定位置がST-Bridge仕様と一致しません',
        nonMain,
      ),
      paths: [],
    };
  }

  const faceSwitches = [];
  for (const face of MAIN_SWITCH_FACES) {
    const resolved = resolveFaceSwitch(section, face);
    if (resolved.status === 'UNRESOLVED') {
      return { check: unresolvedContract(member, resolved), paths: [] };
    }
    if (resolved.status === 'READY') faceSwitches.push(resolved);
  }
  if (!faceSwitches.length) {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_CONTRACT_UNRESOLVED',
        '主筋切替対象を一意に解決できません',
      ),
      paths: [],
    };
  }

  if (
    faceSwitches.length > 1 &&
    faceSwitches.some((item) => item.baseBar.isVertical || item.tipBar.isVertical)
  ) {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_MULTI_FACE_VERTICAL_UNRESOLVED',
        '上下両面が同時に主筋切替されるisVertical端部は相手面切替との対応を一意化できないため推定しません',
      ),
      paths: [],
    };
  }

  const baseDocument = transformSwitchDocument(xmlDoc, member.sectionId, null);
  if (!baseDocument) {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_TRANSFORM_FAILED',
        '主筋元端側の検証用断面を構成できません',
      ),
      paths: [],
    };
  }
  const basePlan = buildBaseStripFootingRebarRenderPlan(baseDocument);
  const baseCheck = memberCheck(basePlan, member.id);
  if (!baseCheck || baseCheck.status !== 'READY') {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_BASE_VARIANT_UNRESOLVED',
        'MAIN_TIPを除いた元端側配筋が既存Continuous配置契約を満たしません',
        {
          baseVariantCode: baseCheck?.code || null,
          baseVariantMessage: baseCheck?.message || null,
        },
      ),
      paths: [],
    };
  }

  const frame = baseInternals.buildFrame(member, section, references);
  if (!frame) {
    return {
      check: makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_MAIN_SWITCH_FRAME_UNRESOLVED',
        '主筋切替用の布基礎ローカル座標系を構成できません',
      ),
      paths: [],
    };
  }

  const switchedBasePositions = new Set(faceSwitches.map((item) => item.basePosition));
  const outputPaths = memberPaths(basePlan, member.id).filter(
    (path) => !switchedBasePositions.has(path?.metadata?.position),
  );
  const faceMetadata = [];

  for (const faceSwitch of faceSwitches) {
    const baseClipped = clipGeneratedMainPaths({
      generatedPaths: memberPaths(basePlan, member.id),
      frame,
      section,
      bar: faceSwitch.baseBar,
      faceSwitch,
      sourcePosition: faceSwitch.basePosition,
      outputPosition: faceSwitch.basePosition,
    });
    if (baseClipped.status !== 'READY') {
      return {
        check: makeCheck(
          member,
          'SPECIAL_REQUIRED',
          'STRIP_FOOTING_MAIN_SWITCH_GEOMETRY_UNRESOLVED',
          'MAIN_BASEの切替区間へRebarPathをクリップできません',
          { face: faceSwitch.face, reason: baseClipped.reason },
        ),
        paths: [],
      };
    }
    outputPaths.push(...baseClipped.paths);

    const tipDocument = transformSwitchDocument(xmlDoc, member.sectionId, faceSwitch.face);
    const tipPlan = tipDocument ? buildBaseStripFootingRebarRenderPlan(tipDocument) : null;
    const tipCheck = tipPlan ? memberCheck(tipPlan, member.id) : null;
    if (!tipCheck || tipCheck.status !== 'READY') {
      return {
        check: makeCheck(
          member,
          'SPECIAL_REQUIRED',
          tipDocument
            ? 'STRIP_FOOTING_MAIN_SWITCH_TIP_VARIANT_UNRESOLVED'
            : 'STRIP_FOOTING_MAIN_SWITCH_TRANSFORM_FAILED',
          tipDocument
            ? 'MAIN_TIPをMAIN_BASEへ正規化した先端側配筋が既存Continuous配置契約を満たしません'
            : '主筋先端側の検証用断面を構成できません',
          {
            face: faceSwitch.face,
            tipVariantCode: tipCheck?.code || null,
            tipVariantMessage: tipCheck?.message || null,
          },
        ),
        paths: [],
      };
    }

    const tipClipped = clipGeneratedMainPaths({
      generatedPaths: memberPaths(tipPlan, member.id),
      frame,
      section,
      bar: faceSwitch.tipBar,
      faceSwitch,
      sourcePosition: faceSwitch.basePosition,
      outputPosition: faceSwitch.tipPosition,
    });
    if (tipClipped.status !== 'READY') {
      return {
        check: makeCheck(
          member,
          'SPECIAL_REQUIRED',
          'STRIP_FOOTING_MAIN_SWITCH_GEOMETRY_UNRESOLVED',
          'MAIN_TIPの切替区間へRebarPathをクリップできません',
          { face: faceSwitch.face, reason: tipClipped.reason },
        ),
        paths: [],
      };
    }
    outputPaths.push(...tipClipped.paths);
    faceMetadata.push({
      face: faceSwitch.face,
      mainType: faceSwitch.mainType,
      lengthMm: faceSwitch.lengthMm,
      baseIntervals: baseClipped.intervalResult.intervals,
      tipIntervals: tipClipped.intervalResult.intervals,
    });
  }

  return {
    check: makeCheck(
      member,
      'READY',
      'STRIP_FOOTING_MAIN_SWITCH_READY',
      'MAIN_BASE / MAIN_TIP の明示切替をST-Bridge length / main_typeから3D配筋化可能',
      {
        ...checkExtra(baseCheck),
        mainSwitchBasis: 'STB_EXPLICIT_LENGTH_MAIN_TYPE',
        mainSwitchFaces: faceMetadata,
      },
    ),
    paths: outputPaths,
  };
}

export function buildStripFootingRebarRenderPlan(xmlDoc) {
  const basePlan = buildBaseStripFootingRebarRenderPlan(xmlDoc);
  const sections = parseStripFootingSectionMap(xmlDoc);
  const members = parseStripFootingMembers(xmlDoc);
  const switchMembers = members.filter((member) =>
    hasMainSwitchIntent(sections.get(member.sectionId)),
  );
  if (!switchMembers.length) return basePlan;

  const nodes = readStripFootingNodeMap(xmlDoc);
  const references = parseFoundationBeamReferenceMap(xmlDoc, nodes);
  const switchIds = new Set(switchMembers.map((member) => String(member.id)));
  const replacements = new Map();
  const replacementPaths = [];

  for (const member of switchMembers) {
    const section = sections.get(member.sectionId);
    const originalCheck = memberCheck(basePlan, member.id);
    const result = buildSwitchMember(xmlDoc, member, section, references, originalCheck);
    replacements.set(String(member.id), result.check);
    if (result.check?.status === 'READY') replacementPaths.push(...result.paths);
  }

  const paths = [
    ...(basePlan.paths || []).filter(
      (path) => !switchIds.has(String(path?.metadata?.memberId ?? '')),
    ),
    ...replacementPaths,
  ];
  const checks = [];
  const seen = new Set();
  for (const check of basePlan.checks || []) {
    const id = String(check.memberId ?? '');
    if (replacements.has(id)) {
      checks.push(replacements.get(id));
      seen.add(id);
    } else {
      checks.push(check);
    }
  }
  for (const member of switchMembers) {
    const id = String(member.id);
    if (!seen.has(id) && replacements.has(id)) checks.push(replacements.get(id));
  }

  return {
    paths,
    checks,
    readyCount: checks.filter((check) => check.status === 'READY').length,
    specialCount: checks.filter((check) => check.status !== 'READY').length,
  };
}

export const _stripFootingMainSwitchPlacementInternals = Object.freeze({
  clipLineToYInterval,
  resolveFaceSwitch,
  transformSwitchDocument,
});
