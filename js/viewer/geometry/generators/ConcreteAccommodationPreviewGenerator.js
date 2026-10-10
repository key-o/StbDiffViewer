/**
 * @fileoverview FukashiCandidate LOCAL_PRISM / FACE_OFFSET をpreview-only 3D boxとして表示する。
 *
 * Working Document / STB geometryは変更しない。meshはpick対象外で、RebarDisplayManagerの
 * lifecycleから安全に破棄できるようdispose()を持たせる。
 */

import * as THREE from 'three';

const EPS = 1e-6;

function accommodationCenterToMemberLocal(center, placement, supportEndpoint) {
  const length = Number(placement?.length);
  if (!(length > 0) || !['start', 'end'].includes(supportEndpoint)) return null;
  return {
    x: -Number(center.x),
    y: Number(center.y),
    z: supportEndpoint === 'start' ? Number(center.z) - length / 2 : length / 2 - Number(center.z),
  };
}

function placementQuaternion(placement) {
  const q = placement?.rotation;
  if (!q) return null;
  const result = new THREE.Quaternion(Number(q.x), Number(q.y), Number(q.z), Number(q.w));
  return result.lengthSq() > EPS ? result.normalize() : null;
}

export function createConcreteAccommodationPreviewMesh({
  candidate,
  solid,
  supportPlacement,
  supportEndpoint,
  modelSource = null,
  opacity = 0.28,
  color = 0xffa000,
} = {}) {
  const bounds = solid?.bounds;
  if (!candidate || !bounds || !['start', 'end'].includes(supportEndpoint) || !supportPlacement) {
    return null;
  }

  const size = {
    x: Number(bounds.max.x) - Number(bounds.min.x),
    y: Number(bounds.max.y) - Number(bounds.min.y),
    z: Number(bounds.max.z) - Number(bounds.min.z),
  };
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > EPS)) {
    return null;
  }

  const accommodationCenter = {
    x: (Number(bounds.min.x) + Number(bounds.max.x)) / 2,
    y: (Number(bounds.min.y) + Number(bounds.max.y)) / 2,
    z: (Number(bounds.min.z) + Number(bounds.max.z)) / 2,
  };
  const localCenter = accommodationCenterToMemberLocal(
    accommodationCenter,
    supportPlacement,
    supportEndpoint,
  );
  const placementQ = placementQuaternion(supportPlacement);
  if (!localCenter || !placementQ) return null;

  const rollQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    Number(supportPlacement.localRollRad) || 0,
  );
  const worldQ = placementQ.clone().multiply(rollQ);
  const worldCenter = new THREE.Vector3(localCenter.x, localCenter.y, localCenter.z)
    .applyQuaternion(worldQ)
    .add(
      new THREE.Vector3(
        Number(supportPlacement.center?.x),
        Number(supportPlacement.center?.y),
        Number(supportPlacement.center?.z),
      ),
    );

  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `ConcreteAccommodationPreview-${candidate.id || 'candidate'}`;
  mesh.position.copy(worldCenter);
  mesh.quaternion.copy(worldQ);
  mesh.renderOrder = 8;
  mesh.raycast = () => {};
  mesh.userData = {
    isConcreteAccommodationPreview: true,
    candidateId: candidate.id || null,
    hostMemberTag: candidate.hostMemberTag || null,
    hostMemberId: candidate.hostMemberId || null,
    face: candidate.face || null,
    mode: candidate.mode || null,
    proposedThicknessMm: candidate.proposedThicknessMm ?? null,
    stationStartMm: candidate.stationStartMm ?? null,
    stationEndMm: candidate.stationEndMm ?? null,
    modelSource,
  };
  mesh.dispose = () => {
    geometry.dispose();
    material.dispose();
  };
  return mesh;
}

export const _concreteAccommodationPreviewInternals = Object.freeze({
  accommodationCenterToMemberLocal,
});
