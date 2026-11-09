// Screen transitions. The old screen's nodes move into a ghost layer that keeps
// their place on screen; the new screen renders into #view as usual. When the new
// content arrives, both move together: forward slides in from the right, back
// uncovers the screen underneath, forms rise from below, tabs follow the swipe.

const DURATION = 280;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const WAIT_FOR_CONTENT_MS = 300;
const PARALLAX = 0.3;

const SNAPSHOTS_MAX = 8;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let running = null;
// Screens that were left, kept as they looked, to show under the finger during a
// swipe back or to a neighbouring tab. The real screen renders fresh on arrival.
const snapshots = new Map();
let committedUnderlay = null;

function stash(key, inner) {
  snapshots.delete(key);
  snapshots.set(key, inner);
  while (snapshots.size > SNAPSHOTS_MAX) snapshots.delete(snapshots.keys().next().value);
}

function dropUnderlay() {
  committedUnderlay?.remove();
  committedUnderlay = null;
}

// Under test automation the old screen would duplicate the new one's selectors
// for a moment; the gesture test turns animations back on explicitly.
function animationsOff() {
  return reducedMotion.matches || (navigator.webdriver && !localStorage.getItem('force-motion'));
}

function finishRunning() {
  running?.();
  running = null;
}

function underBrightness(offset, width) {
  return 0.94 + 0.06 * Math.min(Math.max(offset / width, 0), 1);
}

function keyframes(direction, width, offset) {
  const x = (value) => `translateX(${value}px)`;
  switch (direction) {
    case 'forward':
      return {
        view: [{ transform: x(width + offset) }, { transform: x(0) }],
        ghost: [{ transform: x(offset * PARALLAX), filter: 'brightness(1)' }, { transform: x(-width * PARALLAX), filter: 'brightness(.94)' }],
        ghostOnTop: false,
      };
    case 'back':
      return {
        view: [{ transform: x(-width * PARALLAX + offset * PARALLAX), filter: `brightness(${underBrightness(offset, width)})` }, { transform: x(0), filter: 'brightness(1)' }],
        ghost: [{ transform: x(offset) }, { transform: x(width) }],
        ghostOnTop: true,
      };
    // Fade-through: the old screen is gone before the new one shows, no text over text.
    case 'modal-in':
      return {
        view: [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 0, transform: 'translateY(28px)', offset: 0.3 }, { opacity: 1, transform: 'none' }],
        ghost: [{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }],
        ghostOnTop: true,
      };
    case 'modal-out':
      return {
        view: [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }],
        ghost: [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(28px)', offset: 0.35 }, { opacity: 0 }],
        ghostOnTop: true,
      };
    case 'tab-next':
      return {
        view: [{ transform: x(width + offset) }, { transform: x(0) }],
        ghost: [{ transform: x(offset) }, { transform: x(-width) }],
        ghostOnTop: false,
      };
    case 'tab-prev':
      return {
        view: [{ transform: x(-width + offset) }, { transform: x(0) }],
        ghost: [{ transform: x(offset) }, { transform: x(width) }],
        ghostOnTop: false,
      };
    default: // fade
      return {
        view: [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }],
        ghost: [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }],
        ghostOnTop: true,
        duration: 200,
      };
  }
}

// Call right before the new screen renders into view. offset: how far a swipe has
// already moved the old screen, so the animation continues from the finger.
// stashAs keeps the old screen's look for a later swipe back to it.
export function startTransition(view, direction, { offset = 0, stashAs = null } = {}) {
  finishRunning();
  view.style.transform = '';
  if (direction === 'none' || animationsOff() || view.childNodes.length === 0) {
    dropUnderlay();
    return;
  }

  const rect = view.getBoundingClientRect();
  const style = getComputedStyle(view);
  const ghost = document.createElement('div');
  ghost.className = 'screen-ghost';
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const inner = document.createElement('div');
  inner.className = 'screen-ghost-inner';
  Object.assign(inner.style, { padding: style.padding, gap: style.gap, transform: `translateY(${-view.scrollTop}px)` });
  inner.append(...view.childNodes);
  ghost.append(inner);
  const frames = keyframes(direction, rect.width, offset);
  ghost.classList.toggle('on-top', frames.ghostOnTop);
  ghost.style.transform = frames.ghost[0].transform ?? '';
  document.body.append(ghost);

  // Until the new content is there, the old screen stays where the finger left it.
  view.classList.add('screen-entering');
  Object.assign(view.style, { transform: frames.view[0].transform ?? '', opacity: frames.view[0].opacity ?? '' });

  let animations = [];
  let observer = null;
  let timer = null;
  const cleanup = () => {
    observer?.disconnect();
    clearTimeout(timer);
    for (const animation of animations) animation.cancel();
    ghost.remove();
    dropUnderlay();
    if (stashAs) stash(stashAs, inner);
    view.classList.remove('screen-entering');
    Object.assign(view.style, { transform: '', opacity: '', filter: '' });
  };
  running = cleanup;

  const play = () => {
    observer.disconnect();
    clearTimeout(timer);
    if (running !== cleanup) return;
    const remaining = direction.startsWith('tab') || direction === 'back' ? 1 - Math.min(Math.abs(offset) / rect.width, 0.8) : 1;
    const duration = frames.duration ?? DURATION;
    const options = { duration: Math.max(140, duration * remaining), easing: frames.view.length > 2 ? 'ease-out' : EASE, fill: 'forwards' };
    Object.assign(view.style, { transform: '', opacity: '' });
    // The new screen now covers what the finger was showing.
    dropUnderlay();
    animations = [view.animate(frames.view, options), ghost.animate(frames.ghost, options)];
    animations[0].finished.then(() => {
      if (running === cleanup) finishRunning();
    }, () => {});
  };
  observer = new MutationObserver(play);
  observer.observe(view, { childList: true });
  timer = setTimeout(play, WAIT_FOR_CONTENT_MS);
}

// After the data is erased no swipe may show how the screens looked before.
export function forgetScreens() {
  finishRunning();
  snapshots.clear();
  dropUnderlay();
}

// The screen a swipe leads to, under the finger. side: 'back' (the screen below,
// with parallax), 'prev' or 'next' (a neighbouring tab, edge to edge).
export function peek(view, key, side) {
  const inner = snapshots.get(key);
  if (!inner || animationsOff()) return null;
  const rect = view.getBoundingClientRect();
  const width = rect.width;
  const layer = document.createElement('div');
  layer.className = 'screen-ghost underlay';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${width}px`, height: `${rect.height}px` });
  layer.append(inner);
  const at = (offset) => {
    if (side === 'back') return `translateX(${-width * PARALLAX + offset * PARALLAX}px)`;
    return `translateX(${(side === 'prev' ? -width : width) + offset}px)`;
  };
  const move = (offset) => {
    layer.style.transform = at(offset);
    if (side === 'back') layer.style.filter = `brightness(${underBrightness(offset, width)})`;
  };
  move(0);
  document.body.append(layer);
  return {
    move,
    // Stays until the real screen has content, then the transition takes over.
    commit() {
      snapshots.delete(key);
      dropUnderlay();
      layer.classList.add('committed');
      committedUnderlay = layer;
      setTimeout(() => {
        if (committedUnderlay === layer) dropUnderlay();
      }, 1200);
    },
    cancel(instant = false) {
      const from = layer.style.transform;
      if (instant) {
        layer.remove();
        return;
      }
      layer.animate([{ transform: from }, { transform: at(0) }], { duration: 200, easing: EASE, fill: 'forwards' })
        .finished.then(() => layer.remove(), () => layer.remove());
    },
  };
}

// Brings a scrolled-back screen to where it was. Screens render after their data
// loads, so the position is applied as content arrives, until it fits.
export function restoreScroll(view, top) {
  if (!top) return;
  const deadline = Date.now() + 1500;
  const apply = () => {
    view.scrollTop = top;
    if (view.scrollTop >= top - 1 || Date.now() > deadline) stop();
  };
  const observer = new MutationObserver(apply);
  const stop = () => {
    observer.disconnect();
    view.removeEventListener('touchstart', stop);
  };
  observer.observe(view, { childList: true, subtree: true });
  view.addEventListener('touchstart', stop, { passive: true });
  setTimeout(stop, deadline - Date.now());
  apply();
}
