// Фоновый service worker: хранит результаты сканирования и ведёт очередь загрузок.
// Состояние задания лежит в chrome.storage.session, чтобы пережить перезапуск воркера.

const MAX_ATTEMPTS = 3;
const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|tiff?|heic|svg|ico)$/i;
const GENERIC_STEM = /^(proxy|index|download|attachment|attachments|image|file|unknown|untitled|\d+)$/i;
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'image/tiff': 'tif', 'image/heic': 'heic', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};

let job = null;      // кэш состояния задания
let jobLoaded = false;
let chain = Promise.resolve();

// Все изменения задания выполняются строго последовательно.
const serial = (fn) => (chain = chain.then(fn, fn).catch((e) => console.error('[xfdl]', e)));

async function getJob() {
  if (!jobLoaded) {
    const r = await chrome.storage.session.get('job');
    if (!jobLoaded) {
      job = r.job || null;
      jobLoaded = true;
      if (job && job.state === 'running') await reconcile(job);
    }
  }
  return job;
}

const saveJob = () => chrome.storage.session.set({ job });

// После перезапуска воркера сверяем "активные" элементы с реальным состоянием загрузок.
async function reconcile(j) {
  for (const it of j.items) {
    if (it.status !== 'active' || it.downloadId == null) continue;
    const [d] = await chrome.downloads.search({ id: it.downloadId });
    if (!d) it.status = 'pending';
    else if (d.state === 'complete') it.status = 'done';
    else if (d.state === 'interrupted') {
      it.status = it.attempts < MAX_ATTEMPTS ? 'pending' : 'failed';
      it.error = d.error || 'INTERRUPTED';
    }
  }
}

function setDownloadUi(enabled) {
  try { chrome.downloads.setUiOptions({ enabled }).catch(() => {}); } catch {}
}

// ---------- имена файлов ----------

function sanitize(s, max = 120) {
  s = String(s || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  if (s.length > max) {
    const m = s.match(/(\.[a-z0-9]{1,5})$/i);
    const ext = m ? m[1] : '';
    s = s.slice(0, max - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  return s;
}

function sanitizePath(p) {
  return String(p || '')
    .split(/[\\/]+/)
    .map((seg) => sanitize(seg, 80))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

const basename = (p) => String(p || '').split(/[\\/]/).pop();
const stem = (n) => n.replace(/\.[^.]+$/, '');

const EXT_ALIASES = { jpg: ['jpg', 'jpeg', 'jpe'], tif: ['tif', 'tiff'] };

// Приводим расширение к реальному типу файла: иначе Chrome сам подставит своё (например, .jfif для JPEG).
function fixExt(name, mime) {
  const want = MIME_EXT[(mime || '').toLowerCase()];
  const ext = IMG_EXT.test(name) ? name.split('.').pop().toLowerCase() : null;
  if (!want) return ext === 'jfif' ? `${stem(name)}.jpg` : ext ? name : `${name}.jpg`;
  if (ext && (EXT_ALIASES[want] || [want]).includes(ext)) return name;
  return `${ext ? stem(name) : name}.${want}`;
}

function chooseName(it, item) {
  const server = basename(item.filename);
  let name;
  if (server && IMG_EXT.test(server) && !GENERIC_STEM.test(stem(server))) name = server;
  else if (it.name && IMG_EXT.test(it.name)) name = it.name;
  else name = it.name || (server && stem(server)) || 'image';
  return fixExt(name, item.mime);
}

// ---------- очередь ----------

async function pump() {
  const j = await getJob();
  if (!j) return;
  if (j.state === 'running') {
    let active = j.items.filter((i) => i.status === 'active').length;
    for (const it of j.items) {
      if (active >= j.concurrency) break;
      if (it.status !== 'pending') continue;
      it.status = 'active';
      it.attempts++;
      it.downloadId = null;
      active++;
      try {
        it.downloadId = await chrome.downloads.download({ url: it.url, saveAs: false, conflictAction: 'uniquify' });
      } catch (e) {
        it.status = 'failed';
        it.error = String(e && e.message || e);
        active--;
      }
    }
    if (!j.items.some((i) => i.status === 'pending' || i.status === 'active')) {
      j.state = 'finished';
      j.finishedAt = Date.now();
    }
  }
  if (j.state !== 'running' && j.hideUi) setDownloadUi(true);
  await saveJob();
}

function findItem(j, dl) {
  return j.items.find((i) => i.status === 'active' && i.downloadId === dl.id) ||
    j.items.find((i) => i.status === 'active' && i.downloadId == null && (i.url === dl.url || i.url === dl.finalUrl));
}

async function startJob(tabId, opts) {
  const j = await getJob();
  if (j && j.state === 'running') return { ok: false, error: 'Уже идёт загрузка. Дождитесь окончания или отмените её.' };

  const { [`scan:${tabId}`]: scan } = await chrome.storage.session.get(`scan:${tabId}`);
  if (!scan || !scan.result) return { ok: false, error: 'Сначала просканируйте тред.' };

  const images = scan.result.images.filter((img) =>
    (img.kind === 'attachment' ? opts.incAttach : opts.incEmbed) &&
    (opts.incQuotes || !img.quote) &&
    (opts.incSigs || !img.sig));
  if (!images.length) return { ok: false, error: 'Нет изображений для загрузки с текущими фильтрами.' };

  const title = sanitize(scan.meta.title, 80) || 'thread';
  const thread = scan.meta.threadId ? `${title} [${scan.meta.threadId}]` : title;
  const folder = [sanitizePath(opts.folder), sanitize(thread, 100)].filter(Boolean).join('/');
  const pad = Math.max(3, String(images.length).length);

  job = {
    state: 'running',
    tabId,
    title: scan.meta.title,
    folder,
    numbering: !!opts.numbering,
    pad,
    concurrency: Math.max(1, Math.min(8, +opts.concurrency || 3)),
    eraseHistory: !!opts.eraseHistory,
    hideUi: !!opts.hideUi,
    startedAt: Date.now(),
    items: images.map((img, i) => ({
      idx: i + 1,
      url: opts.preferOriginal && img.orig ? img.orig : img.url,
      name: img.name,
      page: img.page,
      status: 'pending',
      attempts: 0,
      downloadId: null,
      error: null,
    })),
  };
  jobLoaded = true;
  if (job.hideUi) setDownloadUi(false);
  await pump();
  return { ok: true, count: images.length };
}

async function cancelJob() {
  const j = await getJob();
  if (!j || j.state !== 'running') return;
  j.state = 'cancelled';
  for (const it of j.items) {
    if (it.status === 'pending') it.status = 'skipped';
    if (it.status === 'active') {
      it.status = 'skipped';
      if (it.downloadId != null) chrome.downloads.cancel(it.downloadId).catch(() => {});
    }
  }
  await pump();
}

async function retryFailed() {
  const j = await getJob();
  if (!j || j.state === 'running') return;
  let n = 0;
  for (const it of j.items) {
    if (it.status === 'failed' || it.status === 'skipped') {
      it.status = 'pending';
      it.attempts = 0;
      it.error = null;
      n++;
    }
  }
  if (!n) return;
  j.state = 'running';
  if (j.hideUi) setDownloadUi(false);
  await pump();
}

async function clearJob() {
  const j = await getJob();
  if (j && j.state === 'running') return;
  job = null;
  await chrome.storage.session.remove('job');
}

// ---------- события загрузок ----------

// Определяем путь сохранения для наших загрузок; чужие не трогаем.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    const j = await getJob();
    const it = j && j.state === 'running' && findItem(j, item);
    if (!it) return suggest();
    if (it.downloadId == null) it.downloadId = item.id;

    const name = sanitize(chooseName(it, item), 150) || `image-${it.idx}.jpg`;
    const prefix = j.numbering ? `${String(it.idx).padStart(j.pad, '0')}_` : '';
    suggest({ filename: `${j.folder}/${prefix}${name}`, conflictAction: 'uniquify' });

    // Вместо картинки пришла HTML-страница (логин, ошибка, капча) — отменяем.
    if ((item.mime || '').startsWith('text/html')) {
      it.notImage = true;
      chrome.downloads.cancel(item.id).catch(() => {});
    }
  })().catch((e) => {
    console.error('[xfdl]', e);
    try { suggest(); } catch {}
  });
  return true; // suggest вызывается асинхронно
});

chrome.downloads.onChanged.addListener((delta) => {
  const st = delta.state && delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  serial(async () => {
    const j = await getJob();
    if (!j) return;
    const it = j.items.find((i) => i.downloadId === delta.id && i.status === 'active');
    if (!it) return;
    if (st === 'complete') {
      it.status = 'done';
      j.lastDoneId = delta.id;
      if (j.eraseHistory) chrome.downloads.erase({ id: delta.id }).catch(() => {});
    } else {
      const [d] = await chrome.downloads.search({ id: delta.id });
      const err = (d && d.error) || 'INTERRUPTED';
      if (it.notImage) {
        it.status = 'failed';
        it.error = 'Сервер вернул HTML вместо изображения (нужен вход или доступ запрещён)';
      } else if (err === 'USER_CANCELED' || err.startsWith('FILE_') || it.attempts >= MAX_ATTEMPTS) {
        it.status = 'failed';
        it.error = err;
      } else {
        it.status = 'pending'; // повторим
      }
      chrome.downloads.erase({ id: delta.id }).catch(() => {});
    }
    await pump();
  });
});

// ---------- сообщения ----------

async function setScan(tabId, patch) {
  const key = `scan:${tabId}`;
  const { [key]: prev } = await chrome.storage.session.get(key);
  await chrome.storage.session.set({ [key]: { ...(prev || {}), ...patch } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg && msg.type) {
    case 'xfdl:scan-progress':
      serial(() => setScan(tabId, {
        status: 'scanning', meta: msg.meta, done: msg.done, total: msg.total, found: msg.found, result: null, error: null,
      }));
      return false;
    case 'xfdl:scan-done':
      serial(() => setScan(tabId, { status: 'done', meta: msg.meta, result: msg.result, cancelled: msg.cancelled }));
      return false;
    case 'xfdl:scan-error':
      serial(() => setScan(tabId, { status: 'error', meta: msg.meta, error: msg.error }));
      return false;
    case 'xfdl:start':
      serial(() => startJob(msg.tabId, msg.options || {})).then(sendResponse);
      return true;
    case 'xfdl:cancel':
      serial(cancelJob).then(() => sendResponse({ ok: true }));
      return true;
    case 'xfdl:retry':
      serial(retryFailed).then(() => sendResponse({ ok: true }));
      return true;
    case 'xfdl:clear':
      serial(clearJob).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});

// Уход со страницы прерывает сканирование.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  serial(async () => {
    const key = `scan:${tabId}`;
    const { [key]: s } = await chrome.storage.session.get(key);
    if (s && s.status === 'scanning') await setScan(tabId, { status: 'error', error: 'Сканирование прервано: страница была перезагружена.' });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`scan:${tabId}`).catch(() => {});
});

// При старте воркера: если задания нет — возвращаем панель загрузок Chrome.
serial(async () => {
  const j = await getJob();
  if (!j || j.state !== 'running') setDownloadUi(true);
  else await pump();
});
