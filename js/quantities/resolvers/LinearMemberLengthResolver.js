/**
 * @fileoverview STB線材要素の実部材長を節点・オフセットから解決する。
 * Three.js は使用せず、既存 GeometryCalculator の Pure JS 配置契約を再利用する。
 */

import { applyOffset, calculateDistance } from '../../viewer/geometry/core/GeometryCalculator.js';
import { QuantityStatus } from '../core/QuantityStatus.js';

function plainPoint(node) {
  if (!node) return null;
  const x = Number(node.x);
  const y = Number(node.y);
  const z = Number(node.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function nodeLookup(nodes, id) {
  if (!nodes || typeof nodes.get !== 'function' || id === null || id === undefined) return null;
  return nodes.get(String(id)) || nodes.get(id) || null;
}

function unavailable(status, warning, dependencies = []) {
  return {
    status,
    lengthMm: null,
    dependencies: [...new Set(dependencies)],
    warnings: [warning],
  };
}

function readOffsetComponent(value, label) {
  if (value === null || value === undefined || value === '') return { value: 0 };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} は有限値である必要があります` };
  }
  return { value: parsed };
}

function readOffset(source, keys, label) {
  const x = readOffsetComponent(source?.[keys.x], `${label}.${keys.x}`);
  if (x.error) return x;
  const y = readOffsetComponent(source?.[keys.y], `${label}.${keys.y}`);
  if (y.error) return y;
  const z = readOffsetComponent(source?.[keys.z], `${label}.${keys.z}`);
  if (z.error) return z;
  return { offset: { x: x.value, y: y.value, z: z.value } };
}

function endpointContract(shortType, element) {
  if (shortType === 'Column' || shortType === 'Post') {
    return {
      start: {
        id: element?.id_node_bottom,
        offset: readOffset(
          element,
          { x: 'offset_bottom_X', y: 'offset_bottom_Y', z: 'offset_bottom_Z' },
          '始端オフセット',
        ),
      },
      end: {
        id: element?.id_node_top,
        offset: readOffset(
          element,
          { x: 'offset_top_X', y: 'offset_top_Y', z: 'offset_top_Z' },
          '終端オフセット',
        ),
      },
    };
  }

  return {
    start: {
      id: element?.id_node_start,
      offset: readOffset(
        element,
        { x: 'offset_start_X', y: 'offset_start_Y', z: 'offset_start_Z' },
        '始端オフセット',
      ),
    },
    end: {
      id: element?.id_node_end,
      offset: readOffset(
        element,
        { x: 'offset_end_X', y: 'offset_end_Y', z: 'offset_end_Z' },
        '終端オフセット',
      ),
    },
  };
}

function viaStations(element) {
  if (!Array.isArray(element?.quantityViaNodes)) return [];
  return element.quantityViaNodes.map((via, index) => ({
    id: via?.id_node,
    offset: readOffset(
      via,
      { x: 'offset_X', y: 'offset_Y', z: 'offset_Z' },
      `中間節点オフセット[${index}]`,
    ),
  }));
}

/**
 * @param {string} elementType StbColumn/StbPost/StbGirder/StbBeam/StbBrace
 * @param {Object} element
 * @param {Map} nodes
 */
export function resolveLinearMemberLength(elementType, element, nodes) {
  const shortType = String(elementType || '').replace(/^Stb/, '');
  const endpoints = endpointContract(shortType, element);
  const stations = [endpoints.start, ...viaStations(element), endpoints.end];
  const dependencies = stations
    .map((station) => station.id)
    .filter((id) => id !== null && id !== undefined && id !== '')
    .map((id) => `StbNode:${id}`);

  for (const station of stations) {
    if (station.offset?.error) {
      return unavailable(QuantityStatus.INVALID_GEOMETRY, station.offset.error, dependencies);
    }
  }

  const points = [];
  for (const station of stations) {
    const point = plainPoint(nodeLookup(nodes, station.id));
    if (!point) {
      return unavailable(
        QuantityStatus.INSUFFICIENT_DATA,
        `部材経路の節点を解決できません: ${station.id ?? '(missing)'}`,
        dependencies,
      );
    }
    points.push(applyOffset(point, station.offset.offset));
  }

  let lengthMm = 0;
  for (let index = 1; index < points.length; index++) {
    const segmentLength = calculateDistance(points[index - 1], points[index]);
    if (!Number.isFinite(segmentLength) || segmentLength <= 0) {
      return unavailable(
        QuantityStatus.INVALID_GEOMETRY,
        `オフセット適用後の部材経路に0以下の区間長があります: ${index - 1}-${index}`,
        dependencies,
      );
    }
    lengthMm += segmentLength;
  }

  if (!Number.isFinite(lengthMm) || lengthMm <= 0) {
    return unavailable(
      QuantityStatus.INVALID_GEOMETRY,
      'オフセット適用後の部材長が0以下です',
      dependencies,
    );
  }

  return {
    status: QuantityStatus.CALCULATED,
    lengthMm,
    dependencies: [...new Set(dependencies)],
    warnings: [],
  };
}
