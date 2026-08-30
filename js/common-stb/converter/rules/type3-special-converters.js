/**
 * Early special-case conversions for STB v2.0.2 -> v2.1.0.
 */

import logger from '../utils/converter-logger.js';
import { getStbRoot } from '../utils/xml-helper.js';
import { STB_TAG_NAMES } from '../../../constants/elementTypes.js';
import { GUID_NOT_ALLOWED_ELEMENTS } from './type3-attribute-config.js';

/**
 * Remove guid attribute from elements that don't allow it in v2.1.0
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeGuidFromRestrictedElements(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;

  let count = 0;

  // Process StbAxes -> StbParallelAxes
  const axes = rootData?.['StbModel']?.[0]?.['StbAxes']?.[0];
  if (axes) {
    const parallelAxesList = axes['StbParallelAxes'] || [];
    parallelAxesList.forEach((parallelAxes) => {
      if (parallelAxes['$']?.guid !== undefined) {
        delete parallelAxes['$'].guid;
        count++;
      }
    });
  }

  // Process StbStories -> StbStory
  const stories = rootData?.['StbModel']?.[0]?.['StbStories']?.[0]?.['StbStory'];
  if (stories) {
    stories.forEach((story) => {
      if (story['$']?.guid !== undefined) {
        delete story['$'].guid;
        count++;
      }
    });
  }

  // Process Sections
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (sections) {
    GUID_NOT_ALLOWED_ELEMENTS.forEach((elementName) => {
      if (elementName.startsWith('StbSec') && sections[elementName]) {
        const elements = sections[elementName];
        elements.forEach((element) => {
          if (element['$']?.guid !== undefined) {
            delete element['$'].guid;
            count++;
          }
        });
      }
    });
  }

  if (count > 0) {
    logger.info(`Removed ${count} guid attributes from restricted elements`);
  }
}

/**
 * Remove 'isPress' attribute from StbWall (not allowed in v2.1.0)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeWallIsPressTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const walls = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0]?.['StbWalls']?.[0]?.['StbWall'];
  if (!Array.isArray(walls)) return;

  let count = 0;
  walls.forEach((wall) => {
    if (wall['$']?.isPress !== undefined) {
      delete wall['$'].isPress;
      count++;
    }
  });
  if (count > 0) {
    logger.info(`Removed 'isPress' attribute from ${count} StbWall elements`);
  }
}

/**
 * Remove 'type_haunch' attribute from StbSlab (not allowed in v2.1.0)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeSlabTypeHaunchTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const slabs = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0]?.['StbSlabs']?.[0]?.['StbSlab'];
  if (!Array.isArray(slabs)) return;

  let count = 0;
  slabs.forEach((slab) => {
    if (slab['$']?.type_haunch !== undefined) {
      delete slab['$'].type_haunch;
      count++;
    }
  });
  if (count > 0) {
    logger.info(`Removed 'type_haunch' attribute from ${count} StbSlab elements`);
  }
}

/**
 * Fix zero-valued length attributes to minimum positive value
 * Elements like StbSecPipe with D='0' violate minExclusive constraint
 * @param {object} stbRoot - ST-Bridge root element
 */
export function fixZeroLengthAttrsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;
  const lengthAttrs = ['D', 't', 'A', 'B', 'r', 'r1', 'r2', 't1', 't2'];

  // Helper to fix zero values recursively
  const fixZeroValues = (element) => {
    if (!element) return;
    Object.keys(element).forEach((key) => {
      if (key === '$') {
        lengthAttrs.forEach((attr) => {
          // Covers '0', '0.0', 0 etc. (stb:length is minExclusive > 0)
          if (element['$'][attr] !== undefined && parseFloat(element['$'][attr]) === 0) {
            element['$'][attr] = '1'; // Minimum valid value
            count++;
          }
        });
      } else {
        const children = element[key];
        if (Array.isArray(children)) {
          children.forEach(fixZeroValues);
        }
      }
    });
  };

  // Process StbSecSteel elements
  const steelSection = sections['StbSecSteel'];
  if (steelSection) steelSection.forEach(fixZeroValues);

  if (count > 0) {
    logger.info(`Fixed ${count} zero length attribute values`);
  }
}

/**
 * Remove 'pos' attribute from StbSecSlab_RC_ConventionalTaper (not allowed in v2.1.0)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeSlabTaperPosTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Process RC Slab sections
  const slabRC = sections['StbSecSlab_RC'];
  if (slabRC) {
    slabRC.forEach((section) => {
      const figures = section['StbSecFigureSlab_RC'];
      if (!Array.isArray(figures)) return;
      figures.forEach((figure) => {
        const tapers = figure['StbSecSlab_RC_ConventionalTaper'];
        if (Array.isArray(tapers)) {
          tapers.forEach((taper) => {
            if (taper['$']?.pos !== undefined) {
              delete taper['$'].pos;
              count++;
            }
          });
        }
      });
    });
  }

  if (count > 0) {
    logger.info(`Removed 'pos' attribute from ${count} StbSecSlab_RC_ConventionalTaper elements`);
  }
}

/**
 * Remove StbSS7ModelExtension (not expected in v2.1.0 standard schema)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeSS7ExtensionTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;

  // StbSS7ModelExtension is directly under StbModel in some files
  const model = rootData?.['StbModel']?.[0];
  if (model && model['StbSS7ModelExtension']) {
    delete model['StbSS7ModelExtension'];
    logger.info('Removed StbSS7ModelExtension from StbModel');
  }

  // Also try StbExtension location (for other cases)
  let extension = rootData?.['StbExtension']?.[0];
  if (!extension) {
    extension = model?.['StbExtension']?.[0];
  }
  if (extension && extension['StbSS7ModelExtension']) {
    delete extension['StbSS7ModelExtension'];
    logger.info('Removed StbSS7ModelExtension from StbExtension');
  }
}

/**
 * Fix StbPile length attributes with value 0.0 (must be > 0)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function fixPileLengthsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const piles = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0]?.['StbPiles']?.[0]?.['StbPile'];
  if (!Array.isArray(piles)) return;

  let count = 0;
  const lengthAttrs = ['length_all', 'length_head', 'length_foot'];

  piles.forEach((pile) => {
    if (!pile['$']) return;
    lengthAttrs.forEach((attr) => {
      if (pile['$'][attr] === '0' || pile['$'][attr] === '0.0' || pile['$'][attr] === 0) {
        pile['$'][attr] = '1'; // Minimum valid value (must be > 0)
        count++;
      }
    });
  });

  if (count > 0) {
    logger.info(`Fixed ${count} zero pile length attributes`);
  }
}

/**
 * Remove invalid SRC beam steel elements (Joint, FiveTypes - not expected in v2.1.0)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeSrcBeamInvalidElementsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;
  const invalidElements = ['StbSecSteelBeam_SRC_Joint', 'StbSecSteelBeam_SRC_FiveTypes'];

  const beamSrc = sections['StbSecBeam_SRC'];
  if (beamSrc) {
    beamSrc.forEach((section) => {
      const steelFigures = section['StbSecSteelFigureBeam_SRC'];
      if (!Array.isArray(steelFigures)) return;
      steelFigures.forEach((figure, figIdx) => {
        invalidElements.forEach((elemName) => {
          if (figure[elemName]) {
            delete figure[elemName];
            count++;
          }
        });
        // Check if figure is now empty (only has $ attribute)
        const figureKeys = Object.keys(figure).filter((k) => k !== '$');
        if (figureKeys.length === 0 || !figure['StbSecSteelBeam_SRC_Shape']) {
          // Mark for removal by setting to null
          steelFigures[figIdx] = null;
        }
      });
      // Remove null figures and empty parent
      section['StbSecSteelFigureBeam_SRC'] = steelFigures.filter((f) => f !== null);
      if (section['StbSecSteelFigureBeam_SRC'].length === 0) {
        delete section['StbSecSteelFigureBeam_SRC'];
      }
    });
  }

  if (count > 0) {
    logger.info(`Removed ${count} invalid SRC beam steel elements`);
  }
}

/**
 * Fix N_X, N_Y, N_hoop_X, N_hoop_Y values of '0' to '1' (must be positive integer)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function fixZeroBarCountsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;
  // Extended list of positive integer and length attributes that can't be zero
  const attrsToFix = [
    'N_X',
    'N_Y',
    'N_hoop_X',
    'N_hoop_Y',
    'N',
    'N_stirrup',
    'pitch_hoop',
    'pitch_stirrup',
    'pitch',
    'pitch_X',
    'pitch_Y',
  ];

  // Helper to fix zero values recursively
  const fixZeroValues = (element) => {
    if (!element) return;
    Object.keys(element).forEach((key) => {
      if (key === '$') {
        attrsToFix.forEach((attr) => {
          if (element['$'][attr] === '0' || element['$'][attr] === 0) {
            element['$'][attr] = '1';
            count++;
          }
        });
      } else {
        const children = element[key];
        if (Array.isArray(children)) {
          children.forEach(fixZeroValues);
        }
      }
    });
  };

  // Process RC Column sections
  const columnRC = sections['StbSecColumn_RC'];
  if (columnRC) columnRC.forEach(fixZeroValues);

  // Process RC Beam sections
  const beamRC = sections['StbSecBeam_RC'];
  if (beamRC) beamRC.forEach(fixZeroValues);

  if (count > 0) {
    logger.info(`Fixed ${count} zero bar count values to positive integers`);
  }
}

/**
 * Convert StbSecBeamTaper from v2.0.2 to v2.1.0 format
 * v2.0.2: multiple elements with pos=START/END, width, depth
 * v2.1.0: single element with start_width, end_width, start_depth, end_depth
 * @param {object} stbRoot - ST-Bridge root element
 */
export function convertBeamTaperTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  const processTaperElements = (figureElement) => {
    if (!figureElement) return;
    const taperElements = figureElement['StbSecBeamTaper'];
    if (!taperElements || !Array.isArray(taperElements) || taperElements.length === 0) return;

    // Check if already converted (has start_width attribute)
    if (taperElements[0]?.['$']?.start_width) return;

    // Find START and END elements
    let startElement = null;
    let endElement = null;

    taperElements.forEach((taper) => {
      const attrs = taper['$'];
      if (!attrs) return;
      if (attrs.pos === 'START') {
        startElement = attrs;
      } else if (attrs.pos === 'END') {
        endElement = attrs;
      }
    });

    // If no explicit START/END, use first/last or duplicate
    if (!startElement && !endElement && taperElements.length > 0) {
      startElement = taperElements[0]['$'];
      endElement = taperElements[taperElements.length > 1 ? taperElements.length - 1 : 0]['$'];
    }

    if (startElement || endElement) {
      // Use values from found elements, or duplicate if only one found
      const start = startElement || endElement;
      const end = endElement || startElement;

      const newAttrs = {
        start_width: start.width || '300',
        start_depth: start.depth || '600',
        end_width: end.width || '300',
        end_depth: end.depth || '600',
      };

      // Copy offset attributes if present
      if (start.horizontal_offset) newAttrs.start_horizontal_offset = start.horizontal_offset;
      if (start.vertical_offset) newAttrs.start_vertical_offset = start.vertical_offset;
      if (end.horizontal_offset) newAttrs.end_horizontal_offset = end.horizontal_offset;
      if (end.vertical_offset) newAttrs.end_vertical_offset = end.vertical_offset;

      // Replace with single converted element
      figureElement['StbSecBeamTaper'] = [{ $: newAttrs }];
      count++;
    }
  };

  // Process RC Beam sections
  const beamRc = sections['StbSecBeam_RC'];
  if (beamRc) {
    beamRc.forEach((section) => {
      const figures = section['StbSecFigureBeam_RC'] || [];
      figures.forEach((figure) => processTaperElements(figure));
    });
  }

  // Process SRC Beam sections
  const beamSrc = sections['StbSecBeam_SRC'];
  if (beamSrc) {
    beamSrc.forEach((section) => {
      const figures = section['StbSecFigureBeam_SRC'] || [];
      figures.forEach((figure) => processTaperElements(figure));
    });
  }

  if (count > 0) {
    logger.info(`Converted ${count} beam taper elements to v2.1.0 format`);
  }
}

/**
 * Convert StbSecSlab_RC_ConventionalTaper from v2.0.2 to v2.1.0 format
 * v2.0.2: multiple elements with pos, depth
 * v2.1.0: single element with base_depth, tip_depth
 * @param {object} stbRoot - ST-Bridge root element
 */
export function convertSlabTaperTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  const slabRcElements = sections['StbSecSlab_RC'];
  if (!slabRcElements) return;

  slabRcElements.forEach((slabSection) => {
    // Navigate to the taper elements within the new structure
    const conventional = slabSection['StbSecSlab_RC_Conventional']?.[0];
    if (!conventional) return;

    const figureConv = conventional['StbSecFigureSlab_RC_Conventional']?.[0];
    if (!figureConv) return;

    const taperElements = figureConv['StbSecSlab_RC_ConventionalTaper'];
    if (!taperElements || !Array.isArray(taperElements) || taperElements.length === 0) return;

    // Check if already converted (has base_depth attribute)
    if (taperElements[0]?.['$']?.base_depth) return;

    // Find BASE and TIP values
    let baseDepth = null;
    let tipDepth = null;

    taperElements.forEach((taper) => {
      const attrs = taper['$'];
      if (!attrs) return;
      if (attrs.pos === 'BASE' || attrs.pos === 'START') {
        baseDepth = attrs.depth;
      } else if (attrs.pos === 'TIP' || attrs.pos === 'END') {
        tipDepth = attrs.depth;
      } else if (attrs.depth) {
        // No pos attribute, just use depth values
        if (!baseDepth) baseDepth = attrs.depth;
        else if (!tipDepth) tipDepth = attrs.depth;
      }
    });

    // Use found values or defaults
    baseDepth = baseDepth || tipDepth || '200';
    tipDepth = tipDepth || baseDepth || '150';

    const newAttrs = {
      base_depth: baseDepth,
      tip_depth: tipDepth,
    };

    // Replace with single converted element
    figureConv['StbSecSlab_RC_ConventionalTaper'] = [{ $: newAttrs }];
    count++;
  });

  if (count > 0) {
    logger.info(`Converted ${count} slab taper elements to v2.1.0 format`);
  }
}

/**
 * Remove StbNodeIdOrder elements with single values (minLength violation)
 * v2.1.0 monolist_id type requires 3+ space-separated values
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeInvalidNodeIdOrderTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const members = rootData?.['StbModel']?.[0]?.['StbMembers']?.[0];
  if (!members) return;

  let countOrders = 0;
  let countViaNodes = 0;

  // Helper to check if StbNodeIdOrder value is valid (needs 3+ space-separated values)
  const isValidNodeIdOrder = (order) => {
    // xml2js may store text content as string directly or in '_' property
    const value = typeof order === 'string' ? order : order?.['_'] || order;
    if (typeof value === 'string') {
      const parts = value.trim().split(/\s+/);
      return parts.length >= 3;
    }
    return false;
  };

  // Helper to process ViaNode elements - returns number of valid ViaNodes remaining
  const processViaNodeArray = (viaNodeArray) => {
    if (!viaNodeArray || !Array.isArray(viaNodeArray)) return viaNodeArray;

    const validViaNodes = viaNodeArray.filter((viaNode) => {
      const nodeIdOrder = viaNode['StbNodeIdOrder'];
      if (!nodeIdOrder || !Array.isArray(nodeIdOrder)) {
        // No StbNodeIdOrder - remove this ViaNode
        countViaNodes++;
        return false;
      }

      const validOrders = nodeIdOrder.filter(isValidNodeIdOrder);
      if (validOrders.length === 0) {
        // All orders are invalid - remove this ViaNode entirely
        countOrders += nodeIdOrder.length;
        countViaNodes++;
        return false;
      }

      // Some valid orders - keep ViaNode with only valid orders
      if (validOrders.length !== nodeIdOrder.length) {
        countOrders += nodeIdOrder.length - validOrders.length;
        viaNode['StbNodeIdOrder'] = validOrders;
      }
      return true;
    });

    return validViaNodes.length > 0 ? validViaNodes : null;
  };

  // Map from member type to collection element name and via node type
  const memberConfigs = [
    {
      collection: STB_TAG_NAMES.GIRDERS,
      element: STB_TAG_NAMES.GIRDER,
      viaNode: 'StbGirderViaNode',
    },
    { collection: STB_TAG_NAMES.BEAMS, element: STB_TAG_NAMES.BEAM, viaNode: 'StbBeamViaNode' },
    { collection: STB_TAG_NAMES.BRACES, element: STB_TAG_NAMES.BRACE, viaNode: 'StbBraceViaNode' },
    { collection: STB_TAG_NAMES.SLABS, element: STB_TAG_NAMES.SLAB, viaNode: 'StbViaNode' },
    { collection: STB_TAG_NAMES.WALLS, element: STB_TAG_NAMES.WALL, viaNode: 'StbViaNode' },
  ];

  memberConfigs.forEach(({ collection, element, viaNode }) => {
    const collectionElem = members[collection]?.[0];
    if (!collectionElem) return;

    const memberElements = collectionElem[element];
    if (!memberElements || !Array.isArray(memberElements)) return;

    memberElements.forEach((member) => {
      // Check for ViaNode children
      if (member[viaNode]) {
        const result = processViaNodeArray(member[viaNode]);
        if (result) {
          member[viaNode] = result;
        } else {
          delete member[viaNode];
        }
      }
    });
  });

  if (countOrders > 0 || countViaNodes > 0) {
    logger.info(
      `Removed ${countOrders} invalid StbNodeIdOrder elements and ${countViaNodes} empty ViaNode elements`,
    );
  }
}
