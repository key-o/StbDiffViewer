/**
 * @fileoverview 構造要素の配置入力解決とThree.js配置変換
 *
 * STBのoffset/rotate属性を表示用配置入力へ変換し、GeometryCalculatorの
 * Three.js非依存結果をViewerで利用する型へ変換する。
 */

import * as THREE from 'three';
import { calculateBeamPlacement, calculateColumnPlacement } from './GeometryCalculator.js';

/**
 * 2ノード縦要素の配置を計算する。
 * @param {THREE.Vector3|Object} startNode
 * @param {THREE.Vector3|Object} endNode
 * @param {Object} [options]
 * @returns {Object}
 */
export function calculateDualNodePlacement(startNode, endNode, options = {}) {
  const startPlain = { x: startNode.x, y: startNode.y, z: startNode.z };
  const endPlain = { x: endNode.x, y: endNode.y, z: endNode.z };

  return calculateColumnPlacement(startPlain, endPlain, {
    bottomOffset: options.startOffset || { x: 0, y: 0 },
    topOffset: options.endOffset || { x: 0, y: 0 },
    rollAngle: options.rollAngle || 0,
  });
}

/**
 * 梁・ブレース等の水平要素配置を計算する。
 * @param {THREE.Vector3|Object} startNode
 * @param {THREE.Vector3|Object} endNode
 * @param {Object} [options]
 * @returns {Object}
 */
export function calculateHorizontalElementPlacement(startNode, endNode, options = {}) {
  const startPlain = startNode.isVector3
    ? { x: startNode.x, y: startNode.y, z: startNode.z }
    : startNode;
  const endPlain = endNode.isVector3 ? { x: endNode.x, y: endNode.y, z: endNode.z } : endNode;

  const placement = calculateBeamPlacement(startPlain, endPlain, {
    startOffset: options.startOffset || { x: 0, y: 0, z: 0 },
    endOffset: options.endOffset || { x: 0, y: 0, z: 0 },
    rollAngle: options.rollAngle || 0,
    placementMode: options.placementMode || 'center',
    sectionHeight: options.sectionHeight || 0,
  });

  return {
    center: new THREE.Vector3(placement.center.x, placement.center.y, placement.center.z),
    length: placement.length,
    direction: new THREE.Vector3(
      placement.direction.x,
      placement.direction.y,
      placement.direction.z,
    ),
    rotation: new THREE.Quaternion(
      placement.rotation.x,
      placement.rotation.y,
      placement.rotation.z,
      placement.rotation.w,
    ),
    adjustedStart: new THREE.Vector3(
      placement.adjustedStart.x,
      placement.adjustedStart.y,
      placement.adjustedStart.z,
    ),
    adjustedEnd: new THREE.Vector3(
      placement.adjustedEnd.x,
      placement.adjustedEnd.y,
      placement.adjustedEnd.z,
    ),
    basis: placement.basis
      ? {
          xAxis: new THREE.Vector3(
            placement.basis.xAxis.x,
            placement.basis.xAxis.y,
            placement.basis.xAxis.z,
          ),
          yAxis: new THREE.Vector3(
            placement.basis.yAxis.x,
            placement.basis.yAxis.y,
            placement.basis.yAxis.z,
          ),
          zAxis: new THREE.Vector3(
            placement.basis.zAxis.x,
            placement.basis.zAxis.y,
            placement.basis.zAxis.z,
          ),
        }
      : null,
    placementMode: placement.placementMode,
    sectionHeight: placement.sectionHeight,
    rollAngle: placement.rollAngle,
  };
}

/**
 * 1ノード要素の配置を計算する。
 * @param {THREE.Vector3|Object} node
 * @param {number} levelBottom
 * @param {number} depth
 * @param {Object} [options]
 * @returns {Object}
 */
export function calculateSingleNodePlacement(node, levelBottom, depth, options = {}) {
  const finalX = node.x + (options.offset?.x || 0);
  const finalY = node.y + (options.offset?.y || 0);
  const bottomZ = node.z + levelBottom;
  const topZ = bottomZ + depth;
  const centerZ = bottomZ + depth / 2;

  return {
    position: new THREE.Vector3(finalX, finalY, centerZ),
    rotation: new THREE.Euler(0, 0, options.rotation || 0),
    bottomZ,
    topZ,
    nodePosition: node,
    offset: options.offset || { x: 0, y: 0 },
  };
}

/**
 * 1/2ノード縦要素のoffsetと回転をSTB属性から解決する。
 * @param {Object} element
 * @returns {{startOffset:Object,endOffset:Object,rollAngle:number}}
 */
export function getOffsetAndRotation(element) {
  const result = {
    startOffset: { x: 0, y: 0 },
    endOffset: { x: 0, y: 0 },
    rollAngle: 0,
  };

  if (element.offset_X_start !== undefined) {
    result.startOffset.x = element.offset_X_start;
  } else if (element.offset_X !== undefined) {
    result.startOffset.x = element.offset_X;
  }
  if (element.offset_Y_start !== undefined) {
    result.startOffset.y = element.offset_Y_start;
  } else if (element.offset_Y !== undefined) {
    result.startOffset.y = element.offset_Y;
  }
  if (element.offset_X_end !== undefined) {
    result.endOffset.x = element.offset_X_end;
  }
  if (element.offset_Y_end !== undefined) {
    result.endOffset.y = element.offset_Y_end;
  }
  if (element.roll_angle !== undefined) {
    result.rollAngle = element.roll_angle;
  } else if (element.rotate !== undefined) {
    result.rollAngle = element.rotate;
  }

  return result;
}

/**
 * 水平要素のoffsetと回転をSTB属性から解決する。
 * @param {Object} element
 * @returns {{startOffset:Object,endOffset:Object,rollAngle:number}}
 */
export function getHorizontalElementOffsets(element) {
  const result = {
    startOffset: { x: 0, y: 0, z: 0 },
    endOffset: { x: 0, y: 0, z: 0 },
    rollAngle: 0,
  };

  if (element.offset_start_X !== undefined) {
    result.startOffset.x = Number(element.offset_start_X) || 0;
  }
  if (element.offset_start_Y !== undefined) {
    result.startOffset.y = Number(element.offset_start_Y) || 0;
  }
  if (element.offset_start_Z !== undefined) {
    result.startOffset.z = Number(element.offset_start_Z) || 0;
  }
  if (element.offset_end_X !== undefined) {
    result.endOffset.x = Number(element.offset_end_X) || 0;
  }
  if (element.offset_end_Y !== undefined) {
    result.endOffset.y = Number(element.offset_end_Y) || 0;
  }
  if (element.offset_end_Z !== undefined) {
    result.endOffset.z = Number(element.offset_end_Z) || 0;
  }

  if (element.rotate !== undefined) {
    result.rollAngle = Number(element.rotate) || 0;
  } else if (element.angle !== undefined) {
    result.rollAngle = Number(element.angle) || 0;
  }

  return result;
}
