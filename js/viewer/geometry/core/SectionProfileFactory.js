/**
 * @fileoverview 断面プロファイル生成ファクトリ
 *
 * IFCProfileFactory を優先し、失敗時は ProfileCalculator にフォールバックする
 * プロファイル生成ロジックを集約します（ProfileCreationUtils から分割）。
 *
 * @module viewer/geometry/core/SectionProfileFactory
 */

import { calculateProfile } from './ProfileCalculator.js';
import { convertProfileToThreeShape } from './ThreeJSConverter.js';
import { IFCProfileFactory } from '../IFCProfileFactory.js';
import { mapToProfileParams } from './ProfileParameterMapper.js';

/**
 * Viewer要素向けの汎用断面プロファイルを作成する。
 *
 * 寸法オブジェクトを直接 IFCProfileFactory へ渡し、対応しない断面は
 * ProfileCalculator にフォールバックする。梁・ブレース・杭で共有する。
 *
 * @param {Object} sectionData - 断面データ
 * @param {string} sectionType - 断面タイプ
 * @param {Object} element - 要素データ（ログ用）
 * @param {Object} log - ロガー
 * @returns {Object|null} { shape, meta }
 */
export function createProfileFromSectionData(sectionData, sectionType, element, log) {
  const dims = sectionData.dimensions || sectionData;
  const dimsStr = stringifyForLog(dims);

  try {
    const ifcProfile = IFCProfileFactory.createProfile(sectionType, dims);

    if (ifcProfile) {
      log.debug(`Element ${element?.id}: profile created via IFCProfileFactory (${sectionType})`);
      return {
        shape: convertProfileToThreeShape({
          vertices: ifcProfile.points,
          _meta: { type: sectionType === 'PIPE' ? 'circular' : 'polygon' },
        }),
        meta: {
          profileSource: 'IFCProfileFactory',
          profileType: sectionType,
          ...ifcProfile.metadata,
        },
      };
    }

    log.debug(
      `Element ${element?.id}: IFCProfileFactory returned null for sectionType=${sectionType}, dims=${dimsStr}`,
    );
  } catch (error) {
    log.warn(`Element ${element?.id}: IFCProfileFactory failed - ${error.message}`);
  }

  try {
    const profilePoints = calculateProfile(sectionType, dims);
    const hasVertices =
      profilePoints &&
      ((Array.isArray(profilePoints) && profilePoints.length > 0) ||
        (profilePoints.vertices && profilePoints.vertices.length > 0));

    if (hasVertices) {
      log.debug(`Element ${element?.id}: profile created via ProfileCalculator (${sectionType})`);
      const profileData = Array.isArray(profilePoints)
        ? { vertices: profilePoints }
        : profilePoints;

      return {
        shape: convertProfileToThreeShape(profileData),
        meta: {
          profileSource: 'ProfileCalculator',
          profileType: sectionType,
          ...(profileData._meta ? { _meta: profileData._meta } : {}),
        },
      };
    }

    log.debug(
      `Element ${element?.id}: ProfileCalculator returned empty for sectionType=${sectionType}, dims=${dimsStr}`,
    );
  } catch (error) {
    log.warn(`Element ${element?.id}: ProfileCalculator failed - ${error.message}`);
  }

  log.error(`Element ${element?.id}: Failed to create profile for section type ${sectionType}`);
  return null;
}

function stringifyForLog(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * IFCProfileFactoryを使用したプロファイル生成を試行
 * @param {Object} sectionData - 断面データ
 * @param {string} sectionType - 断面タイプ
 * @param {Object} log - ロガー
 * @param {Object} [options] - オプション
 * @param {boolean} [options.supportCircle=false] - CIRCLE断面をサポートするか
 * @returns {Object|null} プロファイル結果
 */
export function tryIFCProfile(sectionData, sectionType, log, options = {}) {
  const { supportCircle = false } = options;
  const steelTypes = new Set(['H', 'BOX', 'PIPE', 'L', 'T', 'C', 'CIRCLE']);

  try {
    let ifcProfile = null;

    if (steelTypes.has(sectionType) && sectionData.steelShape) {
      ifcProfile = IFCProfileFactory.createProfileFromSTB(sectionData.steelShape, sectionType);
    } else if (sectionType === 'RECTANGLE') {
      const rectDims = sectionData.dimensions || sectionData;
      ifcProfile = {
        ProfileType: IFCProfileFactory.mapSTBToIFCProfileType('RECTANGLE'),
        ProfileName: `STB_RECT_${
          rectDims.width || rectDims.outer_width || rectDims.width_X || 'W'
        }x${rectDims.height || rectDims.outer_height || rectDims.width_Y || 'H'}`,
        ProfileParameters: {
          XDim: rectDims.width || rectDims.outer_width || rectDims.width_X,
          YDim: rectDims.height || rectDims.outer_height || rectDims.width_Y || rectDims.depth,
        },
      };
    } else if (supportCircle && sectionType === 'CIRCLE') {
      const circleDims = sectionData.dimensions || sectionData;
      const diameter = circleDims.diameter || circleDims.D;
      if (diameter) {
        ifcProfile = {
          ProfileType: 'IfcCircleProfileDef',
          ProfileName: `STB_CIRCLE_D${diameter}`,
          ProfileParameters: {
            Radius: diameter / 2,
          },
        };
      }
    }

    if (ifcProfile) {
      const threeJSProfile = IFCProfileFactory.createGeometryFromProfile(ifcProfile, 'center');
      if (threeJSProfile) {
        log.debug(`IFC profile created successfully: ${ifcProfile.ProfileType}`);
        return {
          shape: threeJSProfile,
          meta: {
            profileSource: 'ifc',
            sectionTypeResolved: sectionType,
            factoryType: ifcProfile.ProfileType,
          },
        };
      }
    }
  } catch (error) {
    log.warn(`IFC profile creation failed for ${sectionType}: ${error?.message}`);
  }

  return null;
}

/**
 * ProfileCalculatorを使用したプロファイル生成（フォールバック）
 * @param {Object} sectionData - 断面データ
 * @param {string} sectionType - 断面タイプ
 * @param {Object} log - ロガー
 * @returns {Object|null} プロファイル結果
 */
export function createProfileUsingCalculator(sectionData, sectionType, log) {
  const dimensions = sectionData.dimensions || sectionData;
  const profileParams = mapToProfileParams(dimensions, sectionType);

  try {
    const profileData = calculateProfile(sectionType, profileParams);
    const threeShape = convertProfileToThreeShape(profileData);

    log.debug(`Profile created using ProfileCalculator: ${sectionType}`);

    return {
      shape: threeShape,
      meta: {
        profileSource: 'calculator',
        sectionTypeResolved: sectionType,
      },
    };
  } catch (error) {
    log.error(`ProfileCalculator creation failed for ${sectionType}: ${error?.message}`);
    return null;
  }
}

/**
 * 断面プロファイルを作成（IFC優先、フォールバックでProfileCalculator）
 * @param {Object} sectionData - 断面データ
 * @param {string} sectionType - 断面タイプ
 * @param {string} elementId - 要素ID（ログ用）
 * @param {Object} log - ロガー
 * @param {Object} [options] - IFCプロファイルオプション
 * @returns {Object|null} プロファイル結果
 */
export function createSectionProfile(sectionData, sectionType, elementId, log, options = {}) {
  log.debug(`Creating profile for ${elementId}: section_type=${sectionType}`);

  const ifcResult = tryIFCProfile(sectionData, sectionType, log, options);
  if (ifcResult) {
    return ifcResult;
  }

  return createProfileUsingCalculator(sectionData, sectionType, log);
}
