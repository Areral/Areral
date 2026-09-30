import * as THREE from 'three';
import { esc, plural } from './util.js';

const LABEL_RANGE = 16;
const MAX_LABELS = 8;
const SOLID_RADIUS = 0.55;

function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Thread monoliths: one per thread, glowing brighter the more recently the thread was bumped. */
export function createMarkers({ scene, template, labelsEl }) {
  const byId = new Map();
  const group = new THREE.Group();
  scene.add(group);
  const halo = haloTexture();
  const labelPool = [];
  let waypoint = null;

  function add(data, { rise = false } = {}) {
    const existing = byId.get(data.id);
    if (existing) {
      existing.data = { ...existing.data, ...data };
      return existing;
    }
    const obj = template.clone(true);
    const rune = obj.getObjectByName('rune');
    const material = new THREE.MeshStandardMaterial({ color: '#2a1300', emissive: '#ff8a00', emissiveIntensity: 2, roughness: 0.6 });
    if (rune) rune.material = material;
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: halo, color: '#ff9a30', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.4 }),
    );
    glow.position.set(0, 1.02, 0.4);
    glow.scale.set(1.5, 1.5, 1);
    obj.add(glow);
    const seed = hash(data.id);
    obj.position.set(data.x, data.y, data.z);
    obj.rotation.set((seed - 0.5) * 0.08, data.heading, (hash(data.id + 3) - 0.5) * 0.08);
    group.add(obj);
    const entry = { data, obj, material, glow, seed, rise: rise ? 0 : 1, riseStart: null };
    byId.set(data.id, entry);
    return entry;
  }

  function brightness(entry, nowSec) {
    const age = Math.max(0, nowSec - entry.data.bumped);
    return Math.exp(-age / 1800); // ~30 min to cool down to an ember
  }

  function tick(t, dt, nowSec) {
    for (const e of byId.values()) {
      if (e.rise < 1) {
        e.riseStart ??= t;
        e.rise = Math.min(1, (t - e.riseStart) / 2.2); // wall-clock, so slow frames don't stretch it
        const k = 1 - (1 - e.rise) ** 3;
        const shake = (1 - e.rise) * 0.04;
        e.obj.position.set(e.data.x + Math.sin(t * 60) * shake, e.data.y - 2.4 * (1 - k), e.data.z + Math.cos(t * 53) * shake);
      }
      const fresh = brightness(e, nowSec);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + e.seed * 6.28);
      // kept under ~2 so ACES tone mapping leaves the rune amber instead of washing it to pale yellow
      e.material.emissiveIntensity = 0.3 + fresh * (1.0 + pulse * 0.6);
      e.glow.material.opacity = 0.05 + fresh * (0.3 + pulse * 0.15);
    }
    if (waypoint) waypoint.material.opacity = 0.28 + Math.sin(t * 2) * 0.08;
  }

  function nearest(pos, maxDist) {
    let best = null;
    let bestD = maxDist;
    for (const e of byId.values()) {
      const d = Math.hypot(e.data.x - pos.x, e.data.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  const solidsCache = [];
  function solids() {
    solidsCache.length = 0;
    for (const e of byId.values()) solidsCache.push([e.data.x, e.data.z, SOLID_RADIUS]);
    return solidsCache;
  }

  const v = new THREE.Vector3();
  function updateLabels(camera, pos) {
    const near = [];
    for (const e of byId.values()) {
      const d = Math.hypot(e.data.x - pos.x, e.data.z - pos.z);
      if (d < LABEL_RANGE) near.push([d, e]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const w = window.innerWidth;
    const h = window.innerHeight;
    let used = 0;
    for (const [d, e] of near.slice(0, MAX_LABELS)) {
      v.set(e.data.x, e.obj.position.y + 2.2, e.data.z).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) continue;
      let el = labelPool[used];
      if (!el) {
        el = document.createElement('div');
        el.className = 'label3d';
        labelsEl.appendChild(el);
        labelPool.push(el);
      }
      used++;
      const key = `${e.data.id}:${e.data.replies}:${e.data.subject}`;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        const title = e.data.subject || (e.data.excerpt || '').slice(0, 60) || 'без названия';
        el.innerHTML = `${e.data.subject ? `<span class="subject">${esc(title)}</span>` : esc(title)} <span class="meta">№${e.data.id} · ${e.data.replies} ${plural(e.data.replies, 'ответ', 'ответа', 'ответов')}</span>`;
      }
      el.style.display = 'block';
      el.style.opacity = String(Math.min(1, (LABEL_RANGE - d) / 5));
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
    for (let i = used; i < labelPool.length; i++) labelPool[i].style.display = 'none';
  }

  function hideLabels() {
    for (const el of labelPool) el.style.display = 'none';
  }

  function setWaypoint(id) {
    clearWaypoint();
    const e = byId.get(id);
    if (!e) return false;
    waypoint = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 90, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    waypoint.position.set(e.data.x, e.data.y + 45, e.data.z);
    waypoint.userData.id = id;
    scene.add(waypoint);
    return true;
  }

  function clearWaypoint() {
    if (!waypoint) return;
    scene.remove(waypoint);
    waypoint.geometry.dispose();
    waypoint.material.dispose();
    waypoint = null;
  }

  return {
    add,
    tick,
    nearest,
    solids,
    updateLabels,
    hideLabels,
    setWaypoint,
    clearWaypoint,
    get waypointId() { return waypoint?.userData.id ?? null; },
    get(id) { return byId.get(id)?.data ?? null; },
    list: () => [...byId.values()].map((e) => e.data),
    get size() { return byId.size; },
  };
}
