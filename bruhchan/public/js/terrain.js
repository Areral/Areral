// Shared by the browser and the server: one heightmap, one set of rules for where a thread may stand.

export function createTerrain(world) {
  const hm = world.heightmap;
  const heights = Float32Array.from(hm.heights);
  const { cols, rows, cell, x0, z0 } = hm;
  const water = world.water ?? 0;
  const radius = world.radius ?? 110;
  const colliders = world.colliders ?? [];

  // Triangle split along the B–C diagonal, identical to blender/build_world.py.
  function heightAt(x, z) {
    const gx = (x - x0) / cell;
    const gz = (z - z0) / cell;
    const c = Math.min(Math.max(Math.floor(gx), 0), cols - 2);
    const r = Math.min(Math.max(Math.floor(gz), 0), rows - 2);
    const fx = Math.min(Math.max(gx - c, 0), 1);
    const fz = Math.min(Math.max(gz - r, 0), 1);
    const i = r * cols + c;
    const hA = heights[i];
    const hB = heights[i + 1];
    const hC = heights[i + cols];
    const hD = heights[i + cols + 1];
    if (fx + fz <= 1) return hA + (hB - hA) * fx + (hC - hA) * fz;
    return hD + (hC - hD) * (1 - fx) + (hB - hD) * (1 - fz);
  }

  function hitsCollider(x, z, pad = 0) {
    for (const [cx, cz, r] of colliders) {
      const rr = r + pad;
      if ((x - cx) ** 2 + (z - cz) ** 2 < rr * rr) return true;
    }
    return false;
  }

  /** Can a thread monolith be planted here? Thread-to-thread spacing is checked separately. */
  function plantable(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'Не удалось понять, где ты стоишь.' };
    if (Math.hypot(x, z) > radius) return { ok: false, reason: 'Слишком далеко от берега.' };
    const y = heightAt(x, z);
    if (y < water + 0.3) return { ok: false, reason: 'Здесь вода. Треды тонут — найди сухое место.' };
    if (hitsCollider(x, z, 0.6)) return { ok: false, reason: 'Здесь мешают камни. Отойди чуть в сторону.' };
    return { ok: true, y };
  }

  return { heightAt, hitsCollider, plantable, water, radius, colliders };
}
