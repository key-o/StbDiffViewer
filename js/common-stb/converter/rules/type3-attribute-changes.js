/**
 * Type3 attribute conversion orchestrator.
 *
 * Detailed special-case conversions live in responsibility-specific modules.
 */

import { REMOVED_IN_210, RESTORED_IN_202 } from './type3-attribute-config.js';
import { removeAttributes, addDefaultAttributes } from './type3-generic-converters.js';
import {
  convertStoryAttributesTo210,
  convertStoryAttributesTo202,
} from './type3-story-converters.js';
import {
  removeRCSectionAttributesTo210,
  removeBarArrangementParentAttrsTo210,
  removeSSectionAttributesTo210,
  addMissingSteelAttributesTo210,
  removeRollCTypeAttributeTo210,
} from './type3-section-converters.js';
import {
  removeGuidFromRestrictedElements,
  removeWallIsPressTo210,
  removeSlabTypeHaunchTo210,
  fixZeroLengthAttrsTo210,
  removeSlabTaperPosTo210,
  removeSS7ExtensionTo210,
  fixPileLengthsTo210,
  removeSrcBeamInvalidElementsTo210,
  fixZeroBarCountsTo210,
  convertBeamTaperTo210,
  convertSlabTaperTo210,
  removeInvalidNodeIdOrderTo210,
} from './type3-special-converters.js';
import {
  removeEmptyNodeIdListTo210,
  fixZeroPitchAttrsTo210,
  renameSrcColumnThreeTypesShapeTo210,
  renameSlabBarStandardTo210,
  removeStbOpensDirectTo210,
  removeInvalidSecPipeTo210,
  removeEmptyBarArrangementFoundationTo210,
  removeInvalidSecOpenTo210,
  removeStbExtensionsTo210,
  removeInvalidJointsTo210,
} from './type3-cleanup-converters.js';
import { addLegacyGuidsTo202 } from './type3-legacy-guid-converter.js';
export {
  applyAttributeRenamesTo211,
  applyAttributeRenamesTo210from211,
} from './type3-version-rename-converters.js';

/**
 * Apply all attribute conversions for 202 -> 210.
 * @param {object} stbRoot - ST-Bridge root element
 */
export function applyAttributeChangesTo210(stbRoot) {
  Object.keys(REMOVED_IN_210).forEach((elementType) => {
    if (!elementType.startsWith('StbSec')) {
      removeAttributes(stbRoot, elementType, '210');
    }
  });

  convertStoryAttributesTo210(stbRoot);
  addDefaultAttributes(stbRoot, 'StbSlab', '210');

  Object.keys(REMOVED_IN_210).forEach((elementType) => {
    if (elementType.startsWith('StbSec')) {
      removeAttributes(stbRoot, elementType, '210');
    }
  });

  removeGuidFromRestrictedElements(stbRoot);
  removeRCSectionAttributesTo210(stbRoot);
  removeBarArrangementParentAttrsTo210(stbRoot);
  removeSSectionAttributesTo210(stbRoot);
  addMissingSteelAttributesTo210(stbRoot);
  removeRollCTypeAttributeTo210(stbRoot);
  removeWallIsPressTo210(stbRoot);
  removeSlabTypeHaunchTo210(stbRoot);
  fixZeroBarCountsTo210(stbRoot);
  fixZeroLengthAttrsTo210(stbRoot);
  removeSlabTaperPosTo210(stbRoot);
  removeSS7ExtensionTo210(stbRoot);
  removeSrcBeamInvalidElementsTo210(stbRoot);
  fixPileLengthsTo210(stbRoot);
  convertBeamTaperTo210(stbRoot);
  convertSlabTaperTo210(stbRoot);
  removeInvalidNodeIdOrderTo210(stbRoot);
  removeEmptyNodeIdListTo210(stbRoot);
  fixZeroPitchAttrsTo210(stbRoot);
  renameSrcColumnThreeTypesShapeTo210(stbRoot);
  renameSlabBarStandardTo210(stbRoot);
  removeStbOpensDirectTo210(stbRoot);
  removeInvalidSecPipeTo210(stbRoot);
  removeEmptyBarArrangementFoundationTo210(stbRoot);
  removeInvalidSecOpenTo210(stbRoot);
  removeStbExtensionsTo210(stbRoot);
  removeInvalidJointsTo210(stbRoot);
}

/**
 * Apply all attribute conversions for 210 -> 202.
 * @param {object} stbRoot - ST-Bridge root element
 */
export function applyAttributeChangesTo202(stbRoot) {
  convertStoryAttributesTo202(stbRoot);

  Object.keys(RESTORED_IN_202).forEach((elementType) => {
    addDefaultAttributes(stbRoot, elementType, '202');
  });

  addLegacyGuidsTo202(stbRoot);
}
