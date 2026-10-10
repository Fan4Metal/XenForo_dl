const DEFAULTS = {
  range: 'all',
  incAttach: true,
  incEmbed: true,
  incVideo: true,
  incQuotes: true,
  incSigs: false,
  skipSmall: true,
  minSize: 100,
  folder: 'XenForo',
  numbering: true,
  preferOriginal: false,
  hideUi: true,
  eraseHistory: false,
  concurrency: 3,
  pageDelay: 300,
  pageConcurrency: 2,
};
const CHECKS = ['incAttach', 'incEmbed', 'incVideo', 'incQuotes', 'incSigs', 'skipSmall', 'numbering', 'preferOriginal', 'hideUi', 'eraseHistory'];
const NUMBERS = ['minSize', 'concurrency', 'pageDelay', 'pageConcurrency'];

const $ = (id) => document.getElementById(id);
let tab = null;
let info = null;
let settings = { ...DEFAULTS };
let scan = null;
let job = null;

// ---------- настройки ----------

async function loadSettings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(s || {}) };
  for (const k of CHECKS) $(k).checked = !!settings[k];
  for (const k of NUMBERS) $(k).value = settings[k];
  $('folder').value = settings.folder;
  for (const r of document.querySelectorAll('input[name=range]')) r.checked = r.value === settings.range;
}

function readSettings() {
  for (const k of CHECKS) settings[k] = $(k).checked;
  for (const k of NUMBERS) {
    const v = parseInt($(k).value, 10);
    settings[k] = Number.isFinite(v) ? v : DEFAULTS[k];
  }
  settings.folder = $('folder').value.trim();
  settings.range = document.querySelector('input[name=range]:checked')?.value || 'all';
  chrome.storage.local.set({ settings });
  return settings;
}

const onInput = (e) => {
  if (e.target.matches('input')) {
    readSettings();
    renderScan();
  }
};
document.addEventListener('change', onInput);
$('minSize').addEventListener('input', onInput);

// ---------- работа со вкладкой ----------

async function inTab(func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res && res.result;
}

async function detect() {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  return inTab(() => window.__xfdl.detect());
}

// ---------- фильтрация ----------

function selected() {
  if (!scan || !scan.result) return [];
  return scan.result.images.filter((img) => xfdlPasses(img, settings));
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const imgs = (n) => `${n} ${plural(n, 'изображение', 'изображения', 'изображений')}`;
const vids = (n) => `${n} видео`;

// ---------- отрисовка ----------

function renderThread() {
  if (!info) return;
  $('threadTitle').textContent = info.title;
  const parts = [info.host];
  if (info.totalPages > 1) parts.push(`страница ${info.currentPage} из ${info.totalPages}`);
  else parts.push('1 страница');
  if (!info.isXF) parts.push('⚠ не похоже на XenForo');
  else if (!info.isThread) parts.push('⚠ это не страница треда');
  $('threadSub').textContent = parts.join(' · ');

  $('from').max = $('to').max = info.totalPages;
  if (!$('from').value) $('from').value = 1;
  if (!$('to').value) $('to').value = info.totalPages;
  $('scanBox').hidden = false;
}

function renderScan() {
  const relevant = scan && info && scan.meta && scan.meta.threadKey === info.threadKey ? scan : null;
  const scanning = relevant && relevant.status === 'scanning';

  $('scanBtn').disabled = !!scanning;
  $('scanBtn').textContent = relevant && relevant.result ? 'Сканировать заново' : 'Сканировать';
  $('scanStop').hidden = !scanning;
  $('scanProgress').hidden = !scanning;
  if (scanning) {
    const pct = relevant.total ? (relevant.done / relevant.total) * 100 : 0;
    $('scanBar').style.width = `${pct}%`;
    $('scanText').textContent = relevant.phase === 'sizes'
      ? `Проверка размеров: ${relevant.done} из ${relevant.total}`
      : `Страниц: ${relevant.done} из ${relevant.total} · найдено ${relevant.found}`;
  }
  $('scanError').hidden = !(relevant && relevant.status === 'error');
  if (relevant && relevant.status === 'error') $('scanError').textContent = relevant.error;

  const result = relevant && relevant.status === 'done' && relevant.result;
  $('resultBox').hidden = !result;
  if (!result) return;

  const all = result.images;
  const pics = all.filter((i) => i.type !== 'video');
  $('cAttach').textContent = `(${pics.filter((i) => i.kind === 'attachment').length})`;
  $('cEmbed').textContent = `(${pics.filter((i) => i.kind !== 'attachment').length})`;
  $('cVideo').textContent = `(${all.length - pics.length})`;
  $('cSmall').textContent = result.sizesProbed ? `(${pics.filter((i) => xfdlIsSmall(i, settings.minSize)).length})` : '';
  $('cQuotes').textContent = `(${all.filter((i) => i.quote).length})`;
  $('cSigs').textContent = `(${all.filter((i) => i.sig).length})`;

  const sel = selected();
  const n = sel.length;
  const nv = sel.filter((i) => i.type === 'video').length;
  const pages = result.pages.from === result.pages.to
    ? `стр. ${result.pages.from}` : `стр. ${result.pages.from}–${result.pages.to}`;
  $('total').textContent = `К загрузке: ${imgs(n - nv)}${nv ? `, ${vids(nv)}` : ''} (${pages})`;

  const warns = [];
  if (relevant.cancelled) warns.push('Сканирование было остановлено — список неполный.');
  if (settings.skipSmall && !result.sizesProbed) {
    warns.push('Размеры картинок не проверялись — пересканируйте, чтобы отсеять мелкие.');
  }
  if (result.errors.length) {
    warns.push(`Не удалось загрузить страницы: ${result.errors.map((e) => e.page).join(', ')}.`);
  }
  $('scanWarn').hidden = !warns.length;
  $('scanWarn').textContent = warns.join(' ');

  const running = job && job.state === 'running';
  $('dlBtn').disabled = !n || running;
  $('dlBtn').title = running ? 'Дождитесь окончания текущей загрузки' : '';
  $('copyBtn').disabled = !n;
}

function renderJob() {
  $('jobBox').hidden = !job;
  if (!job) return;
  const c = { done: 0, failed: 0, active: 0, pending: 0, skipped: 0 };
  for (const it of job.items) c[it.status]++;
  const total = job.items.length;
  const finished = c.done + c.failed + c.skipped;

  $('jobTitle').textContent = `${job.title} → ${job.folder}`;
  $('jobBar').style.width = `${(finished / total) * 100}%`;
  $('jobBar').classList.toggle('ok', job.state === 'finished' && !c.failed);

  let text = `Скачано ${c.done} из ${total}`;
  if (c.failed) text += ` · ошибок: ${c.failed}`;
  if (job.state === 'running') text += c.active ? ` · в процессе: ${c.active}` : '';
  else if (job.state === 'finished') text = (c.failed ? 'Готово с ошибками. ' : 'Готово! ') + text;
  else if (job.state === 'cancelled') text = `Отменено. ${text}`;
  $('jobText').textContent = text;

  const running = job.state === 'running';
  $('cancelBtn').hidden = !running;
  $('retryBtn').hidden = running || !(c.failed || c.skipped);
  $('showBtn').hidden = !job.lastDoneId && !c.done;
  $('clearBtn').hidden = running;

  const failed = job.items.filter((i) => i.status === 'failed');
  $('failedBox').hidden = !failed.length;
  $('failedCount').textContent = failed.length;
  const list = $('failedList');
  list.replaceChildren(...failed.slice(0, 200).map((it) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.textContent = it.name || it.url;
    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = `стр. ${it.page}: ${it.error || 'ошибка'}`;
    li.append(a, reason);
    return li;
  }));
}

// ---------- действия ----------

$('scanBtn').addEventListener('click', async () => {
  const s = readSettings();
  const opts = {
    range: s.range,
    from: $('from').value,
    to: $('to').value,
    pageDelay: s.pageDelay,
    pageConcurrency: s.pageConcurrency,
    probeSizes: s.skipSmall,
  };
  $('scanBtn').disabled = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await inTab((o) => { window.__xfdl.scan(o); return true; }, [opts]);
  } catch (e) {
    $('scanError').hidden = false;
    $('scanError').textContent = `Не удалось запустить сканирование: ${e.message}`;
    $('scanBtn').disabled = false;
  }
});

$('scanStop').addEventListener('click', () => {
  inTab(() => window.__xfdl && window.__xfdl.cancel()).catch(() => {});
});

$('dlBtn').addEventListener('click', async () => {
  $('dlBtn').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'xfdl:start', tabId: tab.id, options: readSettings() });
  if (!res || !res.ok) {
    $('scanWarn').hidden = false;
    $('scanWarn').textContent = (res && res.error) || 'Не удалось начать загрузку.';
  }
  renderScan();
});

$('copyBtn').addEventListener('click', async () => {
  const urls = selected().map((i) => (settings.preferOriginal && i.orig ? i.orig : i.url));
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    $('copyBtn').textContent = `Скопировано: ${urls.length}`;
  } catch {
    $('copyBtn').textContent = 'Ошибка копирования';
  }
  setTimeout(() => { $('copyBtn').textContent = 'Копировать ссылки'; }, 1800);
});

$('cancelBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'xfdl:cancel' }));
$('retryBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'xfdl:retry' }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'xfdl:clear' }));
$('showBtn').addEventListener('click', async () => {
  try {
    if (job && job.lastDoneId != null) {
      const [d] = await chrome.downloads.search({ id: job.lastDoneId });
      if (d && d.exists !== false) return chrome.downloads.show(job.lastDoneId);
    }
  } catch {}
  chrome.downloads.showDefaultFolder();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (tab && changes[`scan:${tab.id}`]) {
    scan = changes[`scan:${tab.id}`].newValue || null;
    renderScan();
  }
  if (changes.job) {
    job = changes.job.newValue || null;
    renderJob();
    renderScan();
  }
});

// ---------- запуск ----------

(async () => {
  await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'xfdl:ping' }).catch(() => {});
  const stored = await chrome.storage.session.get(['job', `scan:${tab.id}`]);
  job = stored.job || null;
  scan = stored[`scan:${tab.id}`] || null;
  renderJob();

  try {
    info = await detect();
  } catch (e) {
    $('threadTitle').textContent = 'Здесь расширение недоступно';
    $('threadSub').textContent = 'Откройте тред форума на XenForo и нажмите на иконку снова.';
    return;
  }
  renderThread();
  renderScan();
})();
