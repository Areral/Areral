import { renderComment } from './markup.js';
import { api, esc, fmtDate, fmtSize, plural, where } from './util.js';

export const WALLET = 'TZ3cy3xZds7rtCmQcKZKCTXbdy3fbsmPUm';
const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/webm';
const MAX_FILE = 8 * 1024 * 1024;
const TITLE = '/b/ — Остров';

const donation = () => `<div class="boardFooter"><div class="donate">Брухчан живёт без рекламы и трекеров. Помочь с оплатой сервера можно в <b>USDT</b> (сеть <b>TRC-20</b>, например с Bybit): <code class="wallet">${WALLET}</code> <button type="button" data-copy="${WALLET}">Скопировать</button> <span class="copyStatus" aria-live="polite"></span></div></div>`;

const banner = (title, subtitle) =>
  `<div class="boardBanner"><img src="/img/emblem.svg" width="44" height="44" alt=""><div class="boardTitle">${title}</div><div class="boardSubtitle">${subtitle}</div></div><hr>`;

const nav = (extra = '') => `<div class="navLinks">[<a href="#" data-act="close">Вернуться в туман</a>]${extra}</div>`;

function fileBlock(f) {
  return `<div class="file"><div class="fileText">Файл: <a href="${esc(f.src)}" target="_blank" rel="noopener">${esc(f.name)}</a> (${fmtSize(f.size)}, ${f.w}x${f.h}${f.kind === 'video' ? ', webm' : ''})</div><a class="fileThumb" href="${esc(f.src)}" data-kind="${esc(f.kind)}"><img src="${esc(f.thumb)}" width="${f.tw}" height="${f.th}" alt="${fmtSize(f.size)}" loading="lazy"></a></div>`;
}

function postInfo(p) {
  return `<div class="postInfo">${p.subject ? `<span class="subject">${esc(p.subject)}</span> ` : ''}<span class="name">${esc(p.name)}</span> <span class="dateTime">${fmtDate(p.time)}</span> <span class="postNum"><a href="#p${p.no}" data-jump="${p.no}" title="Ссылка на пост">№</a><a href="#" data-quote="${p.no}" title="Ответить на этот пост">${p.no}</a></span><span class="backlinks"></span></div>`;
}

function postHtml(p, isOp) {
  const message = `<blockquote class="postMessage">${renderComment(p.comment)}</blockquote>`;
  if (isOp) {
    return `<div class="postContainer opContainer" id="pc${p.no}"><div class="post op" id="p${p.no}">${p.file ? fileBlock(p.file) : ''}${postInfo(p)}${message}</div></div>`;
  }
  return `<div class="postContainer replyContainer" id="pc${p.no}"><div class="sideArrows">&gt;&gt;</div><div class="post reply" id="p${p.no}">${postInfo(p)}${p.file ? fileBlock(p.file) : ''}${message}</div></div>`;
}

function formHtml(kind) {
  const plant = kind === 'plant';
  const second = plant
    ? '<tr><td class="label">Тема</td><td><input type="text" name="subject" maxlength="100"> <button type="submit">Посадить</button></td></tr>'
    : '<tr><td class="label">Опции</td><td><label class="sage"><input type="checkbox" name="sage" value="1"> sage</label> <button type="submit">Ответить</button></td></tr>';
  return `<form class="postForm" data-form="${kind}" autocomplete="off"><table><tbody>
    <tr><td class="label">Имя</td><td><input type="text" name="name" placeholder="Аноним" maxlength="40"></td></tr>
    ${second}
    <tr><td class="label">Комментарий</td><td><textarea name="comment" rows="5" maxlength="5000"></textarea></td></tr>
    <tr><td class="label">Файл</td><td><input type="file" name="file" accept="${ACCEPT}"></td></tr>
    <tr><td colspan="2" class="formStatus" aria-live="polite"></td></tr>
  </tbody></table>
  <ul class="rules">
    <li>JPG, PNG, GIF, WebP и WebM до 8 МБ. EXIF, геометки и прочие метаданные вырезаются на сервере.</li>
    <li>&gt;текст — гринтекст, &gt;&gt;123 — ссылка на пост, [spoiler]…[/spoiler] — спойлер.</li>
    ${plant ? '' : '<li>sage — ответить, не поднимая тред: руна на камне не разгорится.</li>'}
  </ul></form>`;
}

export function createBoard({ root, body, preview, onOpen, onClose, onPlanted, onMark, getPos, getMarkers }) {
  const scroller = root.querySelector('.boardScroll');
  let mode = null;
  let current = null;
  let plantSpot = null;
  let seenReplies = 0;
  let catalogSort = 'distance';

  function show(html) {
    body.innerHTML = html;
    preview.hidden = true;
    if (root.hidden) {
      root.hidden = false;
      onOpen();
    }
    scroller.scrollTop = 0;
  }

  function close() {
    if (!mode) return;
    mode = null;
    current = null;
    plantSpot = null;
    root.hidden = true;
    preview.hidden = true;
    body.innerHTML = '';
    onClose();
  }

  async function openThread(id, { scrollTo } = {}) {
    const first = mode !== 'thread' || current !== id;
    mode = 'thread';
    current = id;
    if (first) show(`${banner(TITLE, `Тред №${id}`)}<div class="loading">Разбираем надписи на камне…</div>`);
    try {
      const data = await api(`/api/threads/${id}`);
      if (mode !== 'thread' || current !== id) return;
      renderThread(data, first);
      if (scrollTo) jumpTo(scrollTo);
    } catch (err) {
      if (mode === 'thread' && current === id) body.innerHTML = `${banner(TITLE, '')}${nav()}<div class="boardError">${esc(err.message)}</div>`;
    }
  }

  function renderThread({ thread, posts }, first) {
    seenReplies = thread.replies;
    const subtitle = `Тред №${thread.id} · камень стоит в X ${Math.round(thread.x)}, Z ${Math.round(thread.z)} · ${thread.replies} ${plural(thread.replies, 'ответ', 'ответа', 'ответов')}`;
    if (first || !body.querySelector('.thread')) {
      const links = ' [<a href="#" data-act="refresh">Обновить</a>]';
      show(`${banner(TITLE, subtitle)}${nav(`${links} [<a href="#" data-act="bottom">Вниз</a>]`)}${formHtml('reply')}<hr><div class="newReplies" hidden></div><div class="thread"></div><hr>${nav(`${links} [<a href="#" data-act="top">Наверх</a>]`)}${donation()}`);
    } else {
      body.querySelector('.boardSubtitle').textContent = subtitle;
    }
    const container = body.querySelector('.thread');
    container.id = `t${thread.id}`;
    container.innerHTML = posts.map((p, i) => postHtml(p, i === 0)).join('');
    body.querySelector('.newReplies').hidden = true;
    linkBacks(container, thread.id);
  }

  function linkBacks(container, opId) {
    const seen = new Set();
    for (const a of container.querySelectorAll('a.quotelink')) {
      const target = a.dataset.no;
      if (Number(target) === opId) a.textContent += ' (OP)';
      const from = a.closest('.post')?.id.slice(1);
      if (!from || seen.has(`${from}>${target}`)) continue;
      seen.add(`${from}>${target}`);
      container.querySelector(`#p${target} .backlinks`)
        ?.insertAdjacentHTML('beforeend', `<a class="quotelink" href="#p${from}" data-no="${from}">&gt;&gt;${from}</a>`);
    }
  }

  function jumpTo(no) {
    const post = body.querySelector(`#p${no}`);
    if (!post) return;
    for (const el of body.querySelectorAll('.highlight')) el.classList.remove('highlight');
    if (post.classList.contains('reply')) post.classList.add('highlight');
    post.scrollIntoView({ block: 'center' });
  }

  function openPlant(spot) {
    mode = 'plant';
    current = null;
    plantSpot = spot;
    show(`${banner('Посадить тред', 'новый камень на острове')}${nav()}<p class="plantInfo">Камень встанет прямо у твоих ног — X ${spot.x.toFixed(1)}, Z ${spot.z.toFixed(1)}. Его увидит каждый, кто забредёт сюда. Пока в треде отвечают, руна на камне горит ярко; без ответов она остывает до тлеющего уголька.</p>${formHtml('plant')}${donation()}`);
    body.querySelector('input[name="subject"]')?.focus();
  }

  function openCatalog(sort = catalogSort) {
    catalogSort = sort;
    mode = 'catalog';
    current = null;
    const pos = getPos();
    const rows = getMarkers().map((m) => ({ m, d: Math.hypot(m.x - pos.x, m.z - pos.z) }));
    rows.sort(sort === 'distance' ? (a, b) => a.d - b.d : (a, b) => b.m.bumped - a.m.bumped);
    const tr = rows
      .map(({ m }) => `<tr><td>${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : ''}</td><td>№${m.id}</td><td>${m.subject ? `<span class="subject">${esc(m.subject)}</span> ` : ''}${esc((m.excerpt || '').slice(0, 140))}</td><td>${m.replies}</td><td>${where(pos, m)}</td><td>${fmtDate(m.bumped)}</td><td>[<a href="#" data-mark="${m.id}">Отметить</a>]</td></tr>`)
      .join('');
    const empty = '<tr><td colspan="7" class="empty">Остров пуст. Посади первый тред — клавиша T.</td></tr>';
    show(`${banner('Каталог острова', `${rows.length} ${plural(rows.length, 'тред', 'треда', 'тредов')} на острове · расстояния — от места, где ты стоишь`)}${nav(` [<a href="#" data-sort="distance">сначала ближние</a>] [<a href="#" data-sort="bump">по бампу</a>]`)}<p class="boardNote">Читать треды можно только у самого камня. Отметь нужный — над ним встанет столб света — и дойди пешком.</p><table class="catalogTable"><thead><tr><th></th><th>№</th><th>Тред</th><th>Отв.</th><th>Где</th><th>Бамп</th><th></th></tr></thead><tbody>${tr || empty}</tbody></table>${donation()}`);
  }

  function openHelp() {
    mode = 'help';
    current = null;
    const boxes = [...document.querySelectorAll('#portal .box')].map((b) => b.outerHTML).join('');
    show(`${banner('Помощь', 'как устроен остров')}${nav()}${boxes}${donation()}`);
  }

  function notifyBump(marker) {
    if (mode !== 'thread' || current !== marker.id || marker.replies <= seenReplies) return;
    const el = body.querySelector('.newReplies');
    if (!el) return;
    const n = marker.replies - seenReplies;
    el.innerHTML = `${n} ${plural(n, 'новый ответ', 'новых ответа', 'новых ответов')} — [<a href="#" data-act="refresh">Обновить</a>]`;
    el.hidden = false;
  }

  function quote(no) {
    const area = body.querySelector('.postForm textarea');
    if (!area) return;
    const insert = `>>${no}\n`;
    const at = area.selectionStart ?? area.value.length;
    area.value = area.value.slice(0, at) + insert + area.value.slice(area.selectionEnd ?? at);
    area.focus();
    area.selectionStart = area.selectionEnd = at + insert.length;
    area.scrollIntoView({ block: 'center' });
  }

  function expand(link) {
    const img = link.querySelector('img');
    if (link.dataset.kind === 'video') {
      const box = document.createElement('div');
      box.className = 'expandedWebm';
      box.innerHTML = `<video src="${esc(link.getAttribute('href'))}" controls autoplay loop playsinline></video>[<a href="#" data-act="collapse">Свернуть</a>]`;
      link.hidden = true;
      link.after(box);
      return;
    }
    if (!link.classList.contains('expanded')) {
      img.dataset.thumb = img.getAttribute('src');
      img.dataset.size = `${img.getAttribute('width')}x${img.getAttribute('height')}`;
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.src = link.getAttribute('href');
      link.classList.add('expanded');
    } else {
      const [w, h] = img.dataset.size.split('x');
      img.src = img.dataset.thumb;
      img.setAttribute('width', w);
      img.setAttribute('height', h);
      link.classList.remove('expanded');
    }
  }

  async function submit(form) {
    const status = form.querySelector('.formStatus');
    const button = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || !file.size) data.delete('file');
    else if (file.size > MAX_FILE) {
      status.className = 'formStatus error';
      status.textContent = 'Файл слишком большой. Максимум — 8 МБ.';
      return;
    }
    status.className = 'formStatus';
    status.textContent = 'Отправляем…';
    button.disabled = true;
    try {
      if (form.dataset.form === 'plant') {
        data.set('x', String(plantSpot.x));
        data.set('z', String(plantSpot.z));
        data.set('heading', String(plantSpot.heading));
        const { thread } = await api('/api/threads', { method: 'POST', body: data });
        close();
        onPlanted(thread);
      } else {
        const id = current;
        const { post } = await api(`/api/threads/${id}/replies`, { method: 'POST', body: data });
        form.reset();
        status.textContent = '';
        button.disabled = false;
        await openThread(id, { scrollTo: post.no });
      }
    } catch (err) {
      status.className = 'formStatus error';
      status.textContent = err.message;
      button.disabled = false;
    }
  }

  body.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(e.target);
  });

  body.addEventListener('click', (e) => {
    const el = e.target.closest('a');
    if (!el) return;
    const { act, quote: q, mark, sort, jump } = el.dataset;
    if (act) {
      e.preventDefault();
      if (act === 'close') close();
      else if (act === 'refresh' && current) openThread(current);
      else if (act === 'bottom') scroller.scrollTop = scroller.scrollHeight;
      else if (act === 'top') scroller.scrollTop = 0;
      else if (act === 'collapse') {
        const box = el.closest('.expandedWebm');
        box.previousElementSibling.hidden = false;
        box.remove();
      }
    } else if (q) {
      e.preventDefault();
      quote(q);
    } else if (mark) {
      e.preventDefault();
      close();
      onMark(Number(mark));
    } else if (sort) {
      e.preventDefault();
      openCatalog(sort);
    } else if (jump || el.classList.contains('quotelink')) {
      e.preventDefault();
      jumpTo(jump || el.dataset.no);
    } else if (el.classList.contains('fileThumb')) {
      e.preventDefault();
      expand(el);
    }
  });

  function placePreview(e) {
    const r = preview.getBoundingClientRect();
    const x = Math.min(e.clientX + 14, window.innerWidth - r.width - 6);
    const y = Math.max(6, Math.min(e.clientY - r.height / 2, window.innerHeight - r.height - 6));
    preview.style.left = `${x}px`;
    preview.style.top = `${y}px`;
  }
  body.addEventListener('mouseover', (e) => {
    const link = e.target.closest('a.quotelink');
    const post = link && body.querySelector(`#p${link.dataset.no}`);
    if (!post) return;
    const clone = post.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.remove('highlight');
    preview.replaceChildren(clone);
    preview.hidden = false;
    placePreview(e);
  });
  body.addEventListener('mousemove', (e) => { if (!preview.hidden) placePreview(e); });
  body.addEventListener('mouseout', (e) => { if (e.target.closest('a.quotelink')) preview.hidden = true; });

  return {
    openThread,
    openPlant,
    openCatalog,
    openHelp,
    notifyBump,
    close,
    get mode() { return mode; },
    get current() { return current; },
  };
}
