/**
 * Foundation and column-base schema compliance fixups for STB v2.1.1.
 */

import logger from '../utils/converter-logger.js';
import { getStbSections, renameKey } from '../utils/xml-helper.js';

const FOUNDATION_POS_RENAME = {
  MAIN_TOP: 'MAIN_BASE_TOP',
  MAIN_BOTTOM: 'MAIN_BASE_BOTTOM',
};

export function fixBarFoundationContinuous(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;

  const foundations = sections['StbSecFoundation_RC'] || [];
  foundations.forEach((foundation) => {
    const barArr = foundation['StbSecBarArrangementFoundation_RC']?.[0];
    if (!barArr) return;

    const continuous = barArr['StbSecBarFoundation_RC_Continuous'] || [];
    continuous.forEach((el) => {
      const attrs = el['$'];
      if (!attrs) return;

      if (attrs.pos && FOUNDATION_POS_RENAME[attrs.pos]) {
        attrs.pos = FOUNDATION_POS_RENAME[attrs.pos];
        count++;
      }
      if (attrs.pos === '' || attrs.pos === undefined) {
        attrs.pos = 'MAIN_BASE_TOP';
        count++;
      }

      if (attrs.D === '' || attrs.D === undefined) {
        attrs.D = 'D10';
        count++;
      }

      if (!attrs.N || attrs.N === '0') {
        attrs.N = '5';
        count++;
      }
      if (!attrs.pitch || attrs.pitch === '0' || attrs.pitch === '0.0') {
        attrs.pitch = '200';
        count++;
      }
    });

    const parentAttrs = barArr['$'] || {};
    for (const k of ['depth_cover_top', 'depth_cover_bottom', 'depth_cover_side']) {
      const v = parseFloat(parentAttrs[k]);
      if (!isNaN(v) && v <= 0) {
        parentAttrs[k] = '40';
        count++;
      }
    }
    barArr['$'] = parentAttrs;
  });

  if (count > 0) logger.info(`Fixed ${count} StbSecBarFoundation_RC_Continuous issues`);
}

export function fixBaseProductS(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;
  const colTypes = ['StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'];

  colTypes.forEach((colType) => {
    const cols = sections[colType] || [];
    cols.forEach((col) => {
      if (col['StbSecBaseProduct_S']) {
        col['StbSecBaseProduct_S'].forEach((el) => {
          const attrs = el['$'] || {};
          delete attrs.product_company;
          if (!attrs.release_time) attrs.release_time = '';
          el['$'] = attrs;
        });
        renameKey(col, 'StbSecBaseProduct_S', 'StbSecBaseProduct');
        count++;
      }
    });
  });

  if (count > 0) logger.info(`Renamed ${count} StbSecBaseProduct_S to StbSecBaseProduct`);
}

export function fixBaseConventionalAnchorBolts(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;

  const BOLTS_ALLOWED = new Set([
    'kind_bolt',
    'name_bolt',
    'L',
    'strength_bolt',
    'type_bolt',
    'R1',
    'R2',
    'Lt',
    'S1',
    'S2',
    'L1',
    'L2',
    'type_flame',
  ]);
  const BOLTS_RENAME = { length_bolt: 'L', arrangement_bolt: 'type_bolt' };
  const ARRANGEMENT_MAP = { STD: 'I', CUT: 'HOLEIN' };

  const colTypes = ['StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'];
  colTypes.forEach((colType) => {
    const cols = sections[colType] || [];
    cols.forEach((col) => {
      const baseConv = col['StbSecBaseConventional']?.[0];
      if (!baseConv) return;

      const boltsList = baseConv['StbSecBaseConventionalAnchorBolts'] || [];
      boltsList.forEach((bolts) => {
        const boltsAttrs = bolts['$'] || {};

        for (const [oldName, newName] of Object.entries(BOLTS_RENAME)) {
          if (Object.prototype.hasOwnProperty.call(boltsAttrs, oldName)) {
            let val = boltsAttrs[oldName];
            if (oldName === 'arrangement_bolt') val = ARRANGEMENT_MAP[val] ?? 'I';
            boltsAttrs[newName] = val;
            delete boltsAttrs[oldName];
            count++;
          }
        }

        for (const attr of Object.keys(boltsAttrs)) {
          if (!BOLTS_ALLOWED.has(attr)) {
            delete boltsAttrs[attr];
            count++;
          }
        }

        if (!boltsAttrs.kind_bolt) boltsAttrs.kind_bolt = 'STD';
        if (!boltsAttrs.name_bolt) boltsAttrs.name_bolt = 'M20';
        if (!boltsAttrs.L) boltsAttrs.L = '600';
        if (!boltsAttrs.strength_bolt) boltsAttrs.strength_bolt = 'SS400';
        if (!boltsAttrs.type_bolt) boltsAttrs.type_bolt = 'I';

        bolts['$'] = boltsAttrs;

        const boltEls = bolts['StbSecBaseConventionalAnchorBolt'] || [];
        const BOLT_KEEP = new Set(['id_order', 'offset_X', 'offset_Y']);
        boltEls.forEach((bolt, idx) => {
          const attrs = bolt['$'] || {};
          if (!attrs.id_order) attrs.id_order = String(idx + 1);
          const cleaned = {};
          for (const k of Object.keys(attrs)) {
            if (BOLT_KEEP.has(k)) cleaned[k] = attrs[k];
          }
          bolt['$'] = cleaned;
        });
      });
    });
  });

  if (count > 0) logger.info(`Fixed ${count} StbSecBaseConventionalAnchorBolts attribute issues`);
}

export function fixBaseConventionalPlate(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;
  const LENGTH_ATTRS = ['B_X', 'B_Y', 't', 'D_bolthole'];
  const colTypes = ['StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'];

  colTypes.forEach((colType) => {
    (sections[colType] || []).forEach((col) => {
      const baseConv = col['StbSecBaseConventional']?.[0];
      if (!baseConv) return;
      (baseConv['StbSecBaseConventionalPlate'] || []).forEach((plate) => {
        const attrs = plate['$'];
        if (!attrs) return;
        LENGTH_ATTRS.forEach((attr) => {
          const v = parseFloat(attrs[attr]);
          if (!isNaN(v) && v <= 0) {
            attrs[attr] = '1';
            count++;
          }
        });
      });
    });
  });

  if (count > 0) logger.info(`Fixed ${count} zero length values in StbSecBaseConventionalPlate`);
}

export function fixBarArrangementFoundationEmpty(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;
  const CHILD_TYPES = [
    'StbSecBarFoundation_RC_Rect',
    'StbSecBarFoundation_RC_Triangle',
    'StbSecBarFoundation_RC_ThreeWay',
    'StbSecBarFoundation_RC_Continuous',
  ];

  (sections['StbSecFoundation_RC'] || []).forEach((foundation) => {
    (foundation['StbSecBarArrangementFoundation_RC'] || []).forEach((barArr) => {
      for (const childType of CHILD_TYPES) {
        const elems = barArr[childType];
        if (!elems || elems.length === 0) continue;

        while (elems.length < 2) {
          const clone = JSON.parse(JSON.stringify(elems[elems.length - 1]));
          elems.push(clone);
          count++;
        }
        barArr[childType] = elems;
        break;
      }
    });
  });

  if (count > 0) logger.info(`Duplicated ${count} foundation bar elements to meet minOccurs=2`);
}

/**
 * Remove duplicate BarFoundationContinuous elements that were added to satisfy
 * v2.1.1 minOccurs=2. In v2.0.2 a single element per arrangement is valid.
 * @param {object} stbRoot
 */
export function reverseBarFoundationDuplicates(stbRoot) {
  const sections = getStbSections(stbRoot);
  if (!sections) return;

  let count = 0;
  const CHILD_TYPES = [
    'StbSecBarFoundation_RC_Rect',
    'StbSecBarFoundation_RC_Triangle',
    'StbSecBarFoundation_RC_ThreeWay',
    'StbSecBarFoundation_RC_Continuous',
  ];

  (sections['StbSecFoundation_RC'] || []).forEach((foundation) => {
    (foundation['StbSecBarArrangementFoundation_RC'] || []).forEach((barArr) => {
      for (const childType of CHILD_TYPES) {
        const elems = barArr[childType];
        if (!elems || elems.length < 2) continue;

        const seen = new Set();
        const unique = elems.filter((el) => {
          const sig = JSON.stringify(el['$'] || {});
          if (seen.has(sig)) {
            count++;
            return false;
          }
          seen.add(sig);
          return true;
        });
        if (unique.length !== elems.length) barArr[childType] = unique;
      }
    });
  });

  if (count > 0) logger.info(`Removed ${count} duplicate foundation bar elements (reverse fixup)`);
}
