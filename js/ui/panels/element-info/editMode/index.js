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

export { addNewMember, getNewMemberDefinitions } from './memberAdd.js';

export { getNodeLinkTargets, linkNodesToExisting } from './nodeLink.js';

export { addNewSectionElement } from './sectionAdd.js';
export {
  addNewJointElement,
  getCompatibleJointEndpoints202,
  assignJointDefinition202,
  addJointArrangement,
} from './jointAdd.js';
export { addOpenWithAssignment } from './openAdd.js';
