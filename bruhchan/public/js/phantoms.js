import * as THREE from 'three';

const lerpAngle = (a, b, t) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * t;

/** Other wanderers, drawn as pale translucent phantoms. Only an ephemeral id and a position are known. */
export function createPhantoms({ scene, template }) {
  const phantoms = new Map();
  let selfId = null;
  const ghost = new THREE.MeshStandardMaterial({
    color: '#e4eeff',
    emissive: '#8fabd6',
    emissiveIntensity: 0.95,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    roughness: 1,
  });

  function spawn(x, y, z, yaw) {
    const obj = template.clone(true);
    obj.traverse((o) => {
      if (o.isMesh && o.name !== 'glow') {
        o.material = ghost;
        o.castShadow = false;
      }
    });
    obj.position.set(x, y, z);
    obj.rotation.y = yaw;
    scene.add(obj);
    return { obj, target: new THREE.Vector3(x, y, z), yaw, moving: 0, bob: Math.random() * 6 };
  }

  function sync(snapshot) {
    const seen = new Set();
    for (const [id, x, y, z, yaw, moving] of snapshot) {
      if (id === selfId) continue;
      seen.add(id);
      let p = phantoms.get(id);
      if (!p) phantoms.set(id, (p = spawn(x, y, z, yaw)));
      p.target.set(x, y, z);
      p.yaw = yaw;
      p.moving = moving;
    }
    for (const id of phantoms.keys()) if (!seen.has(id)) remove(id);
  }

  function remove(id) {
    const p = phantoms.get(id);
    if (!p) return;
    scene.remove(p.obj);
    phantoms.delete(id);
  }

  function tick(dt) {
    const k = 1 - Math.exp(-dt * 10);
    for (const p of phantoms.values()) {
      p.obj.position.lerp(p.target, k);
      p.obj.rotation.y = lerpAngle(p.obj.rotation.y, p.yaw, k);
      if (p.moving) {
        p.bob += dt * 9;
        p.obj.position.y += Math.abs(Math.sin(p.bob)) * 0.05;
      }
    }
  }

  return {
    sync,
    remove,
    tick,
    set selfId(id) { selfId = id; remove(id); },
    get count() { return phantoms.size; },
  };
}
