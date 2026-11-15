/**
 * @fileoverview STB 線状構造要素パーサーモジュール
 *
 * 柱・梁・大梁・ブレース・免震装置・制振装置・間柱などの
 * 線状構造要素の抽出機能を提供します。
 *
 * @module common/stb/parser/stbLinearElementParser
 */

import { getLogger, parseElements, parseStbExtensions } from './stbParserCore.js';
import { STB_TAG_NAMES } from '../constants/stbTagNames.js';

// --- 柱要素データ抽出関数 ---
/**
 * 柱要素データを抽出する
 *
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 柱要素データの配列
 */
export function extractColumnElements(xmlDoc) {
  const logger = getLogger();
  const columnElementsData = [];
  const columnElements = parseElements(xmlDoc, STB_TAG_NAMES.COLUMN);

  for (const colEl of columnElements) {
    const id = colEl.getAttribute('id');
    const idNodeBottom = colEl.getAttribute('id_node_bottom');
    const idNodeTop = colEl.getAttribute('id_node_top');
    const idSection = colEl.getAttribute('id_section');
    const name = colEl.getAttribute('name');
    const guid = colEl.getAttribute('guid');
    const rotate = colEl.getAttribute('rotate');
    const kindStructure = colEl.getAttribute('kind_structure');

    const offset_bottom_X = colEl.getAttribute('offset_bottom_X');
    const offset_bottom_Y = colEl.getAttribute('offset_bottom_Y');
    const offset_bottom_Z = colEl.getAttribute('offset_bottom_Z');
    const offset_top_X = colEl.getAttribute('offset_top_X');
    const offset_top_Y = colEl.getAttribute('offset_top_Y');
    const offset_top_Z = colEl.getAttribute('offset_top_Z');

    if (id && idNodeBottom && idNodeTop && idSection) {
      const elementData = {
        id: id,
        id_node_bottom: idNodeBottom,
        id_node_top: idNodeTop,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind_structure: kindStructure || 'S',
        rotate: rotate ? parseFloat(rotate) : 0,
        offset_bottom_X: offset_bottom_X ? parseFloat(offset_bottom_X) : 0,
        offset_bottom_Y: offset_bottom_Y ? parseFloat(offset_bottom_Y) : 0,
        offset_bottom_Z: offset_bottom_Z ? parseFloat(offset_bottom_Z) : 0,
        offset_top_X: offset_top_X ? parseFloat(offset_top_X) : 0,
        offset_top_Y: offset_top_Y ? parseFloat(offset_top_Y) : 0,
        offset_top_Z: offset_top_Z ? parseFloat(offset_top_Z) : 0,
      };
      columnElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 柱: 必須属性が不足 (id=${id})`);
    }
  }
  logger.log(`[Load] 柱要素読込完了: ${columnElementsData.length}本`);
  return columnElementsData;
}

/**
 * 梁要素データを抽出する（汎用関数）
 *
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @param {string} elementType - 要素タイプ（"StbBeam" または "StbGirder"）
 * @return {Array} 梁要素データの配列
 */
function extractBeamLikeElements(xmlDoc, elementType) {
  const logger = getLogger();
  const elementsData = [];
  const elements = parseElements(xmlDoc, elementType);

  for (const el of elements) {
    const id = el.getAttribute('id');
    const idNodeStart = el.getAttribute('id_node_start');
    const idNodeEnd = el.getAttribute('id_node_end');
    const idSection = el.getAttribute('id_section');
    const name = el.getAttribute('name');
    const guid = el.getAttribute('guid');
    const typeShape = el.getAttribute('type_shape');

    const offset_start_X = el.getAttribute('offset_start_X');
    const offset_start_Y = el.getAttribute('offset_start_Y');
    const offset_start_Z = el.getAttribute('offset_start_Z');
    const offset_end_X = el.getAttribute('offset_end_X');
    const offset_end_Y = el.getAttribute('offset_end_Y');
    const offset_end_Z = el.getAttribute('offset_end_Z');

    // STB XML属性名に由来する変数（camelcase警告を抑制）
    const haunch_start = el.getAttribute('haunch_start'); // eslint-disable-line camelcase
    const haunch_end = el.getAttribute('haunch_end'); // eslint-disable-line camelcase
    const kind_haunch_start = el.getAttribute('kind_haunch_start'); // eslint-disable-line camelcase
    const kind_haunch_end = el.getAttribute('kind_haunch_end'); // eslint-disable-line camelcase
    const joint_start = el.getAttribute('joint_start'); // eslint-disable-line camelcase
    const joint_end = el.getAttribute('joint_end'); // eslint-disable-line camelcase
    // 継手ID（部材要素に直接記述される場合）
    const joint_id_start = el.getAttribute('joint_id_start'); // eslint-disable-line camelcase
    const joint_id_end = el.getAttribute('joint_id_end'); // eslint-disable-line camelcase

    // rotate属性を取得（大梁・小梁は梁天端中心、ブレースはジオメトリ中心を回転軸とする）
    const rotate = el.getAttribute('rotate');
    const kindStructure = el.getAttribute('kind_structure'); // eslint-disable-line camelcase
    const foundationAttribute = el.getAttribute('isFoundation');

    if (id && idNodeStart && idNodeEnd && idSection) {
      const data = {
        id: id,
        id_node_start: idNodeStart,
        id_node_end: idNodeEnd,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind_structure: kindStructure || 'S', // eslint-disable-line camelcase
        ...(foundationAttribute === 'true' || foundationAttribute === 'false'
          ? { isFoundation: foundationAttribute === 'true' }
          : {}),
      };

      // SS7原典配置情報（StbExtensionsから読み込み）
      const memberExtMap = parseStbExtensions(el.ownerDocument, elementType);
      const extProps = memberExtMap.get(id);
      if (extProps) {
        for (const [key, value] of Object.entries(extProps)) {
          if (key.startsWith('ss7_')) data[key] = value;
        }
      }

      if (typeShape !== null) {
        data.type_shape = typeShape;
      }

      if (
        offset_start_X !== null ||
        offset_start_Y !== null ||
        offset_start_Z !== null ||
        offset_end_X !== null ||
        offset_end_Y !== null ||
        offset_end_Z !== null
      ) {
        data.offset_start_X = offset_start_X ? parseFloat(offset_start_X) : 0;
        data.offset_start_Y = offset_start_Y ? parseFloat(offset_start_Y) : 0;
        data.offset_start_Z = offset_start_Z ? parseFloat(offset_start_Z) : 0;
        data.offset_end_X = offset_end_X ? parseFloat(offset_end_X) : 0;
        data.offset_end_Y = offset_end_Y ? parseFloat(offset_end_Y) : 0;
        data.offset_end_Z = offset_end_Z ? parseFloat(offset_end_Z) : 0;
      }

      // eslint-disable-next-line camelcase
      if (haunch_start !== null || haunch_end !== null) {
        data.haunch_start = haunch_start ? parseFloat(haunch_start) : 0; // eslint-disable-line camelcase
        data.haunch_end = haunch_end ? parseFloat(haunch_end) : 0; // eslint-disable-line camelcase
        // XSDデフォルト値: SLOPE
        data.kind_haunch_start = kind_haunch_start || 'SLOPE'; // eslint-disable-line camelcase
        data.kind_haunch_end = kind_haunch_end || 'SLOPE'; // eslint-disable-line camelcase
      }

      // eslint-disable-next-line camelcase
      if (joint_start !== null || joint_end !== null) {
        data.joint_start = joint_start ? parseFloat(joint_start) : 0; // eslint-disable-line camelcase
        data.joint_end = joint_end ? parseFloat(joint_end) : 0; // eslint-disable-line camelcase
      }

      // 継手ID（部材要素に直接記述される場合）
      // eslint-disable-next-line camelcase
      if (joint_id_start !== null) {
        data.joint_id_start = joint_id_start; // eslint-disable-line camelcase
      }
      // eslint-disable-next-line camelcase
      if (joint_id_end !== null) {
        data.joint_id_end = joint_id_end; // eslint-disable-line camelcase
      }

      // rotate属性がある場合は追加
      if (rotate !== null) {
        data.rotate = parseFloat(rotate);
      }

      elementsData.push(data);
    } else {
      logger.warn(`[Data] ${elementType}: 必須属性が不足 (id=${id})`);
    }
  }

  logger.log(`[Load] ${elementType}要素読込完了: ${elementsData.length}本`);
  return elementsData;
}

/**
 * 梁要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 梁要素データの配列
 */
export function extractBeamElements(xmlDoc) {
  return extractBeamLikeElements(xmlDoc, STB_TAG_NAMES.BEAM);
}

/**
 * 大梁要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 大梁要素データの配列
 */
export function extractGirderElements(xmlDoc) {
  return extractBeamLikeElements(xmlDoc, STB_TAG_NAMES.GIRDER);
}

/**
 * ブレース要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} ブレース要素データの配列
 */
export function extractBraceElements(xmlDoc) {
  return extractBeamLikeElements(xmlDoc, STB_TAG_NAMES.BRACE);
}

/**
 * 免震装置要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 免震装置要素データの配列
 */
export function extractIsolatingDeviceElements(xmlDoc) {
  return extractBeamLikeElements(xmlDoc, STB_TAG_NAMES.ISOLATING_DEVICE);
}

/**
 * 制振装置要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 制振装置要素データの配列
 */
export function extractDampingDeviceElements(xmlDoc) {
  return extractBeamLikeElements(xmlDoc, STB_TAG_NAMES.DAMPING_DEVICE);
}

/**
 * 制振装置（フレーム）要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 制振装置（フレーム）要素データの配列
 */
export function extractFrameDampingDeviceElements(xmlDoc) {
  const logger = getLogger();
  const frameDampingDeviceElementsData = [];
  const frameDampingDeviceElements = parseElements(xmlDoc, STB_TAG_NAMES.FRAME_DAMPING_DEVICE);

  for (const deviceEl of frameDampingDeviceElements) {
    const id = deviceEl.getAttribute('id');
    const idSection = deviceEl.getAttribute('id_section');
    const name = deviceEl.getAttribute('name');
    const guid = deviceEl.getAttribute('guid');
    const typeShape = deviceEl.getAttribute('type_shape');
    const minorTypeShape = deviceEl.getAttribute('minor_type_shape');

    const nodeIdOrderEl = deviceEl.getElementsByTagName('StbNodeIdOrder')[0];
    const nodeIdText = nodeIdOrderEl ? nodeIdOrderEl.textContent || '' : '';
    const nodeIds = nodeIdText.trim().split(/\s+/).filter(Boolean);

    const offsets = new Map();
    const offsetList = deviceEl.getElementsByTagName('StbFrameDampingDeviceOffsetList')[0];
    if (offsetList) {
      const offsetElements = Array.from(
        offsetList.getElementsByTagName('StbFrameDampingDeviceOffset'),
      );
      for (const offsetEl of offsetElements) {
        const nodeId = offsetEl.getAttribute('id_node');
        if (nodeId) {
          offsets.set(nodeId, {
            offset_X: parseFloat(offsetEl.getAttribute('offset_X')) || 0,
            offset_Y: parseFloat(offsetEl.getAttribute('offset_Y')) || 0,
            offset_Z: parseFloat(offsetEl.getAttribute('offset_Z')) || 0,
          });
        }
      }
    }

    const configuration = {
      members: [],
      connections: [],
    };
    const configurationEl = deviceEl.getElementsByTagName('StbFrameDampingDeviceConfiguration')[0];
    if (configurationEl) {
      const memberElements = Array.from(
        configurationEl.getElementsByTagName('StbFrameDampingDeviceMember'),
      );
      for (const memberEl of memberElements) {
        configuration.members.push({
          id_node_start: memberEl.getAttribute('id_node_start'),
          id_node_end: memberEl.getAttribute('id_node_end'),
          offset_start_X: parseFloat(memberEl.getAttribute('offset_start_X')) || 0,
          offset_start_Y: parseFloat(memberEl.getAttribute('offset_start_Y')) || 0,
          offset_start_Z: parseFloat(memberEl.getAttribute('offset_start_Z')) || 0,
          offset_end_X: parseFloat(memberEl.getAttribute('offset_end_X')) || 0,
          offset_end_Y: parseFloat(memberEl.getAttribute('offset_end_Y')) || 0,
          offset_end_Z: parseFloat(memberEl.getAttribute('offset_end_Z')) || 0,
        });
      }

      const connectionElements = Array.from(
        configurationEl.getElementsByTagName('StbFrameDampingDeviceConnection'),
      );
      for (const connectionEl of connectionElements) {
        configuration.connections.push({
          kind: connectionEl.getAttribute('kind'),
          id_member: connectionEl.getAttribute('id_member'),
          id_node_start: connectionEl.getAttribute('id_node_start'),
          id_node_end: connectionEl.getAttribute('id_node_end'),
          offset_start_X: parseFloat(connectionEl.getAttribute('offset_start_X')) || 0,
          offset_start_Y: parseFloat(connectionEl.getAttribute('offset_start_Y')) || 0,
          offset_start_Z: parseFloat(connectionEl.getAttribute('offset_start_Z')) || 0,
          offset_end_X: parseFloat(connectionEl.getAttribute('offset_end_X')) || 0,
          offset_end_Y: parseFloat(connectionEl.getAttribute('offset_end_Y')) || 0,
          offset_end_Z: parseFloat(connectionEl.getAttribute('offset_end_Z')) || 0,
        });
      }
    }

    if (id && idSection && nodeIds.length >= 3) {
      frameDampingDeviceElementsData.push({
        id,
        id_section: idSection,
        name,
        guid: guid || undefined,
        type_shape: typeShape,
        minor_type_shape: minorTypeShape || undefined,
        node_ids: nodeIds,
        offsets,
        configuration,
      });
    } else {
      logger.warn(
        `[Data] 制振装置（フレーム）: 必須属性またはノードが不足 (id=${id}, nodes=${nodeIds.length})`,
      );
    }
  }

  logger.log(`[Load] 制振装置（フレーム）要素読込完了: ${frameDampingDeviceElementsData.length}基`);
  return frameDampingDeviceElementsData;
}

/**
 * 間柱要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 間柱要素データの配列
 */
export function extractPostElements(xmlDoc) {
  const logger = getLogger();
  const postElementsData = [];
  const postElements = parseElements(xmlDoc, STB_TAG_NAMES.POST);

  for (const postEl of postElements) {
    const id = postEl.getAttribute('id');
    const idNodeBottom = postEl.getAttribute('id_node_bottom');
    const idNodeTop = postEl.getAttribute('id_node_top');
    const idSection = postEl.getAttribute('id_section');
    const name = postEl.getAttribute('name');
    const guid = postEl.getAttribute('guid');

    const offset_bottom_X = postEl.getAttribute('offset_bottom_X');
    const offset_bottom_Y = postEl.getAttribute('offset_bottom_Y');
    const offset_bottom_Z = postEl.getAttribute('offset_bottom_Z');
    const offset_top_X = postEl.getAttribute('offset_top_X');
    const offset_top_Y = postEl.getAttribute('offset_top_Y');
    const offset_top_Z = postEl.getAttribute('offset_top_Z');
    const rotate = postEl.getAttribute('rotate');

    if (id && idNodeBottom && idNodeTop && idSection) {
      const elementData = {
        id: id,
        id_node_bottom: idNodeBottom,
        id_node_top: idNodeTop,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        offset_bottom_X: offset_bottom_X ? parseFloat(offset_bottom_X) : 0,
        offset_bottom_Y: offset_bottom_Y ? parseFloat(offset_bottom_Y) : 0,
        offset_bottom_Z: offset_bottom_Z ? parseFloat(offset_bottom_Z) : 0,
        offset_top_X: offset_top_X ? parseFloat(offset_top_X) : 0,
        offset_top_Y: offset_top_Y ? parseFloat(offset_top_Y) : 0,
        offset_top_Z: offset_top_Z ? parseFloat(offset_top_Z) : 0,
        rotate: rotate ? parseFloat(rotate) : 0,
      };
      postElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 間柱: 必須属性が不足 (id=${id})`);
    }
  }
  logger.log(`[Load] 間柱要素読込完了: ${postElementsData.length}本`);
  return postElementsData;
}
