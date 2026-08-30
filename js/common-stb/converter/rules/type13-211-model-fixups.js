/**
 * Model-wide schema compliance and canonicalization fixups for STB v2.1.1.
 */

import logger from '../utils/converter-logger.js';
import { getStbRoot } from '../utils/xml-helper.js';
import { STB_TAG_NAMES } from '../../../constants/elementTypes.js';

export function fixEmptyBooleanAttrs(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const members = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0];
  if (!members) return;

  let count = 0;
  const REQUIRED_BOOL_DEFAULT = { isFoundation: 'false' };
  const OPTIONAL_BOOL_ATTRS = ['isOffset', 'isHingeStart', 'isHingeEnd', 'isCanti'];
  const MEMBER_TYPES = [
    [STB_TAG_NAMES.GIRDERS, STB_TAG_NAMES.GIRDER],
    [STB_TAG_NAMES.BEAMS, STB_TAG_NAMES.BEAM],
    [STB_TAG_NAMES.COLUMNS, STB_TAG_NAMES.COLUMN],
    [STB_TAG_NAMES.POSTS, STB_TAG_NAMES.POST],
    [STB_TAG_NAMES.BRACES, STB_TAG_NAMES.BRACE],
    [STB_TAG_NAMES.SLABS, STB_TAG_NAMES.SLAB],
    [STB_TAG_NAMES.WALLS, STB_TAG_NAMES.WALL],
  ];

  MEMBER_TYPES.forEach(([coll, elem]) => {
    const elements = members[coll]?.[0]?.[elem] || [];
    elements.forEach((el) => {
      const attrs = el['$'];
      if (!attrs) return;
      for (const [attr, def] of Object.entries(REQUIRED_BOOL_DEFAULT)) {
        if (attrs[attr] === '') {
          attrs[attr] = def;
          count++;
        }
      }
      OPTIONAL_BOOL_ATTRS.forEach((attr) => {
        if (attrs[attr] === '') {
          delete attrs[attr];
          count++;
        }
      });
    });
  });

  if (count > 0) logger.info(`Fixed ${count} empty boolean attributes`);
}

export function fixJointArrangementDistance(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;

  function walkJoints(node) {
    if (!node || typeof node !== 'object') return 0;
    let count = 0;
    if (node['StbJointArrangement']) {
      node['StbJointArrangement'].forEach((ja) => {
        const attrs = ja['$'];
        if (!attrs) return;
        const v = parseFloat(attrs.distance);
        if (!isNaN(v) && v <= 0) {
          attrs.distance = '1';
          count++;
        }
      });
    }
    for (const k of Object.keys(node)) {
      if (k === '$') continue;
      const child = node[k];
      if (Array.isArray(child))
        child.forEach((c) => {
          count += walkJoints(c);
        });
      else if (child && typeof child === 'object') count += walkJoints(child);
    }
    return count;
  }

  const count = walkJoints(stbRoot);
  if (count > 0) logger.info(`Fixed ${count} StbJointArrangement.distance zero values`);
}

const FOUNDATION_COLUMN_OPTIONAL_ID_ATTRS = ['id_section_WR', 'id_section_FD'];

export function fixFoundationColumnZeroIds(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const cols =
    rootData?.['StbModel']?.[0]?.['StbMembers']?.[0]?.['StbFoundationColumns']?.[0]?.[
      'StbFoundationColumn'
    ];
  if (!Array.isArray(cols)) return;

  let count = 0;
  cols.forEach((col) => {
    const attrs = col['$'];
    if (!attrs) return;
    FOUNDATION_COLUMN_OPTIONAL_ID_ATTRS.forEach((attr) => {
      if (attrs[attr] === '0') {
        delete attrs[attr];
        count++;
      }
    });
  });
  if (count > 0) logger.info(`Removed ${count} StbFoundationColumn id_section_*="0" attributes`);
}

const GUID_RE = /^[0-9a-f]{32}$/;

export function fixInvalidGuids(stbRoot) {
  let normalized = 0;
  let removed = 0;

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const attrs = node['$'];
    if (attrs && attrs.guid !== undefined) {
      const candidate = String(attrs.guid).replace(/-/g, '').toLowerCase();
      if (GUID_RE.test(candidate)) {
        if (candidate !== attrs.guid) {
          attrs.guid = candidate;
          normalized++;
        }
      } else {
        delete attrs.guid;
        removed++;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === '$' || key === '_') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  };
  walk(stbRoot);

  if (normalized > 0 || removed > 0) {
    logger.warn(`guid fixup: ${normalized} normalized, ${removed} removed (invalid format)`);
  }
}

const MEMBERS_ORDER_21X = [
  'StbColumns',
  'StbPosts',
  'StbGirders',
  'StbBeams',
  'StbBraces',
  'StbSlabs',
  'StbWalls',
  'StbIsolatingDevices',
  'StbDampingDevices',
  'StbFrameDampingDevices',
  'StbFootings',
  'StbStripFootings',
  'StbPiles',
  'StbFoundationColumns',
  'StbParapets',
  'StbOpenArrangements',
  'StbPenetrationArrangements',
  'StbJointArrangements',
  'StbPanelZoneArrangements',
  'StbConnectionArrangements',
];

const SECTIONS_ORDER_21X = [
  'StbSecColumn_RC',
  'StbSecColumn_S',
  'StbSecColumn_SRC',
  'StbSecColumn_CFT',
  'StbSecBeam_RC',
  'StbSecBeam_S',
  'StbSecBeam_SRC',
  'StbSecBrace_S',
  'StbSecSlab_RC',
  'StbSecSlabDeck',
  'StbSecSlabPrecast',
  'StbSecSlabLoad',
  'StbSecWall_RC',
  'StbSecWallLoad',
  'StbSecIsolatingDevice',
  'StbSecDampingDevice',
  'StbSecFoundation_RC',
  'StbSecPile_RC',
  'StbSecPile_S',
  'StbSecPilePrecast',
  'StbSecParapet_RC',
  'StbSecOpen_RC',
  'StbSecPenetration_S',
  'StbSecPanelZone',
  'StbSecSteel',
  'StbSecUndefined',
];

function reorderChildren(container, canonicalOrder) {
  if (!container) return 0;
  const present = canonicalOrder.filter((k) => container[k] !== undefined);
  const current = Object.keys(container).filter((k) => present.includes(k));
  if (current.every((k, i) => k === present[i])) return 0;

  const saved = {};
  present.forEach((k) => {
    saved[k] = container[k];
    delete container[k];
  });
  present.forEach((k) => {
    container[k] = saved[k];
  });
  return 1;
}

export function applyCanonicalChildOrder(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const model = rootData?.['StbModel']?.[0];
  if (!model) return;

  let count = 0;
  count += reorderChildren(model['StbMembers']?.[0], MEMBERS_ORDER_21X);
  count += reorderChildren(model['StbSections']?.[0], SECTIONS_ORDER_21X);
  if (count > 0) {
    logger.info(`Reordered ${count} container(s) to canonical v2.1.x child order`);
  }
}
