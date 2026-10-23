'use strict';

// The collapsed handle fits its content: the mascot, then one reading per visible provider.
// Sizes include the 8px shadow margin and 1px border on each side, and fit the widest
// reading ("CX 100%") so the handle never resizes as numbers change.
const COLLAPSED = { width: 99, perProvider: 47, height: 48 };
const COLLAPSED_VERTICAL = { width: 62, height: 98, perProvider: 43 };
const EXPANDED = { width: 416, height: 560 };

function collapsedSize(vertical, providers) {
  const count = Math.max(1, Math.min(2, providers));
  return vertical
    ? { width: COLLAPSED_VERTICAL.width, height: COLLAPSED_VERTICAL.height + COLLAPSED_VERTICAL.perProvider * count }
    : { width: COLLAPSED.width + COLLAPSED.perProvider * count, height: COLLAPSED.height };
}

function overlayBounds(area, edge = 'top', expanded = false, options = {}) {
  const vertical = edge === 'left' || edge === 'right';
  const providers = Array.isArray(options.visibleProviders) ? options.visibleProviders.length : 2;
  const size = expanded ? EXPANDED : collapsedSize(vertical, providers);
  const scale = Number.isFinite(options.scale) ? Math.max(0.8, Math.min(1.3, options.scale)) : 1;
  const width = Math.min(Math.round(size.width * scale), area.width);
  const height = Math.min(Math.round(size.height * scale), area.height);
  let x = area.x + Math.round((area.width - width) / 2);
  let y = area.y;
  if (edge === 'bottom') y = area.y + area.height - height;
  if (edge === 'left' || edge === 'right') {
    x = edge === 'left' ? area.x : area.x + area.width - width;
    y = area.y + Math.round((area.height - height) / 2);
  }
  if (options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y)) {
    x = Math.round(Math.min(area.x + area.width - width, Math.max(area.x, options.position.x)));
    y = Math.round(Math.min(area.y + area.height - height, Math.max(area.y, options.position.y)));
  }
  return { x, y, width, height };
}

module.exports = { overlayBounds, collapsedSize, COLLAPSED, COLLAPSED_VERTICAL, EXPANDED };
