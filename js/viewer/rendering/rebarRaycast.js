/** @fileoverview 鉄筋InstancedMeshの低コストRaycast */
import * as THREE from 'three';

const meshSphere = new THREE.Sphere();
const instanceSphere = new THREE.Sphere();
const instanceMatrix = new THREE.Matrix4();
const instanceWorldMatrix = new THREE.Matrix4();
const proxyMesh = new THREE.Mesh();
const proxyIntersections = [];

/**
 * InstancedMesh標準の全三角形Raycastを、instanceのbounding sphereで絞ってから実行する。
 * 鉄筋は最大数十万instanceをまとめるため、常時有効な選択モードでも三角形検査を抑える。
 */
export function raycastRebarMesh(raycaster, intersections) {
  const mesh = this;
  if (!mesh.visible || !mesh.geometry) return;
  mesh.updateWorldMatrix?.(true, false);

  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const localSphere = geometry.boundingSphere;
  if (!localSphere) return;

  if (mesh.isInstancedMesh !== true) {
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, intersections);
    return;
  }

  if (!mesh.boundingSphere) mesh.computeBoundingSphere();
  if (mesh.boundingSphere) {
    meshSphere.copy(mesh.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (!raycaster.ray.intersectsSphere(meshSphere)) return;
  }

  proxyMesh.geometry = geometry;
  proxyMesh.material = mesh.material;
  proxyMesh.layers.mask = mesh.layers.mask;

  for (let instanceId = 0; instanceId < mesh.count; instanceId += 1) {
    mesh.getMatrixAt(instanceId, instanceMatrix);
    instanceWorldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
    instanceSphere.copy(localSphere).applyMatrix4(instanceWorldMatrix);
    if (!raycaster.ray.intersectsSphere(instanceSphere)) continue;

    proxyMesh.matrixWorld.copy(instanceWorldMatrix);
    proxyMesh.matrixWorldNeedsUpdate = false;
    proxyIntersections.length = 0;
    THREE.Mesh.prototype.raycast.call(proxyMesh, raycaster, proxyIntersections);

    for (const hit of proxyIntersections) {
      hit.object = mesh;
      hit.instanceId = instanceId;
      intersections.push(hit);
    }
  }
}
