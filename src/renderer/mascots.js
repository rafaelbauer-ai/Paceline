'use strict';

// Provider mascots rendered as stacked SVG slices in CSS 3D space. The shapes are redrawn
// from the reference artwork so each part (eyes, legs, prompt) can move on its own. Motion
// uses transforms/opacity on HTML layers, which the compositor handles without repainting.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const DEPTH = 6;
  const FLOAT_MS = 6400;
  const CARET_MS = 1100;
  // Mood loops, phase-locked like the float so rebuilt cards never restart them.
  const MOOD_LOOPS = { jump: 1100, tear: 1400, wave: 1100, sob: 1800, glance: 2600, type: 800, step: 600, blip: 450 };
  const MOODS = ['sad', 'happy', 'working'];
  const STROKE = { fill: 'none', 'stroke-width': 7.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const CLAUDE = {
    body: [[2, 0, 12, 8]],
    // Arms are separate pieces so they can go up when the mascot celebrates.
    armL: [[0, 4, 2, 2]],
    armR: [[14, 4, 2, 2]],
    legsA: [[3, 8, 1, 2], [10, 8, 1, 2]],
    legsB: [[5, 8, 1, 2], [12, 8, 1, 2]],
    eyes: [[4, 2, 1, 2], [11, 2, 1, 2]],
    glints: [[4.12, 2.18, 0.34, 0.5], [11.12, 2.18, 0.34, 0.5]],
    // The back view: a small pixel "Y" seam low in the middle of the body.
    seam: [[7.7, 6.2, 0.6, 1.8], [7.1, 5.6, 0.6, 0.6], [8.3, 5.6, 0.6, 0.6]],
    // Sad mood: tears dropping from beneath each eye.
    tears: [[4.05, 4.1, 0.9, 1.3], [11.05, 4.1, 0.9, 1.3]],
  };
  const CODEX = {
    // Six-lobed outline: the union of six circles around the centre, traced along the stroke centreline.
    ring: 'M59.67 13.92A21.6 21.6 0 0 1 86.08 40.33A21.6 21.6 0 0 1 76.41 76.41A21.6 21.6 0 0 1 40.33 86.08A21.6 21.6 0 0 1 13.92 59.67A21.6 21.6 0 0 1 23.59 23.59A21.6 21.6 0 0 1 59.67 13.92Z',
    chevron: 'M33.4 37.6 40.7 50 33.4 62.5',
    caret: 'M54.7 61.7H68.75',
    // The back view: the same small "Y" seam as Claude's, low in the middle, clear of the ring.
    back: 'M44.5 56.5 50 62.5 55.5 56.5M50 62.5V71',
    // Happy mood: two arms in the ring's stroke, raised from its sides like \o/.
    armL: 'M12 58 -2 35',
    armR: 'M90 56 104 33',
    // Sad mood: the caret becomes a frowning mouth, and tears drop from the chevron eye.
    frown: 'M53.5 65.5A10 10 0 0 1 70 65.5',
    // Happy mood: the caret becomes a smile, the frown mirrored.
    smile: 'M53.5 59.5A10 10 0 0 0 70 59.5',
    tears: [[31, 60, 8, 11], [37, 60, 8, 11]],
  };
  const KINDS = { claude: { viewBox: '0 0 16 10', ratio: 10 / 16 }, codex: { viewBox: '0 0 100 100', ratio: 1 } };
  const live = new Set();
  const blinkDue = new Map();
  let blinkTimer = null;
  let pointerBound = false;
  let pruneTimer = null;

  const svg = (tag, attrs = {}, ...children) => {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    element.append(...children);
    return element;
  };
  const span = (className) => Object.assign(document.createElement('span'), { className });
  const rects = (list, attrs = {}) => list.map(([x, y, width, height]) => svg('rect', { x, y, width, height, ...attrs }));
  const layer = (kind, className, z, ...children) => {
    const element = svg('svg', { viewBox: KINDS[kind].viewBox, class: `mascot-layer ${className}`.trim(), 'aria-hidden': 'true', focusable: 'false' }, ...children);
    element.style.setProperty('--z', z);
    return element;
  };
  // Slices from back to front; the front slice (z = 0) is the lit face. A rear face in the same
  // colours closes the shape and is only visible once the mascot turns around.
  const stack = (kind, className, depth, draw, { lift = 0, back = draw } = {}) => {
    const element = span(`mascot-stack ${className}`);
    if (lift) element.style.setProperty('--lift', lift);
    if (back) {
      // A full step behind the last slice: nearly coplanar planes are sorted unreliably on the GPU.
      const rear = layer(kind, 'mascot-back', depth, ...back());
      rear.setAttribute('data-z', 'back');
      element.append(rear);
    }
    for (let z = depth - 1; z >= 0; z -= 1) {
      const slice = layer(kind, z ? '' : 'mascot-face', z, ...draw());
      slice.setAttribute('data-z', z);
      element.append(slice);
    }
    return element;
  };

  function ensureDefs() {
    if (document.getElementById('tv-mascot-defs')) return;
    const stop = (offset, color, opacity) => svg('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
    // Gloss gradients span each whole view box, so separate shapes share one continuous light.
    const gloss = (id, height) => svg('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: height },
      stop(0, '#fff', 0.42), stop(0.42, '#fff', 0.04), stop(0.58, '#000', 0), stop(1, '#000', 0.16));
    const defs = svg('defs', {}, gloss('tv-gloss-claude', 10), gloss('tv-gloss-codex', 100));
    const sprite = svg('svg', { id: 'tv-mascot-defs', class: 'mascot-defs', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' }, defs);
    document.body.append(sprite);
  }

  // The sheen is a white copy of the face; a moving CSS gradient mask turns it into a light sweep.
  function claudeParts() {
    return [
      stack('claude', 'mascot-legs mascot-legs-a', DEPTH, () => rects(CLAUDE.legsA)),
      stack('claude', 'mascot-legs mascot-legs-b', DEPTH, () => rects(CLAUDE.legsB)),
      stack('claude', 'mascot-arm mascot-arm-l', DEPTH, () => rects(CLAUDE.armL)),
      stack('claude', 'mascot-arm mascot-arm-r', DEPTH, () => rects(CLAUDE.armR)),
      stack('claude', 'mascot-body', DEPTH, () => rects(CLAUDE.body), {
        back: () => [...rects(CLAUDE.body), ...rects(CLAUDE.body, { fill: 'url(#tv-gloss-claude)' }), ...rects(CLAUDE.seam, { class: 'mascot-seam' })],
      }),
      layer('claude', 'mascot-gloss', -0.05, ...rects(CLAUDE.body, { fill: 'url(#tv-gloss-claude)' })),
      layer('claude', 'mascot-eyes', -0.35, ...rects(CLAUDE.eyes), ...rects(CLAUDE.glints, { class: 'mascot-glint' })),
      layer('claude', 'mascot-sheen', -0.15, ...rects(CLAUDE.body, { fill: '#fff' })),
      ...moodParts('claude'),
    ];
  }

  // Tears sit just in front of the face and only show when the mascot is sad.
  function moodParts(kind) {
    const shape = kind === 'claude' ? CLAUDE : CODEX;
    const tears = shape.tears.map(([x, y, width, height], index) => {
      const tear = svg('rect', { x, y, width, height, rx: width / 2, class: 'mascot-tear' });
      tear.style.setProperty('--tear-offset', `${-Math.round(index * MOOD_LOOPS.tear / shape.tears.length)}ms`);
      return tear;
    });
    return [layer(kind, 'mascot-tears', -0.8, ...tears)];
  }

  function codexParts() {
    return [
      stack('codex', 'mascot-ring', DEPTH, () => [svg('path', { d: CODEX.ring, ...STROKE })], {
        back: () => [svg('path', { d: CODEX.ring, class: 'mascot-core-fill' }), svg('path', { d: CODEX.ring, ...STROKE }), svg('path', { d: CODEX.ring, ...STROKE, stroke: 'url(#tv-gloss-codex)' }), svg('path', { d: CODEX.back, ...STROKE, 'stroke-width': 6 })],
      }),
      // An opaque centre in the theme's background colour keeps text behind the logo from showing through.
      layer('codex', 'mascot-core', 0.5, svg('path', { d: CODEX.ring, class: 'mascot-core-fill' })),
      layer('codex', 'mascot-gloss', -0.05, svg('path', { d: CODEX.ring, ...STROKE, stroke: 'url(#tv-gloss-codex)' })),
      layer('codex', 'mascot-sheen', -0.15, svg('path', { d: CODEX.ring, ...STROKE, stroke: '#fff' })),
      // The prompt floats slightly in front of the ring for parallax and is hidden from behind.
      stack('codex', 'mascot-chevron', 3, () => [svg('path', { d: CODEX.chevron, ...STROKE })], { lift: 2.5, back: null }),
      stack('codex', 'mascot-caret', 3, () => [svg('path', { d: CODEX.caret, ...STROKE })], { lift: 2.5, back: null }),
      stack('codex', 'mascot-frown', 3, () => [svg('path', { d: CODEX.frown, ...STROKE })], { lift: 2.5, back: null }),
      stack('codex', 'mascot-smile', 3, () => [svg('path', { d: CODEX.smile, ...STROKE })], { lift: 2.5, back: null }),
      stack('codex', 'mascot-arm mascot-arm-l', DEPTH, () => [svg('path', { d: CODEX.armL, ...STROKE })]),
      stack('codex', 'mascot-arm mascot-arm-r', DEPTH, () => [svg('path', { d: CODEX.armR, ...STROKE })]),
      ...moodParts('codex'),
    ];
  }

  function create(kind, { size = 24, id = null } = {}) {
    if (!KINDS[kind]) return null;
    ensureDefs();
    const mascot = span('mascot');
    mascot.dataset.kind = kind;
    mascot.setAttribute('aria-hidden', 'true');
    mascot.style.setProperty('--size', `${size}px`);
    mascot.style.setProperty('--ratio', KINDS[kind].ratio);
    // Phase-locked to the clock, so a card rebuilt every few seconds keeps the same motion.
    const now = Date.now();
    mascot.style.setProperty('--float-delay', `${-(now % FLOAT_MS)}ms`);
    mascot.style.setProperty('--caret-delay', `${-(now % CARET_MS)}ms`);
    for (const [name, ms] of Object.entries(MOOD_LOOPS)) mascot.style.setProperty(`--${name}-delay`, `${-(now % ms)}ms`);
    const hop = span('mascot-hop');
    const float = span('mascot-float');
    const rig = span('mascot-rig');
    rig.append(...(kind === 'claude' ? claudeParts() : codexParts()));
    float.append(rig);
    hop.append(float);
    mascot.append(span('mascot-shadow'), hop);
    mascot.blinkId = id || `${kind}:${now}:${Math.random()}`;
    live.add(mascot);
    // Cards are rebuilt on every state update. Detached mascots are dropped shortly after a
    // render (not during it: siblings are still in their fragment), even when blinking is off.
    if (!pruneTimer) pruneTimer = setTimeout(() => { pruneTimer = null; for (const item of live) if (!item.isConnected) live.delete(item); }, 1000);
    bindPointer();
    startBlinking();
    return mascot;
  }

  // 'sad' cries, 'happy' celebrates with arms up and jumps, 'working' busies itself while the
  // agent runs; anything else is the neutral idle.
  function setMood(mascot, mood) {
    if (!mascot) return;
    if (MOODS.includes(mood)) mascot.dataset.mood = mood;
    else delete mascot.dataset.mood;
  }

  function blink(mascot, twice) {
    mascot.classList.add('is-blinking');
    setTimeout(() => mascot.classList.remove('is-blinking'), 130);
    if (!twice) return;
    setTimeout(() => {
      mascot.classList.add('is-blinking');
      setTimeout(() => mascot.classList.remove('is-blinking'), 120);
    }, 270);
  }

  function startBlinking() {
    if (blinkTimer || reduceMotion.matches) return;
    blinkTimer = setInterval(() => {
      const now = Date.now();
      for (const mascot of live) {
        if (!mascot.isConnected) { live.delete(mascot); continue; }
        if (document.hidden || mascot.offsetParent === null || mascot.closest('.mascot-slot') && !mascot.classList.contains('is-active')) continue;
        // Schedules are keyed by identity, so a rebuilt card mascot keeps its next blink.
        if (!blinkDue.has(mascot.blinkId)) blinkDue.set(mascot.blinkId, now + 900 + Math.random() * 2600);
        if (now < blinkDue.get(mascot.blinkId)) continue;
        blinkDue.set(mascot.blinkId, now + 2600 + Math.random() * 3600);
        blink(mascot, Math.random() < 0.22);
      }
      if (!live.size) { clearInterval(blinkTimer); blinkTimer = null; }
    }, 200);
  }

  // Every mascot turns gently toward the pointer.
  function bindPointer() {
    if (pointerBound) return;
    pointerBound = true;
    let frame = null;
    let px = 0;
    let py = 0;
    const apply = () => {
      frame = null;
      for (const mascot of live) {
        mascot.style.setProperty('--px', px.toFixed(3));
        mascot.style.setProperty('--py', py.toFixed(3));
      }
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(apply); };
    window.addEventListener('pointermove', (event) => {
      if (reduceMotion.matches) return;
      px = Math.max(-1, Math.min(1, (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1));
      py = Math.max(-1, Math.min(1, (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1));
      queue();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { px = 0; py = 0; queue(); });
  }

  // A brand slot keeps the Paceline mark and swaps in the mascot of the app in focus.
  function mountSlot(slot, { size = 28, id = 'slot' } = {}) {
    slot.classList.add('mascot-slot');
    const items = {
      claude: create('claude', { size, id: `${id}-claude` }),
      // The open ring reads lighter than Claude's solid body, so it is drawn nearly as wide.
      codex: create('codex', { size: Math.round(size * 0.94), id: `${id}-codex` }),
    };
    slot.append(items.claude, items.codex);
    return (kind, mood = null) => {
      const active = Object.hasOwn(items, kind) ? kind : 'paceline';
      for (const [name, mascot] of Object.entries(items)) setMood(mascot, name === active ? mood : null);
      if (slot.dataset.active === active) return;
      slot.dataset.active = active;
      for (const [name, mascot] of Object.entries(items)) mascot.classList.toggle('is-active', name === active);
    };
  }

  // The pointer becomes the mascot itself: centred on the hotspot and moved on every event,
  // never smoothed, so it is always exactly where a click lands.
  function mountCursor(scope, { kindFor, moodFor = () => null }) {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const cursor = document.createElement('div');
    cursor.className = 'mascot-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    const body = span('mascot-cursor-body');
    const lean = span('mascot-cursor-lean');
    const mascots = { claude: create('claude', { size: 32, id: 'cursor-claude' }), codex: create('codex', { size: 30, id: 'cursor-codex' }) };
    lean.append(mascots.claude, mascots.codex);
    body.append(lean);
    cursor.append(body);
    scope.append(cursor);
    let kind = null;
    let lastX = null;
    let lastTime = 0;
    let idle = null;

    const show = (next) => {
      if (next === kind) return;
      kind = next;
      scope.classList.toggle('mascot-cursor-on', Boolean(next));
      cursor.dataset.kind = next || '';
      for (const [name, mascot] of Object.entries(mascots)) mascot.classList.toggle('is-active', name === next);
      if (!next) lastX = null;
    };
    const settle = () => {
      cursor.classList.remove('is-moving');
      lean.style.setProperty('--lean', '0deg');
    };
    scope.addEventListener('pointermove', (event) => {
      const next = event.pointerType && event.pointerType !== 'mouse' ? null : kindFor(event.target);
      if (next) {
        // Position first, so a mascot that appears is already under the pointer.
        body.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
        if (lastX !== null && !reduceMotion.matches) {
          const velocity = (event.clientX - lastX) / Math.max(8, event.timeStamp - lastTime);
          lean.style.setProperty('--lean', `${Math.max(-10, Math.min(10, velocity * 6)).toFixed(1)}deg`);
          cursor.classList.add('is-moving');
          clearTimeout(idle);
          idle = setTimeout(settle, 140);
        }
        lastX = event.clientX;
        lastTime = event.timeStamp;
        cursor.classList.toggle('is-pointing', Boolean(event.target.closest('button, a, label, [role="switch"]')));
        // The cursor wears the same mood as that app's mascot; only touch the DOM when it changes.
        const mood = moodFor(next) || null;
        if ((mascots[next].dataset.mood || null) !== mood) setMood(mascots[next], mood);
      }
      show(next);
    }, { passive: true });
    // A click makes the mascot blink and spin once; rapid clicks restart the turn.
    const celebrate = () => {
      const mascot = kind && mascots[kind];
      if (!mascot || reduceMotion.matches) return;
      blink(mascot, false);
      mascot.classList.remove('is-spinning');
      void mascot.offsetWidth;
      mascot.classList.add('is-spinning');
    };
    for (const mascot of Object.values(mascots)) {
      mascot.addEventListener('animationend', (event) => { if (event.animationName === 'tv-mascot-spin') mascot.classList.remove('is-spinning'); });
    }
    scope.addEventListener('pointerleave', () => show(null));
    scope.addEventListener('pointerdown', () => { cursor.classList.add('is-pressed'); celebrate(); });
    window.addEventListener('pointerup', () => cursor.classList.remove('is-pressed'));
    window.addEventListener('blur', () => show(null));
  }

  window.PacelineMascots = { create, setMood, mountSlot, mountCursor };
})();
