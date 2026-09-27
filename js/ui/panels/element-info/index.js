/**
 * @fileoverview 要素情報表示モジュール公開API
 *
 * element-info ディレクトリ内のモジュールを統合し、外部向けAPIを提供します。
 */

export {
  displayElementInfo,
  displayMultiSelectionSummary,
  refreshElementInfoPanel,
  exportElementInfoAsJson,
  initializeExportJsonButton,
} from './ElementInfoController.js';

export {
  getCurrentEditingElement as getCurrentSelectedElement,
  getCurrentEditingElement,
  isEditMode,
  getModifications,
  editAttributeValue,
  updateEditingSummary,
  toggleEditMode,
  exportModifications,
  clearModifications,
  undoLastModification,
  addNewMember,
  getNewMemberDefinitions,
  initializeEditModeButton,
} from './editMode/index.js';

export {
  setElementInfoProviders,
  setElementInfoProviders as setProviders,
} from './ElementInfoProviders.js';

export { initializeDockButton } from './dockController.js';

export { initAddMemberForm, openAddMemberForm } from './AddMemberForm.js';
export { initOpenBuilderForm, openOpenBuilder } from './OpenBuilderForm.js';
export { initJointBuilderForm, openJointBuilder } from './JointBuilderPublicForm.js';
export {
  initJointArrangementManagerForm,
  openJointArrangementManager,
} from './JointArrangementManagerTypedForm.js';

export { getAttributeImportanceLevel, getImportanceCircleHtml } from './ImportanceColors.js';
export {
  findSectionNode,
  findSteelSectionInfo,
  extractSectionData,
  generateEquivalenceSection,
  buildElementDataForLabels,
  getAttributesMap,
  renderShapeWithSteelInfo,
} from './SectionHelpers.js';
export {
  renderComparisonRecursive,
  renderSectionInfo,
  generateTableStyles,
  setupCollapseHandlers,
} from './ComparisonRenderer.js';
