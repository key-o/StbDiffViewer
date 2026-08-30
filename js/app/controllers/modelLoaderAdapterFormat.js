/**
 * @fileoverview 比較結果の StbViewerAdapter 形式への変換
 *
 * common/viewer モードのアダプターが要求する形式へ、
 * 比較結果（Map）・要素・断面情報を変換する。
 *
 * @module app/controllers/modelLoaderAdapterFormat
 */

/**
 * 比較結果をStbViewerAdapter用の形式に変換
 * @param {Map} comparisonResults - 比較結果Map
 * @param {Map} nodeMapA - モデルAの節点Map
 * @param {Map} nodeMapB - モデルBの節点Map
 * @param {Object} sectionMaps - 断面データ
 * @returns {Object} アダプター用の比較結果オブジェクト
 */
export function convertToAdapterFormat(comparisonResults, nodeMapA, nodeMapB, sectionMaps) {
  const result = {
    columns: [],
    girders: [],
    beams: [],
    braces: [],
    isolatingDevices: [],
    dampingDevices: [],
    frameDampingDevices: [],
    slabs: [],
    walls: [],
    nodes: [],
  };

  // 要素タイプのマッピング
  const typeMapping = {
    Column: 'columns',
    Girder: 'girders',
    Beam: 'beams',
    Brace: 'braces',
    IsolatingDevice: 'isolatingDevices',
    DampingDevice: 'dampingDevices',
    FrameDampingDevice: 'frameDampingDevices',
    Slab: 'slabs',
    Wall: 'walls',
    StbNode: 'nodes',
  };

  // 比較結果を変換
  if (comparisonResults && comparisonResults instanceof Map) {
    /**
     * カテゴリのアイテム群を変換してresultに追加する
     * @param {string} targetKey - result のキー名
     * @param {string} elementType - 要素タイプ
     * @param {Array} items - 変換対象アイテム配列
     * @param {Function} getElementData - アイテムから elementData を取得するコールバック
     * @param {string} comparisonStatus - 'matched' | 'onlyA' | 'onlyB'
     * @param {string} modelSource - 'A' | 'B'
     * @param {Function} getHasMismatch - アイテムから hasMismatch を取得するコールバック
     */
    const pushCategory = (
      targetKey,
      elementType,
      items,
      getElementData,
      comparisonStatus,
      modelSource,
      getHasMismatch = () => false,
    ) => {
      if (!items) return;
      for (const item of items) {
        const element = convertElementForAdapter(
          getElementData(item),
          elementType,
          comparisonStatus,
          getHasMismatch(item),
          modelSource,
          nodeMapA,
          nodeMapB,
          sectionMaps,
        );
        if (element) result[targetKey].push(element);
      }
    };

    for (const [elementType, categoryResult] of comparisonResults) {
      const targetKey = typeMapping[elementType];
      if (!targetKey) continue;

      pushCategory(
        targetKey,
        elementType,
        categoryResult.matched,
        (item) => item.dataA || item.dataB,
        'matched',
        'A',
        (item) => item.hasMismatch || false,
      );
      pushCategory(targetKey, elementType, categoryResult.onlyA, (item) => item, 'onlyA', 'A');
      pushCategory(targetKey, elementType, categoryResult.onlyB, (item) => item, 'onlyB', 'B');
    }
  }

  return result;
}

/**
 * 単一要素をアダプター形式に変換
 * @private
 */
function convertElementForAdapter(
  elementData,
  elementType,
  comparisonStatus,
  hasMismatch,
  modelSource,
  nodeMapA,
  nodeMapB,
  sectionMaps,
) {
  if (!elementData) return null;

  const nodeMap = modelSource === 'A' ? nodeMapA : nodeMapB;

  // 線状要素（柱、梁、ブレース）
  if (
    ['Column', 'Girder', 'Beam', 'Brace', 'IsolatingDevice', 'DampingDevice'].includes(elementType)
  ) {
    const idNode1 =
      getElementValueForAdapter(elementData, 'id_node_bottom') ||
      getElementValueForAdapter(elementData, 'id_node_start');
    const idNode2 =
      getElementValueForAdapter(elementData, 'id_node_top') ||
      getElementValueForAdapter(elementData, 'id_node_end');

    const startNode = nodeMap.get(idNode1);
    const endNode = nodeMap.get(idNode2);

    if (!startNode || !endNode) {
      return null;
    }

    // 断面情報を取得
    let section = null;
    if (sectionMaps) {
      const sectionKey = getSectionMapKey(elementType);
      const sectionMap = sectionMaps[sectionKey];
      if (sectionMap) {
        const sectionId = getElementValueForAdapter(elementData, 'id_section');
        section = sectionMap.get(sectionId);
      }
    }

    return {
      id: getElementValueForAdapter(elementData, 'id'),
      modelSource,
      comparisonStatus,
      hasMismatch,
      elementType,
      startNode: { x: startNode.x, y: startNode.y, z: startNode.z },
      endNode: { x: endNode.x, y: endNode.y, z: endNode.z },
      section: section ? convertSectionForAdapter(section) : null,
      typeShape: getElementValueForAdapter(elementData, 'type_shape'),
    };
  }

  // 節点
  if (elementType === 'StbNode') {
    return {
      id: elementData.id,
      modelSource,
      comparisonStatus,
      x: parseFloat(elementData.X || elementData.x || 0),
      y: parseFloat(elementData.Y || elementData.y || 0),
      z: parseFloat(elementData.Z || elementData.z || 0),
    };
  }

  // 面要素（スラブ、壁）- 簡略化実装
  if (['Slab', 'ShearWall', 'Wall', 'FrameDampingDevice'].includes(elementType)) {
    // 面要素は節点リストを持つ
    const nodeIds = extractNodeIdsForAdapter(elementData);
    const nodes = nodeIds
      .map((id) => {
        const node = nodeMap.get(id);
        return node ? { x: node.x, y: node.y, z: node.z } : null;
      })
      .filter((n) => n !== null);

    if (nodes.length < 3) return null;

    return {
      id: getElementValueForAdapter(elementData, 'id'),
      modelSource,
      comparisonStatus,
      hasMismatch,
      nodes,
      elementType,
      sectionId: getElementValueForAdapter(elementData, 'id_section'),
      typeShape: getElementValueForAdapter(elementData, 'type_shape'),
    };
  }

  return null;
}

/**
 * 要素タイプから断面マップのキーを取得
 * @private
 */
function getSectionMapKey(elementType) {
  const mapping = {
    Column: 'columnSections',
    Girder: 'girderSections',
    Beam: 'beamSections',
    Brace: 'braceSections',
    IsolatingDevice: 'isolatingDeviceSections',
    DampingDevice: 'dampingDeviceSections',
    FrameDampingDevice: 'dampingDeviceSections',
  };
  return mapping[elementType];
}

/**
 * アダプター向けに要素からノードID配列を抽出
 * @private
 */
function extractNodeIdsForAdapter(elementData) {
  if (!elementData) return [];
  if (Array.isArray(elementData.nodeIds)) return elementData.nodeIds;
  if (Array.isArray(elementData.node_ids)) return elementData.node_ids;

  if (typeof elementData.getElementsByTagName === 'function') {
    const nodeIdOrderEl = elementData.getElementsByTagName('StbNodeIdOrder')[0];
    const nodeIdText = nodeIdOrderEl
      ? nodeIdOrderEl.textContent || nodeIdOrderEl.innerText || ''
      : '';
    return nodeIdText.trim().split(/\s+/).filter(Boolean);
  }

  return [];
}

/**
 * アダプター向けに要素値を取得
 * @private
 */
function getElementValueForAdapter(elementData, key) {
  if (!elementData || !key) return null;
  if (elementData[key] !== undefined && elementData[key] !== null) {
    return elementData[key];
  }
  if (typeof elementData.getAttribute === 'function') {
    return elementData.getAttribute(key);
  }
  return null;
}

/**
 * 断面情報をアダプター形式に変換
 * @private
 */
function convertSectionForAdapter(section) {
  if (!section) return null;

  // 断面タイプを判定
  const sectionType = section.shape || section.type || 'RECTANGLE';

  // 基本的な断面プロパティを抽出
  const result = {
    type: sectionType.toUpperCase(),
  };

  // 矩形断面
  if (sectionType === 'RECTANGLE' || sectionType === 'RC') {
    result.width = parseFloat(section.width || section.A || 400);
    result.height = parseFloat(section.height || section.B || 400);
  }
  // H形鋼
  else if (sectionType === 'H' || sectionType === 'H-SHAPE') {
    result.type = 'H';
    result.height = parseFloat(section.A || section.height || 400);
    result.width = parseFloat(section.B || section.width || 200);
    result.tw = parseFloat(section.t1 || section.tw || 8);
    result.tf = parseFloat(section.t2 || section.tf || 13);
  }
  // 円形断面
  else if (sectionType === 'PIPE' || sectionType === 'CIRCLE') {
    result.type = 'PIPE';
    result.outerRadius = parseFloat(section.D || section.diameter || 300) / 2;
    result.thickness = parseFloat(section.t || section.thickness || 10);
  }

  return result;
}
