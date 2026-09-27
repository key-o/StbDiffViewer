/**
 * @fileoverview 要素ID単位の柱帯筋レイアウトを既存viewerへ接続するアダプター。
 */

import {
  createActualBendShearMeshes,
  createAuxiliaryTieMeshes,
  createColumnHoopMeshes,
  createLegacyShearFallbackLayoutMap,
} from '../../viewer/index.js';
import { decorateShearRebarLayoutMap } from '../../data/extractors/rebar3d/shearRebarActualBendDecorator.js';

function createMeshes(columnElements, nodes, layoutMap, options) {
  const actualLayouts = decorateShearRebarLayoutMap(layoutMap, { memberType: 'column' });
  const legacyLayouts = createLegacyShearFallbackLayoutMap(actualLayouts);
  return [
    ...createColumnHoopMeshes(columnElements, nodes, legacyLayouts, options),
    ...createAuxiliaryTieMeshes(columnElements, nodes, legacyLayouts, {
      ...options,
      memberType: 'column',
      rebarKind: 'columnHoopAuxiliary',
    }),
    ...createActualBendShearMeshes(columnElements, nodes, actualLayouts, {
      ...options,
      memberType: 'column',
      rebarKind: 'columnHoopActualBend',
    }),
  ];
}

/**
 * 柱要素ID単位のレイアウトを既存の断面ID lookup APIへ載せ替えて描画する。
 * @param {Array<Object>} columnElements - 柱要素配列
 * @param {Map<string,Object>} nodes - ノードマップ
 * @param {Map<string,Object>} layoutMap - 要素ID単位レイアウト
 * @param {Object} [options] - 描画設定
 * @returns {Array<Object>} 生成メッシュ
 */
export function createColumnHoopMemberMeshes(columnElements, nodes, layoutMap, options = {}) {
  if (layoutMap?.lookupKey !== 'elementId') {
    return createMeshes(columnElements, nodes, layoutMap, options);
  }

  const memberKeyedElements = (columnElements || []).map((element) => ({
    ...element,
    id_section: element.id,
  }));
  return createMeshes(memberKeyedElements, nodes, layoutMap, options);
}
