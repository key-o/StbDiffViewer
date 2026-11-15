/**
 * A fail-closed, geometry-only STB 2.1 RC beam segment plan derived from a
 * validated IFC rectangular BRep loft. No STB offset/axis basis is assumed.
 *
 * buildingSMART Japan ST-Bridge 2.1 XML specification, sections 5.4.1.2 and
 * 6.6.1.2: ConcreteSwitch.distance is the end station of the matching ordered
 * SecFigureBeam_RC; Taper is linear between its two cross sections.
 *
 * This plan is intentionally NOT ready for STB XML serialization. The IFC
 * transverse / vertical local axes must be mapped to STB member Y/Z, including
 * handedness and vertical offset datum, before exporting section offsets.
 */
const EPS = 1e-4;
const approx = (a, b) => Math.abs(a - b) <= EPS;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function requirePoint(value, count, description) {
  if (!Array.isArray(value) || value.length !== count || !value.every(finite))
    throw new Error('Invalid ' + description);
}

function canonicalStation(section) {
  if (!section || !finite(section.station)) throw new Error('Missing BRep station');
  requirePoint(section.min, 2, 'BRep station min');
  requirePoint(section.max, 2, 'BRep station max');
  requirePoint(section.widths, 2, 'BRep station widths');
  for (let j = 0; j < 2; j++) {
    const measured = section.max[j] - section.min[j];
    if (!(measured > EPS) || !approx(section.widths[j], measured))
      throw new Error('Inconsistent BRep station dimensions');
  }
  return {
    station: section.station,
    bounds: { min: [...section.min], max: [...section.max] },
    width: section.widths[0],
    depth: section.widths[1],
  };
}

/** Piecewise exact volume integration for linearly varying width & depth. */
export function integrateRectangularRcSegments(stations) {
  let volume = 0;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1],
      b = stations[i];
    const l = b.station - a.station;
    if (!(l > EPS)) throw new Error('Invalid or unordered BRep stations');
    volume +=
      (l *
        (2 * a.width * a.depth + a.width * b.depth + b.width * a.depth + 2 * b.width * b.depth)) /
      6;
  }
  return volume;
}

/**
 * @param {Object} measured - proven readIfcRectangularBrepLoft result (mm)
 * @returns {{kind:string, segments:Array, concreteSwitches:Array, sourceVolume:number,
 *    inferredVolume:number, geometryOffsetsResolved:boolean, unverified:Array}}
 */
export function planRectangularRcBrepSegments(measured) {
  if (!measured || !finite(measured.length) || !(measured.length > EPS))
    throw new Error('Invalid BRep beam length');
  requirePoint(measured.localAxisStart, 3, 'IFC axis start');
  requirePoint(measured.localAxisEnd, 3, 'IFC axis end');
  const a = measured.localAxisStart,
    b = measured.localAxisEnd;
  const delta = b.map((v, i) => v - a[i]);
  const nonzeroAxes = delta.flatMap((v, i) => (Math.abs(v) > EPS ? [i] : []));
  // Geometric beam plan only: reject non-axis-aligned and vertical members.
  // No assumption about the eventual STB beam Y/Z basis is made here.
  if (nonzeroAxes.length !== 1 || nonzeroAxes[0] === 2)
    throw new Error('BRep axis direction/basis is not proven supported');
  const longitudinalAxis = nonzeroAxes[0];
  const direction = Math.sign(delta[longitudinalAxis]);
  if (
    !approx(Math.abs(delta[longitudinalAxis]), measured.length) ||
    delta.some((v, i) => i !== longitudinalAxis && !approx(v, 0))
  )
    throw new Error('BRep axis length/basis mismatch');
  if (!Array.isArray(measured.sections) || measured.sections.length < 2)
    throw new Error('At least two BRep stations required');
  // The geometry reader returns stations in ascending world-coordinate order.
  // Reorder for an IFC Axis pointing toward a decreasing coordinate, and then
  // use positive distances measured from the actual IFC Axis start.
  const sourceStations = measured.sections.map(canonicalStation);
  const ordered = direction > 0 ? sourceStations : sourceStations.reverse();
  if (
    !approx(ordered[0].station, a[longitudinalAxis]) ||
    !approx(ordered.at(-1).station, b[longitudinalAxis])
  )
    throw new Error('BRep station endpoints are not on the explicit axis');
  const stations = ordered.map((section) => ({
    ...section,
    station: (section.station - a[longitudinalAxis]) * direction,
  }));
  const inferredVolume = integrateRectangularRcSegments(stations);
  if (
    !finite(measured.volume) ||
    measured.volume <= 0 ||
    Math.abs(measured.volume - inferredVolume) > Math.max(0.01, measured.volume * 1e-6)
  )
    throw new Error('BRep station loft volume mismatch');

  const segments = [],
    concreteSwitches = [];
  for (let i = 1; i < stations.length; i++) {
    const start = stations[i - 1],
      end = stations[i],
      order = i;
    const boundsSame =
      start.bounds.min.every((v, j) => approx(v, end.bounds.min[j])) &&
      start.bounds.max.every((v, j) => approx(v, end.bounds.max[j]));
    const figure = boundsSame
      ? { type: 'StbSecBeamStraight', width: start.width, depth: start.depth }
      : {
          type: 'StbSecBeamTaper',
          start_width: start.width,
          start_depth: start.depth,
          end_width: end.width,
          end_depth: end.depth,
        };
    const startDistance = start.station,
      endDistance = end.station;
    segments.push({
      order,
      startDistance,
      endDistance,
      figure,
      // Raw local coordinates are measured but not STB signed offsets.
      ifcSourceBounds: { start: start.bounds, end: end.bounds },
    });
    concreteSwitches.push({ order, distance: endDistance });
  }
  return {
    kind: 'STB21_RC_SECTION_PLAN_UNPLACED',
    segments,
    concreteSwitches,
    sourceAxis: {
      coordinateIndex: longitudinalAxis,
      sign: direction,
      transverseCoordinateIndices: [0, 1, 2].filter((index) => index !== longitudinalAxis),
    },
    sourceVolume: measured.volume,
    inferredVolume,
    geometryOffsetsResolved: false,
    unverified: [
      'IFC-to-STB local Y/Z orientation and signs',
      'STB vertical top offset and beam reference level',
      'material / reinforcement source properties',
      'reverse IFC BRep mesh and volume',
    ],
  };
}
