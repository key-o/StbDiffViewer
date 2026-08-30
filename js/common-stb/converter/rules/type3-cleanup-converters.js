/**
 * Late validation and cleanup conversions for STB v2.0.2 -> v2.1.0.
 */

import logger from '../utils/converter-logger.js';
import { getStbRoot } from '../utils/xml-helper.js';

/**
 * Remove empty StbNodeIdList elements (missing child elements)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeEmptyNodeIdListTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const model = rootData?.['StbModel']?.[0];
  if (!model) return;

  let count = 0;

  // Helper to check if StbNodeIdList is valid (has StbNodeId children)
  const isValidNodeIdList = (list) => {
    const nodeIds = list?.['StbNodeId'];
    return nodeIds && Array.isArray(nodeIds) && nodeIds.length > 0;
  };

  // Helper to process any element that might have StbNodeIdList
  const processElement = (element) => {
    if (!element) return;
    const nodeIdList = element['StbNodeIdList'];
    if (nodeIdList && Array.isArray(nodeIdList)) {
      const validLists = nodeIdList.filter(isValidNodeIdList);
      if (validLists.length !== nodeIdList.length) {
        count += nodeIdList.length - validLists.length;
        if (validLists.length > 0) {
          element['StbNodeIdList'] = validLists;
        } else {
          delete element['StbNodeIdList'];
        }
      }
    }
  };

  // Process Members (Slab, Wall)
  const members = model['StbMembers']?.[0];
  if (members) {
    const memberConfigs = [
      { collection: 'StbSlabs', element: 'StbSlab' },
      { collection: 'StbWalls', element: 'StbWall' },
    ];

    memberConfigs.forEach(({ collection, element }) => {
      const collectionElem = members[collection]?.[0];
      if (!collectionElem) return;
      const memberElements = collectionElem[element];
      if (memberElements && Array.isArray(memberElements)) {
        memberElements.forEach(processElement);
      }
    });
  }

  // Process Stories
  const stories = model['StbStories']?.[0];
  if (stories && stories['StbStory']) {
    stories['StbStory'].forEach(processElement);
  }

  // Process Axes (ParallelAxes -> ParallelAxis)
  const axes = model['StbAxes']?.[0];
  if (axes) {
    const axesConfigs = ['StbParallelAxes', 'StbRadialAxes', 'StbArcAxes'];
    axesConfigs.forEach((axesType) => {
      if (axes[axesType] && Array.isArray(axes[axesType])) {
        axes[axesType].forEach((axesGroup) => {
          const axisName = axesType.replace('Axes', 'Axis');
          if (axesGroup[axisName] && Array.isArray(axesGroup[axisName])) {
            axesGroup[axisName].forEach(processElement);
          }
        });
      }
    });
  }

  if (count > 0) {
    logger.info(`Removed ${count} empty StbNodeIdList elements`);
  }
}

/**
 * Fix zero pitch values in bar arrangement elements
 * v2.1.0 requires pitch > 0 (minExclusive constraint)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function fixZeroPitchAttrsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Pitch attributes that must be > 0
  const pitchAttrs = ['pitch_hoop', 'pitch_stirrup', 'pitch', 'pitch_band', 'pitch_bar_spacing'];
  // Depth cover attributes that must be > 0
  const depthCoverAttrs = [
    'depth_cover_start_X',
    'depth_cover_end_X',
    'depth_cover_start_Y',
    'depth_cover_end_Y',
    'depth_cover_X',
    'depth_cover_Y',
    'depth_cover',
  ];
  const allAttrs = [...pitchAttrs, ...depthCoverAttrs];

  // Recursive helper to fix zero values in any element
  const fixZeroValues = (element) => {
    if (!element || typeof element !== 'object') return;

    // Fix attributes on this element
    if (element['$']) {
      const attrs = element['$'];
      allAttrs.forEach((attr) => {
        if (attrs[attr] !== undefined) {
          const val = parseFloat(attrs[attr]);
          if (val === 0 || isNaN(val) || val < 0) {
            if (pitchAttrs.includes(attr)) {
              attrs[attr] = '100'; // Default pitch
            } else {
              attrs[attr] = '40'; // Default depth cover
            }
            count++;
          }
        }
      });
    }

    // Recurse into all children
    Object.keys(element).forEach((key) => {
      if (key !== '$' && Array.isArray(element[key])) {
        element[key].forEach((child) => fixZeroValues(child));
      }
    });
  };

  // Process all section types recursively
  Object.keys(sections).forEach((sectionType) => {
    if (sectionType.startsWith('StbSec') && Array.isArray(sections[sectionType])) {
      sections[sectionType].forEach((section) => fixZeroValues(section));
    }
  });

  if (count > 0) {
    logger.info(`Fixed ${count} zero pitch/depth_cover values to non-zero`);
  }
}

/**
 * Rename SRC column ThreeTypes shape elements to v2.1.0 format
 * @param {object} stbRoot - ST-Bridge root element
 */
export function renameSrcColumnThreeTypesShapeTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Rename mapping for ThreeTypes shapes
  const renameMap = {
    StbSecColumn_SRC_ThreeTypesShapeH: 'StbSecSteelColumn_SRC_ShapeH',
    StbSecColumn_SRC_ThreeTypesShapeT: 'StbSecSteelColumn_SRC_ShapeT',
    StbSecColumn_SRC_ThreeTypesShapeBox: 'StbSecSteelColumn_SRC_ShapeBox',
    StbSecColumn_SRC_ThreeTypesShapePipe: 'StbSecSteelColumn_SRC_ShapePipe',
    StbSecColumn_SRC_ThreeTypesShapeCross1: 'StbSecSteelColumn_SRC_ShapeCross1',
    StbSecColumn_SRC_ThreeTypesShapeCross2: 'StbSecSteelColumn_SRC_ShapeCross2',
  };

  const columnSrc = sections['StbSecColumn_SRC'];
  if (!columnSrc) return;

  columnSrc.forEach((section) => {
    const steelFigure = section['StbSecSteelFigureColumn_SRC']?.[0];
    if (!steelFigure) return;

    // Process ThreeTypes containers
    const threeTypes = steelFigure['StbSecSteelColumn_SRC_ThreeTypes'];
    if (!threeTypes || !Array.isArray(threeTypes)) return;

    threeTypes.forEach((container) => {
      Object.keys(renameMap).forEach((oldName) => {
        if (container[oldName]) {
          const newName = renameMap[oldName];
          container[newName] = container[oldName];
          delete container[oldName];
          count++;
        }
      });
    });
  });

  if (count > 0) {
    logger.info(`Renamed ${count} SRC column ThreeTypes shape elements`);
  }
}

/**
 * Rename StbSecBarSlab_RC_Standard to StbSecBarSlab_RC_ConventionalStandard
 * @param {object} stbRoot - ST-Bridge root element
 */
export function renameSlabBarStandardTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  const renameMap = {
    StbSecBarSlab_RC_Standard: 'StbSecBarSlab_RC_ConventionalStandard',
    StbSecBarSlab_RC_2Way: 'StbSecBarSlab_RC_Conventional2Way',
    StbSecBarSlab_RC_1Way1: 'StbSecBarSlab_RC_Conventional1Way1',
    StbSecBarSlab_RC_1Way2: 'StbSecBarSlab_RC_Conventional1Way2',
  };

  const slabRcElements = sections['StbSecSlab_RC'];
  if (!slabRcElements) return;

  slabRcElements.forEach((slabSection) => {
    const conventional = slabSection['StbSecSlab_RC_Conventional']?.[0];
    if (!conventional) return;

    const barArr = conventional['StbSecBarArrangementSlab_RC_Conventional']?.[0];
    if (!barArr) return;

    Object.keys(renameMap).forEach((oldName) => {
      if (barArr[oldName]) {
        const newName = renameMap[oldName];
        barArr[newName] = barArr[oldName];
        delete barArr[oldName];
        count++;
      }
    });
  });

  if (count > 0) {
    logger.info(`Renamed ${count} slab bar arrangement elements`);
  }
}

/**
 * Remove StbOpens when directly under StbModel (should be in StbArrangements)
 * @param {object} stbRoot - ST-Bridge root element
 */
export function removeStbOpensDirectTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const model = rootData?.['StbModel']?.[0];
  if (!model) return;

  let count = 0;

  // Remove StbOpens if directly under StbModel
  if (model['StbOpens']) {
    delete model['StbOpens'];
    count++;
    logger.info('Removed StbOpens from StbModel');
  }

  // Also check StbMembers for StbOpens (it should not be there in v2.1.0)
  const members = model['StbMembers']?.[0];
  if (members) {
    if (members['StbOpens']) {
      delete members['StbOpens'];
      count++;
      logger.info('Removed StbOpens from StbMembers');
    }

    // Also check for StbOpenIdList in walls and slabs
    const memberConfigs = [
      { collection: 'StbWalls', element: 'StbWall' },
      { collection: 'StbSlabs', element: 'StbSlab' },
    ];
    memberConfigs.forEach(({ collection, element }) => {
      const collectionElem = members[collection]?.[0];
      if (!collectionElem) return;
      const memberElements = collectionElem[element];
      if (memberElements && Array.isArray(memberElements)) {
        memberElements.forEach((member) => {
          if (member['StbOpenIdList']) {
            delete member['StbOpenIdList'];
            count++;
          }
        });
      }
    });
  }

  if (count > 0) {
    logger.info(`Removed ${count} invalid StbOpens/StbOpenIdList elements`);
  }
}

/**
 * Remove StbSecPipe elements with invalid (negative or zero) D attribute
 */
export function removeInvalidSecPipeTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Check StbSecSteel for StbSecPipe elements
  const secSteel = sections['StbSecSteel']?.[0];
  if (secSteel && secSteel['StbSecPipe']) {
    const pipes = secSteel['StbSecPipe'];
    const validPipes = pipes.filter((pipe) => {
      const d = parseFloat(pipe?.['$']?.['D']);
      if (d <= 0 || isNaN(d)) {
        count++;
        return false;
      }
      return true;
    });
    if (validPipes.length !== pipes.length) {
      if (validPipes.length > 0) {
        secSteel['StbSecPipe'] = validPipes;
      } else {
        delete secSteel['StbSecPipe'];
      }
    }
  }

  if (count > 0) {
    logger.info(`Removed ${count} StbSecPipe elements with invalid D attribute`);
  }
}

/**
 * Remove StbSecBarArrangementFoundation_RC empty elements
 */
export function removeEmptyBarArrangementFoundationTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Check StbSecFoundation_RC elements
  const foundations = sections['StbSecFoundation_RC'];
  if (foundations && Array.isArray(foundations)) {
    foundations.forEach((foundation) => {
      if (foundation['StbSecBarArrangementFoundation_RC']) {
        const barArrs = foundation['StbSecBarArrangementFoundation_RC'];
        // Filter out empty bar arrangement elements (no valid children)
        const validBarArrs = barArrs.filter((barArr) => {
          // Check if it has any child elements other than $ (attributes)
          const childKeys = Object.keys(barArr).filter((k) => k !== '$');
          if (childKeys.length === 0) {
            count++;
            return false;
          }
          // Check if any child arrays are non-empty
          const hasChildren = childKeys.some(
            (k) => Array.isArray(barArr[k]) && barArr[k].length > 0,
          );
          if (!hasChildren) {
            count++;
            return false;
          }
          return true;
        });
        if (validBarArrs.length !== barArrs.length) {
          if (validBarArrs.length > 0) {
            foundation['StbSecBarArrangementFoundation_RC'] = validBarArrs;
          } else {
            delete foundation['StbSecBarArrangementFoundation_RC'];
          }
        }
      }
    });
  }

  if (count > 0) {
    logger.info(`Removed ${count} empty StbSecBarArrangementFoundation_RC elements`);
  }
}

/**
 * Remove StbSecOpen_RC elements that are missing required attributes
 */
export function removeInvalidSecOpenTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const sections = rootData?.['StbModel']?.[0]?.['StbSections']?.[0];
  if (!sections) return;

  let count = 0;

  // Check StbSecOpen_RC elements
  if (sections['StbSecOpen_RC']) {
    const opens = sections['StbSecOpen_RC'];
    const validOpens = opens.filter((open) => {
      const attrs = open?.['$'];
      // Required attributes in v2.1.0
      if (!attrs?.['length_X'] || !attrs?.['length_Y']) {
        count++;
        return false;
      }
      return true;
    });
    if (validOpens.length !== opens.length) {
      if (validOpens.length > 0) {
        sections['StbSecOpen_RC'] = validOpens;
      } else {
        delete sections['StbSecOpen_RC'];
      }
    }
  }

  if (count > 0) {
    logger.info(`Removed ${count} StbSecOpen_RC elements with missing required attributes`);
  }
}

/**
 * Remove StbExtensions from StbModel (not allowed in v2.1.0)
 */
export function removeStbExtensionsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const model = rootData?.['StbModel']?.[0];
  if (!model) return;

  if (model['StbExtensions']) {
    delete model['StbExtensions'];
    logger.info('Removed StbExtensions from StbModel');
  }
}

/**
 * Remove StbJoints element (structure changed significantly in v2.1.0, too complex to convert)
 */
export function removeInvalidJointsTo210(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return;
  const rootData = Array.isArray(root) ? root[0] : root;
  const model = rootData?.['StbModel']?.[0];
  if (!model) return;

  // Check if StbJoints has problematic elements that can't be easily converted
  const joints = model['StbJoints']?.[0];
  if (joints) {
    // Check for StbJointBeamShapeH with old structure
    const hasProblematicJoints =
      joints['StbJointBeamShapeH']?.some(
        (j) =>
          j['StbJointShapeHFlange'] &&
          !j['StbJointShapeHFlange'][0]?.['StbJointShapeHFlangeBolt']?.[0]?.['$']?.['id_order'],
      ) ||
      joints['StbJointColumnShapeH']?.some(
        (j) =>
          j['StbJointShapeHFlange'] &&
          !j['StbJointShapeHFlange'][0]?.['StbJointShapeHFlangeBolt']?.[0]?.['$']?.['id_order'],
      );

    if (hasProblematicJoints) {
      delete model['StbJoints'];
      logger.info('Removed StbJoints (structure changed significantly in v2.1.0)');
    }
  }
}
