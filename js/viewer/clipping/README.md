# Viewer clipping / SectionBox lifecycle

## 責務

```text
STB / comparison data
        |
        v
GeometryGenerator
  - structural geometry only
        |
        v
element group regeneration
        |
        v
finalizeRenderableBatch()
  - active clipping policy sync
  - render:geometryChanged
        |
        v
SectionBox lifecycle
  - six reusable box planes
  - scene-wide material-local clipping
  - structural-only StencilCap refresh

color mode / material replacement
        |
        v
material application complete
  - render:materialsChanged
        |
        v
SectionBox lifecycle
  - rebuild StencilCap from final materials
```

`GeometryGenerator` は SectionBox、active clipping state、StencilCap、scene traversal を認識しない。

## ClippingStateManager

`ClippingStateManager` を active clipping state の SSOT とする。

- 通常クリッピング: `renderer.clippingPlanes` の global plane のみを使用する。Material-local `clippingPlanes` へは重複適用しない。
- SectionBox: renderer-global plane は空にし、world-space Renderable の Material に6面を local clipping として適用する。
- SectionBox 中に通常クリッピング状態が変更された場合、その状態は保持し、SectionBox 解除後の renderer-global 復帰先とする。
- Material生成側や再描画側は `renderer.clippingPlanes` を「現在の表示状態」の判定源として扱わない。
- `Node` / `Axis` / `Story` も、参照要素であることを理由にSectionBox対象外にはしない。実ジオメトリは通常Renderableと同じ6面に従う。
- `GridHelper` など `elementGroups` 外のworld-space補助描画もScene clipping roots経由で6面に従う。
- labelは実表示位置をモデル外へ逃がす場合があるためmaterial clipping対象外とし、`LabelVisibilityCuller` がsemantic anchorでSectionBox内外を判定する。
- SectionBox UI / handle / StencilCap は独自のclipping contractを持つため、Scene全体走査でもMaterialを上書きしない。
- SectionBox中に新規生成するMaterialはlocal clippingなしをbaselineとして作り、`applyToMaterial()` で6面を適用する。これにより解除時の復帰先へSectionBox 6面自身を誤登録しない。

## SectionBox / Stencil / Cap 契約

PR #191 で固定した表示契約を維持する。

| 対象 | clipping planes | 備考 |
| --- | ---: | --- |
| 通常world-space要素 | 6面 | SectionBox全境界をlocal clipping |
| Node / Axis / Story geometry | 6面 | Stencil対象外だが表示範囲はSectionBoxに従う |
| Label | semantic判定 | Material clippingではなくanchor位置で判定 |
| Stencil書込み | 対象面1面 | 切断面だけをステンシル化 |
| Cap | 対象面以外5面 | Box面内に制限 |
| SectionBox UI / handle | 対象外 | 独自表示契約を保持 |

Cap material は `depthTest=true`, `depthWrite=false`, `depthFunc=LessDepth` とする。

## Clipping roots と Stencil roots

SectionBoxで「表示を制限する対象」と「断面キャップを生成する対象」は同義ではない。

`LifecycleSectionBox` は2種類のproviderを受ける。

```text
clipping roots
  -> Scene全体
  -> elementGroups外のGridHelper等も含む

stencil roots
  -> elementGroups
  -> 構造MeshのみをStencilCap入力へ使う
```

これにより、モデル最下部にあるGridHelperやworld-space補助線が対象階の画面領域へ透けて見える問題を防ぎつつ、補助描画をStencilCap生成へ混入させない。

## Plane lifecycle

SectionBox有効化時に6枚の `THREE.Plane` を生成する。Box境界変更時は同じPlaneオブジェクトの `normal` / `constant` のみ更新する。

これにより pointer move ごとの以下の処理を避ける。

- scene全体traverse
- Materialへの `clippingPlanes` 再代入
- Plane座標変更だけを理由とした `material.needsUpdate=true`

StencilCap は drag end、geometry batch完了、Material適用完了後に再構築する。

## GeometryChanged

要素groupの再生成は、各Mesh追加ごとではなくバッチ完了時に `finalizeRenderableBatch()` を1回呼ぶ。

`render:geometryChanged` を受けたSectionBox lifecycleは、SectionBox有効中のみ次を行う。

1. Scene全体の新規Materialへ現在の6面を同期
2. 現在の構造Renderable集合からStencil/Capを再構築

モデルclear時はSectionBoxを解除し、旧geometryを参照するStencilを残さない。

## MaterialsChanged

色モード適用は `requestAnimationFrame` / timer で複数バッチに分割される場合がある。`ViewEvents.COLOR_MODE_CHANGED` は色モード選択の通知であり、Material差替え完了を意味しない。

そのため、SectionBoxのStencil/Cap再構築は `render:materialsChanged` をMaterial適用完了通知として使用し、`COLOR_MODE_CHANGED` を完了判定には使用しない。

- 通常の差分・部材・スキーマ色モード: `applyColorModeToAllObjects()` の全バッチ完了後に1回通知する。
- 重要度モードの非同期バッチ: `applyImportanceColorModeBatch()` の全バッチ完了後に1回通知する。
- 重要度モードの同期適用: 同一call stack内の複数 `applyImportanceColorMode()` をmicrotask単位に集約し、1回通知する。

これにより、分割更新途中のMaterial色をStencilCapへ取り込むことを避ける。

## StencilCap render roots

`StencilCapManager` は global `elementGroups` をimportしない。呼び出し側から構造Render root集合を注入する。

現行policy:

- `Node`, `Axis`, `Story`: cap対象外
- SectionBox UI/handle: 対象外
- Stencil/Cap自身: 対象外
- GridHelper / measurement helper等: cap対象外（clipping rootsには含めてよい）
- Model B overlay: cap対象外（比較用半透明形状を断面色へ混入させない）
- Stencil Meshは元Meshのgeometryを共有する。Stencil側は共有geometryをdisposeしない。

## 新しいObject3D種別を追加するときの確認

- GeometryGeneratorへSectionBox依存を追加していないか
- element group再生成後に `finalizeRenderableBatch()` が呼ばれるか
- Scene上のworld-space表示ならclipping rootsへ含まれるか
- SectionBox UI / stencil等、独自clippingを持つ場合は明示的にskipされるか
- Material差替え後にactive clippingが同期されるか
- Material適用完了時に `render:materialsChanged` が発火するか
- StencilCap対象に含めるべきMeshか
- overlay / label / helper / picking用Objectか
- 元geometry共有時のdispose責務が明確か
- SectionBox ON中の再描画とOFF後の通常clip復帰をテストしたか
