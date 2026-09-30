import * as THREE from 'three';

const WALK = 4.2;
const RUN = 7.4;
const GRAVITY = 18;
const JUMP = 6.2;
const RADIUS = 0.35;
const EYE = 1.62;
const SENS = 0.0022;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpAngle = (a, b, t) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * t;

/**
 * Third/first-person wanderer. Yaw 0 looks toward +Z; forward = (sin yaw, cos yaw).
 * Ground height comes from the shared heightmap, obstacles are circles from world.json + thread stones.
 */
export function createPlayer({ scene, camera, canvas, template, terrain, markers, spawn }) {
  const pos = new THREE.Vector3().fromArray(spawn.pos);
  const vel = new THREE.Vector3();
  const push = new THREE.Vector2();
  const keys = new Set();
  let yaw = spawn.yaw;
  let pitch = -0.12;
  let facing = spawn.yaw;
  let vy = 0;
  let grounded = true;
  let firstPerson = false;
  let enabled = false;
  let dragging = false;
  let moving = false;
  let bob = 0;

  const avatar = template.clone(true);
  avatar.visible = false;
  scene.add(avatar);

  const typing = (e) => e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  const locked = () => document.pointerLockElement === canvas;

  window.addEventListener('keydown', (e) => {
    if (!enabled || typing(e) || !MOVE_KEYS.has(e.code)) return;
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointerdown', () => {
    if (!enabled) return;
    dragging = true;
    if (!locked()) requestLock();
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!enabled || (!locked() && !dragging)) return;
    yaw -= e.movementX * SENS;
    pitch = clamp(pitch - e.movementY * SENS, -1.1, 0.75);
  });

  function requestLock() {
    try {
      const r = canvas.requestPointerLock?.();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* drag-to-look still works */ }
  }

  const walkable = (x, z) => Math.hypot(x, z) < terrain.radius + 12 && terrain.heightAt(x, z) > terrain.water - 0.8;

  function resolve(x, z) {
    for (const list of [terrain.colliders, markers.solids()]) {
      for (const [cx, cz, r] of list) {
        const dx = x - cx;
        const dz = z - cz;
        const min = r + RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          x = cx + (dx / d) * min;
          z = cz + (dz / d) * min;
        }
      }
    }
    return [x, z];
  }

  const has = (...codes) => codes.some((c) => keys.has(c));

  function update(dt) {
    const ix = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
    const iz = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    let dx = fx * iz - fz * ix;
    let dz = fz * iz + fx * ix;
    const len = Math.hypot(dx, dz);
    const speed = len ? (has('ShiftLeft', 'ShiftRight') ? RUN : WALK) : 0;
    if (len) { dx /= len; dz /= len; }
    const k = 1 - Math.exp(-dt * (len ? 10 : 8));
    vel.x += (dx * speed - vel.x) * k;
    vel.z += (dz * speed - vel.z) * k;

    const pk = Math.min(1, dt * 5);
    const px = push.x * pk;
    const pz = push.y * pk;
    push.x -= px;
    push.y -= pz;

    let nx = pos.x + vel.x * dt + px;
    let nz = pos.z + vel.z * dt + pz;
    if (!walkable(nx, nz)) {
      if (walkable(nx, pos.z)) nz = pos.z;
      else if (walkable(pos.x, nz)) nx = pos.x;
      else { nx = pos.x; nz = pos.z; }
    }
    [nx, nz] = resolve(nx, nz);
    pos.x = nx;
    pos.z = nz;

    if (grounded && keys.has('Space')) { vy = JUMP; grounded = false; }
    vy -= GRAVITY * dt;
    pos.y += vy * dt;
    const ground = terrain.heightAt(pos.x, pos.z);
    if (pos.y <= ground || (grounded && vy <= 0 && pos.y - ground < 0.4)) {
      pos.y = ground;
      vy = 0;
      grounded = true;
    } else {
      grounded = false;
    }

    const planar = Math.hypot(vel.x, vel.z);
    moving = planar > 0.5;
    if (planar > 0.3) facing = lerpAngle(facing, Math.atan2(vel.x, vel.z), 1 - Math.exp(-dt * 12));
    if (moving) bob += dt * planar * 1.9;
    avatar.position.set(pos.x, pos.y + (moving && grounded ? Math.abs(Math.sin(bob)) * 0.05 : 0), pos.z);
    avatar.rotation.set(0, facing, moving ? Math.sin(bob) * 0.03 : 0);
    avatar.visible = !firstPerson;
    updateCamera();
  }

  const dir = new THREE.Vector3();
  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  function updateCamera() {
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    if (firstPerson) {
      camera.position.set(pos.x, pos.y + EYE + (moving && grounded ? Math.sin(bob * 2) * 0.035 : 0), pos.z);
      camera.lookAt(look.copy(camera.position).add(dir));
      return;
    }
    const rx = -Math.cos(yaw) * 0.65;
    const rz = Math.sin(yaw) * 0.65;
    head.set(pos.x + rx, pos.y + 1.55, pos.z + rz);
    camera.position.copy(head).addScaledVector(dir, -4.5);
    camera.position.y += 0.3;
    const floor = terrain.heightAt(camera.position.x, camera.position.z) + 0.4;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.lookAt(look.copy(head).addScaledVector(dir, 3));
  }

  return {
    pos,
    update,
    requestLock,
    get yaw() { return yaw; },
    get moving() { return moving; },
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = value;
      keys.clear();
      dragging = false;
      if (!value && locked()) document.exitPointerLock();
    },
    show() {
      avatar.visible = true;
      updateCamera();
    },
    toggleView() {
      firstPerson = !firstPerson;
      return firstPerson;
    },
    nudge(dx, dz) { push.set(push.x + dx, push.y + dz); },
    teleport(x, z) {
      pos.set(x, terrain.heightAt(x, z), z);
      vel.set(0, 0, 0);
    },
    look(newYaw, newPitch = pitch) {
      yaw = newYaw;
      facing = newYaw;
      pitch = clamp(newPitch, -1.1, 0.75);
    },
    netState: () => [pos.x, pos.y, pos.z, facing, moving ? 1 : 0],
  };
}
