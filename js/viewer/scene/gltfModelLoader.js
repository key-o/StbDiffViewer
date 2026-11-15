/**
 * @fileoverview GLBモデルをThree.jsシーンへ読み込む機能
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { scene, requestRender, elementGroups } from '../core/core.js';
import { fitCameraToBox } from '../camera/cameraFitter.js';
import { disposeRecursive } from '../utils/ResourceDisposer.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus, SceneEvents } from '../../data/events/index.js';

const log = createLogger('viewer:gltfModelLoader');
const GLB_MAX_FILE_SIZE = 100 * 1024 * 1024;
const GLB_METADATA_MAX_FILE_SIZE = 20 * 1024 * 1024;
let glbModel = null;
let loadGeneration = 0;

function parseGlb(arrayBuffer) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
  });
}

function getModelBoundsWithGlb(glbBounds) {
  const bounds = glbBounds.clone();
  for (const group of Object.values(elementGroups)) {
    if (!group || group.children.length === 0) continue;
    const groupBounds = new THREE.Box3().setFromObject(group);
    if (!groupBounds.isEmpty()) bounds.union(groupBounds);
  }
  return bounds;
}

async function readGlbMetadata(file) {
  if (!file) return null;
  if (!file.name?.toLowerCase().endsWith('.json')) {
    throw new TypeError('GLB情報には拡張子が.jsonのファイルを指定してください。');
  }
  if (file.size <= 0 || file.size > GLB_METADATA_MAX_FILE_SIZE) {
    throw new RangeError('GLB情報JSONは0バイトより大きく、20MB以下である必要があります。');
  }

  const contents =
    typeof file.text === 'function'
      ? await file.text()
      : new TextDecoder().decode(await file.arrayBuffer());
  const metadata = JSON.parse(contents);
  if (!metadata || !Array.isArray(metadata.elements)) {
    throw new TypeError('GLB情報JSONにelements配列がありません。');
  }

  const elements = new Map();
  for (const element of metadata.elements) {
    if (element?.elementId === undefined || element?.elementId === null) continue;
    elements.set(String(element.elementId), element);
  }
  if (elements.size === 0) {
    throw new TypeError('GLB情報JSONにelementIdを持つ要素がありません。');
  }

  const typeRecords = Array.isArray(metadata.types)
    ? metadata.types
    : Object.values(metadata.types || {});
  const types = new Map(
    typeRecords
      .filter((type) => type?.typeId !== undefined && type?.typeId !== null)
      .map((type) => [String(type.typeId), type]),
  );

  return {
    documentTitle: metadata.documentTitle || '',
    elements,
    types,
  };
}

function attachElementMetadata(root, metadataIndex) {
  const matchedIds = new Set();

  const visit = (object, inheritedElement = null) => {
    const extras = object.userData || {};
    const elementId = extras.elementId ?? inheritedElement?.elementId;
    const element = elementId === undefined ? null : metadataIndex?.elements.get(String(elementId));
    const glbElement = element
      ? {
          elementId: String(elementId),
          category: element.category || extras.category || '',
          element,
          type: element.typeId ? metadataIndex.types.get(String(element.typeId)) || null : null,
          documentTitle: metadataIndex.documentTitle,
        }
      : elementId === undefined
        ? null
        : {
            elementId: String(elementId),
            category: extras.category || '',
            element: { ...extras, elementId: String(elementId) },
            type: null,
            documentTitle: metadataIndex?.documentTitle || '',
          };
    const currentElement = glbElement || inheritedElement;

    if (currentElement && (object.isMesh || object.isLine || object.isPoints)) {
      object.userData = {
        ...object.userData,
        isGlbElement: true,
        elementType: 'GLB',
        elementId: currentElement.elementId,
        modelSource: 'GLB',
        glbElementInfo: currentElement,
      };
      if (element) matchedIds.add(String(elementId));
    }

    for (const child of object.children || []) {
      visit(child, currentElement);
    }
  };

  visit(root);
  return matchedIds.size;
}

/**
 * GLBファイルを読み込み、現在のシーンに重ねて表示する。
 * GLBのメートル単位・Y-upを、ビューアのmm単位・Z-upへ変換する。
 * @param {{name: string, size: number, arrayBuffer: () => Promise<ArrayBuffer>}} file
 * @param {{name: string, size: number, text?: () => Promise<string>, arrayBuffer?: () => Promise<ArrayBuffer>}} [metadataFile]
 * @returns {Promise<{bounds: THREE.Box3, meshCount: number, matchedElementCount: number, metadataElementCount: number}|null>}
 */
export async function loadGlbModel(file, metadataFile = null) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('GLBファイルを指定してください。');
  }
  if (!file.name?.toLowerCase().endsWith('.glb')) {
    throw new TypeError('拡張子が.glbのファイルを指定してください。');
  }
  if (file.size <= 0 || file.size > GLB_MAX_FILE_SIZE) {
    throw new RangeError('GLBファイルは0バイトより大きく、100MB以下である必要があります。');
  }

  const generation = ++loadGeneration;
  const metadataIndex = await readGlbMetadata(metadataFile);
  const gltf = await parseGlb(await file.arrayBuffer());
  if (generation !== loadGeneration) {
    disposeRecursive(gltf.scene);
    return null;
  }
  if (!gltf.scene) {
    throw new Error('GLBに表示可能なシーンがありません。');
  }

  const modelRoot = new THREE.Group();
  modelRoot.name = file.name;
  modelRoot.userData.isGlbModel = true;
  const matchedElementCount = attachElementMetadata(gltf.scene, metadataIndex);
  if (metadataIndex && matchedElementCount === 0) {
    disposeRecursive(gltf.scene);
    throw new Error('選択したJSONに、このGLBと対応するelementIdがありません。');
  }
  modelRoot.scale.setScalar(1000);
  modelRoot.rotation.x = Math.PI / 2;
  modelRoot.add(gltf.scene);
  modelRoot.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(modelRoot);
  if (bounds.isEmpty()) {
    disposeRecursive(modelRoot);
    throw new Error('GLBに表示可能なジオメトリがありません。');
  }

  if (glbModel) {
    eventBus.emit(SceneEvents.GLB_CLEARED);
    disposeRecursive(glbModel);
  }
  glbModel = modelRoot;
  scene.add(glbModel);
  fitCameraToBox(getModelBoundsWithGlb(bounds));

  let meshCount = 0;
  modelRoot.traverse((object) => {
    if (object.isMesh) meshCount += 1;
  });
  requestRender();
  eventBus.emit(SceneEvents.GLB_LOADED);
  log.info(`GLBを読み込みました: ${file.name} (${meshCount} meshes)`);
  return {
    bounds,
    meshCount,
    matchedElementCount,
    metadataElementCount: metadataIndex?.elements.size || 0,
  };
}

/** 読み込んだGLBをシーンから解除し、関連リソースを解放する。 */
export function clearGlbModel() {
  loadGeneration += 1;
  eventBus.emit(SceneEvents.GLB_CLEARED);
  if (glbModel) {
    disposeRecursive(glbModel);
    glbModel = null;
    requestRender();
  }
}

/** 現在読み込まれているGLBの選択raycast用rootを返す。 */
export function getGlbModel() {
  return glbModel;
}

/**
 * 読み込んだGLBの表示状態を切り替える。
 * @param {boolean} visible
 * @returns {boolean} GLBモデルが読み込まれている場合true
 */
export function setGlbModelVisible(visible) {
  if (!glbModel) return false;
  glbModel.visible = Boolean(visible);
  requestRender();
  return true;
}
