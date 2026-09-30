import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FILES = ['world', 'marker', 'wanderer'];

export async function loadAssets(onProgress) {
  const loader = new GLTFLoader();
  let done = 0;
  const [world, marker, wanderer] = await Promise.all(
    FILES.map((name) =>
      loader.loadAsync(`/assets/${name}.glb`).then((gltf) => {
        onProgress?.(++done, FILES.length);
        return gltf.scene;
      }),
    ),
  );
  world.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = true;
    o.castShadow = o.name !== 'coals';
  });
  for (const root of [marker, wanderer]) {
    root.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
  }
  return { world, marker, wanderer };
}
