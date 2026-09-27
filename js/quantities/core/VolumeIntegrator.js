/**
 * @fileoverview Three.js 非依存の体積積分 helper。
 */

function requireFiniteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return number;
}

function requirePositiveLength(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError('lengthMm must be a finite positive number');
  }
  return number;
}

/**
 * 一様断面の体積 V=A*L。
 *
 * @param {number} areaMm2
 * @param {number} lengthMm
 * @returns {number}
 */
export function calculatePrismaticVolume(areaMm2, lengthMm) {
  return requireFiniteNonNegative(areaMm2, 'areaMm2') * requirePositiveLength(lengthMm);
}

/**
 * Prismoidal rule / Simpson 1区間。
 * V=L/6*(A0+4Am+A1)
 *
 * @param {number} startAreaMm2
 * @param {number} midAreaMm2
 * @param {number} endAreaMm2
 * @param {number} lengthMm
 * @returns {number}
 */
export function calculatePrismoidalVolume(startAreaMm2, midAreaMm2, endAreaMm2, lengthMm) {
  const a0 = requireFiniteNonNegative(startAreaMm2, 'startAreaMm2');
  const am = requireFiniteNonNegative(midAreaMm2, 'midAreaMm2');
  const a1 = requireFiniteNonNegative(endAreaMm2, 'endAreaMm2');
  const length = requirePositiveLength(lengthMm);

  return (length / 6) * (a0 + 4 * am + a1);
}

/**
 * 面積評価関数を composite Simpson rule で積分する。
 * 将来のテーパー・多断面 quantity calculator から使用する。
 *
 * @param {(positionMm:number, ratio:number)=>number} areaAt
 * @param {number} lengthMm
 * @param {Object} [options]
 * @param {number} [options.segments=32] 偶数であること
 * @returns {number}
 */
export function integrateSectionArea(areaAt, lengthMm, { segments = 32 } = {}) {
  if (typeof areaAt !== 'function') {
    throw new TypeError('areaAt must be a function');
  }
  const length = requirePositiveLength(lengthMm);
  if (!Number.isInteger(segments) || segments < 2 || segments % 2 !== 0) {
    throw new RangeError('segments must be an even integer >= 2');
  }

  const step = length / segments;
  let weightedArea = 0;

  for (let i = 0; i <= segments; i++) {
    const position = i * step;
    const ratio = position / length;
    const area = requireFiniteNonNegative(areaAt(position, ratio), `areaAt(${position})`);
    const weight = i === 0 || i === segments ? 1 : i % 2 === 0 ? 2 : 4;
    weightedArea += weight * area;
  }

  return (step / 3) * weightedArea;
}
