/**
 * @fileoverview elementGroups の走査と段階的なオブジェクト処理を共通化します。
 *
 * Three.js や描画層には依存せず、対象判定・スケジューラ・完了処理は
 * 呼び出し側から注入します。これにより色モードごとの描画タイミングや
 * GPU リソース管理の違いを維持できます。
 */

/**
 * elementGroups 以下から条件に合うオブジェクトを収集します。
 *
 * @param {Object|Array} elementGroups
 * @param {(object: Object) => boolean} [matches]
 * @returns {Object[]}
 */
export function collectElementGroupObjects(elementGroups, matches = () => true) {
  if (!elementGroups || typeof elementGroups !== 'object') return [];

  const objects = [];
  const groups = Array.isArray(elementGroups) ? elementGroups : Object.values(elementGroups);

  groups.forEach((group) => {
    if (!group?.traverse) return;
    group.traverse((object) => {
      if (matches(object)) objects.push(object);
    });
  });

  return objects;
}

/**
 * オブジェクト配列を同期の先頭バッチから段階的に処理します。
 *
 * @param {Object[]} objects
 * @param {Object} options
 * @param {number} options.batchSize
 * @param {(object: Object, index: number) => void} options.processObject
 * @param {(nextBatch: () => void) => void} options.scheduleNext
 * @param {() => void} [options.onBatchComplete]
 * @param {() => void} [options.onComplete]
 */
export function processObjectsInBatches(
  objects,
  { batchSize, processObject, scheduleNext, onBatchComplete, onComplete },
) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive integer');
  }
  if (typeof processObject !== 'function' || typeof scheduleNext !== 'function') {
    throw new TypeError('processObject and scheduleNext must be functions');
  }

  let currentIndex = 0;

  const processBatch = () => {
    const endIndex = Math.min(currentIndex + batchSize, objects.length);

    for (; currentIndex < endIndex; currentIndex++) {
      processObject(objects[currentIndex], currentIndex);
    }

    if (currentIndex < objects.length) {
      onBatchComplete?.();
      scheduleNext(processBatch);
    } else {
      onComplete?.();
    }
  };

  processBatch();
}
