/**
 * @fileoverview STB原データとは分離して派生数量を保持する store。
 */

import { isQuantityResult } from './core/QuantityResult.js';

function requiredKeyPart(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  return String(value);
}

export class DerivedQuantityStore {
  constructor() {
    this._values = new Map();
    this._dependencyIndex = new Map();
  }

  static key(elementType, elementId) {
    return `${requiredKeyPart(elementType, 'elementType')}:${requiredKeyPart(elementId, 'elementId')}`;
  }

  get size() {
    return this._values.size;
  }

  get(elementType, elementId) {
    return this._values.get(DerivedQuantityStore.key(elementType, elementId));
  }

  has(elementType, elementId) {
    return this._values.has(DerivedQuantityStore.key(elementType, elementId));
  }

  set(elementType, elementId, result) {
    if (!isQuantityResult(result)) {
      throw new TypeError('result must satisfy QuantityResult contract');
    }

    const key = DerivedQuantityStore.key(elementType, elementId);
    const resultKey = DerivedQuantityStore.key(
      result.identity.elementType,
      result.identity.elementId,
    );
    if (key !== resultKey) {
      throw new TypeError(`store key (${key}) does not match result identity (${resultKey})`);
    }

    const existing = this._values.get(key);
    if (existing) this._removeDependencyLinks(key, existing.dependencies);

    this._values.set(key, result);
    this._addDependencyLinks(key, result.dependencies);
    return result;
  }

  delete(elementType, elementId) {
    const key = DerivedQuantityStore.key(elementType, elementId);
    const existing = this._values.get(key);
    if (!existing) return false;

    this._removeDependencyLinks(key, existing.dependencies);
    return this._values.delete(key);
  }

  clear() {
    this._values.clear();
    this._dependencyIndex.clear();
  }

  entries() {
    return this._values.entries();
  }

  values() {
    return this._values.values();
  }

  /**
   * Node/Section等の dependency key が変更されたとき、依存する quantity result を破棄する。
   *
   * @param {Iterable<string>} keys
   * @returns {string[]} invalidation した store key
   */
  invalidateByKeys(keys) {
    if (!keys || typeof keys[Symbol.iterator] !== 'function') {
      throw new TypeError('keys must be iterable');
    }

    const targets = new Set();
    for (const dependencyKey of keys) {
      const dependents = this._dependencyIndex.get(String(dependencyKey));
      if (!dependents) continue;
      for (const storeKey of dependents) targets.add(storeKey);
    }

    for (const storeKey of targets) {
      const existing = this._values.get(storeKey);
      if (!existing) continue;
      this._removeDependencyLinks(storeKey, existing.dependencies);
      this._values.delete(storeKey);
    }

    return [...targets];
  }

  _addDependencyLinks(storeKey, dependencies = []) {
    for (const dependency of dependencies) {
      const dependencyKey = String(dependency);
      if (!this._dependencyIndex.has(dependencyKey)) {
        this._dependencyIndex.set(dependencyKey, new Set());
      }
      this._dependencyIndex.get(dependencyKey).add(storeKey);
    }
  }

  _removeDependencyLinks(storeKey, dependencies = []) {
    for (const dependency of dependencies) {
      const dependencyKey = String(dependency);
      const dependents = this._dependencyIndex.get(dependencyKey);
      if (!dependents) continue;
      dependents.delete(storeKey);
      if (dependents.size === 0) this._dependencyIndex.delete(dependencyKey);
    }
  }
}

export default DerivedQuantityStore;
