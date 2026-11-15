/**
 * XRはm単位、通常ビューはmm単位。カメラ設定と姿勢をセッション限定で退避/復元する。
 * WebXRManagerが通常カメラの行列・投影行列を書き換えることにも対応する。
 */
export const AR_CAMERA_NEAR_M = 0.02;
export const AR_CAMERA_FAR_M = 2000;

export function configureCamerasForAr(cameras, controls = null) {
  const originals = [...new Set(cameras.filter(Boolean))].map((camera) => ({
    camera,
    near: camera.near,
    far: camera.far,
    fov: camera.fov,
    zoom: camera.zoom,
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    scale: camera.scale.clone(),
    up: camera.up.clone(),
    projectionMatrix: camera.projectionMatrix.clone(),
  }));
  const target = controls?.target?.clone?.() ?? null;

  for (const { camera } of originals) {
    camera.near = AR_CAMERA_NEAR_M;
    camera.far = AR_CAMERA_FAR_M;
    camera.updateProjectionMatrix();
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (target && controls?.target?.copy) controls.target.copy(target);
    for (const saved of originals) {
      const { camera } = saved;
      camera.near = saved.near;
      camera.far = saved.far;
      if (saved.fov !== undefined) camera.fov = saved.fov;
      if (saved.zoom !== undefined) camera.zoom = saved.zoom;
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      camera.scale.copy(saved.scale);
      camera.up.copy(saved.up);
      camera.updateMatrixWorld(true);
      camera.projectionMatrix.copy(saved.projectionMatrix);
      camera.projectionMatrixInverse.copy(saved.projectionMatrix).invert();
    }
  };
}
