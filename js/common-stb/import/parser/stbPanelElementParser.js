/**
 * @fileoverview STB パネル・その他要素パーサーモジュール
 *
 * 床・壁・パラペット・開口・継手などの面状・特殊構造要素の抽出機能を提供します。
 *
 * @module common/stb/parser/stbPanelElementParser
 */

import { getLogger, parseElements, parseStbExtensions } from './stbParserCore.js';
import { detectStbVersion } from './utils/versionDetector.js';
import { STB_TAG_NAMES } from '../constants/stbTagNames.js';

/**
 * 床(Slab)要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 床要素データの配列
 */
export function extractSlabElements(xmlDoc) {
  const logger = getLogger();
  const slabElementsData = [];
  const slabElements = parseElements(xmlDoc, STB_TAG_NAMES.SLAB);

  for (const slabEl of slabElements) {
    const id = slabEl.getAttribute('id');
    const idSection = slabEl.getAttribute('id_section');
    const name = slabEl.getAttribute('name');
    const kindStructure = slabEl.getAttribute('kind_structure');
    const kindSlab = slabEl.getAttribute('kind_slab');
    const directionLoad = slabEl.getAttribute('direction_load');
    const isFoundation = slabEl.getAttribute('isFoundation');
    const guid = slabEl.getAttribute('guid');

    const nodeIdOrderEl = slabEl.getElementsByTagName('StbNodeIdOrder')[0];
    const nodeIdText = nodeIdOrderEl ? nodeIdOrderEl.textContent || '' : '';
    const nodeIds = nodeIdText.trim().split(/\s+/).filter(Boolean);

    const offsets = new Map();
    const offsetList = slabEl.getElementsByTagName('StbSlabOffsetList')[0];
    if (offsetList) {
      const offsetElements = Array.from(offsetList.getElementsByTagName('StbSlabOffset'));
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

    // STB 2.0.2では壁と同様に StbOpenIdList で開口を参照する。
    // 数量計算などの後段が壁/床で同じ関連付け契約を利用できるよう保持する。
    const openIds = [];
    const openList = slabEl.getElementsByTagName('StbOpenIdList')[0];
    if (openList) {
      const openElements = Array.from(openList.getElementsByTagName('StbOpenId'));
      for (const openEl of openElements) {
        const openId = openEl.getAttribute('id');
        if (openId) openIds.push(openId);
      }
    }

    if (id && idSection && nodeIds.length >= 3) {
      const elementData = {
        id: id,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind_structure: kindStructure,
        kind_slab: kindSlab,
        direction_load: directionLoad,
        isFoundation: isFoundation === 'true',
        node_ids: nodeIds,
        offsets: offsets,
        open_ids: openIds,
      };
      const slabExtMap = parseStbExtensions(slabEl.ownerDocument, STB_TAG_NAMES.SLAB);
      const slabExtProps = slabExtMap.get(id);
      if (slabExtProps) {
        for (const [key, value] of Object.entries(slabExtProps)) {
          if (key.startsWith('ss7_')) elementData[key] = value;
        }
      }
      slabElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 床: 必須属性またはノードが不足 (id=${id}, nodes=${nodeIds.length})`);
    }
  }
  logger.log(`[Load] 床要素読込完了: ${slabElementsData.length}枚`);
  return slabElementsData;
}

/**
 * 壁(Wall)要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 壁要素データの配列
 */
export function extractWallElements(xmlDoc) {
  const logger = getLogger();
  const wallElementsData = [];
  const wallElements = parseElements(xmlDoc, STB_TAG_NAMES.WALL);

  for (const wallEl of wallElements) {
    const id = wallEl.getAttribute('id');
    const idSection = wallEl.getAttribute('id_section');
    const name = wallEl.getAttribute('name');
    const kindStructure = wallEl.getAttribute('kind_structure');
    const kindLayout = wallEl.getAttribute('kind_layout');
    const kindWall = wallEl.getAttribute('kind_wall');
    const guid = wallEl.getAttribute('guid');

    const nodeIdOrderEl = wallEl.getElementsByTagName('StbNodeIdOrder')[0];
    const nodeIdText = nodeIdOrderEl ? nodeIdOrderEl.textContent || '' : '';
    const nodeIds = nodeIdText.trim().split(/\s+/).filter(Boolean);

    const offsets = new Map();
    const offsetList = wallEl.getElementsByTagName('StbWallOffsetList')[0];
    if (offsetList) {
      const offsetElements = Array.from(offsetList.getElementsByTagName('StbWallOffset'));
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

    const openIds = [];
    const openList = wallEl.getElementsByTagName('StbOpenIdList')[0];
    if (openList) {
      const openElements = Array.from(openList.getElementsByTagName('StbOpenId'));
      for (const openEl of openElements) {
        const openId = openEl.getAttribute('id');
        if (openId) openIds.push(openId);
      }
    }

    if (id && idSection && nodeIds.length >= 3) {
      const elementData = {
        id: id,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind_structure: kindStructure,
        kind_layout: kindLayout,
        kind_wall: kindWall,
        node_ids: nodeIds,
        offsets: offsets,
        open_ids: openIds,
      };
      // SS7原典配置情報（StbExtensionsから読み込み）
      const wallExtMap = parseStbExtensions(wallEl.ownerDocument, STB_TAG_NAMES.WALL);
      const wallExtProps = wallExtMap.get(id);
      if (wallExtProps) {
        if (wallExtProps.ss7_story) elementData.ss7_story = wallExtProps.ss7_story;
        if (wallExtProps.ss7_frame) elementData.ss7_frame = wallExtProps.ss7_frame;
        if (wallExtProps.ss7_start) elementData.ss7_start = wallExtProps.ss7_start;
        if (wallExtProps.ss7_end) elementData.ss7_end = wallExtProps.ss7_end;
      }
      wallElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 壁: 必須属性またはノードが不足 (id=${id}, nodes=${nodeIds.length})`);
    }
  }
  logger.log(`[Load] 壁要素読込完了: ${wallElementsData.length}枚`);
  return wallElementsData;
}

/**
 * StbParapets要素からパラペット（パラペット壁）情報を抽出します。
 * パラペットは屋上の手すり壁で、2ノード間の線状要素として定義されます。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Array} パラペット要素の配列
 */
export function extractParapetElements(xmlDoc) {
  const logger = getLogger();
  const parapetElementsData = [];
  const parapetElements = parseElements(xmlDoc, STB_TAG_NAMES.PARAPET);

  for (const parapetEl of parapetElements) {
    const id = parapetEl.getAttribute('id');
    const idSection = parapetEl.getAttribute('id_section');
    const name = parapetEl.getAttribute('name');
    const guid = parapetEl.getAttribute('guid');
    const kindStructure = parapetEl.getAttribute('kind_structure');
    const kindLayout = parapetEl.getAttribute('kind_layout');
    const idNodeStart = parapetEl.getAttribute('id_node_start');
    const idNodeEnd = parapetEl.getAttribute('id_node_end');
    const offset = parseFloat(parapetEl.getAttribute('offset')) || 0;

    if (id && idSection && idNodeStart && idNodeEnd) {
      const elementData = {
        id: id,
        id_section: idSection,
        name: name,
        guid: guid,
        kind_structure: kindStructure,
        kind_layout: kindLayout,
        id_node_start: idNodeStart,
        id_node_end: idNodeEnd,
        offset: offset,
      };
      parapetElementsData.push(elementData);
    } else {
      logger.warn(
        `[Data] パラペット: 必須属性が不足 (id=${id}, id_node_start=${idNodeStart}, id_node_end=${idNodeEnd})`,
      );
    }
  }
  logger.log(`[Load] パラペット要素読込完了: ${parapetElementsData.length}枚`);
  return parapetElementsData;
}

/**
 * StbOpens要素から開口情報を抽出します。
 * 開口情報は壁に関連付けられ、3D表示およびIFCエクスポートで使用されます。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Map<string, Object>} 開口IDをキーとする開口情報のMap
 */
export function extractOpeningElements(xmlDoc) {
  const logger = getLogger();
  const openingMap = new Map();
  const version = detectStbVersion(xmlDoc);

  if (
    (version === '2.1.0' || version === '2.1.1') &&
    parseElements(xmlDoc, 'StbOpenArrangement').length > 0
  ) {
    // STB 2.1.x: StbOpenArrangement から開口情報を取得
    extractOpeningsFromArrangements(xmlDoc, openingMap);
  } else {
    // STB 2.0.2 または互換データで StbOpen を使用している場合
    extractOpeningsFromStbOpen(xmlDoc, openingMap);
  }

  logger.log(`[Load] 開口要素読込完了: ${openingMap.size}個 (${version})`);
  return openingMap;
}

/**
 * STB 2.0.2形式: StbOpen要素から開口情報を抽出
 * @param {Document} xmlDoc - XMLドキュメント
 * @param {Map} openingMap - 開口マップ
 */
function extractOpeningsFromStbOpen(xmlDoc, openingMap) {
  const openElements = parseElements(xmlDoc, STB_TAG_NAMES.OPEN);

  for (const openEl of openElements) {
    const id = openEl.getAttribute('id');
    if (!id) continue;

    const posX =
      parseFloat(openEl.getAttribute('position_X') || openEl.getAttribute('offset_X')) || 0;
    const posY =
      parseFloat(openEl.getAttribute('position_Y') || openEl.getAttribute('offset_Y')) || 0;

    const opening = {
      id: id,
      name: openEl.getAttribute('name') || '',
      guid: openEl.getAttribute('guid') || '',
      id_section: openEl.getAttribute('id_section') || '',
      position_X: posX,
      position_Y: posY,
      offset_X: posX,
      offset_Y: posY,
      offset_Z: parseFloat(openEl.getAttribute('offset_Z')) || 0,
      length_X: parseFloat(openEl.getAttribute('length_X')) || 0,
      length_Y: parseFloat(openEl.getAttribute('length_Y')) || 0,
      rotate: parseFloat(openEl.getAttribute('rotate')) || 0,
      sourceVersion: '2.0.2',
    };

    openingMap.set(id, opening);
  }
}

/**
 * STB 2.1.x形式: StbOpenArrangement要素から開口情報を抽出
 * @param {Document} xmlDoc - XMLドキュメント
 * @param {Map} openingMap - 開口マップ
 */
function extractOpeningsFromArrangements(xmlDoc, openingMap) {
  // 開口セクションマップを構築（length_X, length_Yを取得するため）
  const openingSectionMap = buildOpeningSectionMap(xmlDoc);

  const arrangements = parseElements(xmlDoc, 'StbOpenArrangement');

  for (const arr of arrangements) {
    const id = arr.getAttribute('id');
    if (!id) continue;

    const idSection = arr.getAttribute('id_section') || '';
    const sectionData = openingSectionMap.get(idSection) || {};

    const opening = {
      id: id,
      name: arr.getAttribute('name') || '',
      guid: arr.getAttribute('guid') || '',
      id_section: idSection,
      id_member: arr.getAttribute('id_member') || '',
      kind_member: arr.getAttribute('kind_member') || '',
      position_X: parseFloat(arr.getAttribute('position_X')) || 0,
      position_Y: parseFloat(arr.getAttribute('position_Y')) || 0,
      offset_X: parseFloat(arr.getAttribute('offset_X')) || 0,
      offset_Y: parseFloat(arr.getAttribute('offset_Y')) || 0,
      offset_Z: parseFloat(arr.getAttribute('offset_Z')) || 0,
      rotate: parseFloat(arr.getAttribute('rotate')) || 0,
      length_X: sectionData.length_X || 0,
      length_Y: sectionData.length_Y || 0,
      sourceVersion: '2.1.0',
    };

    openingMap.set(id, opening);
  }
}

/**
 * 開口セクションマップを構築
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Map<string, Object>} 開口セクションマップ
 */
function buildOpeningSectionMap(xmlDoc) {
  const sectionMap = new Map();
  const openSections = parseElements(xmlDoc, 'StbSecOpen_RC');

  for (const sec of openSections) {
    const id = sec.getAttribute('id');
    if (!id) continue;

    sectionMap.set(id, {
      id: id,
      name: sec.getAttribute('name') || '',
      length_X: parseFloat(sec.getAttribute('length_X')) || 0,
      length_Y: parseFloat(sec.getAttribute('length_Y')) || 0,
    });
  }

  return sectionMap;
}

/**
 * StbJoints要素から継手情報を抽出します。
 * 継手は鋼構造の梁・柱接合部の詳細情報を定義します。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Map<string, Object>} 継手IDをキーとする継手情報のMap
 */
export function extractJointElements(xmlDoc) {
  const logger = getLogger();
  const jointMap = new Map();

  const jointTypes = [
    { tag: 'StbJointBeamShapeH', type: 'BeamShapeH' },
    { tag: 'StbJointColumnShapeH', type: 'ColumnShapeH' },
    { tag: 'StbJointBeamShapeBox', type: 'BeamShapeBox' },
    { tag: 'StbJointColumnShapeBox', type: 'ColumnShapeBox' },
    { tag: 'StbJointBeamShapeT', type: 'BeamShapeT' },
    { tag: 'StbJointColumnShapeT', type: 'ColumnShapeT' },
  ];

  for (const { tag, type } of jointTypes) {
    const elements = parseElements(xmlDoc, tag);
    for (const el of elements) {
      const id = el.getAttribute('id');
      if (!id) continue;

      const joint = {
        id: id,
        joint_name: el.getAttribute('joint_name') || '',
        joint_mark: el.getAttribute('joint_mark') || '',
        joint_type: type,
      };

      // 共通形状情報
      const shapeEl = el.querySelector
        ? el.querySelector('StbJointShapeH, StbJointShapeBox, StbJointShapeT')
        : null;
      if (shapeEl) {
        joint.shape = {
          strength_plate: shapeEl.getAttribute('strength_plate') || '',
          strength_bolt: shapeEl.getAttribute('strength_bolt') || '',
          name_bolt: shapeEl.getAttribute('name_bolt') || '',
          clearance: parseFloat(shapeEl.getAttribute('clearance')) || 0,
        };
      }

      // フランジ情報
      const flangeEl = el.querySelector
        ? el.querySelector('StbJointShapeHFlange, StbJointShapeBoxFlange, StbJointShapeTFlange')
        : null;
      if (flangeEl) {
        joint.flange = {
          nf: parseInt(flangeEl.getAttribute('nf')) || 0,
          mf: parseInt(flangeEl.getAttribute('mf')) || 0,
          g1: parseFloat(flangeEl.getAttribute('g1')) || 0,
          pitch: parseFloat(flangeEl.getAttribute('pitch')) || 0,
          e1: parseFloat(flangeEl.getAttribute('e1')) || 0,
          outside_thickness: parseFloat(flangeEl.getAttribute('outside_thickness')) || 0,
          outside_width: parseFloat(flangeEl.getAttribute('outside_width')) || 0,
          outside_length: parseFloat(flangeEl.getAttribute('outside_length')) || 0,
          inside_thickness: parseFloat(flangeEl.getAttribute('inside_thickness')) || 0,
          inside_width: parseFloat(flangeEl.getAttribute('inside_width')) || 0,
          inside_length: parseFloat(flangeEl.getAttribute('inside_length')) || 0,
          bolt_length: parseFloat(flangeEl.getAttribute('bolt_length')) || 0,
          isZigzag: flangeEl.getAttribute('isZigzag') === 'true',
        };
      }

      // ウェブ情報
      const webEl = el.querySelector
        ? el.querySelector('StbJointShapeHWeb, StbJointShapeBoxWeb, StbJointShapeTWeb')
        : null;
      if (webEl) {
        joint.web = {
          mw: parseInt(webEl.getAttribute('mw')) || 0,
          nw: parseInt(webEl.getAttribute('nw')) || 0,
          pitch_depth: parseFloat(webEl.getAttribute('pitch_depth')) || 0,
          pitch: parseFloat(webEl.getAttribute('pitch')) || 0,
          e1: parseFloat(webEl.getAttribute('e1')) || 0,
          plate_thickness: parseFloat(webEl.getAttribute('plate_thickness')) || 0,
          plate_width: parseFloat(webEl.getAttribute('plate_width')) || 0,
          plate_length: parseFloat(webEl.getAttribute('plate_length')) || 0,
          bolt_length: parseFloat(webEl.getAttribute('bolt_length')) || 0,
        };
      }

      jointMap.set(id, joint);
    }
  }

  logger.log(`[Load] 継手要素読込完了: ${jointMap.size}個`);
  return jointMap;
}

/**
 * StbJointArrangements要素から継手配置情報を抽出します。
 * 継手配置情報は、どの部材のどの端部にどの継手が配置されているかを定義します。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Array<Object>} 継手配置情報の配列
 */
export function extractJointArrangements(xmlDoc) {
  const logger = getLogger();
  const jointArrangements = [];
  const arrangementElements = parseElements(xmlDoc, 'StbJointArrangement');

  for (const arrEl of arrangementElements) {
    const id = arrEl.getAttribute('id');
    // STB 2.1.0以降: id_section、STB 2.0.x: idで継手定義を参照
    const idSection = arrEl.getAttribute('id_section') || arrEl.getAttribute('id');
    const kindMember = arrEl.getAttribute('kind_member');
    const idMember = arrEl.getAttribute('id_member');
    // STB 2.1.0以降: starting_point、STB 2.0.x: pos
    const startingPoint = arrEl.getAttribute('starting_point') || arrEl.getAttribute('pos');

    if (id && kindMember && idMember && startingPoint) {
      jointArrangements.push({
        id: id,
        id_section: idSection, // 継手定義のID
        kind_member: kindMember, // COLUMN, POST, GIRDER, BEAM, BRACE
        id_member: idMember, // 部材ID
        starting_point: startingPoint, // START or END
        name: arrEl.getAttribute('name') || '',
        guid: arrEl.getAttribute('guid') || '',
      });
    } else {
      logger.warn(
        `[Data] 継手配置: 必須属性が不足 (id=${id}, section=${idSection}, member=${kindMember}/${idMember}, pos=${startingPoint})`,
      );
    }
  }

  logger.log(`[Load] 継手配置情報読込完了: ${jointArrangements.length}個`);
  return jointArrangements;
}

/**
 * 継手配置情報を部材要素に適用します。
 * 各部材に joint_id_start / joint_id_end 属性を追加します。
 *
 * @param {Array<Object>} elements - 部材要素の配列
 * @param {Array<Object>} jointArrangements - 継手配置情報の配列
 * @param {string} kindMember - 部材種別 (COLUMN, POST, GIRDER, BEAM, BRACE)
 * @returns {Array<Object>} 継手ID属性が追加された部材要素の配列
 */
export function applyJointArrangementsToElements(elements, jointArrangements, kindMember) {
  const logger = getLogger();
  if (!elements || elements.length === 0) return elements;
  if (!jointArrangements || jointArrangements.length === 0) return elements;

  // 部材種別でフィルタリング
  const relevantArrangements = jointArrangements.filter(
    (arr) => arr.kind_member.toUpperCase() === kindMember.toUpperCase(),
  );

  if (relevantArrangements.length === 0) return elements;

  // 部材IDをキーとしたマップを作成（STARTとENDを分けて管理）
  const startJointMap = new Map();
  const endJointMap = new Map();

  for (const arr of relevantArrangements) {
    if (arr.starting_point.toUpperCase() === 'START') {
      startJointMap.set(arr.id_member, arr.id_section);
    } else if (arr.starting_point.toUpperCase() === 'END') {
      endJointMap.set(arr.id_member, arr.id_section);
    }
  }

  // 各部材要素に継手IDを付与
  let appliedCount = 0;
  for (const element of elements) {
    const elementId = element.id;
    if (startJointMap.has(elementId)) {
      element.joint_id_start = startJointMap.get(elementId);
      appliedCount++;
    }
    if (endJointMap.has(elementId)) {
      element.joint_id_end = endJointMap.get(elementId);
      appliedCount++;
    }
  }

  if (appliedCount > 0) {
    logger.log(`[Load] ${kindMember}: ${appliedCount}個の継手IDを付与`);
  }

  return elements;
}
