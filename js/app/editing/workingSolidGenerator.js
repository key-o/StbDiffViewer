/**
 * @fileoverview Working nodeMap を既存 solid generator へ接続する element-ID 再生成
 *
 * Working Document を parse した element / section を使い、座標だけ Working nodeMap を
 * 優先する読み取りviewへ差し替える。Node移動・属性変更・structural add のいずれでも
 * element-ID 単位で既存generatorを再利用する。
 */

import * as THREE from 'three';

import { getElementRedrawConfig } from '../../config/elementRedrawConfig.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';

function getMapValueById(map, id) {
  if (!(map instanceof Map)) return undefined;
  if (map.has(id)) return map.get(id);
  const stringId = String(id);
  if (map.has(stringId)) return map.get(stringId);
  for (const [key, value] of map.entries()) {
    if (String(key) === stringId) return value;
  }
  return undefined;
}

function toVector3(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return new THREE.Vector3(x, y, z);
}

/**
 * Map全コピーを避ける Working座標overlay view。
 * generator側の通常利用（get/has/iteration）をMap互換の形で提供する。
 */
export class WorkingNodeVectorView extends Map {
  constructor(baseNodes, workingNodeMap) {
    super();
    this.baseNodes = baseNodes instanceof Map ? baseNodes : new Map();
    this.workingNodeMap = workingNodeMap instanceof Map ? workingNodeMap : new Map();
  }

  get size() {
    const keys = new Set([...this.baseNodes.keys()].map(String));
    for (const key of this.workingNodeMap.keys()) keys.add(String(key));
    return keys.size;
  }

  get(id) {
    const working = toVector3(getMapValueById(this.workingNodeMap, id));
    return working || getMapValueById(this.baseNodes, id);
  }

  has(id) {
    return this.get(id) !== undefined;
  }

  *keys() {
    const yielded = new Set();
    for (const key of this.baseNodes.keys()) {
      yielded.add(String(key));
      yield key;
    }
    for (const key of this.workingNodeMap.keys()) {
      if (yielded.has(String(key))) continue;
      yield key;
    }
  }

  *values() {
    for (const key of this.keys()) yield this.get(key);
  }

  *entries() {
    for (const key of this.keys()) yield [key, this.get(key)];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

function isPolygonLikeConfig(config) {
  return config?.nodeEndAttr === null && config?.nodeStartAttr === 'node_ids';
}

function isSupportedPolygonElementType(elementType) {
  return ['Slab', 'Wall', 'ShearWall', 'FrameDampingDevice'].includes(elementType);
}

function getFilteredElements(parsedData, config, elementType) {
  const elements = Array.isArray(parsedData?.[config.elementsKey])
    ? parsedData[config.elementsKey]
    : [];
  if (elementType === 'Wall' || elementType === 'ShearWall') {
    return elements.filter((element) => getViewerWallElementType(element) === elementType);
  }
  return elements;
}

function findElementById(elements, elementId) {
  const target = String(elementId);
  return Array.isArray(elements)
    ? elements.find((element) => String(element?.id) === target)
    : null;
}

function getGeneratorAdditionalData(elementType, parsedData) {
  return elementType === 'Wall' || elementType === 'ShearWall'
    ? parsedData?.openingElements || null
    : null;
}

/**
 * Working座標で1要素だけ既存solid generatorを実行する。
 * Slab / Wall / ShearWall / FrameDampingDevice は current full-render path と同じ
 * polygon generator を element-ID 単位で再利用する。FrameDampingDevice の
 * configuration は parsed element に保持し、既存 generator contract をそのまま渡す。
 * generatorInfo は viewer 公開境界側のcontrollerから注入する。
 *
 * @param {Object} options
 * @returns {{supported:boolean, meshes:Array, reason:string|null, element:Object|null}}
 */
export function generateWorkingSolidMeshes(options = {}) {
  const {
    elementType,
    elementId,
    parsedData,
    workingNodeMap,
    config = getElementRedrawConfig(elementType),
    generatorInfo = null,
  } = options;

  if (!config) {
    return { supported: false, meshes: [], reason: 'unsupported-element-type', element: null };
  }
  if (!generatorInfo) {
    return { supported: false, meshes: [], reason: 'generator-info-missing', element: null };
  }
  if (isPolygonLikeConfig(config) && !isSupportedPolygonElementType(elementType)) {
    return { supported: false, meshes: [], reason: 'polygon-route-required', element: null };
  }
  if (!parsedData) {
    return { supported: false, meshes: [], reason: 'parsed-data-missing', element: null };
  }

  const element = findElementById(getFilteredElements(parsedData, config, elementType), elementId);
  if (!element) {
    return { supported: false, meshes: [], reason: 'element-not-found', element: null };
  }

  const generator = generatorInfo.class;
  const generatorMethod = generatorInfo.method;
  if (!generator || typeof generator[generatorMethod] !== 'function') {
    return { supported: false, meshes: [], reason: 'generator-method-missing', element };
  }

  const nodes = new WorkingNodeVectorView(parsedData.nodes, workingNodeMap);
  const sections = parsedData[config.sectionsKey];
  const additionalData = getGeneratorAdditionalData(elementType, parsedData);
  const meshes =
    generator[generatorMethod](
      [element],
      nodes,
      sections,
      parsedData.steelSections,
      elementType,
      false,
      additionalData,
    ) || [];

  return {
    supported: true,
    meshes: Array.isArray(meshes) ? meshes.filter(Boolean) : [],
    reason: null,
    element,
  };
}

/**
 * Working座標で生成したsolid meshを既存groupへ element-ID 単位で差し替える。
 * replace は viewer 公開境界側のcontrollerから注入する。
 */
export function replaceWorkingSolidElement(options = {}) {
  const { group, elementType, elementId, replace = null } = options;
  const generated = generateWorkingSolidMeshes(options);
  if (!generated.supported || generated.meshes.length === 0) {
    return { ...generated, replaced: false, replacement: null };
  }
  if (typeof replace !== 'function') {
    return {
      ...generated,
      supported: false,
      reason: 'replace-function-missing',
      replaced: false,
      replacement: null,
    };
  }

  const replacement = replace(
    group,
    elementType,
    elementId,
    generated.meshes,
    options.replaceOptions,
  );
  return {
    ...generated,
    replaced: replacement?.replaced === true,
    replacement,
  };
}

/**
 * Working Document で生成した新規 solid mesh を既存 group へ挿入する。
 * insert は viewer 公開境界側の controller から注入する。
 */
export function insertWorkingSolidElement(options = {}) {
  const { group, elementType, elementId, insert = null } = options;
  const generated = generateWorkingSolidMeshes(options);
  if (!generated.supported || generated.meshes.length === 0) {
    return { ...generated, inserted: false, insertion: null };
  }
  if (typeof insert !== 'function') {
    return {
      ...generated,
      supported: false,
      reason: 'insert-function-missing',
      inserted: false,
      insertion: null,
    };
  }

  const insertion = insert(group, elementType, elementId, generated.meshes, options.insertOptions);
  return {
    ...generated,
    inserted: insertion?.inserted === true,
    insertion,
  };
}
