/**
 * Legacy GUID restoration for STB v2.1.x -> v2.0.2.
 */

import logger from '../utils/converter-logger.js';
import { getStbRoot } from '../utils/xml-helper.js';
import { STB_TAG_NAMES } from '../../../constants/elementTypes.js';

let legacyGuidCounter = 1;

function nextLegacyGuid() {
  return Math.max(0, legacyGuidCounter++).toString(16).padStart(32, '0').slice(-32);
}

function ensureGuid(elements) {
  if (!Array.isArray(elements)) return 0;
  let count = 0;
  elements.forEach((element) => {
    const attrs = element?.['$'] || (element['$'] = {});
    if (!attrs.guid) {
      attrs.guid = nextLegacyGuid();
      count++;
    }
  });
  return count;
}

/**
 * Add legacy-compatible guid attributes to v2.0.x output.
 * The comparison target uses 2.0.1-style guid-rich XML, so we preserve that shape in downgraded output.
 * @param {object} stbRoot - ST-Bridge root element
 */
export function addLegacyGuidsTo202(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  let count = 0;

  count += ensureGuid(rootData?.['StbCommon']);
  count += ensureGuid(rootData?.['StbModel']?.[0]?.['StbNodes']?.[0]?.['StbNode']);
  count += ensureGuid(rootData?.['StbModel']?.[0]?.['StbStories']?.[0]?.['StbStory']);

  const parallelAxes = rootData?.['StbModel']?.[0]?.['StbAxes']?.[0]?.['StbParallelAxes'] || [];
  parallelAxes.forEach((group) => {
    count += ensureGuid(group?.['StbParallelAxis']);
  });

  const members = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0];
  [
    [STB_TAG_NAMES.COLUMNS, STB_TAG_NAMES.COLUMN],
    [STB_TAG_NAMES.GIRDERS, STB_TAG_NAMES.GIRDER],
    [STB_TAG_NAMES.BEAMS, STB_TAG_NAMES.BEAM],
    [STB_TAG_NAMES.BRACES, STB_TAG_NAMES.BRACE],
    [STB_TAG_NAMES.WALLS, STB_TAG_NAMES.WALL],
    [STB_TAG_NAMES.PARAPETS, STB_TAG_NAMES.PARAPET],
    [STB_TAG_NAMES.SLABS, STB_TAG_NAMES.SLAB],
  ].forEach(([collection, element]) => {
    count += ensureGuid(members?.[collection]?.[0]?.[element]);
  });

  const sections =
    rootData?.['StbModel']?.[0]?.['StbSections']?.[0] || rootData?.['StbSections']?.[0] || null;
  if (sections) {
    ['StbSecColumn_RC', 'StbSecBeam_RC', 'StbSecSlab_RC'].forEach((tag) => {
      count += ensureGuid(sections?.[tag]);
    });
  }

  if (count > 0) {
    logger.info(`Added ${count} legacy-compatible guid attributes for v2.0.x output`);
  }
}
