/**
 * #565: Project-level DXF layer settings (layer name, AutoCAD color index, line type).
 *
 * Settings are keyed by the RenderPlan layer id (the member type or annotation role, e.g.
 * `Column`, `Girder`, `Axis`). They only change how a sheet DXF names and styles its layers;
 * geometry, SVG and PDF are untouched. A project without settings produces the same DXF
 * as before, so the optional `dxfLayerSettings` project field is backward compatible.
 */

export const DXF_LAYER_LINE_TYPES = Object.freeze({
  CONTINUOUS: Object.freeze({ label: '実線', pattern: null }),
  DASHED: Object.freeze({ label: '破線', pattern: Object.freeze([6, -3]) }),
  HIDDEN: Object.freeze({ label: '隠れ線', pattern: Object.freeze([3, -1.5]) }),
  CENTER: Object.freeze({ label: '一点鎖線', pattern: Object.freeze([12, -2, 2, -2]) }),
  DOT: Object.freeze({ label: '点線', pattern: Object.freeze([0.5, -2]) }),
});

const LAYER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
// R12 layer names: up to 31 of letters, digits, `$`, `-` and `_`.
const LAYER_NAME = /^[A-Za-z0-9$_-]{1,31}$/;
const KEYS = ['layerId', 'name', 'colorIndex', 'lineType'];
/** Prefix of the LTYPE definitions this module adds, kept apart from per-view dash names. */
const LINE_TYPE_PREFIX = 'SDV_LT_';

function invalid(path, message) {
  const error = new Error(`DrawingProject schema error at ${path}: ${message}`);
  error.code = 'INVALID_DXF_LAYER_SETTINGS';
  error.path = path;
  throw error;
}

/**
 * Returns undefined when absent (or empty), so projects without settings round-trip unchanged.
 * Entries keep their order; layer ids and output names must each be unique.
 */
export function normalizeDxfLayerSettings(value, path = 'dxfLayerSettings') {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(path, 'array required');
  const ids = new Set();
  const names = new Set();
  const result = value.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(at, 'object required');
    for (const key of Object.keys(entry))
      if (!KEYS.includes(key)) invalid(`${at}.${key}`, 'unknown field');
    if (typeof entry.layerId !== 'string' || !LAYER_ID.test(entry.layerId))
      invalid(`${at}.layerId`, 'RenderPlan layer id required');
    if (ids.has(entry.layerId)) invalid(`${at}.layerId`, 'duplicate layer id: ' + entry.layerId);
    ids.add(entry.layerId);
    const next = { layerId: entry.layerId };
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string' || !LAYER_NAME.test(entry.name))
        invalid(`${at}.name`, 'up to 31 of A-Z, a-z, 0-9, $, - and _ required');
      const key = entry.name.toUpperCase();
      if (names.has(key)) invalid(`${at}.name`, 'duplicate layer name: ' + entry.name);
      names.add(key);
      next.name = entry.name;
    }
    if (entry.colorIndex !== undefined) {
      if (!Number.isInteger(entry.colorIndex) || entry.colorIndex < 1 || entry.colorIndex > 255)
        invalid(`${at}.colorIndex`, 'AutoCAD color index 1-255 required');
      next.colorIndex = entry.colorIndex;
    }
    if (entry.lineType !== undefined) {
      if (!Object.hasOwn(DXF_LAYER_LINE_TYPES, entry.lineType))
        invalid(`${at}.lineType`, 'one of ' + Object.keys(DXF_LAYER_LINE_TYPES).join(', '));
      next.lineType = entry.lineType;
    }
    if (Object.keys(next).length === 1) invalid(at, 'name, colorIndex or lineType required');
    return next;
  });
  return result.length ? result : undefined;
}

function lineTypeName(lineType) {
  return lineType === 'CONTINUOUS' ? 'CONTINUOUS' : LINE_TYPE_PREFIX + lineType;
}

/**
 * Rename and restyle the layers of one sheet DXF.
 * `layerIds` are the RenderPlan layer ids actually used by the sheet. Returns the layer table
 * entries, the id => output-name map to apply to every entity, and the LTYPE definitions the
 * chosen line types need. Fails closed if two different layers would end up with one name.
 */
export function resolveDxfLayerTable({ layerIds, settings = [], defaultColor = () => undefined }) {
  const byId = new Map(settings.map((entry) => [entry.layerId, entry]));
  const nameOf = new Map();
  const owner = new Map();
  const layers = [];
  const usedLineTypes = new Set();
  for (const layerId of layerIds) {
    const setting = byId.get(layerId);
    const name = setting?.name ?? layerId;
    const key = name.toUpperCase();
    if (owner.has(key) && owner.get(key) !== layerId)
      throw new Error(`DXFレイヤー名が重複します: ${name} (${owner.get(key)} / ${layerId})`);
    owner.set(key, layerId);
    nameOf.set(layerId, name);
    const colorIndex = setting?.colorIndex ?? defaultColor(layerId);
    const lineType = setting?.lineType ?? 'CONTINUOUS';
    if (lineType !== 'CONTINUOUS') usedLineTypes.add(lineType);
    layers.push({
      name,
      ...(colorIndex === undefined ? {} : { colorIndex }),
      lineType: lineTypeName(lineType),
    });
  }
  const lineTypes = [...usedLineTypes].map((lineType) => ({
    name: lineTypeName(lineType),
    description: DXF_LAYER_LINE_TYPES[lineType].label,
    pattern: [...DXF_LAYER_LINE_TYPES[lineType].pattern],
  }));
  return { layers, nameOf, lineTypes };
}
