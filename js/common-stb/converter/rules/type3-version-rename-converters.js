/**
 * Attribute and enum renames between STB v2.1.0 and v2.1.1.
 */

import logger from '../utils/converter-logger.js';

/**
 * Attribute rename map: v2.1.0 -> v2.1.1 (typo fixes)
 * Each entry: { element: string, old: string, new: string }
 */
const ATTR_RENAME_210_TO_211 = [
  // stiffner -> stiffener
  {
    element: 'StbConnectionSpecStiffener',
    old: 'stiffner_size_up_connected',
    new: 'stiffener_size_up_connected',
  },
  {
    element: 'StbConnectionSpecStiffener',
    old: 'stiffner_size_up_connecting',
    new: 'stiffener_size_up_connecting',
  },
  { element: 'StbConnectionStiffener', old: 'id_stiffner', new: 'id_stiffener' },
  { element: 'StbStiffener', old: 'kind_section_stiffner', new: 'kind_section_stiffener' },
  { element: 'StbStiffener', old: 'id_section_stiffner', new: 'id_section_stiffener' },
  // refactory -> refractory
  { element: null, old: 'D_refactory_bar', new: 'D_refractory_bar' },
  { element: null, old: 'strength_refactory_bar', new: 'strength_refractory_bar' },
  // pile band -> pile head
  { element: null, old: 'D_pile_band', new: 'D_pile_head' },
  { element: null, old: 'N_pile_band', new: 'N_pile_head' },
  // shape_plate_start -> shape_plate_bearingside
  { element: null, old: 'shape_plate_start', new: 'shape_plate_bearingside' },
  // bavel -> bevel
  { element: null, old: 'shape_bavel', new: 'shape_bevel' },
  { element: null, old: 'sid_bavel1', new: 'side_bevel1' },
  { element: null, old: 'sid_bavel2', new: 'side_bevel2' },
  // heigth -> height
  { element: null, old: 'steel_switch_heigth_top', new: 'steel_switch_height_top' },
];

const ATTR_RENAME_211_TO_210 = ATTR_RENAME_210_TO_211.map(({ element, old: o, new: n }) => ({
  element,
  old: n,
  new: o,
}));

/**
 * Enum value rename map: v2.1.0 -> v2.1.1
 */
const ENUM_RENAME_210_TO_211 = {
  THROUGE_BOLT: 'THROUGH_BOLT',
  ASSYMMETRICAL: 'ASYMMETRICAL',
};

const ENUM_RENAME_211_TO_210 = Object.fromEntries(
  Object.entries(ENUM_RENAME_210_TO_211).map(([k, v]) => [v, k]),
);

/**
 * Element+attribute-scoped enum value changes: v2.1.0 -> v2.1.1.
 * Numeric values must not be replaced globally (would corrupt dimension values),
 * so these are applied only on the named element/attribute pair.
 */
const SCOPED_VALUE_RENAME_210_TO_211 = [
  { element: 'StbSecBaseProduct', attr: 'direction_type', from: '280', to: '270' },
];

const SCOPED_VALUE_RENAME_211_TO_210 = SCOPED_VALUE_RENAME_210_TO_211.map(
  ({ element, attr, from, to }) => ({ element, attr, from: to, to: from }),
);

/**
 * Walk the XML tree renaming attributes and enum values.
 * @param {object} node - Current node
 * @param {Array} attrRenames - Array of { element, old, new }
 * @param {object} enumRenames - Map of old enum -> new enum
 * @param {Array} scopedValueRenames - Array of { element, attr, from, to }
 * @returns {number} Total renames performed
 */
function walkAndRenameAttributes(node, attrRenames, enumRenames, scopedValueRenames = []) {
  if (!node || typeof node !== 'object') return 0;
  let count = 0;

  const nodeName = node._elementName || null;

  if (node.$) {
    const attrs = node.$;
    for (const rename of attrRenames) {
      if (rename.element && rename.element !== nodeName) continue;
      if (Object.prototype.hasOwnProperty.call(attrs, rename.old)) {
        attrs[rename.new] = attrs[rename.old];
        delete attrs[rename.old];
        count++;
      }
    }
    // Rename enum values in all string attributes
    for (const [attrKey, attrVal] of Object.entries(attrs)) {
      if (typeof attrVal === 'string' && enumRenames[attrVal]) {
        attrs[attrKey] = enumRenames[attrVal];
        count++;
      }
    }
    // Element+attribute-scoped value changes (e.g. direction_type 280 -> 270)
    for (const { element, attr, from, to } of scopedValueRenames) {
      if (element !== nodeName) continue;
      if (attrs[attr] === from) {
        attrs[attr] = to;
        count++;
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === '$' || key === '_' || key === '_elementName') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((item) => {
        if (item && typeof item === 'object') {
          item._elementName = key;
          count += walkAndRenameAttributes(item, attrRenames, enumRenames, scopedValueRenames);
          delete item._elementName;
        }
      });
    } else if (child && typeof child === 'object') {
      child._elementName = key;
      count += walkAndRenameAttributes(child, attrRenames, enumRenames, scopedValueRenames);
      delete child._elementName;
    }
  }

  return count;
}

/**
 * Apply attribute and enum renames from v2.1.0 to v2.1.1
 * @param {object} stbRoot - ST-Bridge root element
 */
export function applyAttributeRenamesTo211(stbRoot) {
  const count = walkAndRenameAttributes(
    stbRoot,
    ATTR_RENAME_210_TO_211,
    ENUM_RENAME_210_TO_211,
    SCOPED_VALUE_RENAME_210_TO_211,
  );
  if (count > 0) {
    logger.info(`Attribute renaming (2.1.0->2.1.1) complete: ${count} renames`);
  }
}

/**
 * Apply attribute and enum renames from v2.1.1 to v2.1.0
 * @param {object} stbRoot - ST-Bridge root element
 */
export function applyAttributeRenamesTo210from211(stbRoot) {
  const count = walkAndRenameAttributes(
    stbRoot,
    ATTR_RENAME_211_TO_210,
    ENUM_RENAME_211_TO_210,
    SCOPED_VALUE_RENAME_211_TO_210,
  );
  if (count > 0) {
    logger.info(`Attribute renaming (2.1.1->2.1.0) complete: ${count} renames`);
  }
}
