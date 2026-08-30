/**
 * @fileoverview DXFエクスポーター依存性注入プロバイダー
 *
 * 外部依存性（カメラ、シーン、クリッピング等）へのアクセスを
 * 依存性注入パターンで提供します。
 */

let providers = {
  getOrthographicCamera: null,
  getActiveCamera: null,
  getElementGroups: null,
  getCurrentClippingState: null,
  getCurrentStories: null,
  getCurrentAxesData: null,
  getSectionMaps: null,
  applyStoryClip: null,
  applyAxisClip: null,
  clearAllClippingPlanes: null,
  getLoadedFilename: null,
};

/**
 * DXFエクスポーターのプロバイダーを設定
 * @param {Object} deps - 依存性オブジェクト
 */
export function setDxfExporterProviders(deps) {
  providers = { ...providers, ...deps };
}

export function getOrthographicCameraInternal() {
  return providers.getOrthographicCamera?.() || null;
}

export function getActiveCameraInternal() {
  return providers.getActiveCamera?.() || null;
}

/**
 * 要素グループを取得する。
 * Openは独立Meshを持たないため、DXF UIで選択可能にする目的でWall groupを
 * 仮想Open groupとして公開する。実際のOpenジオメトリ収集は
 * DxfOpeningCollectorがwallData.openingsから行う。
 * @returns {Object}
 */
export function getElementGroupsInternal() {
  const groups = providers.getElementGroups?.() || {};
  if (groups.Wall && !groups.Open) {
    return { ...groups, Open: groups.Wall };
  }
  return groups;
}

export function getCurrentClippingStateInternal() {
  return providers.getCurrentClippingState?.() || null;
}

export function getCurrentStoriesInternal() {
  return providers.getCurrentStories?.() || null;
}

export function getCurrentAxesDataInternal() {
  return providers.getCurrentAxesData?.() || null;
}

export function getSectionMapsInternal() {
  return providers.getSectionMaps?.() || providers.getState?.('models.sectionMaps') || null;
}

export async function applyStoryClipInternal(storyId, range) {
  if (providers.applyStoryClip) {
    await providers.applyStoryClip(storyId, range);
  }
}

export async function applyAxisClipInternal(direction, axisId, range) {
  if (providers.applyAxisClip) {
    await providers.applyAxisClip(direction, axisId, range);
  }
}

export function clearAllClippingPlanesInternal() {
  if (providers.clearAllClippingPlanes) {
    providers.clearAllClippingPlanes();
  }
}

export function getLoadedFilenameInternal() {
  return providers.getLoadedFilename?.() || 'stb_export';
}

export {
  EXPORTABLE_ELEMENT_TYPES,
  ELEMENT_TYPE_COLORS,
} from '../../../constants/dxfElementTypes.js';
