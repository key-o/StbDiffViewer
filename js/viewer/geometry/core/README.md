# 3D表示ジオメトリ計算コアレイヤー

このディレクトリには、stb-diff-viewerのジオメトリ生成に必要なコアモジュールが含まれています。

## アーキテクチャ概要

3D表示機能を以下の2層に分離することで、テスタビリティと保守性を向上させています：

```
┌─────────────────────────────────────┐
│  Three.js表示レイヤー               │
│  (ProfileBasedColumnGenerator等)    │
│  - THREE.Shape作成                  │
│  - ExtrudeGeometry作成              │
│  - Mesh作成・配置                   │
└────────────┬────────────────────────┘
             │ 使用
             ↓
┌─────────────────────────────────────┐
│  ジオメトリ計算コア                  │
│  (このディレクトリ)                  │
│  - ProfileCalculator.js             │
│  - GeometryCalculator.js            │
│  - ThreeJSConverter.js              │
│  - TaperedGeometryBuilder.js        │
│  - BaseElementGenerator.js          │
│  - MeshCreationValidator.js         │
│  - MeshMetadataBuilder.js           │
│  - ProfileParameterMapper.js        │
│  - ElementNodeResolver.js           │
│  - ElementSectionResolver.js        │
│  - ElementPlacementResolver.js      │
│  - SectionProfileFactory.js         │
│  - sectionTypeUtil.js (common-stb)  │
└─────────────────────────────────────┘
```

## モジュール構成

### 1. ProfileCalculator.js （Three.js非依存）

**役割**: 断面パラメータから頂点座標を計算

**入力**: 断面パラメータ（寸法値）
```javascript
{
  overallDepth: 400,
  overallWidth: 200,
  webThickness: 9,
  flangeThickness: 16
}
```

**出力**: プロファイルデータ（頂点座標配列）
```javascript
{
  vertices: [
    { x: -100, y: -200 },
    { x: 100, y: -200 },
    // ...
  ],
  holes: [
    // 穴の頂点座標（BOX、PIPEなど）
  ]
}
```

**サポート形状**:
- H形鋼 (`calculateHShapeProfile`)
- BOX形鋼 (`calculateBoxProfile`)
- PIPE形鋼 (`calculatePipeProfile`)
- 矩形 (`calculateRectangleProfile`)
- 円形 (`calculateCircleProfile`)
- チャンネル形 (`calculateChannelProfile`)
- L形鋼 (`calculateLShapeProfile`)
- T形鋼 (`calculateTShapeProfile`)

**特徴**:
- ✅ Pure JavaScript（Three.js不要）
- ✅ 数値計算のみ
- ✅ 高速実行
- ✅ Node.jsで単体テスト可能

---

### 2. GeometryCalculator.js （Three.js非依存）

**役割**: 要素の配置・回転を計算

**主要関数**:

#### `calculatePlacement(startNode, endNode, options)`
要素の配置情報を計算

**入力**:
```javascript
startNode: { x: 0, y: 0, z: 0 }
endNode: { x: 0, y: 0, z: 3000 }
options: {
  startOffset: { x: 0, y: 0, z: 0 },
  endOffset: { x: 0, y: 0, z: 0 },
  rollAngle: 0  // ラジアン
}
```

**出力**:
```javascript
{
  center: { x: 0, y: 0, z: 1500 },
  length: 3000,
  direction: { x: 0, y: 0, z: 1 },
  rotation: { x: 0, y: 0, z: 0, w: 1 }  // 四元数
}
```

#### `calculateColumnPlacement(bottomNode, topNode, options)`
柱要素専用の配置計算（X/Yオフセット対応）

**その他のユーティリティ関数**:
- `calculateDistance(point1, point2)` - 2点間の距離
- `normalizeVector(vector)` - ベクトル正規化
- `calculateQuaternionFromVectors(from, to)` - 回転四元数計算
- `crossProduct(v1, v2)` - 外積
- `inferSectionTypeFromDimensions(dimensions)` - 断面タイプ推定

**特徴**:
- ✅ Pure JavaScript（Three.js不要）
- ✅ 数値計算のみ（Plain Objectを使用）
- ✅ ベクトル・四元数演算
- ✅ Node.jsで単体テスト可能

---

### 3. Element resolver / placement modules

**役割**: 要素ジェネレーターが必要とする入力解決を責務別に集約

- `ElementNodeResolver.js`: STB節点Map / JSON geometryから節点位置を解決
- `ElementSectionResolver.js`: STB/JSON断面参照と天端基準用の断面高さを解決
- `ElementPlacementResolver.js`: STB offset/rotateを配置入力へ変換し、`GeometryCalculator` の結果をThree.js型へ変換
- `SectionProfileFactory.js`: IFC優先・ProfileCalculatorフォールバックの断面プロファイル生成を集約

旧 `ElementGeometryUtils.js` の多責務クラスは廃止し、ジェネレーターは必要な機能だけを直接importします。

---

### 4. ThreeJSConverter.js （Three.js依存）

**役割**: Pure JavaScriptのデータをThree.jsオブジェクトに変換

**主要関数**:

#### `convertProfileToThreeShape(profileData)`
プロファイルデータ → THREE.Shape

#### `createExtrudeGeometry(shape, length, options)`
THREE.Shape → THREE.ExtrudeGeometry

#### `createMeshFromProfile(profileData, placement, material, userData)`
プロファイルデータと配置情報から直接メッシュを作成

#### `applyPlacementToMesh(mesh, placement)`
配置情報をメッシュに適用

**特徴**:
- Three.js依存（変換層として明確に分離）
- Pure JSデータをThree.jsに橋渡し

---

## 使用例

### 基本的な使用フロー

```javascript
// コアモジュールからインポート
import { calculateHShapeProfile, calculateProfile } from './core/ProfileCalculator.js';
import { calculatePlacement } from './core/GeometryCalculator.js';
import { createMeshFromProfile } from './core/ThreeJSConverter.js';
import { materials } from '../rendering/materials.js';

// 1. プロファイル計算（Three.js非依存）
const profileData = calculateHShapeProfile({
  overallDepth: 400,
  overallWidth: 200,
  webThickness: 9,
  flangeThickness: 16
});

// 2. 配置計算（Three.js非依存）
const startNode = { x: 0, y: 0, z: 0 };
const endNode = { x: 0, y: 0, z: 3000 };
const placement = calculatePlacement(startNode, endNode);

// 3. メッシュ作成（Three.js依存）
const mesh = createMeshFromProfile(
  profileData,
  placement,
  materials.matchedMesh,
  { elementType: 'Column', elementId: 'C1' }
);
```

### テスト例

```javascript
// Pure JavaScript関数なので、Three.js不要でテスト可能
import assert from 'node:assert/strict';
import { calculateHShapeProfile } from '../../js/viewer/geometry/core/ProfileCalculator.js';

const profile = calculateHShapeProfile({
  overallDepth: 400,
  overallWidth: 200,
  webThickness: 9,
  flangeThickness: 16
});

assert.ok(profile.vertices.length === 12);
assert.ok(profile.vertices[0].x === -100);
assert.ok(profile.vertices[0].y === -200);
```

---

## 単体テスト

### テストファイル

- `test/unit/profile-calculator.test.js` - ProfileCalculatorのテスト
- `test/unit/geometry-calculator.test.js` - GeometryCalculatorのテスト

### テスト実行

```bash
# ProfileCalculatorテスト（Three.js不要）
node test/unit/profile-calculator.test.js

# GeometryCalculatorテスト（Three.js不要）
node test/unit/geometry-calculator.test.js
```

**特徴**:
- ✅ Three.js不要（Node.jsで直接実行）
- ✅ 高速実行（ブラウザ不要）
- ✅ CI/CDで容易に統合可能

---

## 今後の拡張予定

### StbPost対応
StbColumnと同様の実装で、柱と同じプロファイル計算・配置計算を使用可能。

### IFCプロファイルベース実装への置き換え
現在の手動プロファイル生成を、IFCProfileFactoryベースの実装に段階的に移行：

1. ✅ ProfileCalculatorで断面タイプを推定
2. ✅ GeometryCalculatorで配置を計算
3. 🔄 IFCProfileFactoryで標準プロファイルを生成
4. 🔄 ThreeJSConverterでThree.jsに変換

### テストカバレッジ拡大
- エッジケーステスト
- パフォーマンステスト
- 統合テスト

---

## 利点

### 1. テスタビリティ
- Three.js非依存の計算ロジック
- Node.jsで高速にユニットテスト実行
- ブラウザ・WebGL不要

### 2. 保守性
- 責務の明確な分離
- 各レイヤーが独立して変更可能
- IFCへの移行が容易

### 3. パフォーマンス
- 計算ロジックの最適化が容易
- Three.js初期化不要でテスト実行
- CI/CDの高速化

### 4. 再利用性
- 計算ロジックは他の3Dライブラリでも使用可能
- IFCエクスポート機能にも流用可能
- サーバーサイドでの計算も可能

---

## 設計原則

1. **関心の分離**: 計算ロジックと表示ロジックを分離
2. **依存性の逆転**: Three.jsへの依存を最小化
3. **テスト容易性**: Pure JavaScript関数として単体テスト可能
4. **段階的移行**: 既存コードを壊さず新機能を追加

---

## 参考資料

- [IFC4.3 Profile Definitions](http://ifc43-docs.standards.buildingsmart.org/)
- [Three.js ExtrudeGeometry Documentation](https://threejs.org/docs/#api/en/geometries/ExtrudeGeometry)
- [STB仕様書](https://www.building-smart.or.jp/)
