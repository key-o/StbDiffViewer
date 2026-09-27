/**
 * @fileoverview R12 小梁で断面の材軸回り回転を扱うための共通判定。
 *
 * R12-N/Oのavailability計算は平面geometryと鉛直clear zoneを前提とする。
 * viewer側はrotate/angleを断面の材軸回り回転として適用するため、同じ変換を
 * availabilityへ実装するまでは、回転した小梁をR12のproduction候補へ進めない。
 */

export const SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON =
  'small-beam-rotated-section-r12-unsupported';

const ROTATION_TOLERANCE_DEG = 1e-6;

function field(element, name) {
  if (element && typeof element.hasAttribute === 'function') {
    if (element.hasAttribute(name)) {
      return { present: true, value: element.getAttribute(name), source: 'attribute' };
    }
  } else {
    const attribute = element?.getAttribute?.(name);
    if (attribute !== null && attribute !== undefined) {
      return { present: true, value: attribute, source: 'attribute' };
    }
  }
  if (element && Object.prototype.hasOwnProperty.call(element, name)) {
    return { present: true, value: element[name], source: 'property' };
  }
  return { present: false, value: null, source: null };
}

/**
 * STBのrotateを優先し、後方互換としてangleを読む。
 * フィールド自体が無い場合だけ0°とし、空白・非数値を含め、存在する不正値はnullを返す。
 */
export function resolveSmallBeamSectionRollDegrees(element) {
  const rotate = field(element, 'rotate');
  const angle = field(element, 'angle');
  const selected = rotate.present ? rotate : angle;
  if (!selected.present) return 0;
  if (
    selected.value === null ||
    selected.value === undefined ||
    String(selected.value).trim() === ''
  ) {
    return null;
  }
  const degrees = Number(selected.value);
  return Number.isFinite(degrees) ? degrees : null;
}

/**
 * R12 availabilityで未対応の断面回転があるかを判定する。
 * 360°の整数倍は実質的に無回転として許容する。
 * rotate/angleが存在するのに解釈できない場合はfail-closedとする。
 */
export function hasUnsupportedSmallBeamSectionRotation(element) {
  const resolvedDegrees = resolveSmallBeamSectionRollDegrees(element);
  if (!Number.isFinite(resolvedDegrees)) return true;
  const degrees = Math.abs(resolvedDegrees % 360);
  const distanceFromZero = Math.min(degrees, 360 - degrees);
  return distanceFromZero > ROTATION_TOLERANCE_DEG;
}
