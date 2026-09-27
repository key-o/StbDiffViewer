import * as THREE from 'three';

const instanceMatrix = new THREE.Matrix4();
const worldMatrix = new THREE.Matrix4();

/** Raycast hitを、クリックした鉄筋instanceだけを表す選択オブジェクトへ変換する。 */
export function createRebarSelectionCandidate(intersection) {
  const sourceMesh = intersection?.object;
  if (!sourceMesh?.userData?.isRebar || !sourceMesh.geometry || !sourceMesh.material) return null;

  const isInstanced = sourceMesh.isInstancedMesh === true;
  const instanceId = isInstanced ? intersection.instanceId : null;
  if (
    isInstanced &&
    (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= sourceMesh.count)
  ) {
    return null;
  }

  sourceMesh.updateWorldMatrix?.(true, false);
  if (isInstanced) sourceMesh.getMatrixAt(instanceId, instanceMatrix);
  else instanceMatrix.identity();
  worldMatrix.multiplyMatrices(sourceMesh.matrixWorld, instanceMatrix);

  const candidate = new THREE.Mesh(sourceMesh.geometry, sourceMesh.material);
  candidate.matrixAutoUpdate = false;
  candidate.matrix.copy(worldMatrix);
  candidate.matrixWorld.copy(worldMatrix);
  candidate.matrixWorldNeedsUpdate = false;
  candidate.frustumCulled = false;
  candidate.raycast = () => {};

  const modelSource = sourceMesh.userData.modelSource || null;
  const rebarKind = sourceMesh.userData.rebarKind || 'rebar';
  const barDiameterMm = Number(sourceMesh.userData.barDiameterMm) || null;
  const instanceKey = instanceId === null ? 'mesh' : String(instanceId);
  candidate.userData = {
    ...sourceMesh.userData,
    elementType: 'Rebar',
    elementId: `${modelSource || 'unknown'}:${rebarKind}:${barDiameterMm || 'unknown'}:${sourceMesh.uuid}:${instanceKey}`,
    isRebarInstanceSelection: true,
    rebarInstanceId: instanceId,
    sourceMesh,
    sourceGroup: sourceMesh.parent,
  };
  candidate.renderOrder = (sourceMesh.renderOrder || 0) + 1;
  return candidate;
}
