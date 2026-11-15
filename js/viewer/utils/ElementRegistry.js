/**
 * @fileoverview 要素レジストリモジュール
 *
 * 3D要素のHashMapキャッシュを提供し、O(1)での要素検索を実現します。
 * scene.traverse()による線形検索を置き換えることでパフォーマンスを向上させます。
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:ElementRegistry');

/**
 * 複合キーを生成
 * @param {string} elementId - 要素ID
 * @param {string} modelSource - モデルソース (matched, onlyA, onlyB, A, B)
 * @returns {string} 複合キー
 */
function createCompositeKey(elementId, modelSource) {
  // modelSourceの正規化
  const normalizedSource = normalizeModelSource(modelSource);
  return `${elementId}:${normalizedSource}`;
}

/**
 * modelSourceを正規化
 * @param {string} modelSource
 * @returns {string}
 */
function normalizeModelSource(modelSource) {
  if (modelSource === 'A') return 'onlyA';
  if (modelSource === 'B') return 'onlyB';
  return modelSource;
}

function getElementIds(userData) {
  return [
    ...new Set(
      [userData.elementId, userData.elementIdA, userData.elementIdB].filter(
        (id) => id != null && String(id) !== '',
      ),
    ),
  ];
}

/**
 * 要素レジストリクラス
 * HashMapを使用して要素を管理し、高速な検索を提供
 */
class ElementRegistry {
  /** Isolate candidate registrations without mutating the displayed model's indexes. */
  beginReplacement() {
    const previous = {
      byCompositeKey: this.byCompositeKey,
      byType: this.byType,
      byModelSource: this.byModelSource,
      count: this.count,
    };
    this.byCompositeKey = new Map();
    this.byType = new Map();
    this.byModelSource = new Map();
    this.count = 0;
    return { rollback: () => Object.assign(this, previous) };
  }

  constructor() {
    /** @type {Map<string, THREE.Object3D>} ID+Source → 要素 */
    this.byCompositeKey = new Map();

    /** @type {Map<string, THREE.Object3D[]>} 要素タイプ → 要素配列 */
    this.byType = new Map();

    /** @type {Map<string, THREE.Object3D[]>} モデルソース → 要素配列 */
    this.byModelSource = new Map();

    /** @type {number} 登録済み要素数 */
    this.count = 0;
  }

  /**
   * 要素を登録
   * @param {THREE.Object3D} element - 登録する3Dオブジェクト
   */
  register(element) {
    if (!element || !element.userData) {
      return;
    }

    // モデルBオーバーレイは装飾用メッシュ。実要素と同じ elementIdA + modelSource
    // を持つため、登録すると複合キーが衝突して実要素を上書きし、ツリー選択・
    // カメラフォーカスが誤ったメッシュに向く。登録対象から除外する。
    if (element.userData.isOverlayModelB) {
      return;
    }

    const { userData } = element;
    const elementType = userData.elementType;
    const modelSource = userData.modelSource;

    const elementIds = getElementIds(userData);

    if (elementIds.length === 0 || !elementType) {
      return;
    }

    // 複合キーで登録
    for (const elementId of elementIds) {
      const compositeKey = createCompositeKey(elementId, modelSource);
      this.byCompositeKey.set(compositeKey, element);
    }

    // タイプ別に登録
    if (!this.byType.has(elementType)) {
      this.byType.set(elementType, []);
    }
    this.byType.get(elementType).push(element);

    // モデルソース別に登録
    const normalizedSource = normalizeModelSource(modelSource);
    if (!this.byModelSource.has(normalizedSource)) {
      this.byModelSource.set(normalizedSource, []);
    }
    this.byModelSource.get(normalizedSource).push(element);

    this.count++;
  }

  /**
   * 複数の要素を一括登録
   * @param {THREE.Object3D[]} elements - 登録する要素の配列
   */
  registerAll(elements) {
    for (const element of elements) {
      this.register(element);
    }
  }

  /**
   * Three.jsグループから子要素を一括登録
   * @param {THREE.Group} group - 登録するグループ
   */
  registerFromGroup(group) {
    if (!group || !group.children) return;

    group.traverse((child) => {
      if (child.userData && child.userData.elementType) {
        this.register(child);
      }
    });
  }

  /**
   * ID、タイプ、モデルソースで要素を検索
   * @param {string} elementType - 要素タイプ
   * @param {string} elementId - 要素ID
   * @param {string} modelSource - モデルソース
   * @returns {THREE.Object3D|null} 見つかった要素またはnull
   */
  find(elementType, elementId, modelSource) {
    const compositeKey = createCompositeKey(elementId, modelSource);
    const element = this.byCompositeKey.get(compositeKey);

    // タイプも一致するか確認
    if (element && element.userData.elementType === elementType) {
      return element;
    }

    return null;
  }

  /**
   * IDとモデルソースのみで要素を検索（タイプ不問）
   * @param {string} elementId - 要素ID
   * @param {string} modelSource - モデルソース
   * @returns {THREE.Object3D|null}
   */
  findByIdAndSource(elementId, modelSource) {
    const compositeKey = createCompositeKey(elementId, modelSource);
    return this.byCompositeKey.get(compositeKey) || null;
  }

  /**
   * タイプで要素を取得
   * @param {string} elementType - 要素タイプ
   * @returns {THREE.Object3D[]} 該当する要素の配列
   */
  getByType(elementType) {
    return this.byType.get(elementType) || [];
  }

  /**
   * モデルソースで要素を取得
   * @param {string} modelSource - モデルソース
   * @returns {THREE.Object3D[]} 該当する要素の配列
   */
  getByModelSource(modelSource) {
    const normalizedSource = normalizeModelSource(modelSource);
    return this.byModelSource.get(normalizedSource) || [];
  }

  /**
   * 登録済み要素を全件取得
   * @returns {THREE.Object3D[]}
   */
  getAll() {
    return [...new Set(this.byCompositeKey.values())];
  }

  /**
   * 要素を削除
   * @param {THREE.Object3D} element - 削除する要素
   */
  unregister(element) {
    if (!element || !element.userData) return;

    // register() と対称に、オーバーレイは未登録なので削除処理も行わない。
    // 実要素と同一の複合キーを持つため、誤って実要素の登録を消さないための防御。
    if (element.userData.isOverlayModelB) {
      return;
    }

    const { userData } = element;
    const elementType = userData.elementType;
    const modelSource = userData.modelSource;
    const elementIds = getElementIds(userData);

    if (elementIds.length === 0) return;

    // 複合キーから削除
    for (const elementId of elementIds) {
      const compositeKey = createCompositeKey(elementId, modelSource);
      this.byCompositeKey.delete(compositeKey);
    }

    // タイプ別から削除
    const typeElements = this.byType.get(elementType);
    if (typeElements) {
      const idx = typeElements.indexOf(element);
      if (idx !== -1) {
        typeElements.splice(idx, 1);
      }
    }

    // モデルソース別から削除
    const normalizedSource = normalizeModelSource(modelSource);
    const sourceElements = this.byModelSource.get(normalizedSource);
    if (sourceElements) {
      const idx = sourceElements.indexOf(element);
      if (idx !== -1) {
        sourceElements.splice(idx, 1);
      }
    }

    this.count--;
  }

  /**
   * 全要素をクリア
   */
  clear() {
    this.byCompositeKey.clear();
    this.byType.clear();
    this.byModelSource.clear();
    this.count = 0;
    log.info('ElementRegistry cleared');
  }

  /**
   * 統計情報を取得
   * @returns {Object} 統計情報
   */
  getStats() {
    const stats = {
      totalCount: this.count,
      byType: {},
      byModelSource: {},
    };

    for (const [type, elements] of this.byType) {
      stats.byType[type] = elements.length;
    }

    for (const [source, elements] of this.byModelSource) {
      stats.byModelSource[source] = elements.length;
    }

    return stats;
  }
}

// シングルトンインスタンス
let instance = null;

/**
 * グローバルなElementRegistryインスタンスを取得
 * @returns {ElementRegistry}
 */
export function getElementRegistry() {
  if (!instance) {
    instance = new ElementRegistry();
    log.info('ElementRegistry initialized');
  }
  return instance;
}
