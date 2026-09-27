import { validateContinuousMainType } from './stripFootingMainSwitch.js';

const EPS = 1e-6;
export const MAIN_SWITCH_FACES = Object.freeze(['TOP', 'BOTTOM']);
export const SWITCH_LEGACY_CODES = Object.freeze(
  new Set(['STRIP_FOOTING_BAR_SET_UNSUPPORTED', 'STRIP_FOOTING_MAIN_SWITCH_UNSUPPORTED']),
);

function continuousBar(section, position) {
  return section?.bars?.find((bar) => bar.pos === position) || null;
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= EPS;
}

function explicitPairValue(values, kind) {
  const present = values.filter((value) =>
    kind === 'number' ? Number.isFinite(value) : value != null && value !== '',
  );
  if (!present.length) return { status: 'MISSING', value: null };
  const first = present[0];
  const conflict = present.some((value) =>
    kind === 'number' ? !nearlyEqual(value, first) : String(value) !== String(first),
  );
  return conflict
    ? { status: 'CONFLICT', value: null, values: present }
    : { status: 'READY', value: first };
}

export function hasMainSwitchIntent(section) {
  return Boolean(
    section?.bars?.some(
      (bar) =>
        bar.pos?.startsWith('MAIN_TIP_') || Number.isFinite(bar.lengthMm) || Boolean(bar.mainType),
    ),
  );
}

export function resolveFaceSwitch(section, face) {
  const basePosition = `MAIN_BASE_${face}`;
  const tipPosition = `MAIN_TIP_${face}`;
  const baseBar = continuousBar(section, basePosition);
  const tipBar = continuousBar(section, tipPosition);
  const hasAttributes = [baseBar, tipBar].some(
    (bar) => bar && (Number.isFinite(bar.lengthMm) || bar.mainType),
  );

  if (!tipBar && !hasAttributes) return { status: 'NONE', face };
  if (!baseBar || !tipBar) {
    return {
      status: 'UNRESOLVED',
      reason: 'MAIN_SWITCH_PAIR_INCOMPLETE',
      face,
      basePosition,
      tipPosition,
    };
  }
  if (section.shape?.type !== 'REVERSE_T') {
    return {
      status: 'UNRESOLVED',
      reason: 'MAIN_SWITCH_SHAPE_UNSUPPORTED',
      face,
      shapeType: section.shape?.type || null,
    };
  }

  const length = explicitPairValue([baseBar.lengthMm, tipBar.lengthMm], 'number');
  if (length.status === 'MISSING') {
    return { status: 'UNRESOLVED', reason: 'MAIN_SWITCH_LENGTH_DEFAULT_UNRESOLVED', face };
  }
  if (length.status === 'CONFLICT') {
    return {
      status: 'UNRESOLVED',
      reason: 'MAIN_SWITCH_LENGTH_CONFLICT',
      face,
      values: length.values,
    };
  }

  const mainType = explicitPairValue([baseBar.mainType, tipBar.mainType], 'string');
  if (mainType.status === 'MISSING') {
    return { status: 'UNRESOLVED', reason: 'MAIN_SWITCH_TYPE_UNRESOLVED', face };
  }
  if (mainType.status === 'CONFLICT') {
    return {
      status: 'UNRESOLVED',
      reason: 'MAIN_SWITCH_TYPE_CONFLICT',
      face,
      values: mainType.values,
    };
  }

  for (const position of [basePosition, tipPosition]) {
    const validated = validateContinuousMainType({
      shapeType: section.shape.type,
      position,
      mainType: mainType.value,
      hasSwitch: true,
    });
    if (validated.status !== 'READY') {
      return {
        status: 'UNRESOLVED',
        reason: validated.reason || 'MAIN_SWITCH_TYPE_UNRESOLVED',
        face,
        mainType: mainType.value,
      };
    }
  }

  return {
    status: 'READY',
    face,
    basePosition,
    tipPosition,
    baseBar,
    tipBar,
    lengthMm: length.value,
    mainType: String(mainType.value).toUpperCase(),
  };
}

export function validateNonMainSwitchAttributes(section) {
  for (const bar of section?.bars || []) {
    if (bar.pos?.startsWith('MAIN_')) continue;
    if (Number.isFinite(bar.lengthMm)) {
      return {
        status: 'UNRESOLVED',
        reason: 'SWITCH_LENGTH_NOT_ALLOWED_FOR_NON_MAIN',
        position: bar.pos,
      };
    }
    if (!bar.mainType) continue;
    const validated = validateContinuousMainType({
      shapeType: section.shape?.type,
      position: bar.pos,
      mainType: bar.mainType,
      hasSwitch: true,
    });
    if (validated.status !== 'READY') {
      return {
        status: 'UNRESOLVED',
        reason: validated.reason || 'MAIN_TYPE_NOT_ALLOWED_FOR_NON_MAIN',
        position: bar.pos,
      };
    }
  }
  return { status: 'READY' };
}
