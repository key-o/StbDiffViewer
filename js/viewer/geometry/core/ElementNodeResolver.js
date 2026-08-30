/**
 * @fileoverview 構造要素の節点位置解決
 *
 * STBの節点Map参照とJSON geometry座標の読み取りを一箇所に集約する。
 * Three.js座標への変換はViewer境界としてこのモジュールで行う。
 */

import * as THREE from 'three';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('viewer:geometry:node-resolver');

/**
 * 要素のノード位置を取得する。
 * @param {Object} element
 * @param {Map} nodes
 * @param {Object} config
 * @param {'1node'|'2node-vertical'|'2node-horizontal'} config.nodeType
 * @param {boolean} config.isJsonInput
 * @param {string} [config.node1Key]
 * @param {string} [config.node1KeyStart]
 * @param {string} [config.node1KeyEnd]
 * @returns {Object}
 */
export function getNodePositions(element, nodes, config) {
  const { nodeType, isJsonInput } = config;

  if (isJsonInput) {
    return getNodePositionsFromJson(element, config);
  }

  if (nodeType === '1node') {
    const nodeId = element[config.node1Key];
    const node = nodes ? nodes.get(nodeId) : null;

    if (!node) {
      log.warn(`1node element ${element.id}: node not found (${config.node1Key}=${nodeId})`);
    }

    return { type: '1node', node, valid: !!node };
  }

  if (nodeType === '2node-vertical') {
    const bottomNodeId = element[config.node1KeyStart];
    const topNodeId = element[config.node1KeyEnd];
    const bottomNode = nodes ? nodes.get(bottomNodeId) : null;
    const topNode = nodes ? nodes.get(topNodeId) : null;

    if (!bottomNode || !topNode) {
      log.warn(
        `2node-vertical element ${element.id}: nodes not found (${config.node1KeyStart}=${bottomNodeId}, ${config.node1KeyEnd}=${topNodeId})`,
      );
    }

    return {
      type: '2node-vertical',
      startNode: bottomNode,
      endNode: topNode,
      bottomNode,
      topNode,
      valid: !!(bottomNode && topNode),
    };
  }

  if (nodeType === '2node-horizontal') {
    const startNodeId = element[config.node1KeyStart];
    const endNodeId = element[config.node1KeyEnd];
    const startNode = nodes ? nodes.get(startNodeId) : null;
    const endNode = nodes ? nodes.get(endNodeId) : null;

    if (!startNode || !endNode) {
      log.warn(
        `2node-horizontal element ${element.id}: nodes not found (${config.node1KeyStart}=${startNodeId}, ${config.node1KeyEnd}=${endNodeId})`,
      );
    }

    return {
      type: '2node-horizontal',
      startNode,
      endNode,
      valid: !!(startNode && endNode),
    };
  }

  log.error(`Unknown nodeType: ${nodeType}`);
  return { valid: false };
}

function getNodePositionsFromJson(element, config) {
  const geometry = element.geometry;
  if (!geometry) {
    log.warn(`JSON element ${element.id}: no geometry data`);
    return { valid: false };
  }

  if (config.nodeType === '1node') {
    const point = geometry.center_point || geometry.position;
    if (!point) {
      log.warn(`JSON 1node element ${element.id}: no center_point/position`);
      return { valid: false };
    }

    return {
      type: '1node',
      node: toVector3(point),
      valid: true,
    };
  }

  const startPoint = geometry.start_point;
  const endPoint = geometry.end_point;
  if (!startPoint || !endPoint) {
    log.warn(`JSON 2node element ${element.id}: missing start_point or end_point`);
    return { valid: false };
  }

  return {
    type: config.nodeType,
    startNode: toVector3(startPoint),
    endNode: toVector3(endPoint),
    valid: true,
  };
}

function toVector3(point) {
  if (Array.isArray(point)) {
    return new THREE.Vector3(point[0], point[1], point[2]);
  }
  return new THREE.Vector3(point.x, point.y, point.z);
}
