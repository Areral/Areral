import * as THREE from 'three';

/** Brazier fire at the spawn plaza: flickering light, additive flame cones, rising embers. */
export function createFire(scene, [x, y, z]) {
  const group = new THREE.Group();
  group.position.set(x, y - 0.2, z);
  scene.add(group);

  const light = new THREE.PointLight('#ff8a33', 40, 24, 1.6);
  light.position.set(0, 0.7, 0);
  group.add(light);

  const flames = [];
  const specs = [
    [0, 0, 0.36, 1.35, '#ff6a10', 0.7],
    [0.14, 0.08, 0.22, 0.95, '#ffa030', 0.75],
    [-0.13, -0.07, 0.2, 0.85, '#ffa030', 0.75],
    [0, 0, 0.15, 0.65, '#fff1b8', 0.9],
  ];
  for (const [ox, oz, r, h, color, opacity] of specs) {
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 7, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.position.set(ox, h / 2, oz);
    mesh.userData = { h, phase: flames.length * 1.7 };
    group.add(mesh);
    flames.push(mesh);
  }

  const count = 36;
  const embers = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const reset = (i, spread = true) => {
    embers[i * 3] = (Math.random() - 0.5) * 0.5;
    embers[i * 3 + 1] = spread ? Math.random() * 3 : 0.2;
    embers[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    speed[i] = 0.6 + Math.random() * 0.9;
  };
  for (let i = 0; i < count; i++) reset(i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(embers, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: '#ffb050', size: 0.07, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  group.add(points);

  function update(t, dt) {
    light.intensity = 36 + Math.sin(t * 13.1) * 4 + Math.sin(t * 7.7) * 3 + Math.sin(t * 23.3) * 2;
    for (const f of flames) {
      const k = 1 + Math.sin(t * 9 + f.userData.phase) * 0.14 + Math.sin(t * 15.3 + f.userData.phase) * 0.06;
      f.scale.set(1, k, 1);
      f.position.y = (f.userData.h * k) / 2;
      f.rotation.y = t * 0.8 + f.userData.phase;
    }
    for (let i = 0; i < count; i++) {
      embers[i * 3 + 1] += speed[i] * dt;
      embers[i * 3] += Math.sin(t * 2 + i) * 0.15 * dt;
      if (embers[i * 3 + 1] > 3.2) reset(i, false);
    }
    geometry.attributes.position.needsUpdate = true;
  }
  return { update };
}
