// Сканер треда XenForo. Внедряется в страницу из popup через chrome.scripting.
// Повторное внедрение безопасно: всё API живёт в window.__xfdl.
(() => {
  const VERSION = 2;
  if (window.__xfdl && window.__xfdl.version === VERSION) return;

  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|tiff?|heic|svg)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|mpe?g|3gp|ogv)$/i;
  const MEDIA_SLUG = /-(jpe?g|jfif|png|gif|webp|avif|bmp|tiff?|heic|svg|mp4|m4v|webm|mov|mkv|avi|wmv|flv|mpe?g|3gp|ogv)$/i;
  // Картинки, которые не являются контентом поста.
  const SKIP_IMG = [
    '.smilie', '[data-smilie]', '.emoji', '[data-shortname]', '.avatar', '.reaction',
    '.bbCodeBlock--unfurl', '.bbCodeBlock-expandLink', '.bbMediaWrapper', '.contentRow-figure',
  ].join(',');

  let cancelled = false;
  let running = false;

  const hasMediaExt = (n) => IMG_EXT.test(n) || VIDEO_EXT.test(n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  function baseHref(doc, pageUrl) {
    const b = doc.querySelector('base[href]');
    try { return b ? new URL(b.getAttribute('href'), pageUrl).href : pageUrl; } catch { return pageUrl; }
  }

  function absUrl(u, base) {
    if (!u) return null;
    u = u.trim();
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) return null;
    try {
      const url = new URL(u, base);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  function isXenForo(doc) {
    const id = doc.documentElement.id;
    return id === 'XF' || id === 'XenForo' ||
      !!doc.querySelector('article.message .bbWrapper, #messageList li.message');
  }

  function threadTitle(doc) {
    const h = doc.querySelector('h1.p-title-value, .titleBar h1, h1');
    const t = (h ? h.textContent : doc.title).replace(/\s+/g, ' ').trim();
    return t || 'thread';
  }

  function threadId(url) {
    const m = url.match(/threads\/(?:[^/?#]*\.)?(\d+)/);
    return m ? m[1] : null;
  }

  const NAV_SEL = '.pageNav, .PageNav, .pageNavSimple';

  function pageInfo(doc, url) {
    let current = 1;
    let last = 1;
    const m = url.match(/\/page-(\d+)/);
    if (m) current = +m[1];
    const cur = doc.querySelector('.pageNav-page--current, .PageNav a.currentPage');
    if (cur && /^\d+$/.test(cur.textContent.trim())) current = +cur.textContent.trim();

    let template = null;
    for (const nav of doc.querySelectorAll(NAV_SEL)) {
      const dl = parseInt(nav.getAttribute('data-last'), 10);
      if (dl > last) last = dl;
      for (const a of nav.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        const mm = href.match(/\/page-(\d+)/);
        if (mm) {
          last = Math.max(last, +mm[1]);
          if (!template) template = absUrl(href, baseHref(doc, url));
        }
        const txt = a.textContent.trim();
        if (/^\d+$/.test(txt)) last = Math.max(last, +txt);
      }
    }
    last = Math.max(last, current);

    // Ссылка на первую страницу — без "/page-N".
    const cleanCurrent = url.split('#')[0];
    const pageUrl = (n) => {
      const tpl = template || cleanCurrent;
      if (/\/page-\d+/.test(tpl)) {
        return n === 1 ? tpl.replace(/\/page-\d+/, '') : tpl.replace(/\/page-\d+/, `/page-${n}`);
      }
      if (n === 1) return tpl;
      // Шаблона нет (одна страница) — дописываем page-N к пути треда.
      const u = new URL(tpl);
      u.pathname = u.pathname.replace(/\/?$/, `/page-${n}`);
      return u.href;
    };
    return { current, last, pageUrl };
  }

  // "/attachments/my-photo-jpg.12345/" -> { id: "12345", name: "my-photo.jpg" }
  function parseAttachment(url) {
    const m = url.match(/attachments\/(?:([^/?#&]*?)\.)?(\d+)\/?(?:[?#&]|$)/);
    if (!m) return null;
    let name = null;
    if (m[1]) {
      name = decodeURIComponent(m[1]).replace(MEDIA_SLUG, '.$1');
    }
    return { id: m[2], name };
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const proxied = /proxy\.php/i.test(u.pathname) && (u.searchParams.get('image') || u.searchParams.get('url'));
      if (proxied) return nameFromUrl(proxied);
      const att = parseAttachment(url);
      if (att) return att.name || `attachment-${att.id}`;
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(seg) || null;
    } catch { return null; }
  }

  function originalOf(url, img) {
    const dataUrl = img && img.getAttribute('data-url');
    if (dataUrl && /^https?:/i.test(dataUrl)) return dataUrl;
    try {
      const u = new URL(url);
      if (/proxy\.php/i.test(u.pathname)) return u.searchParams.get('image') || null;
    } catch {}
    return null;
  }

  const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ''; } };
  const isVideoUrl = (url) => VIDEO_EXT.test(pathOf(url)) || VIDEO_EXT.test(nameFromUrl(url) || '');

  function looksLikeImageLink(href) {
    if (/attachments\/(?:[^/?#&]*\.)?\d+/.test(href)) return true;
    return IMG_EXT.test(pathOf(href));
  }

  // Лучший (полноразмерный) URL для <img> из тела поста.
  function bestImageUrl(img, base) {
    const link = img.closest('a[href]');
    if (link) {
      const href = absUrl(link.getAttribute('href'), base);
      if (href && looksLikeImageLink(href)) return href;
    }
    const wrap = img.parentElement && img.parentElement.closest('[data-src]');
    if (wrap && wrap.matches('.bbImageWrapper, .lbContainer, .lbContainer-zoomer, .js-lbImage')) {
      const ds = absUrl(wrap.getAttribute('data-src'), base);
      if (ds) return ds;
    }
    return absUrl(img.getAttribute('data-src'), base) || absUrl(img.getAttribute('src'), base);
  }

  // URL видеофайла из <video>: сам src или первый <source>.
  function videoUrl(video, base) {
    const cands = [video.getAttribute('src'), video.getAttribute('data-src')];
    for (const s of video.querySelectorAll('source')) cands.push(s.getAttribute('src'), s.getAttribute('data-src'));
    for (const c of cands) {
      const u = absUrl(c, base);
      if (u) return u;
    }
    return null;
  }

  function postIdOf(post) {
    const s = `${post.id || ''} ${post.getAttribute('data-content') || ''}`;
    const m = s.match(/post-(\d+)/);
    return m ? m[1] : null;
  }

  function extractImages(doc, pageUrl, page) {
    const base = baseHref(doc, pageUrl);
    const host = new URL(pageUrl).host;
    const live = doc === document;
    const found = [];

    const add = (url, el, post, { name, img, type } = {}) => {
      if (!url) return;
      const att = parseAttachment(url);
      let sameHost = false;
      try { sameHost = new URL(url).host === host; } catch {}
      name = name || nameFromUrl(url);
      type = type || (VIDEO_EXT.test(name || '') || isVideoUrl(url) ? 'video' : 'image');
      const rec = {
        url,
        key: att && sameHost ? `att:${att.id}` : url,
        orig: img ? originalOf(url, img) : null,
        name,
        type,
        kind: att && sameHost ? 'attachment' : 'embed',
        page,
        post: postIdOf(post),
        quote: !!el.closest('.bbCodeBlock--quote, .bbCodeQuote, blockquote.quote'),
        sig: !!el.closest('.message-signature, .signature'),
        w: null,
        h: null,
      };
      // На открытой странице картинка уже загружена — размеры известны без запроса.
      if (live && img && type === 'image' && img.complete && img.naturalWidth && img.currentSrc === url) {
        rec.w = img.naturalWidth;
        rec.h = img.naturalHeight;
      }
      found.push(rec);
    };

    let posts = [...doc.querySelectorAll('article.message, li.message, div.message')]
      .filter((p) => !p.matches('.message--quickReply'));
    if (!posts.length) posts = [doc.body];

    for (const post of posts) {
      // Тело поста + подпись (подпись отфильтровывается флагом sig).
      const bodies = post.querySelectorAll(
        '.message-body .bbWrapper, .message-signature .bbWrapper, .messageText, .signature'
      );
      for (const body of bodies) {
        for (const el of body.querySelectorAll('img, video, a[href]')) {
          if (el.tagName === 'IMG') {
            if (!el.closest(SKIP_IMG)) add(bestImageUrl(el, base), el, post, { img: el });
          } else if (el.tagName === 'VIDEO') {
            add(videoUrl(el, base), el, post, { type: 'video' });
          } else if (!el.querySelector('img')) {
            // Обычная ссылка на видеофайл (в т.ч. на видео-вложение).
            const href = absUrl(el.getAttribute('href'), base);
            if (href && isVideoUrl(href)) add(href, el, post, { type: 'video' });
          }
        }
      }

      // Список вложений под постом (XF2: .message-attachments, XF1: .attachedFiles).
      for (const a of post.querySelectorAll('.message-attachments a.file-preview[href], .attachedFiles li.attachment a[href]')) {
        const li = a.closest('li');
        const fnEl = li && li.querySelector('.file-name');
        const fn = ((fnEl && (fnEl.getAttribute('title') || fnEl.textContent)) ||
          (li && li.getAttribute('title')) || '').trim() || null;
        const url = absUrl(a.getAttribute('href'), base);
        const isVideo = !!a.querySelector('video') || VIDEO_EXT.test(fn || '') || (url && isVideoUrl(url));
        if (isVideo) add(url, a, post, { name: fn, type: 'video' });
        else if (a.querySelector('img')) add(url, a, post, { name: fn, type: 'image' });
        // остальное (zip, pdf и т.п.) пропускаем
      }
    }
    return found;
  }

  // Узнаём размеры картинки, не скачивая её целиком: Chrome выставляет naturalWidth,
  // как только прочитан заголовок файла, после чего загрузку можно оборвать.
  function probeSize(url, timeout = 15000) {
    return new Promise((resolve) => {
      const img = new Image();
      let timer = null;
      let poll = null;
      const finish = (w, h) => {
        clearTimeout(timer);
        clearInterval(poll);
        img.onload = img.onerror = null;
        img.src = '';
        resolve(w ? { w, h } : null);
      };
      img.onload = () => finish(img.naturalWidth, img.naturalHeight);
      img.onerror = () => finish(0, 0);
      timer = setTimeout(() => finish(img.naturalWidth, img.naturalHeight), timeout);
      poll = setInterval(() => { if (img.naturalWidth) finish(img.naturalWidth, img.naturalHeight); }, 50);
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      img.src = url;
    });
  }

  async function fetchDoc(url) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancelled) throw new Error('cancelled');
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`HTTP ${r.status}`);
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        return { doc: new DOMParser().parseFromString(html, 'text/html'), url: r.url || url };
      } catch (e) {
        lastErr = e;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  function detect() {
    const url = location.href;
    const info = pageInfo(document, url);
    return {
      isXF: isXenForo(document),
      isThread: document.documentElement.getAttribute('data-template') === 'thread_view' || !!threadId(url),
      title: threadTitle(document),
      threadId: threadId(url),
      threadKey: `${location.host}/${threadId(url) || location.pathname.replace(/\/page-\d+.*$/, '')}`,
      host: location.host,
      url,
      currentPage: info.current,
      totalPages: info.last,
      scanning: running,
    };
  }

  async function scan(opts) {
    if (running) return;
    running = true;
    cancelled = false;
    const meta = detect();
    const { current, last, pageUrl } = pageInfo(document, location.href);

    let from = 1;
    let to = last;
    if (opts.range === 'current') from = to = current;
    else if (opts.range === 'custom') {
      from = Math.max(1, Math.min(last, parseInt(opts.from, 10) || 1));
      to = Math.max(from, Math.min(last, parseInt(opts.to, 10) || last));
    }
    const pages = [];
    for (let p = from; p <= to; p++) pages.push(p);

    const perPage = new Map();
    const errors = [];
    let done = 0;
    let foundCount = 0;
    const delay = Math.max(0, +opts.pageDelay || 0);
    const workers = Math.max(1, Math.min(4, +opts.pageConcurrency || 1));

    send({ type: 'xfdl:scan-progress', meta, phase: 'pages', done, total: pages.length, found: 0 });

    const queue = [...pages];
    const worker = async () => {
      while (queue.length && !cancelled) {
        const p = queue.shift();
        try {
          let imgs;
          if (p === current) {
            imgs = extractImages(document, location.href, p);
          } else {
            const { doc, url } = await fetchDoc(pageUrl(p));
            imgs = extractImages(doc, url, p);
            if (delay) await sleep(delay);
          }
          perPage.set(p, imgs);
          foundCount += imgs.length;
        } catch (e) {
          if (!cancelled) errors.push({ page: p, error: String(e && e.message || e) });
        }
        done++;
        send({ type: 'xfdl:scan-progress', meta, phase: 'pages', done, total: pages.length, found: foundCount });
      }
    };

    try {
      await Promise.all(Array.from({ length: workers }, worker));

      // Склейка в порядке страниц + дедупликация. Картинка считается "из цитаты/подписи",
      // только если она нигде больше не встречается.
      const byKey = new Map();
      const images = [];
      for (const p of pages) {
        for (const img of perPage.get(p) || []) {
          const prev = byKey.get(img.key);
          if (prev) {
            prev.quote = prev.quote && img.quote;
            prev.sig = prev.sig && img.sig;
            if (!prev.orig && img.orig) prev.orig = img.orig;
            if (!prev.w && img.w) { prev.w = img.w; prev.h = img.h; }
            if (img.name && (!prev.name || !hasMediaExt(prev.name)) && hasMediaExt(img.name)) prev.name = img.name;
            continue;
          }
          byKey.set(img.key, img);
          images.push(img);
        }
      }

      // Размеры картинок — для фильтра мелких (смайлы, иконки, кнопки).
      if (opts.probeSizes && !cancelled) {
        const todo = images.filter((i) => i.type === 'image' && !i.w);
        const q = [...todo];
        let pd = 0;
        const progress = () => send({ type: 'xfdl:scan-progress', meta, phase: 'sizes', done: pd, total: todo.length, found: images.length });
        progress();
        await Promise.all(Array.from({ length: 6 }, async () => {
          while (q.length && !cancelled) {
            const it = q.shift();
            const size = await probeSize(it.url);
            if (size) { it.w = size.w; it.h = size.h; }
            pd++;
            if (pd % 5 === 0 || pd === todo.length) progress();
          }
        }));
      }

      send({
        type: 'xfdl:scan-done',
        meta,
        cancelled,
        result: { images, pages: { from, to, total: last }, errors, sizesProbed: !!opts.probeSizes, scannedAt: Date.now() },
      });
    } catch (e) {
      send({ type: 'xfdl:scan-error', meta, error: String(e && e.message || e) });
    } finally {
      running = false;
    }
  }

  window.__xfdl = {
    version: VERSION,
    detect,
    scan,
    cancel() { cancelled = true; },
  };
})();
