/** STB steel fabrication data, checked against the independently read IFC profile. */
const PREFIX = 'STBSTEEL_META:';
const TAGS = new Set([
  'StbSecRoll-H',
  'StbSecBuild-H',
  'StbSecRoll-BOX',
  'StbSecBuild-BOX',
  'StbSecRoll-C',
  'StbSecRoll-L',
]);
const NUMERIC = ['A', 'B', 't', 't1', 't2', 'r', 'r1', 'r2'];

export function encodeSteelProfileMetadata(source, type, p) {
  if (!source || !TAGS.has(source.elementTag)) return null;
  const dimensions =
    type === 'H'
      ? { A: p.overallDepth, B: p.overallWidth, t1: p.webThickness, t2: p.flangeThickness }
      : type === 'BOX'
        ? { A: p.height, B: p.width, t: p.wallThickness }
        : type === 'C'
          ? { A: p.depth, B: p.flangeWidth, t1: p.webThickness, t2: p.flangeThickness }
          : type === 'L'
            ? { A: p.depth, B: p.width, t1: p.thickness, t2: p.thickness }
            : null;
  if (!dimensions || !Object.values(dimensions).every((v) => Number.isFinite(v) && v > 0))
    return null;
  const attrs = {};
  for (const key of NUMERIC) if (Number.isFinite(source[key])) attrs[key] = source[key];
  if (source.shapeTypeAttr) attrs.type = source.shapeTypeAttr;
  const encoded =
    PREFIX + JSON.stringify({ tag: source.elementTag, name: source.name, attrs, type, dimensions });
  // IfcProfileDef.ProfileName is an IfcLabel (255 characters).
  return encoded.length <= 255 ? encoded : null;
}

export function decodeSteelProfileMetadata(name, measured) {
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return null;
  try {
    const data = JSON.parse(name.slice(PREFIX.length));
    if (
      !TAGS.has(data?.tag) ||
      !data.tag.endsWith(`-${data.type}`) ||
      typeof data.name !== 'string' ||
      !data.name.trim() ||
      data.type !== measured?.stbType
    )
      return null;
    const keys = ['H', 'C', 'L'].includes(data.type) ? ['A', 'B', 't1', 't2'] : ['A', 'B', 't'];
    if (
      !keys.every(
        (key) =>
          Number.isFinite(data.dimensions?.[key]) &&
          data.dimensions[key] > 0 &&
          Math.abs(data.dimensions[key] - measured.params[key]) < 0.001,
      )
    )
      return null;
    if (
      !data.attrs ||
      Object.entries(data.attrs).some(([key, value]) =>
        key === 'type'
          ? typeof value !== 'string'
          : !NUMERIC.includes(key) || !Number.isFinite(value),
      )
    )
      return null;
    const sourceDimensions = { ...data.attrs };
    if (data.tag === 'StbSecBuild-BOX') sourceDimensions.t = Math.max(data.attrs.t1, data.attrs.t2);
    if (
      !keys.every(
        (key) =>
          Number.isFinite(sourceDimensions[key]) &&
          Math.abs(sourceDimensions[key] - measured.params[key]) < 0.001,
      )
    )
      return null;
    for (const radius of ['r', 'r1', 'r2']) {
      const actual = measured.params[radius];
      const original = data.attrs[radius];
      if (
        actual != null &&
        original != null &&
        (!Number.isFinite(actual) || Math.abs(actual - original) >= 0.001)
      )
        return null;
    }
    return { tag: data.tag, name: data.name, attrs: data.attrs };
  } catch {
    return null;
  }
}
