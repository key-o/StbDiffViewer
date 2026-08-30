/**
 * @fileoverview DXFコントローラー
 *
 * DXFローダー機能へのFacadeを提供します。
 * UI層がDXF処理層に直接依存することを防ぎます。
 *
 * @module app/controllers/dxfController
 */

import { updatePlacementPositionOptions, updateStbExportStatus } from './dxfLoader.js';

/**
 * DXFコントローラー
 * DXF関連機能への統一的なインターフェースを提供
 */
export const dxfController = {
  /**
   * 配置位置オプションを更新
   */
  updatePlacementOptions() {
    updatePlacementPositionOptions();
  },

  /**
   * STBエクスポートステータスを更新
   */
  updateExportStatus() {
    updateStbExportStatus();
  },
};

export default dxfController;
