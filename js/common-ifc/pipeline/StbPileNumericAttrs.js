/**
 * Serialize only measured ST-Bridge 2.1 pile numbers. The schema uses xs:double
 * for locations/offsets and stb:length (> 0) for pile lengths. In particular,
 * null, blank and non-finite values must never be converted to a fake zero.
 * Preserve precision instead of passing tiny measured values through fmtNumber.
 */
const XML_DOUBLE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function serializePileNumericAttr(value, attribute, positiveLength = false) {
  if (value === undefined) return '';
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`StbPile: invalid measured ${attribute}`);
  }
  const numericText = String(value).trim();
  const parsed = Number(numericText);
  if (
    !XML_DOUBLE.test(numericText) ||
    !Number.isFinite(parsed) ||
    (positiveLength && parsed <= 0)
  ) {
    throw new Error(`StbPile: invalid measured ${attribute}`);
  }
  return ` ${attribute}="${numericText}"`;
}
