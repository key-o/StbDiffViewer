/**
 * @fileoverview 編集モード機能の公開API（バレル）
 *
 * 要素パラメータの編集、修正履歴の管理、新規要素の配置、エクスポート機能を提供する。
 * XMLドキュメントの更新と EditEvents.ATTRIBUTE_CHANGED の発行までを担当し、
 * キャッシュ反映・再比較・3D再描画は editComparisonSyncController /
 * editGeometrySyncController が行う。
 *
 * id属性を持たない断面子要素（フィギュア要素等）は editPath.js の
 * パスアドレッシングで特定する。
 */

export {
  isEditMode,
  getCurrentEditingElement,
  setCurrentEditingElement,
  setDisplayElementInfoFn,
  getModifications,
} from './editState.js';

export { toggleEditMode, initializeEditModeButton } from './editModeToggle.js';

export {
  exportModifications,
  updateEditingSummary,
  undoLastModification,
  clearModifications,
} from './editHistory.js';

export { editAttributeValue } from './attributeEdit.js';
export { applyBatchPropertyEdit, inspectBatchPropertyTargets } from './batchPropertyEdit.js';

export { addNewMember, getNewMemberDefinitions } from './memberAddWorkingCommand.js';

export { getNodeLinkTargets, linkNodesToExisting } from './nodeLink.js';

export { addNewSectionElement } from './sectionAdd.js';
export {
  addNewJointElement,
  getCompatibleJointEndpoints202,
  assignJointDefinition202,
} from './jointWorkingCommand.js';
export {
  addOpenWithAssignment,
  reassignOpenArrangement,
  deleteOpenArrangement,
} from './openArrangementWorkingCommand.js';
export {
  addJointArrangement,
  reassignJointArrangement,
  deleteJointArrangement,
  getCompatibleJointDefinitions21,
} from './jointArrangementPublicCommand.js';

// Working Document 編集API。現段階ではUIから自動起動せず、明示利用に限定する。
export { default as editingSession } from '../../../../app/editing/editingSession.js';
export {
  WorkingNodeVectorView,
  generateWorkingSolidMeshes,
  replaceWorkingSolidElement,
} from '../../../../app/editing/workingSolidGenerator.js';

export {
  getSemanticGrips,
  getSemanticGripsForSelections,
} from '../../../../app/editing/semanticGripProvider.js';

// Phase 4 command core。Property panel の自動切替は旧 Add/Delete 経路の移行完了まで行わない。
export { createSetAttributeCommand } from '../../../../app/editing/setAttributeCommand.js';
export { createSetMemberOffsetCommand } from '../../../../app/editing/setMemberOffsetCommand.js';
export { createChangeSectionCommand } from '../../../../app/editing/changeSectionCommand.js';
