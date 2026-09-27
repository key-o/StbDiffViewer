/**
 * @fileoverview Issue #273: 配筋納まりの選択軸を単一責務で保持する正規化設定。
 *
 * 付録Aの「閉鎖方式」「フック配置」「加工順序」「柱梁接合部の組立順」を、
 * 3D geometry や hard constraint から分離して保持する。未実装形状は設定として
 * 保持できるが、production geometry へは fail-closed で接続する。
 */

export const RebarDetailingChoiceProfile = Object.freeze({
  SDV_APPENDIX_A_2010: 'SDV_APPENDIX_A_2010',
});

const LEGACY_REBAR_DETAILING_CHOICE_PROFILE_MAP = Object.freeze({
  SDV_APPENDIX_A_DRAFT: RebarDetailingChoiceProfile.SDV_APPENDIX_A_2010,
});

export const ShearClosureFamily = Object.freeze({
  HOOKED: 'HOOKED',
  WELDED_CLOSED: 'WELDED_CLOSED',
  SPIRAL: 'SPIRAL',
  MECHANICAL_CLOSED: 'MECHANICAL_CLOSED',
  U_WITH_CAP: 'U_WITH_CAP',
});

export const ShearHookPattern = Object.freeze({
  ALTERNATING: 'ALTERNATING',
  SINGLE_CORNER: 'SINGLE_CORNER',
});

export const ShearFabricationSequence = Object.freeze({
  UNSPECIFIED: 'UNSPECIFIED',
  PRE_BENT: 'PRE_BENT',
  POST_BENT: 'POST_BENT',
});

export const OrthogonalBeamAssemblyOrder = Object.freeze({
  EXPLICIT_REQUIRED: 'EXPLICIT_REQUIRED',
  X_THEN_Y: 'X_THEN_Y',
  Y_THEN_X: 'Y_THEN_X',
});

export const CornerJointAnchorageMethod = Object.freeze({
  EXPLICIT_REQUIRED: 'EXPLICIT_REQUIRED',
  ENCLOSING_ANCHORAGE: 'ENCLOSING_ANCHORAGE',
  U_SHAPE_ANCHORAGE: 'U_SHAPE_ANCHORAGE',
});

export const CornerJointCongestionMethod = Object.freeze({
  STANDARD: 'STANDARD',
  BEAM_PROJECTION: 'BEAM_PROJECTION',
  BEAM_INNER_SETBACK: 'BEAM_INNER_SETBACK',
});

export const JointHoopConstructionMethod = Object.freeze({
  EXPLICIT_REQUIRED: 'EXPLICIT_REQUIRED',
  DROP_IN: 'DROP_IN',
  IN_PLACE_ASSEMBLY: 'IN_PLACE_ASSEMBLY',
  ACCORDION_DROP_IN: 'ACCORDION_DROP_IN',
});

function freezeMemberChoice(choice) {
  return Object.freeze({ ...choice });
}

const DEFAULT_SHEAR_CHOICE = Object.freeze({
  closureFamily: ShearClosureFamily.HOOKED,
  hookPattern: ShearHookPattern.ALTERNATING,
  fabricationSequence: ShearFabricationSequence.UNSPECIFIED,
  finalHookAngleDeg: 135,
});

export const DEFAULT_REBAR_DETAILING_CHOICE = Object.freeze({
  profile: RebarDetailingChoiceProfile.SDV_APPENDIX_A_2010,
  columnHoop: freezeMemberChoice(DEFAULT_SHEAR_CHOICE),
  girderStirrup: freezeMemberChoice(DEFAULT_SHEAR_CHOICE),
  joint: Object.freeze({
    orthogonalBeamAssemblyOrder: OrthogonalBeamAssemblyOrder.EXPLICIT_REQUIRED,
    cornerAnchorageMethod: CornerJointAnchorageMethod.EXPLICIT_REQUIRED,
    cornerCongestionMethod: CornerJointCongestionMethod.STANDARD,
    hoopConstructionMethod: JointHoopConstructionMethod.EXPLICIT_REQUIRED,
  }),
  continuity: Object.freeze({
    columnCornerPriority: false,
    girderCornerPriority: false,
  }),
});

export const REBAR_DETAILING_CHOICE_UI_OPTIONS = Object.freeze({
  profile: Object.freeze([
    {
      value: RebarDetailingChoiceProfile.SDV_APPENDIX_A_2010,
      label: 'SDV標準納まり（配筋指針2010 付録A照合）',
      selectable: true,
    },
  ]),
  closureFamily: Object.freeze([
    {
      value: ShearClosureFamily.HOOKED,
      label: 'フック閉鎖',
      selectable: true,
      geometrySupported: true,
    },
    {
      value: ShearClosureFamily.WELDED_CLOSED,
      label: '溶接閉鎖',
      selectable: true,
      geometrySupported: true,
    },
    {
      value: ShearClosureFamily.SPIRAL,
      label: 'スパイラル',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: ShearClosureFamily.MECHANICAL_CLOSED,
      label: '機械式閉鎖',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: ShearClosureFamily.U_WITH_CAP,
      label: 'U字形＋キャップタイ',
      selectable: true,
      geometrySupported: false,
      memberTypes: ['beam'],
    },
  ]),
  hookPattern: Object.freeze([
    {
      value: ShearHookPattern.ALTERNATING,
      label: '交互',
      selectable: true,
      geometrySupported: true,
    },
    {
      value: ShearHookPattern.SINGLE_CORNER,
      label: '片隅',
      selectable: true,
      geometrySupported: false,
    },
  ]),
  fabricationSequence: Object.freeze([
    { value: ShearFabricationSequence.UNSPECIFIED, label: '未指定', selectable: true },
    { value: ShearFabricationSequence.PRE_BENT, label: 'フック先曲げ', selectable: true },
    { value: ShearFabricationSequence.POST_BENT, label: 'フック後曲げ', selectable: true },
  ]),
  cornerAnchorageMethod: Object.freeze([
    {
      value: CornerJointAnchorageMethod.EXPLICIT_REQUIRED,
      label: '図面指定必須（未指定）',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: CornerJointAnchorageMethod.ENCLOSING_ANCHORAGE,
      label: '抱え込み定着',
      selectable: true,
      geometrySupported: true,
    },
    {
      value: CornerJointAnchorageMethod.U_SHAPE_ANCHORAGE,
      label: 'U字形定着',
      selectable: true,
      geometrySupported: 'EXPLICIT',
    },
  ]),
  cornerCongestionMethod: Object.freeze([
    {
      value: CornerJointCongestionMethod.STANDARD,
      label: '標準納まり',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: CornerJointCongestionMethod.BEAM_PROJECTION,
      label: '梁突出し法',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: CornerJointCongestionMethod.BEAM_INNER_SETBACK,
      label: '梁内寄せ法',
      selectable: true,
      geometrySupported: false,
    },
  ]),
  hoopConstructionMethod: Object.freeze([
    {
      value: JointHoopConstructionMethod.EXPLICIT_REQUIRED,
      label: '施工方法指定必須（未指定）',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: JointHoopConstructionMethod.DROP_IN,
      label: '落とし込み',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: JointHoopConstructionMethod.IN_PLACE_ASSEMBLY,
      label: '現場組立',
      selectable: true,
      geometrySupported: false,
    },
    {
      value: JointHoopConstructionMethod.ACCORDION_DROP_IN,
      label: 'アコーディオン方式',
      selectable: true,
      geometrySupported: false,
    },
  ]),
  orthogonalBeamAssemblyOrder: Object.freeze([
    {
      value: OrthogonalBeamAssemblyOrder.EXPLICIT_REQUIRED,
      label: '図面指定必須（未指定）',
      selectable: true,
    },
    { value: OrthogonalBeamAssemblyOrder.X_THEN_Y, label: 'X方向梁 → Y方向梁', selectable: true },
    { value: OrthogonalBeamAssemblyOrder.Y_THEN_X, label: 'Y方向梁 → X方向梁', selectable: true },
  ]),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function oneOf(value, values) {
  return Object.values(values).includes(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProfile(value) {
  if (oneOf(value, RebarDetailingChoiceProfile)) return value;
  return LEGACY_REBAR_DETAILING_CHOICE_PROFILE_MAP[value] || value;
}

export function normalizeRebarDetailingChoice(choice) {
  const source = isPlainObject(choice) ? choice : {};
  return {
    profile: normalizeProfile(source.profile ?? DEFAULT_REBAR_DETAILING_CHOICE.profile),
    columnHoop: {
      ...clone(DEFAULT_REBAR_DETAILING_CHOICE.columnHoop),
      ...(isPlainObject(source.columnHoop) ? source.columnHoop : {}),
    },
    girderStirrup: {
      ...clone(DEFAULT_REBAR_DETAILING_CHOICE.girderStirrup),
      ...(isPlainObject(source.girderStirrup) ? source.girderStirrup : {}),
    },
    joint: {
      ...clone(DEFAULT_REBAR_DETAILING_CHOICE.joint),
      ...(isPlainObject(source.joint) ? source.joint : {}),
    },
    continuity: {
      ...clone(DEFAULT_REBAR_DETAILING_CHOICE.continuity),
      ...(isPlainObject(source.continuity) ? source.continuity : {}),
    },
  };
}

function validateMemberChoice(member, path, { allowUWithCap }, errors) {
  if (!isPlainObject(member)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!oneOf(member.closureFamily, ShearClosureFamily)) {
    errors.push(`${path}.closureFamily is unsupported: ${member.closureFamily}`);
  }
  if (!oneOf(member.hookPattern, ShearHookPattern)) {
    errors.push(`${path}.hookPattern is unsupported: ${member.hookPattern}`);
  }
  if (!oneOf(member.fabricationSequence, ShearFabricationSequence)) {
    errors.push(`${path}.fabricationSequence is unsupported: ${member.fabricationSequence}`);
  }
  if (!Number.isFinite(member.finalHookAngleDeg) || member.finalHookAngleDeg <= 0) {
    errors.push(`${path}.finalHookAngleDeg must be a positive number`);
  }
  if (
    member.closureFamily === ShearClosureFamily.HOOKED &&
    Number(member.finalHookAngleDeg) !== 135
  ) {
    errors.push(`${path}.finalHookAngleDeg must be 135 for the Appendix A 2010 profile`);
  }
  if (!allowUWithCap && member.closureFamily === ShearClosureFamily.U_WITH_CAP) {
    errors.push(`${path}.closureFamily U_WITH_CAP is beam-only`);
  }
}

export function validateRebarDetailingChoice(choice) {
  const errors = [];
  if (!isPlainObject(choice))
    return { valid: false, errors: ['detailing.choice must be an object'] };

  const normalizedProfile = normalizeProfile(choice.profile);
  if (!oneOf(normalizedProfile, RebarDetailingChoiceProfile)) {
    errors.push(`detailing.choice.profile is unsupported: ${choice.profile}`);
  }
  validateMemberChoice(
    choice.columnHoop,
    'detailing.choice.columnHoop',
    { allowUWithCap: false },
    errors,
  );
  validateMemberChoice(
    choice.girderStirrup,
    'detailing.choice.girderStirrup',
    { allowUWithCap: true },
    errors,
  );

  if (!isPlainObject(choice.joint)) {
    errors.push('detailing.choice.joint must be an object');
  } else {
    if (!oneOf(choice.joint.orthogonalBeamAssemblyOrder, OrthogonalBeamAssemblyOrder)) {
      errors.push(
        `detailing.choice.joint.orthogonalBeamAssemblyOrder is unsupported: ${choice.joint.orthogonalBeamAssemblyOrder}`,
      );
    }
    if (!oneOf(choice.joint.cornerAnchorageMethod, CornerJointAnchorageMethod)) {
      errors.push(
        `detailing.choice.joint.cornerAnchorageMethod is unsupported: ${choice.joint.cornerAnchorageMethod}`,
      );
    }
    if (!oneOf(choice.joint.cornerCongestionMethod, CornerJointCongestionMethod)) {
      errors.push(
        `detailing.choice.joint.cornerCongestionMethod is unsupported: ${choice.joint.cornerCongestionMethod}`,
      );
    }
    if (!oneOf(choice.joint.hoopConstructionMethod, JointHoopConstructionMethod)) {
      errors.push(
        `detailing.choice.joint.hoopConstructionMethod is unsupported: ${choice.joint.hoopConstructionMethod}`,
      );
    }
  }

  if (!isPlainObject(choice.continuity)) {
    errors.push('detailing.choice.continuity must be an object');
  } else {
    if (typeof choice.continuity.columnCornerPriority !== 'boolean') {
      errors.push('detailing.choice.continuity.columnCornerPriority must be a boolean');
    }
    if (typeof choice.continuity.girderCornerPriority !== 'boolean') {
      errors.push('detailing.choice.continuity.girderCornerPriority must be a boolean');
    }
  }

  return { valid: errors.length === 0, errors };
}

function memberChoiceFor(choice, memberType) {
  const normalized = normalizeRebarDetailingChoice(choice);
  return memberType === 'column' ? normalized.columnHoop : normalized.girderStirrup;
}

function defaultMemberChoice(memberType) {
  return memberType === 'column'
    ? DEFAULT_REBAR_DETAILING_CHOICE.columnHoop
    : DEFAULT_REBAR_DETAILING_CHOICE.girderStirrup;
}

function sameChoice(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 現行R11 geometryへ接続可能な選択肢だけを解決する。
 * 未実装の形状は推定せず supported=false として返す。
 */
export function resolveShearRebarChoiceForMember(choice, memberType = 'beam') {
  const normalizedMemberType = memberType === 'column' ? 'column' : 'beam';
  const memberChoice = memberChoiceFor(choice, normalizedMemberType);
  const source = sameChoice(memberChoice, defaultMemberChoice(normalizedMemberType))
    ? 'nikkenren-jsca-default'
    : 'project-config';

  if (memberChoice.closureFamily === ShearClosureFamily.WELDED_CLOSED) {
    return {
      supported: true,
      reason: null,
      source,
      memberType: normalizedMemberType,
      choice: memberChoice,
      geometry: { closureType: 'WELDED', hookAngleDeg: null },
    };
  }

  if (memberChoice.closureFamily !== ShearClosureFamily.HOOKED) {
    return {
      supported: false,
      reason: `detailing-choice-geometry-not-implemented:${memberChoice.closureFamily}`,
      source,
      memberType: normalizedMemberType,
      choice: memberChoice,
      geometry: null,
    };
  }

  if (memberChoice.hookPattern !== ShearHookPattern.ALTERNATING) {
    return {
      supported: false,
      reason: `detailing-choice-hook-pattern-not-implemented:${memberChoice.hookPattern}`,
      source,
      memberType: normalizedMemberType,
      choice: memberChoice,
      geometry: null,
    };
  }

  return {
    supported: true,
    reason: null,
    source,
    memberType: normalizedMemberType,
    choice: memberChoice,
    geometry: { closureType: 'HOOK', hookAngleDeg: memberChoice.finalHookAngleDeg },
  };
}

export function resolveRebarDetailingChoiceControlState(choice, memberType = 'beam') {
  const memberChoice = memberChoiceFor(choice, memberType);
  const hooked = memberChoice.closureFamily === ShearClosureFamily.HOOKED;
  return {
    hookPatternDisabled: !hooked,
    fabricationSequenceDisabled: !hooked,
    finalHookAngleDeg: hooked ? memberChoice.finalHookAngleDeg : null,
    geometrySupport: resolveShearRebarChoiceForMember(choice, memberType),
  };
}

/**
 * A3幅判定のテーブルlookupに必要な意味軸だけを返す。
 * 表番号・必要幅そのものは後続validatorで与え、ここでは推定しない。
 */
export function buildAppendixAWidthSelector(choice, memberType = 'beam') {
  const memberChoice = memberChoiceFor(choice, memberType);
  return Object.freeze({
    memberType: memberType === 'column' ? 'COLUMN' : 'BEAM',
    closureFamily: memberChoice.closureFamily,
    hookPattern:
      memberChoice.closureFamily === ShearClosureFamily.HOOKED ? memberChoice.hookPattern : null,
    fabricationSequence:
      memberChoice.closureFamily === ShearClosureFamily.HOOKED
        ? memberChoice.fabricationSequence
        : null,
    finalHookAngleDeg:
      memberChoice.closureFamily === ShearClosureFamily.HOOKED
        ? memberChoice.finalHookAngleDeg
        : null,
  });
}
