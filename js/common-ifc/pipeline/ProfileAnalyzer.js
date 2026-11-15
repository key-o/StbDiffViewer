/**
 * @fileoverview Stage 5: 断面プロファイル解析
 *
 * IFC要素の表現(Representation)から断面プロファイルを抽出し、
 * STB断面情報に変換する。同一断面は重複排除して共有する。
 *
 * @module ProfileAnalyzer
 */

import * as WebIFC from 'web-ifc';
import { readIfcRectangularBrepLoft } from './BrepSectionReader.js';
import { decodeSteelProfileMetadata } from './StbSteelProfileMetadata.js';
import {
  extractStbSectionFromProfile,
  buildSectionKey,
} from '../mapping/IfcProfileToStbSection.js';
import { collectMappedItemLeaves, getUniformScale } from '../util/CoordinateHelper.js';

export class ProfileAnalyzer {
  /**
   * @param {Object} api - web-ifc IfcAPI
   * @param {number} modelID
   * @param {number} unitFactor - mm変換係数
   */
  constructor(api, modelID, unitFactor) {
    this.api = api;
    this.modelID = modelID;
    this.unitFactor = unitFactor;

    /** @type {Map<string, Object>} sectionKey → section定義 */
    this.sectionMap = new Map();
    this.nextSectionId = 1;
  }

  /**
   * 要素のRepresentationからプロファイルを抽出し、断面IDを返す
   * @param {number} representationRef - IFCPRODUCTDEFINITIONSHAPE の expressID
   * @returns {{ sectionId: string, sectionInfo: Object, length: number } | null}
   */
  analyzeElement(representationRef, options = {}) {
    if (!representationRef) return null;

    const productShape = this.api.GetLine(this.modelID, representationRef);
    if (!productShape) return null;

    const representations = (productShape.Representations || [])
      .map((ref) => this.api.GetLine(this.modelID, ref?.value ?? ref))
      .filter(Boolean);
    const isBrepBody = (rep) =>
      (rep.RepresentationIdentifier?.value ?? rep.RepresentationIdentifier) === 'Body' &&
      (rep.RepresentationType?.value ?? rep.RepresentationType) === 'Brep';

    // A beam with an explicit BRep Body must be judged by that actual geometry.
    // If it is unsupported, do not manufacture a seemingly valid STB section
    // from a different, auxiliary SweptSolid representation.
    const beamBrepBodies =
      options.element?.stbCategory === 'beam' ? representations.filter(isBrepBody) : [];
    const candidates = beamBrepBodies.length ? beamBrepBodies : representations;

    for (const rep of candidates) {
      // Body表現を優先
      const repType = rep.RepresentationType?.value ?? rep.RepresentationType ?? '';
      const repId2 = rep.RepresentationIdentifier?.value ?? rep.RepresentationIdentifier ?? '';
      // A BRep-shaped auxiliary representation is not the beam's physical Body.
      if (options.element?.stbCategory === 'beam' && repType === 'Brep' && repId2 !== 'Body')
        continue;
      if (
        repId2 !== 'Body' &&
        repType !== 'SweptSolid' &&
        repType !== 'Brep' &&
        repType !== 'MappedRepresentation' &&
        repType !== 'Clipping'
      ) {
        continue;
      }

      const items = rep.Items || [];
      for (const itemRef of items) {
        const itemId = itemRef?.value ?? itemRef;
        const result = this._extractFromItem(itemId, {
          ...options,
          productShapeRef: representationRef,
          brepOnly: beamBrepBodies.length > 0,
        });
        if (result) return result;
      }
    }

    return null;
  }

  /**
   * 表現アイテムからプロファイルと長さを再帰的に抽出
   * @param {number} itemId
   * @returns {{ sectionId: string, sectionInfo: Object, length: number } | null}
   */
  _extractFromItem(itemId, options = {}) {
    // Resolve nested mapped representations and retain the placement transform.
    // An unrepresentable BRep Body never falls back to an auxiliary SweptSolid.
    const leaves = collectMappedItemLeaves(this.api, this.modelID, itemId);
    for (const leaf of leaves) {
      const item = leaf.item;
      if (item.type === WebIFC.IFCEXTRUDEDAREASOLID && !options.brepOnly) {
        const result = this._handleExtrudedAreaSolid(item, {
          ...options,
          mappingTransform: leaf.mappingTransform,
        });
        if (result) return result;
      }
      if (item.type === WebIFC.IFCFACETEDBREP && options.element?.stbCategory === 'beam') {
        // The current BRep reader does not incorporate a mapped-item transform.
        // Reject it instead of returning an incorrectly positioned axis.
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        if (leaf.mappingTransform.some((value, index) => Math.abs(value - identity[index]) > 1e-10))
          continue;
        try {
          const measured = readIfcRectangularBrepLoft(
            this.api,
            this.modelID,
            options.productShapeRef,
            this.unitFactor,
          );
          return {
            sectionId: null,
            sectionInfo: null,
            length: measured.length,
            extrusionDirection: measured.direction,
            localAxisStart: measured.localAxisStart,
            localAxisEnd: measured.localAxisEnd,
            measuredBrepLoft: measured,
          };
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /**
   * IFCEXTRUDEDAREASOLID からプロファイルと押出長さを抽出
   */
  _handleExtrudedAreaSolid(item, options = {}) {
    // 押出長さ
    const depth = item.Depth?.value ?? item.Depth ?? 0;
    const lengthMM = depth * this.unitFactor;

    // SweptArea → プロファイル定義
    const sweptAreaRef = item.SweptArea?.value ?? item.SweptArea;
    if (!sweptAreaRef) return null;

    const profileEntity = this.api.GetLine(this.modelID, sweptAreaRef);
    if (!profileEntity) return null;

    const sectionInfo = extractStbSectionFromProfile(
      this.api,
      this.modelID,
      profileEntity,
      options.element || options.profileHint || {},
    );

    if (!sectionInfo) return null;

    // mm変換（IFC内の寸法値は長さ単位と同じ）
    const mappingScale = options.mappingTransform ? getUniformScale(options.mappingTransform) : 1;
    const convertedParams = {};
    for (const [key, value] of Object.entries(sectionInfo.params)) {
      convertedParams[key] = value * this.unitFactor * mappingScale;
    }
    const normalizedSectionInfo = {
      ...sectionInfo,
      params: convertedParams,
    };
    if (options.element?.stbCategory === 'footing' && Number.isFinite(lengthMM) && lengthMM > 0)
      normalizedSectionInfo.params.depth = lengthMM;
    const sourceSteel = decodeSteelProfileMetadata(
      profileEntity.ProfileName?.value,
      normalizedSectionInfo,
    );
    if (sourceSteel) {
      normalizedSectionInfo.sourceSteel = sourceSteel;
      normalizedSectionInfo.name = sourceSteel.name;
    }

    if (options.skipSectionRegistration) {
      return {
        sectionId: null,
        sectionInfo: normalizedSectionInfo,
        length: Math.round(lengthMM * 100) / 100,
        extrusionDirection: this._resolveExtrusionDirection(item),
        mappingTransform: options.mappingTransform,
        extrusionPositionRef: item.Position?.value ?? item.Position ?? null,
      };
    }

    const section = this.registerSection(normalizedSectionInfo);
    return {
      sectionId: section.id,
      sectionInfo: section,
      length: Math.round(lengthMM * 100) / 100,
      extrusionDirection: this._resolveExtrusionDirection(item),
      mappingTransform: options.mappingTransform,
      extrusionPositionRef: item.Position?.value ?? item.Position ?? null,
    };
  }

  _resolveExtrusionDirection(item) {
    const dirRef = item.ExtrudedDirection?.value ?? item.ExtrudedDirection;
    if (!dirRef) return { x: 0, y: 0, z: 1 };

    let direction;
    try {
      direction = this.api.GetLine(this.modelID, dirRef);
    } catch {
      return { x: 0, y: 0, z: 1 };
    }

    const ratios = direction?.DirectionRatios;
    if (!ratios) return { x: 0, y: 0, z: 1 };

    const x = ratios[0]?.value ?? ratios[0] ?? 0;
    const y = ratios[1]?.value ?? ratios[1] ?? 0;
    const z = ratios[2]?.value ?? ratios[2] ?? 1;
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    return { x: x / length, y: y / length, z: z / length };
  }

  registerSection(sectionInfo) {
    if (!sectionInfo) return null;

    const key = this._buildSectionRegistryKey(sectionInfo);
    if (!this.sectionMap.has(key)) {
      const sectionId = String(this.nextSectionId++);
      this.sectionMap.set(key, {
        id: sectionId,
        ...sectionInfo,
      });
    }

    return this.sectionMap.get(key);
  }

  _buildSectionRegistryKey(sectionInfo) {
    if (sectionInfo?.sectionKey) return sectionInfo.sectionKey;
    if (sectionInfo?.sourceSteel)
      return JSON.stringify({
        type: sectionInfo.stbType,
        params: sectionInfo.params,
        sourceSteel: sectionInfo.sourceSteel,
      });

    const params = sectionInfo?.params || {};
    const requiresDetailedKey =
      String(sectionInfo?.stbType || '').startsWith('PILE_') ||
      Array.isArray(sectionInfo?.segments) ||
      !!sectionInfo?.pileTagName ||
      !!sectionInfo?.pileType;
    const isNumericOnly = Object.values(params).every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    );

    if (isNumericOnly && !requiresDetailedKey) {
      return buildSectionKey(sectionInfo.stbType, params);
    }

    const sortedParams = Object.fromEntries(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    );

    return JSON.stringify({
      stbType: sectionInfo?.stbType || '',
      name: sectionInfo?.name || '',
      pileTagName: sectionInfo?.pileTagName || null,
      pileType: sectionInfo?.pileType || null,
      params: sortedParams,
      segments: Array.isArray(sectionInfo?.segments)
        ? sectionInfo.segments.map((segment) =>
            Object.fromEntries(
              Object.entries(segment)
                .filter(([, value]) => value !== undefined)
                .sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
        : null,
    });
  }

  /**
   * 全断面定義を返す
   * @returns {Array<Object>}
   */
  getSections() {
    return [...this.sectionMap.values()];
  }
}
