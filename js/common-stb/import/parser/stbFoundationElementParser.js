/**
 * @fileoverview STB 基礎要素パーサーモジュール
 *
 * 杭・基礎・基礎柱・布基礎などの基礎構造要素の抽出機能を提供します。
 *
 * @module common/stb/parser/stbFoundationElementParser
 */

import { getLogger, parseElements } from './stbParserCore.js';
import { STB_TAG_NAMES } from '../constants/stbTagNames.js';

/**
 * 杭(Pile)要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 杭要素データの配列
 */
export function extractPileElements(xmlDoc) {
  const logger = getLogger();
  const pileElementsData = [];
  const pileElements = parseElements(xmlDoc, STB_TAG_NAMES.PILE);

  for (const pileEl of pileElements) {
    const id = pileEl.getAttribute('id');
    const idSection = pileEl.getAttribute('id_section');
    const name = pileEl.getAttribute('name');
    const guid = pileEl.getAttribute('guid');
    const kind = pileEl.getAttribute('kind');
    const kindStructure = pileEl.getAttribute('kind_structure');

    const idNodeBottom = pileEl.getAttribute('id_node_bottom');
    const idNodeTop = pileEl.getAttribute('id_node_top');

    const idNode = pileEl.getAttribute('id_node');
    const levelTop = pileEl.getAttribute('level_top');
    const lengthAll = pileEl.getAttribute('length_all');
    const lengthHead = pileEl.getAttribute('length_head');
    const lengthFoot = pileEl.getAttribute('length_foot');

    const offset_bottom_X = pileEl.getAttribute('offset_bottom_X');
    const offset_bottom_Y = pileEl.getAttribute('offset_bottom_Y');
    const offset_top_X = pileEl.getAttribute('offset_top_X');
    const offset_top_Y = pileEl.getAttribute('offset_top_Y');

    const offsetX = pileEl.getAttribute('offset_X');
    const offsetY = pileEl.getAttribute('offset_Y');
    const rotate = pileEl.getAttribute('rotate');

    // 2ノード形式の場合
    if (id && idNodeBottom && idNodeTop && idSection) {
      const elementData = {
        id: id,
        id_node_bottom: idNodeBottom,
        id_node_top: idNodeTop,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind: kind,
        kind_structure: kindStructure,
        length_all: lengthAll ? parseFloat(lengthAll) : undefined,
        length_head: lengthHead ? parseFloat(lengthHead) : undefined,
        length_foot: lengthFoot ? parseFloat(lengthFoot) : undefined,
        offset_bottom_X: offset_bottom_X ? parseFloat(offset_bottom_X) : 0,
        offset_bottom_Y: offset_bottom_Y ? parseFloat(offset_bottom_Y) : 0,
        offset_top_X: offset_top_X ? parseFloat(offset_top_X) : 0,
        offset_top_Y: offset_top_Y ? parseFloat(offset_top_Y) : 0,
        rotate: rotate ? parseFloat(rotate) : 0,
        pileFormat: '2node',
      };
      pileElementsData.push(elementData);
    }
    // 1ノード形式の場合
    else if (id && idNode && idSection && levelTop) {
      const elementData = {
        id: id,
        id_node: idNode,
        level_top: parseFloat(levelTop),
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        kind: kind,
        kind_structure: kindStructure,
        length_all: lengthAll ? parseFloat(lengthAll) : undefined,
        length_head: lengthHead ? parseFloat(lengthHead) : undefined,
        length_foot: lengthFoot ? parseFloat(lengthFoot) : undefined,
        offset_X: offsetX ? parseFloat(offsetX) : 0,
        offset_Y: offsetY ? parseFloat(offsetY) : 0,
        rotate: rotate ? parseFloat(rotate) : 0,
        pileFormat: '1node',
      };
      pileElementsData.push(elementData);
    } else {
      logger.warn(
        `[Data] 杭: 必須属性が不足 (id=${id}, 2node=${!!idNodeBottom && !!idNodeTop}, 1node=${!!idNode && !!levelTop})`,
      );
    }
  }
  logger.log(`[Load] 杭要素読込完了: ${pileElementsData.length}本`);
  return pileElementsData;
}

/**
 * 基礎(Footing)要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 基礎要素データの配列
 */
export function extractFootingElements(xmlDoc) {
  const logger = getLogger();
  const footingElementsData = [];
  const footingElements = parseElements(xmlDoc, STB_TAG_NAMES.FOOTING);

  for (const footingEl of footingElements) {
    const id = footingEl.getAttribute('id');
    const idNode = footingEl.getAttribute('id_node');
    const idSection = footingEl.getAttribute('id_section');
    const name = footingEl.getAttribute('name');
    const guid = footingEl.getAttribute('guid');

    const levelBottom = footingEl.getAttribute('level_bottom');
    const offsetX = footingEl.getAttribute('offset_X');
    const offsetY = footingEl.getAttribute('offset_Y');
    const rotate = footingEl.getAttribute('rotate');

    if (id && idNode && idSection) {
      const elementData = {
        id: id,
        id_node: idNode,
        id_section: idSection,
        name: name,
        guid: guid || undefined,
        level_bottom: levelBottom ? parseFloat(levelBottom) : 0,
        offset_X: offsetX ? parseFloat(offsetX) : 0,
        offset_Y: offsetY ? parseFloat(offsetY) : 0,
        rotate: rotate ? parseFloat(rotate) : 0,
      };
      footingElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 基礎: 必須属性が不足 (id=${id})`);
    }
  }
  logger.log(`[Load] 基礎要素読込完了: ${footingElementsData.length}個`);
  return footingElementsData;
}

/**
 * 基礎柱(FoundationColumn)要素データを抽出する
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Array} 基礎柱要素データの配列
 */
export function extractFoundationColumnElements(xmlDoc) {
  const logger = getLogger();
  const foundationColumnElementsData = [];
  const foundationColumnElements = parseElements(xmlDoc, STB_TAG_NAMES.FOUNDATION_COLUMN);

  for (const fcEl of foundationColumnElements) {
    const id = fcEl.getAttribute('id');
    const idNode = fcEl.getAttribute('id_node');
    const name = fcEl.getAttribute('name');
    const guid = fcEl.getAttribute('guid');

    const idSectionFD = fcEl.getAttribute('id_section_FD');
    const lengthFD = fcEl.getAttribute('length_FD');
    const offsetFdX = fcEl.getAttribute('offset_FD_X');
    const offsetFdY = fcEl.getAttribute('offset_FD_Y');
    const thicknessAddFDStartX = fcEl.getAttribute('thickness_add_FD_start_X');
    const thicknessAddFDEndX = fcEl.getAttribute('thickness_add_FD_end_X');
    const thicknessAddFDStartY = fcEl.getAttribute('thickness_add_FD_start_Y');
    const thicknessAddFDEndY = fcEl.getAttribute('thickness_add_FD_end_Y');

    const idSectionWR = fcEl.getAttribute('id_section_WR');
    const lengthWR = fcEl.getAttribute('length_WR');
    const offsetWrX = fcEl.getAttribute('offset_WR_X');
    const offsetWrY = fcEl.getAttribute('offset_WR_Y');
    const thicknessAddWRStartX = fcEl.getAttribute('thickness_add_WR_start_X');
    const thicknessAddWREndX = fcEl.getAttribute('thickness_add_WR_end_X');
    const thicknessAddWRStartY = fcEl.getAttribute('thickness_add_WR_start_Y');
    const thicknessAddWREndY = fcEl.getAttribute('thickness_add_WR_end_Y');

    const rotate = fcEl.getAttribute('rotate');
    const offsetZ = fcEl.getAttribute('offset_Z');
    const kindStructure = fcEl.getAttribute('kind_structure');

    if (id && idNode && name) {
      const elementData = {
        id: id,
        id_node: idNode,
        name: name,
        guid: guid || undefined,
        id_section_FD: idSectionFD || undefined,
        length_FD: lengthFD ? parseFloat(lengthFD) : 0,
        offset_FD_X: offsetFdX ? parseFloat(offsetFdX) : 0,
        offset_FD_Y: offsetFdY ? parseFloat(offsetFdY) : 0,
        thickness_add_FD_start_X: thicknessAddFDStartX ? parseFloat(thicknessAddFDStartX) : 0,
        thickness_add_FD_end_X: thicknessAddFDEndX ? parseFloat(thicknessAddFDEndX) : 0,
        thickness_add_FD_start_Y: thicknessAddFDStartY ? parseFloat(thicknessAddFDStartY) : 0,
        thickness_add_FD_end_Y: thicknessAddFDEndY ? parseFloat(thicknessAddFDEndY) : 0,
        id_section_WR: idSectionWR || undefined,
        length_WR: lengthWR ? parseFloat(lengthWR) : 0,
        offset_WR_X: offsetWrX ? parseFloat(offsetWrX) : 0,
        offset_WR_Y: offsetWrY ? parseFloat(offsetWrY) : 0,
        thickness_add_WR_start_X: thicknessAddWRStartX ? parseFloat(thicknessAddWRStartX) : 0,
        thickness_add_WR_end_X: thicknessAddWREndX ? parseFloat(thicknessAddWREndX) : 0,
        thickness_add_WR_start_Y: thicknessAddWRStartY ? parseFloat(thicknessAddWRStartY) : 0,
        thickness_add_WR_end_Y: thicknessAddWREndY ? parseFloat(thicknessAddWREndY) : 0,
        rotate: rotate ? parseFloat(rotate) : 0,
        offset_Z: offsetZ ? parseFloat(offsetZ) : 0,
        kind_structure: kindStructure || 'RC',
      };
      foundationColumnElementsData.push(elementData);
    } else {
      logger.warn(`[Data] 基礎柱: 必須属性が不足 (id=${id})`);
    }
  }
  logger.log(`[Load] 基礎柱要素読込完了: ${foundationColumnElementsData.length}本`);
  return foundationColumnElementsData;
}

/**
 * StbStripFootings要素から布基礎情報を抽出します。
 * 布基礎は壁下に連続して設置される基礎で、2ノード間の線状要素として定義されます。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Array} 布基礎要素の配列
 */
export function extractStripFootingElements(xmlDoc) {
  const logger = getLogger();
  const stripFootingElementsData = [];
  const stripFootingElements = parseElements(xmlDoc, STB_TAG_NAMES.STRIP_FOOTING);

  for (const stripFootingEl of stripFootingElements) {
    const id = stripFootingEl.getAttribute('id');
    const idSection = stripFootingEl.getAttribute('id_section');
    const name = stripFootingEl.getAttribute('name');
    const guid = stripFootingEl.getAttribute('guid');
    const kindStructure = stripFootingEl.getAttribute('kind_structure');
    const idNodeStart = stripFootingEl.getAttribute('id_node_start');
    const idNodeEnd = stripFootingEl.getAttribute('id_node_end');
    const lengthExStart = stripFootingEl.getAttribute('length_ex_start');
    const lengthExEnd = stripFootingEl.getAttribute('length_ex_end');
    const level = parseFloat(stripFootingEl.getAttribute('level')) || 0;
    const offset = parseFloat(stripFootingEl.getAttribute('offset')) || 0;

    if (id && idSection && idNodeStart && idNodeEnd) {
      const elementData = {
        id,
        id_section: idSection,
        name,
        guid,
        kind_structure: kindStructure,
        id_node_start: idNodeStart,
        id_node_end: idNodeEnd,
        length_ex_start: lengthExStart ? parseFloat(lengthExStart) : 0,
        length_ex_end: lengthExEnd ? parseFloat(lengthExEnd) : 0,
        level,
        offset,
      };
      stripFootingElementsData.push(elementData);
    } else {
      logger.warn(
        `[Data] 布基礎: 必須属性が不足 (id=${id}, section=${idSection}, nodes=${idNodeStart}/${idNodeEnd})`,
      );
    }
  }

  logger.log(`[Load] 布基礎要素読込完了: ${stripFootingElementsData.length}個`);
  return stripFootingElementsData;
}
