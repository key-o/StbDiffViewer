import * as THREE from 'three';
import { createLogger } from '../utils/logger.js';
import { getNodePositions } from '../viewer/index.js';
import { getDefaultScene } from './geometryInspector.js';
import { getState } from '../data/state/globalState.js';

const log = createLogger('diagnostics:geomMismatch');

const ELEMENT_NODE_CONFIG = {
  Beam: {
    nodeType: '2node-horizontal',
    startKey: 'id_node_start',
    endKey: 'id_node_end',
  },
  Girder: {
    nodeType: '2node-horizontal',
    startKey: 'id_node_start',
    endKey: 'id_node_end',
  },
  Brace: {
    nodeType: '2node-horizontal',
    startKey: 'id_node_start',
    endKey: 'id_node_end',
  },
  Column: {
    nodeType: '2node-vertical',
    startKey: 'id_node_bottom',
    endKey: 'id_node_top',
  },
  Post: {
    nodeType: '2node-vertical',
    startKey: 'id_node_bottom',
    endKey: 'id_node_top',
  },
  Pile: {
    nodeType: '2node-vertical',
    startKey: 'id_node_bottom',
    endKey: 'id_node_top',
  },
};

const DEFAULT_THRESHOLDS = {
  positionToleranceMm: 3,
  positionFailMm: 15,
  lengthToleranceMm: 1,
  lengthFailMm: 5,
  lengthToleranceRatio: 0.002,
  lengthFailRatio: 0.01,
  angleToleranceDeg: 0.1,
  angleFailDeg: 2,
};

const DEFAULT_SCAN_OPTIONS = {
  elementTypes: null,
  limit: Infinity,
  thresholds: DEFAULT_THRESHOLDS,
};

function scanSceneForGeometryMismatches(scene, options = {}) {
  const targetScene = scene || getDefaultScene();
  if (!targetScene) {
    log.warn('Scene not available for geometry mismatch scan');
    return { summary: createSummary([], DEFAULT_THRESHOLDS), results: [] };
  }

  const mergedOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    ...options,
    thresholds: mergeThresholds(options.thresholds),
  };

  const nodeMaps = resolveNodeMaps(options.nodeMaps);
  const elementFilter = buildElementFilter(mergedOptions.elementTypes);
  const results = [];

  targetScene.traverse((obj) => {
    if (results.length >= mergedOptions.limit) {
      return;
    }
    if (!obj.isMesh || !obj.userData?.elementId) {
      return;
    }
    if (elementFilter && !elementFilter.has(obj.userData.elementType)) {
      return;
    }

    const report = analyzeMeshInternal(obj, nodeMaps, mergedOptions.thresholds);
    if (report) {
      results.push(report);
    }
  });

  return {
    summary: createSummary(results, mergedOptions.thresholds),
    results,
  };
}

export function analyzeMeshGeometry(mesh, options = {}) {
  const thresholds = mergeThresholds(options.thresholds);
  const nodeMaps = resolveNodeMaps(options.nodeMaps);
  return analyzeMeshInternal(mesh, nodeMaps, thresholds);
}

function highlightGeometryMismatches(scene, report, options = {}) {
  if (!scene || !report?.results?.length) {
    return 0;
  }
  const severityFilter = new Set(
    (options.severity && [].concat(options.severity)) || ['warn', 'error'],
  );
  const severityMap = new Map();
  for (const entry of report.results) {
    if (severityFilter.has(entry.severity)) {
      severityMap.set(serializeElementKey(entry), entry);
    }
  }
  let highlighted = 0;

  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.userData?.elementId) {
      return;
    }
    const key = serializeElementKey({
      elementId: obj.userData.elementId,
      modelSource: obj.userData.modelSource || obj.userData.comparison || null,
    });
    const entry = severityMap.get(key);
    if (!entry) {
      return;
    }
    highlighted++;
    applyHighlight(obj, entry.severity);
  });

  return highlighted;
}

function showGeometryMismatchPanel(report, options = {}) {
  if (!report?.results?.length) {
    return;
  }
  const tolerance = options.tolerancePercent ?? 0.2;
  const maxEntries = options.maxEntries ?? 80;
  const rows = report.results
    .slice(0, maxEntries)
    .map((entry) => {
      const lengthDelta = formatDelta(entry.deltas.lengthAbs, entry.expected.length);
      const startOffset = entry.deltas.startOffset?.toFixed(2) ?? '-';
      const endOffset = entry.deltas.endOffset?.toFixed(2) ?? '-';
      const angle = entry.deltas.angleDeg?.toFixed(3) ?? '-';
      const badge =
        entry.severity === 'error'
          ? '#3a0010'
          : entry.severity === 'warn'
            ? '#3a2a00'
            : 'transparent';
      return `<tr style="background:${badge}"><td>${
        entry.elementType
      }</td><td>${entry.elementId}</td><td>${
        entry.modelSource || '-'
      }</td><td>${lengthDelta}</td><td>${startOffset}</td><td>${endOffset}</td><td>${angle}</td></tr>`;
    })
    .join('');

  const id = 'geom-mismatch-panel';
  let panel = document.getElementById(id);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = id;
    Object.assign(panel.style, {
      position: 'fixed',
      right: '12px',
      top: '12px',
      zIndex: 9999,
      width: '520px',
      maxHeight: '70vh',
      overflow: 'auto',
      background: 'rgba(10,10,16,0.95)',
      color: '#f2f2f2',
      border: '1px solid #333',
      borderRadius: '8px',
      padding: '8px',
      font: '12px/1.4 ui-monospace,Menlo,Consolas,monospace',
    });
    document.body.appendChild(panel);
  }

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <strong>ジオメトリ整合診断 (${report.summary.total} 件)</strong>
      <span style="opacity:0.7">閾値 ±${tolerance}%</span>
      <button id="geom-mismatch-close" style="margin-left:auto">×</button>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr><th>Type</th><th>ID</th><th>Model</th><th>ΔLength</th><th>ΔStart</th><th>ΔEnd</th><th>ΔAngle</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  panel.querySelector('#geom-mismatch-close')?.addEventListener('click', () => {
    panel.remove();
  });
}

function getDefaultGeometryMismatchReport(options = {}) {
  const scene = getDefaultScene();
  return scanSceneForGeometryMismatches(scene, options);
}

function analyzeMeshInternal(mesh, nodeMaps, thresholds) {
  if (!mesh || !mesh.isMesh) {
    return null;
  }
  const elementContext = extractElementContext(mesh);
  if (!elementContext) {
    return null;
  }

  const expected = resolveExpectedEndpoints(mesh, elementContext, nodeMaps);
  const actual = computeActualEndpoints(mesh);
  if (!expected || !actual) {
    return null;
  }

  const deltas = computeDeltas(expected, actual);
  const severity = classifySeverity(deltas, thresholds);

  return {
    elementId: elementContext.elementId,
    elementType: elementContext.elementType,
    modelSource: elementContext.modelSource,
    expected: {
      start: vectorToPlain(expected.start),
      end: vectorToPlain(expected.end),
      length: expected.length,
      source: expected.source,
    },
    actual: {
      start: vectorToPlain(actual.start),
      end: vectorToPlain(actual.end),
      length: actual.length,
    },
    deltas,
    severity,
  };
}

function extractElementContext(mesh) {
  const data =
    mesh.userData?.beamData ||
    mesh.userData?.girderData ||
    mesh.userData?.columnData ||
    mesh.userData?.braceData ||
    mesh.userData?.postData ||
    mesh.userData?.pileData ||
    mesh.userData?.elementData ||
    mesh.userData?.originalElement ||
    mesh.userData?.originalData;

  const elementType = mesh.userData?.elementType;
  if (!data || !elementType) {
    return null;
  }
  return {
    data,
    elementId: mesh.userData.elementId || data.id,
    elementType,
    isJson: Boolean(mesh.userData?.isJsonInput || data.isJsonInput),
    modelSource: mesh.userData?.modelSource || mesh.userData?.comparison || null,
  };
}

function resolveExpectedEndpoints(mesh, ctx, nodeMaps) {
  const config = ELEMENT_NODE_CONFIG[ctx.elementType];
  if (!config) {
    return null;
  }
  const nodeConfig = {
    nodeType: config.nodeType,
    isJsonInput: ctx.isJson,
    node1KeyStart: config.startKey,
    node1KeyEnd: config.endKey,
  };
  const nodeMap = ctx.isJson ? null : pickNodeMap(mesh, nodeMaps);
  const nodeData = getNodePositions(ctx.data, nodeMap, nodeConfig);
  if (!nodeData?.valid || !nodeData.startNode || !nodeData.endNode) {
    return null;
  }
  return {
    start: nodeData.startNode.clone(),
    end: nodeData.endNode.clone(),
    length: nodeData.startNode.distanceTo(nodeData.endNode),
    source: ctx.isJson ? 'json' : 'stb',
  };
}

function computeActualEndpoints(mesh) {
  const length = resolveMeshLength(mesh);
  if (!length || !isFinite(length) || length <= 0) {
    return null;
  }
  mesh.updateWorldMatrix(true, false);
  const half = length / 2;
  const localStart = new THREE.Vector3(0, 0, -half);
  const localEnd = new THREE.Vector3(0, 0, half);
  const worldStart = mesh.localToWorld(localStart.clone());
  const worldEnd = mesh.localToWorld(localEnd.clone());
  return {
    start: worldStart,
    end: worldEnd,
    length: worldStart.distanceTo(worldEnd),
  };
}

function resolveMeshLength(mesh) {
  const direct = mesh.userData?.length;
  if (typeof direct === 'number' && isFinite(direct) && direct > 0) {
    return direct;
  }
  const geometry = mesh.geometry;
  if (!geometry) {
    return null;
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    return null;
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  return Math.max(size.x, size.y, size.z) || null;
}

function computeDeltas(expected, actual) {
  const expectedDir = new THREE.Vector3().copy(expected.end).sub(expected.start).normalize();
  const actualDir = new THREE.Vector3().copy(actual.end).sub(actual.start).normalize();
  const angleRad = expectedDir.angleTo(actualDir);

  const deltaLength = actual.length - expected.length;
  const lengthRatio = expected.length ? deltaLength / expected.length : null;
  const startOffset = expected.start.distanceTo(actual.start);
  const endOffset = expected.end.distanceTo(actual.end);
  const midpointExpected = new THREE.Vector3().copy(expected.start).lerp(expected.end, 0.5);
  const midpointActual = new THREE.Vector3().copy(actual.start).lerp(actual.end, 0.5);
  const midpointOffset = midpointExpected.distanceTo(midpointActual);

  return {
    lengthAbs: deltaLength,
    lengthRatio,
    startOffset,
    endOffset,
    midpointOffset,
    maxPositionOffset: Math.max(startOffset, endOffset, midpointOffset),
    angleDeg: THREE.MathUtils.radToDeg(angleRad),
  };
}

function classifySeverity(deltas, thresholds) {
  const lengthAbs = Math.abs(deltas.lengthAbs ?? 0);
  const lengthRatio = Math.abs(deltas.lengthRatio ?? 0);
  const position = deltas.maxPositionOffset ?? 0;
  const angle = Math.abs(deltas.angleDeg ?? 0);

  const isError =
    (lengthAbs > thresholds.lengthFailMm && thresholds.lengthFailMm > 0) ||
    (lengthRatio > thresholds.lengthFailRatio && thresholds.lengthFailRatio > 0) ||
    (position > thresholds.positionFailMm && thresholds.positionFailMm > 0) ||
    (angle > thresholds.angleFailDeg && thresholds.angleFailDeg > 0);
  if (isError) {
    return 'error';
  }

  const isWarn =
    (lengthAbs > thresholds.lengthToleranceMm && thresholds.lengthToleranceMm > 0) ||
    (lengthRatio > thresholds.lengthToleranceRatio && thresholds.lengthToleranceRatio > 0) ||
    (position > thresholds.positionToleranceMm && thresholds.positionToleranceMm > 0) ||
    (angle > thresholds.angleToleranceDeg && thresholds.angleToleranceDeg > 0);
  return isWarn ? 'warn' : 'ok';
}

function createSummary(results, thresholds) {
  const counts = { ok: 0, warn: 0, error: 0 };
  let maxLengthAbs = 0;
  let maxPosition = 0;
  let maxAngle = 0;

  for (const entry of results) {
    counts[entry.severity] = (counts[entry.severity] || 0) + 1;
    maxLengthAbs = Math.max(maxLengthAbs, Math.abs(entry.deltas.lengthAbs ?? 0));
    maxPosition = Math.max(maxPosition, entry.deltas.maxPositionOffset ?? 0);
    maxAngle = Math.max(maxAngle, Math.abs(entry.deltas.angleDeg ?? 0));
  }

  return {
    total: results.length,
    counts,
    maxLengthAbs,
    maxPositionOffset: maxPosition,
    maxAngleDeg: maxAngle,
    thresholds,
  };
}

function vectorToPlain(vec) {
  return {
    x: Number(vec.x.toFixed(3)),
    y: Number(vec.y.toFixed(3)),
    z: Number(vec.z.toFixed(3)),
  };
}

function resolveNodeMaps(overrides = {}) {
  const mapA = overrides.modelA ?? getState('models.nodeMapA');
  const mapB = overrides.modelB ?? getState('models.nodeMapB');
  const fallback =
    overrides.default ??
    (typeof window !== 'undefined' ? window.stbParsedData?.nodes : null) ??
    mapA ??
    mapB ??
    null;
  return {
    modelA: mapA || fallback,
    modelB: mapB || fallback,
    fallback,
  };
}

function pickNodeMap(mesh, nodeMaps) {
  const source = (mesh.userData?.modelSource || mesh.userData?.comparison || '').toLowerCase();
  if (source.includes('b')) {
    return nodeMaps.modelB || nodeMaps.fallback;
  }
  return nodeMaps.modelA || nodeMaps.fallback;
}

function mergeThresholds(custom = {}) {
  return { ...DEFAULT_THRESHOLDS, ...(custom || {}) };
}

function buildElementFilter(elementTypes) {
  if (!elementTypes) {
    return null;
  }
  const list = Array.isArray(elementTypes) ? elementTypes : [elementTypes];
  return new Set(list);
}

function serializeElementKey(entry) {
  return `${entry.elementId || ''}::${entry.modelSource || ''}`;
}

function applyHighlight(mesh, severity) {
  if (!mesh.material) {
    return;
  }
  const materials = Array.isArray(mesh.material)
    ? mesh.material.map((mat) => (mat?.isMaterial ? mat.clone() : mat))
    : [mesh.material.isMaterial ? mesh.material.clone() : mesh.material];
  if (Array.isArray(mesh.material)) {
    mesh.material = materials;
  } else if (materials[0]?.isMaterial) {
    mesh.material = materials[0];
  }
  const color = severity === 'error' ? '#ff2d95' : severity === 'warn' ? '#ffd966' : '#00ffaa';
  try {
    for (const mat of materials) {
      if (!mat || !mat.isMaterial) {
        continue;
      }
      mat.color?.set(color);
      if (mat.emissive) {
        mat.emissive.set(color);
        mat.emissiveIntensity = 0.4;
      }
    }
  } catch (err) {
    log.warn('Failed to apply highlight', err);
  }
}

function formatDelta(lengthAbs, expectedLength) {
  if (lengthAbs == null || !isFinite(lengthAbs)) {
    return '-';
  }
  const ratio = expectedLength ? (lengthAbs / expectedLength) * 100 : null;
  const ratioText = ratio == null ? '' : ` (${ratio >= 0 ? '+' : ''}${ratio.toFixed(2)}%)`;
  return `${lengthAbs.toFixed(2)}${ratioText}`;
}

if (typeof window !== 'undefined') {
  window.GeometryMismatchAnalyzer = {
    scan: (options = {}) => getDefaultGeometryMismatchReport(options),
    highlight: (report, options = {}) => {
      const scene = getDefaultScene();
      return highlightGeometryMismatches(scene, report, options);
    },
    panel: (report, options = {}) => showGeometryMismatchPanel(report, options),
    analyzeMesh: analyzeMeshGeometry,
  };
  log.info('GeometryMismatchAnalyzer ready. Use window.GeometryMismatchAnalyzer.scan().');
}
