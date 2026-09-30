import * as THREE from 'three';

export const FOG = new THREE.Color('#8b9498');
const SKY_TOP = new THREE.Color('#58636b');
const SUN_DIR = new THREE.Vector3(-0.55, 0.38, -0.74).normalize();

function createSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: SKY_TOP },
      horizon: { value: FOG },
      sunDir: { value: SUN_DIR },
      sunColor: { value: new THREE.Color('#f6dcc0') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    // Horizon equals the fog colour and goes through the same tone mapping, so fogged terrain melts into the sky.
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 48.0) * 0.35 + pow(s, 5.0) * 0.1);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

function createWater() {
  const geometry = new THREE.PlaneGeometry(900, 900, 140, 140);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: '#3a484d',
    roughness: 0.32,
    metalness: 0.12,
    flatShading: true,
    transparent: true,
    opacity: 0.9,
  });
  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      transformed.y += sin(position.x * 0.17 + uTime * 0.8) * 0.13
        + sin(position.z * 0.21 - uTime * 0.65) * 0.1
        + sin((position.x + position.z) * 0.43 + uTime * 1.5) * 0.04;`,
    );
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -0.08;
  mesh.receiveShadow = true;
  return { mesh, uniforms };
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function createMotes(count = 700) {
  const positions = new Float32Array(count * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() - 0.5) * 60;
    positions[i * 3 + 1] = rnd() * 18;
    positions[i * 3 + 2] = (rnd() - 0.5) * 60;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: '#ece6d8', size: 0.12, map: dotTexture(), transparent: true, opacity: 0.7, depthWrite: false }),
  );
  points.frustumCulled = false;
  let t = 0;
  function update(dt, focus) {
    t += dt;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      positions[j] += (0.5 + Math.sin(t * 0.7 + i) * 0.25) * dt;
      positions[j + 1] += (Math.sin(t * 1.3 + i * 0.37) * 0.12 - 0.06) * dt;
      positions[j + 2] += (0.2 + Math.cos(t * 0.5 + i) * 0.2) * dt;
      const rx = positions[j] - focus.x;
      const rz = positions[j + 2] - focus.z;
      if (rx > 30) positions[j] -= 60; else if (rx < -30) positions[j] += 60;
      if (rz > 30) positions[j + 2] -= 60; else if (rz < -30) positions[j + 2] += 60;
      const ry = positions[j + 1] - focus.y;
      if (ry < -2) positions[j + 1] += 18; else if (ry > 16) positions[j + 1] -= 18;
    }
    geometry.attributes.position.needsUpdate = true;
  }
  return { points, update };
}

export function createEngine(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r18x; radius softens instead

  const scene = new THREE.Scene();
  scene.background = FOG.clone();
  scene.fog = new THREE.FogExp2(FOG.clone(), 0.019);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 800);

  scene.add(new THREE.HemisphereLight('#cfd6d9', '#4a4033', 1.9));
  const sun = new THREE.DirectionalLight('#ffdcb5', 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 280 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);

  const sky = createSky();
  const water = createWater();
  const motes = createMotes();
  scene.add(sky, water.mesh, motes.points);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const texel = 90 / 2048; // snap the shadow frustum to texels to stop shimmering while walking
  function update(t, dt, focus) {
    water.uniforms.uTime.value = t;
    motes.update(dt, focus);
    sky.position.copy(camera.position);
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    sun.target.position.set(fx, focus.y, fz);
    sun.position.set(fx, focus.y, fz).addScaledVector(SUN_DIR, 120);
  }

  return { renderer, scene, camera, update, render: () => renderer.render(scene, camera) };
}
