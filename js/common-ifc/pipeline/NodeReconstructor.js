/**
 * @fileoverview Stage 3: 共有節点テーブル構築
 *
 * IFC要素の配置情報から始点・終点を抽出し、
 * 近接点をマージして共有節点テーブルを構築する。
 *
 * @module NodeReconstructor
 */

/** デフォルトの節点マージ許容差 (mm) */
const DEFAULT_TOLERANCE = 1.0;

export class NodeReconstructor {
  /**
   * @param {number} [tolerance=1.0] - 節点マージ許容差 (mm)
   */
  constructor(tolerance = DEFAULT_TOLERANCE) {
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      throw new RangeError('Node tolerance must be a positive finite number');
    }
    this.tolerance = tolerance;
    /** @type {Map<string, Array<{id: string, x: number, y: number, z: number}>>} */
    this.nodeMap = new Map();
    /** @type {Array<{id: string, x: number, y: number, z: number}>} */
    this.nodes = [];
    this.nextId = 1;
  }

  /** Return integer spatial-cell indices (one tolerance-sized cell per axis). */
  _cell(x, y, z) {
    return [x, y, z].map((coordinate) => Math.floor(coordinate / this.tolerance));
  }

  _key(ix, iy, iz) {
    return `${ix}_${iy}_${iz}`;
  }

  /**
   * 座標を登録し、節点IDを返す。近接する既存節点があればそのIDを返す。
   * A cell can hold multiple distinct nodes: sharing a hash never means
   * sharing an analytical STB node.
   * @param {number} x - mm
   * @param {number} y - mm
   * @param {number} z - mm
   * @returns {string} 節点ID
   */
  addOrGet(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) {
      throw new TypeError('Node coordinates must be finite numbers');
    }

    const [ix, iy, iz] = this._cell(x, y, z);
    const toleranceSquared = this.tolerance * this.tolerance;
    // A point closer than the tolerance must belong to the same cell or one
    // of its 26 neighbors. Check every entry even for the exact same hash key.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.nodeMap.get(this._key(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const existing of bucket) {
            const ex = existing.x - x;
            const ey = existing.y - y;
            const ez = existing.z - z;
            if (ex * ex + ey * ey + ez * ez < toleranceSquared) return existing.id;
          }
        }
      }
    }

    const id = String(this.nextId++);
    const node = {
      id,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
    };
    const key = this._key(ix, iy, iz);
    const bucket = this.nodeMap.get(key) || [];
    // Keep unrounded input coordinates for proximity checks. Output coordinates
    // remain rounded to 0.01mm, but must not influence the tolerance decision.
    bucket.push({ id, x, y, z });
    this.nodeMap.set(key, bucket);
    this.nodes.push(node);
    return id;
  }

  /**
   * 全節点をSTB形式の配列で返す
   * @returns {Array<{id: string, x: number, y: number, z: number}>}
   */
  getNodes() {
    return [...this.nodes];
  }
}
