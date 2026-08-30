/**
 * Type13: v2.1.0→v2.1.1 で必要な追加修正 (schema compliance fixups)
 *
 * これらの変換は v2.0.2→v2.1.0 の変換ルール (type8/11/12) では対応していなかった
 * XSD 検証エラーを修正します。
 *
 * 対象:
 *   1. StbSecBarPile_RC_TopBottom/Same: 属性リネーム (circumference_1st 系)
 *   2. StbSecBarFoundation_RC_Continuous: pos 値リネーム + 必須属性補完
 *   3. StbSecLipC: type=SINGLE → type削除, BACKTOBACK/FACETOFACE → StbSecLip2C にリネーム
 *   4. StbSecBaseProduct_S → StbSecBaseProduct にリネーム + product_company 削除
 *   5. StbSecBaseConventionalAnchorBolts: 必須属性を AnchorBolt から昇格
 *   6. StbSecPilePrecast_*: product_company/product_code 削除
 *   7. StbGirder.isFoundation: 空文字列を削除
 *   8. StbSecPile_RC.strength_concrete: v2.1.1 では不可なので削除
 *   9. StbSecBaseConventionalPlate: B_X/B_Y/t = 0 → 最小値補正
 *  10. StbSecBarArrangementFoundation_RC: depth_cover=0 補正、空 pos/D 補完
 */

import logger from '../utils/converter-logger.js';
import { getStbSections } from '../utils/xml-helper.js';
import {
  fixBarArrangementFoundationEmpty,
  fixBarFoundationContinuous,
  fixBaseConventionalAnchorBolts,
  fixBaseConventionalPlate,
  fixBaseProductS,
  reverseBarFoundationDuplicates,
} from './type13-211-foundation-fixups.js';
import {
  applyCanonicalChildOrder,
  fixEmptyBooleanAttrs,
  fixFoundationColumnZeroIds,
  fixInvalidGuids,
  fixJointArrangementDistance,
} from './type13-211-model-fixups.js';

export { reverseBarFoundationDuplicates };
export { applyCanonicalChildOrder, fixInvalidGuids };

const PILE_BAR_ATTR_RENAME = {
  D_main_circumference_1st: 'D_main',
  N_main_circumference_1st: 'N_main',
  D_main_circumference_2nd: 'D_2nd_main',
  N_main_circumference_2nd: 'N_2nd_main',
  D_main_core: 'D_core',
  N_main_core: 'N_core',
  strength_main_circumference_1st: 'strength_main',
  strength_main_circumference_2nd: 'strength_2nd_main',
  D_band: 'D_band',
  strength_band: 'strength_band',
  pitch_band: 'pitch_band',
};

function fixBarPileRcTopBottom(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;

  const pileRc = sections['StbSecPile_RC'] || [];
  pileRc.forEach((pile) => {
    const conv = pile['StbSecPile_RC_Conventional']?.[0];
    const barArr =
      conv?.['StbSecBarArrangementPile_RC_Conventional']?.[0] ??
      pile['StbSecBarArrangementPile_RC']?.[0];
    if (!barArr) return;

    for (const elemName of ['StbSecBarPile_RC_TopBottom', 'StbSecBarPile_RC_Same']) {
      const elems = barArr[elemName] || [];
      elems.forEach((el) => {
        const attrs = el['$'];
        if (!attrs) return;
        for (const [oldName, newName] of Object.entries(PILE_BAR_ATTR_RENAME)) {
          if (oldName === newName) continue;
          if (Object.prototype.hasOwnProperty.call(attrs, oldName)) {
            attrs[newName] = attrs[oldName];
            delete attrs[oldName];
            count++;
          }
        }
        for (const k of Object.keys(attrs)) {
          if (attrs[k] === '') {
            delete attrs[k];
            count++;
          }
        }
        if (!attrs.D_main || attrs.D_main === '') attrs.D_main = 'D19';
        if (!attrs.N_main || attrs.N_main === '0') attrs.N_main = '6';
        if (!attrs.D_band) attrs.D_band = 'D10';
        if (!attrs.pitch_band || attrs.pitch_band === '0' || attrs.pitch_band === '0.0')
          attrs.pitch_band = '150';
      });
    }
  });

  if (count > 0) logger.info(`Fixed ${count} StbSecBarPile_RC_* attribute issues`);
}

function fixLipCSections(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  const steelSections = sections['StbSecSteel'];
  if (!steelSections) return;

  let count = 0;

  steelSections.forEach((steelSection) => {
    const lipCs = steelSection['StbSecLipC'];
    if (!lipCs) return;

    const lip2cList = steelSection['StbSecLip2C'] || [];

    const keptLipCs = [];
    lipCs.forEach((el) => {
      const attrs = el['$'] || {};
      const type = attrs.type;

      if (!type || type === 'SINGLE') {
        const newAttrs = { ...attrs };
        delete newAttrs.type;
        el['$'] = newAttrs;
        keptLipCs.push(el);
        if (type) count++;
      } else {
        lip2cList.push(el);
        count++;
      }
    });

    steelSection['StbSecLipC'] = keptLipCs.length > 0 ? keptLipCs : undefined;
    if (keptLipCs.length === 0) delete steelSection['StbSecLipC'];
    if (lip2cList.length > 0) steelSection['StbSecLip2C'] = lip2cList;
  });

  if (count > 0) logger.info(`Fixed ${count} StbSecLipC type attribute issues`);
}

const PRECAST_PILE_TYPES = [
  'StbSecPilePrecast_PHC',
  'StbSecPilePrecast_ST',
  'StbSecPilePrecast_SC',
  'StbSecPilePrecast_PRC',
  'StbSecPilePrecast_CPRC',
  'StbSecPilePrecastNodular_PHC',
  'StbSecPilePrecastNodular_PRC',
  'StbSecPilePrecastNodular_CPRC',
];

function fixPrecastPileAttrs(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;

  const precastPiles = sections['StbSecPilePrecast'] || [];
  precastPiles.forEach((pile) => {
    const conv = pile['StbSecPilePrecastConventional']?.[0];
    const figurePrecast = conv?.['StbSecFigurePilePrecast']?.[0] ?? conv;
    if (!figurePrecast) return;

    PRECAST_PILE_TYPES.forEach((typeName) => {
      const elements = figurePrecast[typeName] || [];
      elements.forEach((el) => {
        const attrs = el['$'];
        if (!attrs) return;
        if (attrs.product_company !== undefined) {
          delete attrs.product_company;
          count++;
        }
        if (attrs.product_code !== undefined) {
          delete attrs.product_code;
          count++;
        }
      });
    });
  });

  if (count > 0)
    logger.info(`Removed ${count} invalid product_company/product_code from precast pile elements`);
}

function fixPileRcAttrs(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;
  const pileRc = sections['StbSecPile_RC'] || [];
  pileRc.forEach((pile) => {
    const attrs = pile['$'];
    if (attrs && attrs.strength_concrete !== undefined) {
      delete attrs.strength_concrete;
      count++;
    }
  });

  if (count > 0) logger.info(`Removed ${count} StbSecPile_RC.strength_concrete attributes`);
}

export function applySchemaComplianceFixups(stbRoot) {
  fixBarPileRcTopBottom(stbRoot);
  fixBarFoundationContinuous(stbRoot);
  fixBarArrangementFoundationEmpty(stbRoot);
  fixLipCSections(stbRoot);
  fixBaseProductS(stbRoot);
  fixBaseConventionalAnchorBolts(stbRoot);
  fixBaseConventionalPlate(stbRoot);
  fixPrecastPileAttrs(stbRoot);
  fixEmptyBooleanAttrs(stbRoot);
  fixPileRcAttrs(stbRoot);
  fixJointArrangementDistance(stbRoot);
  fixFoundationColumnZeroIds(stbRoot);
  fixInvalidGuids(stbRoot);
  applyCanonicalChildOrder(stbRoot);
}
