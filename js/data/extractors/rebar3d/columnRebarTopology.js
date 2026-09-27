/**
 * @fileoverview Issue #273 Phase 2: RC柱主筋の断面内topology分類。
 *
 * Phase 2 は観測可能な断面内位置を semantic metadata に正規化するだけで、
 * continuity assignment の優先順位には使用しない。座標・径・配筋本数・RebarPath は変更しない。
 */

const EPS = 1e-6;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function near(left, right) {
  return Math.abs(left - right) <= EPS;
}

function resetTopologyDetails(bar) {
  bar.topologyFace = null;
  bar.topologyOrdinal = null;
  bar.topologyCountOnFace = null;
}

function setResolved(bar, topologyRole, topologyPosition, extra = {}) {
  bar.topologyRole = topologyRole;
  bar.topologyPosition = topologyPosition;
  bar.topologyStatus = 'RESOLVED';
  bar.topologyReason = null;
  resetTopologyDetails(bar);
  for (const [key, value] of Object.entries(extra)) bar[key] = value;
  return bar;
}

function setUnresolved(bar, reason) {
  bar.topologyRole = null;
  bar.topologyPosition = null;
  bar.topologyStatus = 'UNRESOLVED';
  bar.topologyReason = reason;
  resetTopologyDetails(bar);
  return bar;
}

function coordinateKey(bar) {
  const u = finite(bar?.u);
  const v = finite(bar?.v);
  return u === null || v === null ? null : `${u.toFixed(6)}:${v.toFixed(6)}`;
}

function boundsOf(bars) {
  const coordinates = bars
    .map((bar) => ({ u: finite(bar?.u), v: finite(bar?.v) }))
    .filter((item) => item.u !== null && item.v !== null);
  if (coordinates.length !== bars.length || coordinates.length === 0) return null;
  const us = coordinates.map((item) => item.u);
  const vs = coordinates.map((item) => item.v);
  return {
    minU: Math.min(...us),
    maxU: Math.max(...us),
    minV: Math.min(...vs),
    maxV: Math.max(...vs),
  };
}

function duplicatePositionKeys(bars) {
  const seen = new Set();
  const duplicated = new Set();
  for (const bar of bars) {
    const key = coordinateKey(bar);
    if (!key) continue;
    if (seen.has(key)) duplicated.add(key);
    seen.add(key);
  }
  return duplicated;
}

function rectangularLocation(bar, bounds) {
  const u = finite(bar?.u);
  const v = finite(bar?.v);
  if (u === null || v === null) return null;
  const xMin = near(u, bounds.minU);
  const xMax = near(u, bounds.maxU);
  const yMin = near(v, bounds.minV);
  const yMax = near(v, bounds.maxV);
  if ((xMin && xMax) || (yMin && yMax)) return null;
  const xFace = xMin ? 'X_MIN' : xMax ? 'X_MAX' : null;
  const yFace = yMin ? 'Y_MIN' : yMax ? 'Y_MAX' : null;
  if (xFace && yFace) return { kind: 'CORNER', position: `${xFace}_${yFace}` };
  if (xFace) return { kind: 'EDGE', face: xFace, along: v };
  if (yFace) return { kind: 'EDGE', face: yFace, along: u };
  return { kind: 'INTERMEDIATE' };
}

function annotateEdgeOrdinals(items, layerPrefix, role) {
  const byFace = new Map();
  for (const item of items) {
    if (item.location?.kind !== 'EDGE') continue;
    const list = byFace.get(item.location.face) || [];
    list.push(item);
    byFace.set(item.location.face, list);
  }
  for (const [face, list] of byFace) {
    list.sort(
      (a, b) =>
        a.location.along - b.location.along ||
        finite(a.bar?.u) - finite(b.bar?.u) ||
        finite(a.bar?.v) - finite(b.bar?.v),
    );
    list.forEach((item, index) => {
      const ordinal = index + 1;
      setResolved(item.bar, role, `${layerPrefix}${face}:${ordinal}_OF_${list.length}`, {
        topologyFace: face,
        topologyOrdinal: ordinal,
        topologyCountOnFace: list.length,
      });
    });
  }
}

function annotateRectangularLayer(bars, layer) {
  if (!bars.length) return;
  const bounds = boundsOf(bars);
  if (!bounds) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-invalid'));
    return;
  }
  if (bounds.maxU - bounds.minU <= EPS || bounds.maxV - bounds.minV <= EPS) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-layer-degenerate'));
    return;
  }
  if (duplicatePositionKeys(bars).size > 0) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-duplicate'));
    return;
  }

  const layerPrefix = layer === 1 ? '' : `L${layer}:`;
  const items = bars.map((bar) => ({ bar, location: rectangularLocation(bar, bounds) }));
  for (const item of items) {
    if (!item.location) {
      setUnresolved(item.bar, 'topology-position-ambiguous');
      continue;
    }
    if (item.location.kind === 'CORNER') {
      setResolved(
        item.bar,
        layer === 1 ? 'CORNER' : 'INTERMEDIATE',
        `${layerPrefix}${item.location.position}`,
      );
      continue;
    }
    if (item.location.kind === 'INTERMEDIATE') {
      setResolved(item.bar, 'INTERMEDIATE', `${layerPrefix}INTERIOR`);
    }
  }
  annotateEdgeOrdinals(items, layerPrefix, layer === 1 ? 'EDGE' : 'INTERMEDIATE');
}

function angle0To2Pi(u, v) {
  const angle = Math.atan2(v, u);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

function annotateCircularMainBars(bars) {
  const positioned = bars
    .map((bar) => ({ bar, u: finite(bar?.u), v: finite(bar?.v) }))
    .filter((item) => item.u !== null && item.v !== null);
  if (positioned.length !== bars.length) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-invalid'));
    return;
  }

  if (duplicatePositionKeys(bars).size > 0) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-duplicate'));
    return;
  }
  positioned.sort(
    (a, b) => angle0To2Pi(a.u, a.v) - angle0To2Pi(b.u, b.v) || a.u - b.u || a.v - b.v,
  );
  positioned.forEach((item, index) => {
    const ordinal = index + 1;
    setResolved(item.bar, 'EDGE', `CIRCUMFERENCE:${ordinal}_OF_${positioned.length}`, {
      topologyFace: 'CIRCUMFERENCE',
      topologyOrdinal: ordinal,
      topologyCountOnFace: positioned.length,
    });
  });
}

function annotateCoreBars(bars) {
  if (!bars.length) return;
  const positioned = bars
    .map((bar) => ({ bar, u: finite(bar?.u), v: finite(bar?.v) }))
    .filter((item) => item.u !== null && item.v !== null);
  if (positioned.length !== bars.length) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-invalid'));
    return;
  }

  if (duplicatePositionKeys(bars).size > 0) {
    bars.forEach((bar) => setUnresolved(bar, 'topology-position-duplicate'));
    return;
  }
  const centers = positioned.filter((item) => Math.hypot(item.u, item.v) <= EPS);
  positioned.sort((a, b) => a.u - b.u || a.v - b.v);
  let innerOrdinal = 0;
  const innerCount = positioned.length - (centers.length === 1 ? 1 : 0);
  for (const item of positioned) {
    if (centers.length === 1 && centers[0] === item) {
      setResolved(item.bar, 'CENTER', 'CENTER', {
        topologyOrdinal: 1,
        topologyCountOnFace: 1,
      });
      continue;
    }
    innerOrdinal += 1;
    setResolved(item.bar, 'INNER', `INNER:${innerOrdinal}_OF_${innerCount}`, {
      topologyOrdinal: innerOrdinal,
      topologyCountOnFace: innerCount,
    });
  }
}

/**
 * buildColumnArrangementFacts() の返却bar objectへtopology metadataを付加する。
 * mainBars/coreBars/bars が同じbar objectを共有する現行契約を維持するためin-placeで注記する。
 *
 * @param {object|null} arrangementFacts
 * @param {{type?: string}|null} dimensions
 * @returns {object|null}
 */
export function annotateColumnArrangementTopology(arrangementFacts, dimensions) {
  if (!arrangementFacts) return arrangementFacts;
  const bars = Array.isArray(arrangementFacts.bars) ? arrangementFacts.bars : [];
  const mainBars = bars.filter((bar) => bar?.role === 'main');
  const coreBars = bars.filter((bar) => bar?.role === 'core');
  const shape = String(dimensions?.type || '').toUpperCase();

  if (shape === 'CIRCLE') {
    const firstLayer = mainBars.filter((bar) => Number(bar?.layer) === 1);
    const otherLayers = mainBars.filter((bar) => Number(bar?.layer) !== 1);
    annotateCircularMainBars(firstLayer);
    otherLayers.forEach((bar) => setUnresolved(bar, 'topology-circle-layer-unsupported'));
  } else if (shape === 'RECTANGLE') {
    const layers = new Map();
    for (const bar of mainBars) {
      const layer = Number(bar?.layer);
      if (!Number.isInteger(layer) || layer < 1) {
        setUnresolved(bar, 'topology-layer-invalid');
        continue;
      }
      const list = layers.get(layer) || [];
      list.push(bar);
      layers.set(layer, list);
    }
    for (const [layer, layerBars] of layers) annotateRectangularLayer(layerBars, layer);
  } else {
    mainBars.forEach((bar) => setUnresolved(bar, 'topology-section-shape-unsupported'));
  }

  annotateCoreBars(coreBars);
  return arrangementFacts;
}
