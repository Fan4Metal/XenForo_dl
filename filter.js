// Общий фильтр результатов сканирования: подключается и в popup, и в background.

// Картинка мельче minSize px хотя бы по одной стороне (смайлы, иконки, кнопки).
// Если размер не удалось определить — не считаем мелкой.
function xfdlIsSmall(img, minSize) {
  return img.type !== 'video' && minSize > 0 && img.w != null && (img.w < minSize || img.h < minSize);
}

function xfdlPasses(img, o) {
  if (img.type === 'video') {
    if (!o.incVideo) return false;
  } else if (!(img.kind === 'attachment' ? o.incAttach : o.incEmbed)) {
    return false;
  }
  if (!o.incQuotes && img.quote) return false;
  if (!o.incSigs && img.sig) return false;
  if (o.skipSmall && xfdlIsSmall(img, +o.minSize || 0)) return false;
  return true;
}
