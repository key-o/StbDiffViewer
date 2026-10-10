/**
 * @fileoverview 繧ｸ繧ｪ繝｡繝医Μ繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繝輔ぃ繧ｯ繝医Μ繝ｼ
 *
 * 隕∫ｴ繧ｿ繧､繝励↓蠢懊§縺溘ず繧ｪ繝｡繝医Μ繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧堤ｮ｡逅・・謠蝉ｾ帙＠縺ｾ縺吶・ * - 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧ｯ繝ｩ繧ｹ縺ｮ逋ｻ骭ｲ縺ｨ蜿門ｾ・ * - 繧､繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ縺ｮ繧ｭ繝｣繝・す繝･邂｡逅・ * - 隕∫ｴ繧ｿ繧､繝励→繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ縺ｮ繝槭ャ繝斐Φ繧ｰ
 */

import { createLogger } from '../../utils/logger.js';

import {
  ProfileBasedBeamGenerator,
  ProfileBasedBraceGenerator,
  ProfileBasedColumnGenerator,
  ProfileBasedFoundationColumnGenerator,
  ProfileBasedPostGenerator,
  ParapetGenerator,
  PileGenerator,
  FootingGenerator,
  DampingDeviceGenerator,
  IsolatingDeviceGenerator,
  JointGenerator,
  SlabGenerator,
  StripFootingGenerator,
  WallGenerator,
} from './generators/index.js';

const log = createLogger('GeometryGeneratorFactory');

/**
 * 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧ｯ繝ｩ繧ｹ縺ｮ繝槭ャ繝斐Φ繧ｰ
 * @type {Object.<string, {class: Function, method: string}>}
 */
const GENERATOR_MAP = {
  Column: {
    get class() {
      return ProfileBasedColumnGenerator;
    },
    method: 'createColumnMeshes',
  },
  Post: {
    get class() {
      return ProfileBasedPostGenerator;
    },
    method: 'createPostMeshes',
  },
  Girder: {
    get class() {
      return ProfileBasedBeamGenerator;
    },
    method: 'createBeamMeshes',
  },
  Beam: {
    get class() {
      return ProfileBasedBeamGenerator;
    },
    method: 'createBeamMeshes',
  },
  Brace: {
    get class() {
      return ProfileBasedBraceGenerator;
    },
    method: 'createBraceMeshes',
  },
  Pile: {
    get class() {
      return PileGenerator;
    },
    method: 'createPileMeshes',
  },
  Footing: {
    get class() {
      return FootingGenerator;
    },
    method: 'createFootingMeshes',
  },
  StripFooting: {
    get class() {
      return StripFootingGenerator;
    },
    method: 'createStripFootingMeshes',
  },
  FoundationColumn: {
    get class() {
      return ProfileBasedFoundationColumnGenerator;
    },
    method: 'createFoundationColumnMeshes',
  },
  Slab: {
    get class() {
      return SlabGenerator;
    },
    method: 'createSlabMeshes',
  },
  Wall: {
    get class() {
      return WallGenerator;
    },
    method: 'createWallMeshes',
  },
  Parapet: {
    get class() {
      return ParapetGenerator;
    },
    method: 'createParapetMeshes',
  },
  Joint: {
    get class() {
      return JointGenerator;
    },
    method: 'createJointMeshes',
  },
  IsolatingDevice: {
    get class() {
      return IsolatingDeviceGenerator;
    },
    method: 'createIsolatingDeviceMeshes',
  },
  DampingDevice: {
    get class() {
      return DampingDeviceGenerator;
    },
    method: 'createDampingDeviceMeshes',
  },
  FrameDampingDevice: {
    get class() {
      return WallGenerator;
    },
    method: 'createWallMeshes',
  },
};

/**
 * 繧ｸ繧ｪ繝｡繝医Μ繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繝輔ぃ繧ｯ繝医Μ繝ｼ繧ｯ繝ｩ繧ｹ
 */
export class GeometryGeneratorFactory {
  constructor() {
    /** @type {Map<string, Object>} 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧､繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ縺ｮ繧ｭ繝｣繝・す繝･ */
    this.instanceCache = new Map();
  }

  /**
   * 隕∫ｴ繧ｿ繧､繝励↓蟇ｾ蠢懊☆繧九ず繧ｧ繝阪Ξ繝ｼ繧ｿ諠・ｱ繧貞叙蠕・   * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・   * @returns {{class: Function, method: string}|null} 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ諠・ｱ
   */
  getGeneratorInfo(elementType) {
    return GENERATOR_MAP[elementType] || null;
  }

  /**
   * 隕∫ｴ繧ｿ繧､繝励↓蟇ｾ蠢懊☆繧九ず繧ｧ繝阪Ξ繝ｼ繧ｿ繧､繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ繧貞叙蠕・   * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・   * @returns {Object|null} 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧､繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ
   */
  getGenerator(elementType) {
    const info = this.getGeneratorInfo(elementType);
    if (!info) {
      log.warn(`Unknown element type: ${elementType}`);
      return null;
    }

    // 繧ｭ繝｣繝・す繝･縺九ｉ蜿門ｾ励√↑縺代ｌ縺ｰ譁ｰ隕丈ｽ懈・
    if (!this.instanceCache.has(elementType)) {
      try {
        // 髱咏噪繧ｯ繝ｩ繧ｹ縺ｮ蝣ｴ蜷医・繧ｯ繝ｩ繧ｹ閾ｪ菴薙ｒ霑斐☆
        if (this.isStaticGenerator(info.class)) {
          this.instanceCache.set(elementType, info.class);
        } else {
          this.instanceCache.set(elementType, new info.class());
        }
        log.debug(`Created generator instance for ${elementType}`);
      } catch (error) {
        log.error(`Failed to create generator for ${elementType}:`, error);
        return null;
      }
    }

    return this.instanceCache.get(elementType);
  }

  /**
   * 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ縺碁撕逧・け繝ｩ繧ｹ縺九←縺・°繧貞愛螳・   * @param {Function} GeneratorClass - 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧ｯ繝ｩ繧ｹ
   * @returns {boolean} 髱咏噪繧ｯ繝ｩ繧ｹ縺ｮ蝣ｴ蜷・rue
   */
  isStaticGenerator(GeneratorClass) {
    // 髱咏噪繝｡繧ｽ繝・ラ縺ｮ縺ｿ繧呈戟縺､繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧ｯ繝ｩ繧ｹ
    const staticGenerators = [
      JointGenerator,
      SlabGenerator,
      WallGenerator,
      ParapetGenerator,
      PileGenerator,
      FootingGenerator,
      StripFootingGenerator,
      IsolatingDeviceGenerator,
      DampingDeviceGenerator,
    ];
    return staticGenerators.includes(GeneratorClass);
  }

  /**
   * 隕∫ｴ繧ｿ繧､繝励↓蟇ｾ蠢懊☆繧九Γ繝・す繝･逕滓・繝｡繧ｽ繝・ラ繧貞叙蠕・   * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・   * @returns {string|null} 繝｡繧ｽ繝・ラ蜷・   */
  getGeneratorMethod(elementType) {
    const info = this.getGeneratorInfo(elementType);
    return info ? info.method : null;
  }

  /**
   * 繝｡繝・す繝･繧堤函謌・   * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・   * @param {Array} elements - 隕∫ｴ繝・・繧ｿ驟榊・
   * @param {Map} nodes - 遽轤ｹ繝槭ャ繝・   * @param {Object} sections - 譁ｭ髱｢繝・・繧ｿ
   * @param {Object} steelSections - 驩・ｪｨ譁ｭ髱｢繝・・繧ｿ
   * @param {boolean} [isJsonInput=false] - JSON蜈･蜉帙ヵ繝ｩ繧ｰ
   * @param {Object} [additionalData=null] - 霑ｽ蜉繝・・繧ｿ・磯幕蜿｣諠・ｱ縺ｪ縺ｩ・・   * @returns {Array} 逕滓・縺輔ｌ縺溘Γ繝・す繝･驟榊・
   */
  createMeshes(
    elementType,
    elements,
    nodes,
    sections,
    steelSections,
    isJsonInput = false,
    additionalData = null,
  ) {
    const generator = this.getGenerator(elementType);
    const method = this.getGeneratorMethod(elementType);

    if (!generator || !method) {
      log.warn(`Cannot create meshes for ${elementType}: generator or method not found`);
      return [];
    }

    try {
      // 髱咏噪繧ｯ繝ｩ繧ｹ縺ｮ蝣ｴ蜷医・繧ｯ繝ｩ繧ｹ繝｡繧ｽ繝・ラ繧堤峩謗･蜻ｼ縺ｳ蜃ｺ縺・
      if (this.isStaticGenerator(generator.constructor || generator)) {
        return generator[method](
          elements,
          nodes,
          sections,
          steelSections,
          elementType,
          isJsonInput,
          additionalData,
        );
      }
      return generator[method](
        elements,
        nodes,
        sections,
        steelSections,
        elementType,
        isJsonInput,
        additionalData,
      );
    } catch (error) {
      log.error(`Failed to create meshes for ${elementType}:`, error);
      return [];
    }
  }

  /**
   * 繧ｭ繝｣繝・す繝･繧偵け繝ｪ繧｢
   */
  clearCache() {
    this.instanceCache.clear();
    log.debug('Generator instance cache cleared');
  }

  /**
   * 繧ｵ繝昴・繝医＆繧後※縺・ｋ隕∫ｴ繧ｿ繧､繝励・荳隕ｧ繧貞叙蠕・   * @returns {string[]} 隕∫ｴ繧ｿ繧､繝励・驟榊・
   */
  getSupportedTypes() {
    return Object.keys(GENERATOR_MAP);
  }

  /**
   * 隕∫ｴ繧ｿ繧､繝励′繧ｵ繝昴・繝医＆繧後※縺・ｋ縺九ｒ遒ｺ隱・   * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・   * @returns {boolean} 繧ｵ繝昴・繝医＆繧後※縺・ｋ蝣ｴ蜷・rue
   */
  isSupported(elementType) {
    return elementType in GENERATOR_MAP;
  }
}

// 繧ｷ繝ｳ繧ｰ繝ｫ繝医Φ繧､繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ
export const geometryGeneratorFactory = new GeometryGeneratorFactory();

// 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繧ｯ繝ｩ繧ｹ縺ｮ逶ｴ謗･繧ｨ繧ｯ繧ｹ繝昴・繝茨ｼ亥､夜Κ繝｢繧ｸ繝･繝ｼ繝ｫ縺九ｉ縺ｮ蛻ｩ逕ｨ逕ｨ
export {
  ProfileBasedBraceGenerator,
  ProfileBasedColumnGenerator,
  ProfileBasedPostGenerator,
  ProfileBasedBeamGenerator,
  PileGenerator,
  FootingGenerator,
  ProfileBasedFoundationColumnGenerator,
  SlabGenerator,
  WallGenerator,
  ParapetGenerator,
  JointGenerator,
  StripFootingGenerator,
  IsolatingDeviceGenerator,
  DampingDeviceGenerator,
};

// 繧ｸ繧ｧ繝阪Ξ繝ｼ繧ｿ繝槭ャ繝励・繧ｨ繧ｯ繧ｹ繝昴・繝茨ｼ郁ｨｭ螳壼盾辣ｧ逕ｨ
export { GENERATOR_MAP };
