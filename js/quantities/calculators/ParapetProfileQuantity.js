/**
 * @fileoverview RCパラペット L/T 型の断面積・体積 calculator。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import { distance3d } from '../core/PanelMeasure.js';
import { elementsByTagName } from '../core/StbXmlDomUtils.js';

const VERSION = 2;

function firstDescendant(root, names) {
  for (const name of names) {
    const node = elementsByTagName(root, name)[0];
    if (node) return node;
  }
  return null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function identity(context) {
  return {
    elementType: context.elementType,
    elementId: context.element?.id,
    guid: context.element?.guid || null,
  };
}

function dependencies(context) {
  const result = [];
  for (const nodeId of [context.element?.id_node_start, context.element?.id_node_end]) {
    if (nodeId !== undefined && nodeId !== null && nodeId !== '') result.push(`StbNode:${nodeId}`);
  }
  if (context.section?.id !== undefined && context.section?.id !== null) {
    result.push(`${context.section.sectionType || 'StbSecParapet_RC'}:${context.section.id}`);
  }
  return [...new Set(result)];
}

function unavailable(context, status, warning) {
  return createUnavailableQuantityResult({
    identity: identity(context),
    status,
    values: {},
    basis: {
      method: 'PARAPET_PROFILE_PRISM',
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: VERSION,
      unitSystem: 'STB_MM',
    },
    dependencies: dependencies(context),
    warnings: [warning],
    revision: context.revision,
  });
}

function rawParapet(context) {
  const document = context.sectionNode?.ownerDocument;
  if (!document) return null;
  return (
    elementsByTagName(document, 'StbParapet').find(
      (node) => String(node.getAttribute?.('id')) === String(context.element?.id),
    ) || null
  );
}

function direction(context) {
  const value =
    context.element?.direction || rawParapet(context)?.getAttribute?.('direction') || null;
  const normalized = String(value || '').toUpperCase();
  return normalized === 'R' || normalized === 'L' ? normalized : null;
}

function parseProfile(node, kind) {
  const tT = positive(node?.getAttribute?.('t_T'));
  const depthH = positive(node?.getAttribute?.('depth_H'));
  const tT1 = positive(node?.getAttribute?.('t_T1'));
  const depthH1 = positive(node?.getAttribute?.('depth_H1'));
  const depthH2 = nonnegative(node?.getAttribute?.('depth_H2'));
  const depthH3 = kind === 'T' ? nonnegative(node?.getAttribute?.('depth_H3')) : 0;
  if (!tT || !depthH || !tT1 || !depthH1 || depthH2 === null || depthH3 === null) return null;
  const occupiedHeight = depthH1 + depthH2 + depthH3;
  if (occupiedHeight > depthH + 1e-7) return { invalid: true };
  // 図示断面: 縦ウェブ T×H + アゴの矩形 T1×H1 + 勾配部三角形 T1×H2/2。
  const areaMm2 = tT * depthH + tT1 * depthH1 + (tT1 * depthH2) / 2;
  return { tT, depthH, tT1, depthH1, depthH2, depthH3, areaMm2 };
}

export function calculateParapetProfileQuantity(context) {
  if (context?.elementType !== 'StbParapet') return null;
  const typeL = firstDescendant(context.sectionNode, ['StbSecParapet_RC_TypeL']);
  const typeT = firstDescendant(context.sectionNode, ['StbSecParapet_RC_TypeT']);
  const profileNode = typeL || typeT;
  if (!profileNode) return null;
  const kind = typeL ? 'L' : 'T';
  const profile = parseProfile(profileNode, kind);
  if (!profile) {
    return unavailable(
      context,
      QuantityStatus.INSUFFICIENT_DATA,
      `PARAPET_TYPE_${kind}_DIMENSIONS_MISSING`,
    );
  }
  if (profile.invalid) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `PARAPET_TYPE_${kind}_HEIGHTS_INVALID`,
    );
  }
  const side = direction(context);
  if (!side) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `PARAPET_TYPE_${kind}_DIRECTION_REQUIRED`,
    );
  }
  if (
    !Array.isArray(context.points) ||
    context.points.length !== 2 ||
    context.points.some((point) => !point)
  ) {
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'PARAPET_NODE_MISSING');
  }
  let lengthMm;
  try {
    lengthMm = distance3d(context.points[0], context.points[1]);
  } catch (error) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `PARAPET_LENGTH_INVALID:${error?.message || error}`,
    );
  }
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) {
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'PARAPET_LENGTH_INVALID');
  }
  const volumeMm3 = profile.areaMm2 * lengthMm;
  return createQuantityResult({
    identity: identity(context),
    status: QuantityStatus.CALCULATED,
    values: {
      lengthMm,
      sectionAreaMm2: profile.areaMm2,
      grossVolumeMm3: volumeMm3,
      netVolumeMm3: volumeMm3,
      concreteVolumeMm3: volumeMm3,
    },
    basis: {
      method: `PARAPET_TYPE_${kind}_PRISM`,
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: VERSION,
      unitSystem: 'STB_MM',
      direction: side,
      tTMm: profile.tT,
      depthHMm: profile.depthH,
      tT1Mm: profile.tT1,
      depthH1Mm: profile.depthH1,
      depthH2Mm: profile.depthH2,
      ...(kind === 'T' ? { depthH3Mm: profile.depthH3 } : {}),
    },
    dependencies: dependencies(context),
    warnings: [],
    revision: context.revision,
  });
}
