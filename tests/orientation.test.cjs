'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { overlayBounds } = require('../src/main/geometry.cjs');

const edges = ['top', 'right', 'bottom', 'left'];
const area = { x: -1920, y: -1080, width: 1920, height: 1040 };

function assertReachable(bounds, workArea) {
  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
}

test('collapsed handles stand vertically on side edges and horizontally on top and bottom', () => {
  const expected = {
    top: { x: -1056, y: -1080, width: 193, height: 48 },
    right: { x: -62, y: -652, width: 62, height: 184 },
    bottom: { x: -1056, y: -88, width: 193, height: 48 },
    left: { x: -1920, y: -652, width: 62, height: 184 },
  };
  for (const edge of edges) assert.deepEqual(overlayBounds(area, edge), expected[edge]);
});

test('expanded panels keep their shape on all four edges', () => {
  for (const edge of edges) {
    const bounds = overlayBounds(area, edge, true);
    assert.equal(bounds.width, 416);
    assert.equal(bounds.height, 560);
    assertReachable(bounds, area);
  }
});

test('both handle orientations respect supported scaling and negative display coordinates', () => {
  for (const scale of [0.8, 1, 1.3]) {
    for (const edge of edges) {
      const vertical = edge === 'left' || edge === 'right';
      const bounds = overlayBounds(area, edge, false, { scale });
      assert.equal(bounds.width, Math.round((vertical ? 62 : 193) * scale));
      assert.equal(bounds.height, Math.round((vertical ? 184 : 48) * scale));
      assertReachable(bounds, area);
    }
  }
});

test('the handle shrinks when only one provider is shown', () => {
  assert.deepEqual([overlayBounds(area, 'top', false, { visibleProviders: ['codex'] }).width, overlayBounds(area, 'top').width], [146, 193]);
  assert.deepEqual([overlayBounds(area, 'left', false, { visibleProviders: ['claude'] }).height, overlayBounds(area, 'left').height], [141, 184]);
  assert.equal(overlayBounds(area, 'top', true, { visibleProviders: ['codex'] }).width, 416);
});

test('manual positions survive edge changes and are clamped with the current handle shape', () => {
  for (const edge of edges) {
    const position = { x: -1500, y: -800 };
    const bounds = overlayBounds(area, edge, false, { position });
    assert.equal(bounds.x, position.x);
    assert.equal(bounds.y, position.y);
    const outside = overlayBounds(area, edge, false, { scale: 1.3, position: { x: 9000, y: -9000 } });
    assert.equal(outside.x, area.x + area.width - outside.width);
    assert.equal(outside.y, area.y);
    assertReachable(outside, area);
  }
});

test('small work areas constrain both orientations without placing any edge off screen', () => {
  const smallArea = { x: -60, y: 20, width: 60, height: 100 };
  for (const edge of edges) {
    for (const expanded of [false, true]) {
      const bounds = overlayBounds(smallArea, edge, expanded, { scale: 1.3 });
      assertReachable(bounds, smallArea);
    }
  }
});
