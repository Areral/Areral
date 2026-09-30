import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { createWind } from './audio.js';
import { createBoard } from './board.js';
import { createEngine } from './engine.js';
import { createFire } from './fire.js';
import { createMarkers } from './markers.js';
import { connect } from './net.js';
import { createPhantoms } from './phantoms.js';
import { createPlayer } from './player.js';
import { createTerrain } from './terrain.js';
import { api, copyText, esc, plural } from './util.js';

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('world'),
  portal: $('portal'),
  enter: $('enter'),
  status: $('loadStatus'),
  stats: $('stats'),
  hud: $('hud'),
  online: $('online'),
  coords: $('coords'),
  prompt: $('prompt'),
  toast: $('toast'),
  lockHint: $('lockHint'),
  labels: $('labels'),
  board: $('board'),
  boardBody: $('boardBody'),
  preview: $('quotePreview'),
};

const INTERACT_RANGE = 2.8;
const THREAD_SPACING = 2.4;

document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  const ok = await copyText(button.dataset.copy);
  const status = button.parentElement.querySelector('.copyStatus');
  if (!status) return;
  status.textContent = ok ? 'Скопировано!' : 'Не вышло — выдели адрес вручную.';
  setTimeout(() => { status.textContent = ''; }, 2500);
});

function fail(message) {
  ui.status.textContent = message;
  ui.status.className = 'loadStatus error';
  ui.enter.textContent = 'Остров недоступен';
  ui.enter.disabled = true;
}

let toastTimer = 0;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3500);
}

async function boot() {
  let engine;
  try {
    engine = createEngine(ui.canvas);
  } catch {
    fail('Твой браузер не умеет WebGL — остров не отрисуется. Попробуй свежий Firefox или Chromium.');
    return;
  }
  const { scene, camera } = engine;
  ui.status.textContent = 'Поднимаем остров из тумана…';
  const [world, assets, listing] = await Promise.all([
    fetch('/assets/world.json').then((r) => {
      if (!r.ok) throw new Error('нет карты острова');
      return r.json();
    }),
    loadAssets((n, total) => { ui.status.textContent = `Поднимаем остров из тумана… ${n}/${total}`; }),
    api('/api/threads'),
  ]);

  const terrain = createTerrain(world);
  scene.add(assets.world);
  const fire = createFire(scene, world.fire);
  const markers = createMarkers({ scene, template: assets.marker, labelsEl: ui.labels });
  for (const t of listing.threads) markers.add(t);
  const player = createPlayer({ scene, camera, canvas: ui.canvas, template: assets.wanderer, terrain, markers, spawn: world.spawn });
  const phantoms = createPhantoms({ scene, template: assets.wanderer });
  const wind = createWind();

  let phase = 'portal';
  let online = 0;
  const counts = { threads: listing.stats.threads, posts: listing.stats.posts };
  const renderStats = () => {
    ui.online.textContent = String(Math.max(online, phase === 'world' ? 1 : 0));
    ui.stats.textContent = `На острове ${counts.threads} ${plural(counts.threads, 'тред', 'треда', 'тредов')} и ${counts.posts} ${plural(counts.posts, 'пост', 'поста', 'постов')} · бродят сейчас: ${online}`;
  };
  renderStats();

  function addThread(marker, rise) {
    const isNew = !markers.get(marker.id);
    markers.add(marker, { rise });
    if (isNew) {
      counts.threads++;
      counts.posts++;
      renderStats();
    }
  }

  const net = connect({
    onHello: (d) => { online = d.online; renderStats(); },
    onWelcome: (id) => { phantoms.selfId = id; },
    onPlayers: (snapshot) => {
      phantoms.sync(snapshot);
      online = snapshot.length;
      renderStats();
    },
    onLeave: (id) => phantoms.remove(id),
    onThread: (m) => addThread(m, true),
    onBump: (m) => {
      markers.add(m);
      counts.posts++;
      renderStats();
      board.notifyBump(m);
    },
  });

  const forward = () => ({ x: Math.sin(player.yaw), z: Math.cos(player.yaw) });

  const board = createBoard({
    root: ui.board,
    body: ui.boardBody,
    preview: ui.preview,
    onOpen: () => {
      player.setEnabled(false);
      ui.prompt.hidden = true;
      ui.lockHint.hidden = true;
      markers.hideLabels();
    },
    onClose: () => { if (phase === 'world') player.setEnabled(true); },
    onPlanted: (thread) => {
      addThread(thread, true);
      const f = forward();
      // Step back and a little left: the over-the-shoulder camera sits right, so the rising stone
      // ends up beside the avatar instead of hidden behind it.
      player.nudge(-f.x * 2.6 + f.z * 1.3, -f.z * 2.6 - f.x * 1.3);
      toast(`Тред №${thread.id} посажен. Камень поднимается из земли.`);
    },
    onMark: (id) => { if (markers.setWaypoint(id)) toast(`Камень №${id} отмечен столбом света. Иди к нему.`); },
    getPos: () => player.pos,
    getMarkers: () => markers.list(),
  });

  function interact() {
    const near = markers.nearest(player.pos, INTERACT_RANGE);
    if (!near) return toast('Рядом нет камней. Подойди к монолиту поближе.');
    if (markers.waypointId === near.data.id) markers.clearWaypoint();
    board.openThread(near.data.id);
  }

  function plant() {
    const x = Math.round(player.pos.x * 100) / 100;
    const z = Math.round(player.pos.z * 100) / 100;
    const spot = terrain.plantable(x, z);
    if (!spot.ok) return toast(spot.reason);
    const near = markers.nearest(player.pos, THREAD_SPACING);
    if (near) return toast(`Тут уже стоит тред №${near.data.id}. Отойди на пару шагов.`);
    board.openPlant({ x, z, heading: player.yaw + Math.PI });
  }

  const toggleView = () => toast(player.toggleView() ? 'Вид от первого лица' : 'Вид от третьего лица');
  const toggleWind = () => toast(wind.toggle() ? 'Ветер: вкл' : 'Ветер: выкл');

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && board.mode) {
      e.preventDefault();
      board.close();
      return;
    }
    if (phase !== 'world' || board.mode || e.repeat) return;
    if (e.target instanceof Element && e.target.closest('input, textarea')) return;
    if (e.code === 'KeyE') interact();
    else if (e.code === 'KeyT') plant();
    else if (e.code === 'KeyC') board.openCatalog();
    else if (e.code === 'KeyV') toggleView();
    else if (e.code === 'KeyM') toggleWind();
  });

  ui.hud.addEventListener('click', (e) => {
    const link = e.target.closest('[data-hud]');
    if (!link) return;
    e.preventDefault();
    const action = link.dataset.hud;
    if (action === 'catalog') board.openCatalog();
    else if (action === 'plant') plant();
    else if (action === 'view') toggleView();
    else if (action === 'sound') toggleWind();
    else if (action === 'help') board.openHelp();
  });

  ui.enter.addEventListener('click', () => {
    phase = 'world';
    ui.portal.hidden = true;
    ui.hud.hidden = false;
    player.setEnabled(true);
    player.show();
    player.requestLock();
    net.enter();
    wind.set(true);
    renderStats();
    toast('Ты на острове. Найди светящийся камень и нажми E. Свой тред — клавиша T.');
  });

  let promptKey = '';
  let coordsKey = '';
  function updateHud() {
    const near = markers.nearest(player.pos, INTERACT_RANGE);
    const key = near ? `${near.data.id}` : '';
    if (key !== promptKey) {
      promptKey = key;
      if (near) {
        const title = near.data.subject || (near.data.excerpt || '').slice(0, 48) || 'без названия';
        ui.prompt.innerHTML = `[E] Прочесть тред №${near.data.id} — <span class="subject">${esc(title)}</span>`;
      }
      ui.prompt.hidden = !near;
    }
    const c = `X ${Math.round(player.pos.x)} · Z ${Math.round(player.pos.z)}`;
    if (c !== coordsKey) ui.coords.textContent = coordsKey = c;
    ui.lockHint.hidden = document.pointerLockElement === ui.canvas;
    const wp = markers.waypointId && markers.get(markers.waypointId);
    if (wp && Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) < 4) markers.clearWaypoint();
  }

  const timer = new THREE.Timer();
  timer.connect(document);
  const orbitTarget = new THREE.Vector3().fromArray(world.landmarks.circle);
  let sendClock = 0;
  let lastSent = '';

  engine.renderer.setAnimationLoop((ts) => {
    timer.update(ts);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();
    let focus = orbitTarget;
    if (phase === 'world') {
      if (player.enabled) player.update(dt);
      focus = player.pos;
      sendClock += dt;
      if (sendClock >= 0.1) {
        sendClock = 0;
        const state = player.netState();
        const key = state.map((v) => v.toFixed(2)).join();
        if (key !== lastSent) {
          lastSent = key;
          net.move(state);
        }
      }
    } else {
      const a = t * 0.035;
      camera.position.set(orbitTarget.x + Math.sin(a) * 34, orbitTarget.y + 11, orbitTarget.z + Math.cos(a) * 34);
      camera.lookAt(orbitTarget.x, orbitTarget.y + 1.5, orbitTarget.z);
    }
    markers.tick(t, dt, Date.now() / 1000);
    phantoms.tick(dt);
    fire.update(t, dt);
    engine.update(t, dt, focus);
    engine.render();
    if (phase === 'world' && !board.mode) {
      markers.updateLabels(camera, player.pos);
      updateHud();
    }
  });

  ui.status.textContent = '';
  ui.enter.textContent = 'Войти в туман';
  ui.enter.disabled = false;

  // Handle for automated smoke tests; exposes nothing the client does not already control.
  window.__bruhchan = {
    get phase() { return phase; },
    get pos() { return player.pos.toArray(); },
    get markers() { return markers.size; },
    get phantoms() { return phantoms.count; },
    get board() { return board.mode; },
    teleport: (x, z) => player.teleport(x, z),
    look: (yaw, pitch) => player.look(yaw, pitch),
  };
}

boot().catch((err) => fail(`Остров не загрузился: ${err.message}`));
