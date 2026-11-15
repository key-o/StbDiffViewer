/**
 * @fileoverview Stage 2: 空間構造（階情報）抽出
 *
 * IFCBUILDINGSTOREY から階名・標高を取得し、
 * IFCRELCONTAINEDINSPATIALSTRUCTURE で要素→階のマッピングを構築する。
 *
 * @module SpatialStructureExtractor
 */

import * as WebIFC from 'web-ifc';
import { decodeStoryMetadata } from './StbStoryMetadata.js';

export class SpatialStructureExtractor {
  /**
   * @param {Object} api - web-ifc IfcAPI
   * @param {number} modelID
   * @param {number} unitFactor - mm変換係数
   */
  constructor(api, modelID, unitFactor) {
    this.api = api;
    this.modelID = modelID;
    this.unitFactor = unitFactor;
  }

  /**
   * 階情報を抽出
   * @returns {{ stories: Array, elementToStory: Map<number, string> }}
   */
  extract() {
    const rawStoreys = this._getStoreys();

    // 標高でソート
    rawStoreys.sort((a, b) => a.elevation - b.elevation);

    // Reserve all sourced STB IDs before numbering third-party IFC storeys.
    // A generic floor must never shadow a genuine STB story ID, regardless
    // of IFC entity order or elevation. Preserve sourced lexical ID spelling.
    const usedIds = new Set();
    for (const raw of rawStoreys) {
      if (!raw.sourceStory) continue;
      const canonical = BigInt(raw.sourceStory.id).toString();
      if (usedIds.has(canonical)) {
        throw new Error(`Duplicate IFC-to-STB story id: ${raw.sourceStory.id}`);
      }
      usedIds.add(canonical);
    }

    let nextGeneratedId = 1n;
    const stories = rawStoreys.map((s, idx) => {
      let id = s.sourceStory?.id;
      if (id == null) {
        while (usedIds.has(nextGeneratedId.toString())) nextGeneratedId += 1n;
        id = nextGeneratedId.toString();
        usedIds.add(id);
        nextGeneratedId += 1n;
      }
      return {
        id,
        name: s.name || `${idx + 1}FL`,
        height: Math.round(s.elevation * this.unitFactor * 100) / 100,
        kind: s.sourceStory?.kind ?? 'GENERAL',
        _expressID: s.expressID, // 内部参照用
      };
    });

    // 要素expressID → 階IDのマッピング
    const elementToStory = this._buildElementToStoryMap(rawStoreys, stories);

    return { stories, elementToStory };
  }

  /**
   * IFCBUILDINGSTOREY 一覧を取得
   */
  _getStoreys() {
    const storeys = [];
    const ids = this.api.GetLineIDsWithType(this.modelID, WebIFC.IFCBUILDINGSTOREY);

    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const line = this.api.GetLine(this.modelID, id);
      const rawElevation = line.Elevation?.value ?? line.Elevation;
      const numericElevation = Number(rawElevation);
      // IFCBUILDINGSTOREY.Elevation is optional. An absent or invalid value
      // cannot be silently replaced with GL=0 in the emitted STB model.
      if (
        (typeof rawElevation !== 'number' && typeof rawElevation !== 'string') ||
        (typeof rawElevation === 'string' &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawElevation.trim())) ||
        !Number.isFinite(numericElevation)
      ) {
        throw new Error(`IFC storey ${id}: measured elevation is unavailable`);
      }
      storeys.push({
        expressID: id,
        name: line.Name?.value || line.LongName?.value || null,
        elevation: numericElevation,
        sourceStory: decodeStoryMetadata(line.Description?.value ?? line.Description),
      });
    }

    return storeys;
  }

  /**
   * IFCRELCONTAINEDINSPATIALSTRUCTURE から要素→階マッピングを構築
   */
  _buildElementToStoryMap(rawStoreys, stories) {
    const map = new Map();

    // expressID → STB story ID のマップ
    const storeyIdMap = new Map();
    for (let i = 0; i < rawStoreys.length; i++) {
      storeyIdMap.set(rawStoreys[i].expressID, stories[i].id);
    }

    const relIds = this.api.GetLineIDsWithType(
      this.modelID,
      WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE,
    );

    for (let i = 0; i < relIds.size(); i++) {
      const rel = this.api.GetLine(this.modelID, relIds.get(i));
      const structureRef = rel.RelatingStructure;
      const structureId = structureRef?.value ?? structureRef;
      const storyId = storeyIdMap.get(structureId);
      if (!storyId) continue;

      const elements = rel.RelatedElements || [];
      for (const elemRef of elements) {
        const elemId = elemRef?.value ?? elemRef;
        if (elemId) map.set(elemId, storyId);
      }
    }

    return map;
  }
}
