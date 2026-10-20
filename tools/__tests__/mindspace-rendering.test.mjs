import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../packages/daemon/webui/js/renderer.js';
import { createRenderLoop } from '../../packages/daemon/webui/js/boot/render-loop.js';

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
}

function drawing(t, nodes = [], edges = []) {
  const calls = [];
  const ctx = new Proxy({}, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => {
      calls.push([name, ...args]);
      if (name === 'measureText') return { width: 10 };
      if (String(name).includes('Gradient')) return { addColorStop() {} };
    };
  } });
  globals(t, {
    document: { documentElement: {}, createElement: () => ({ getContext: () => ctx }) },
    window: { devicePixelRatio: 1 },
    getComputedStyle: () => ({ getPropertyValue: name => ({
      '--map-glow-alpha': '0.2', '--map-dim': '0.1',
    })[name] ?? '#ffffff' }),
  });
  const canvas = { clientWidth: 100, clientHeight: 100, getContext: () => ctx };
  const sim = { nodes, edges, centers: new Map(), byId: new Map(nodes.map(n => [n.id, n])) };
  const renderer = createRenderer(canvas, sim, new Map());
  const painted = () => calls.filter(c => c[0] === 'arc').map(c => c[1]);
  return { renderer, sim, calls, painted };
}
const node = (id, x, depth = 0) => ({ id, x, y: 50, idx: 0, degree: 1, kind: 'skill', cluster: 'a', orbitDepth: depth });

test('depth sorting observes mutations, stable ties and same-size graph replacements', t => {
  const a = node('a', 20, 0), b = node('b', 40, 1);
  const { renderer, sim, calls, painted } = drawing(t, [a, b]);
  renderer.setDrawOrder((a, b) => b.orbitDepth - a.orbitDepth);
  renderer.draw(0);
  assert.deepEqual(painted(), [40, 40, 20, 20]);
  calls.length = 0;
  a.orbitDepth = 1;
  renderer.draw(1);
  assert.deepEqual(painted(), [20, 20, 40, 40], 'ties retain source order, not previous depth order');
  calls.length = 0;
  sim.nodes[0] = node('c', 60, 2);
  renderer.draw(2);
  assert.deepEqual(painted(), [60, 60, 40, 40], 'in-place node replacement is observed');
  calls.length = 0;
  sim.nodes = [node('d', 80), node('e', 90)];
  renderer.draw(3);
  assert.deepEqual(painted(), [80, 80, 90, 90], 'new same-length graph is observed');
  calls.length = 0;
  renderer.setDrawOrder(null);
  renderer.draw(4);
  renderer.setDrawOrder(() => 0);
  sim.nodes.reverse();
  calls.length = 0;
  renderer.draw(5);
  assert.deepEqual(painted(), [90, 90, 80, 80]);
});

test('culling retains the visible tail of a filtered salience halo', t => {
  const n = { ...node('hot', -61), kind: 'memory', degree: 100, salience: 1 };
  const { renderer, calls } = drawing(t, [n]);
  renderer.setFilter(() => true);
  renderer.draw(Math.PI * 350 / 2);
  assert.ok(calls.some(c => c[0] === 'drawImage' && c[2] < 0 && c[2] + c[4] > 0),
    'the breathing sprite overlaps the viewport even though its node is outside');
});

test('culling preserves crossing edges, hub-bent curves and offscreen overlays', t => {
  const a = { ...node('a', -5000), y: -250 };
  const b = { ...node('b', 5000), y: -250 };
  const { renderer, calls, sim } = drawing(t, [a, b], [{ s: a, t: b }]);
  renderer.setBendCenter({ x: 0, y: 1000 });
  let overlays = 0;
  renderer.setOverlay(() => overlays++);
  renderer.draw(0);
  assert.ok(calls.some(c => c[0] === 'quadraticCurveTo'), 'curve bows into the viewport');
  assert.equal(overlays, 1, 'overlay runs even when source nodes are culled');
  calls.length = 0;
  renderer.setBendCenter(null);
  a.x = -300; a.y = 50; b.x = 300; b.y = 50;
  renderer.draw(1);
  assert.ok(calls.some(c => c[0] === 'lineTo'), 'straight edge crosses viewport from offscreen endpoints');
  calls.length = 0;
  a.x = -1000; b.x = -900;
  renderer.draw(2);
  assert.equal(calls.filter(c => c[0] === 'lineTo').length, 0, 'fully offscreen edge is skipped');
  assert.equal(sim.nodes.length, 2);
});

function loopFixture(t, hidden = false) {
  const events = new EventTarget(), canvas = new EventTarget(), doc = new EventTarget();
  doc.hidden = hidden;
  let clock = 0, next = 1, draws = 0, fits = 0, live = false, flying = false, bursts = [], transition = null, view = 'clouds', ringAnimating = false;
  const pending = new Map();
  globals(t, {
    document: doc, performance: { now: () => clock },
    addEventListener: events.addEventListener.bind(events),
    requestAnimationFrame: fn => { const id = next++; pending.set(id, fn); return id; },
    cancelAnimationFrame: id => pending.delete(id),
  });
  const loop = createRenderLoop({ canvas,
    sim: { nodes: [], tick: () => false, separateClouds: () => false },
    renderer: { draw: () => draws++, resize() {}, hasLiveEffects: () => live },
    minimap: { draw() {} }, ringView: { tick() {}, isAnimating: () => ringAnimating },
    orbitView: { tick() {}, listBursts: () => bursts }, semanticView: { tick() {} },
    getInteractions: () => ({ fitAll: () => fits++, step() {}, draggedCluster: () => null, isFlying: () => flying }),
    getView: () => view, getTransition: () => transition, setTransition: value => transition = value, saveAnchorsSoon() {},
  });
  return { loop, pending, events, doc, get draws() { return draws; }, get fits() { return fits; },
    setLive: value => live = value, setFlying: value => flying = value,
    setBursts: value => bursts = value, setView: value => view = value,
    setRing: value => ringAnimating = value,
    setTransition: value => transition = value,
    frame(now) { clock = now; const work = [...pending.values()]; pending.clear(); for (const fn of work) fn(now); },
    visibility(value) { doc.hidden = value; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

test('visibility cannot start an unstarted loop; start and resume keep one RAF', t => {
  const f = loopFixture(t);
  f.visibility(true); f.visibility(false);
  assert.equal(f.pending.size, 0);
  f.loop.start(); f.loop.start();
  assert.equal(f.pending.size, 1);
  assert.equal(f.fits, 1);
  f.frame(0);
  f.visibility(true);
  assert.equal(f.pending.size, 0);
  const draws = f.draws;
  f.frame(5000);
  assert.equal(f.draws, draws);
  f.visibility(false); f.visibility(false);
  assert.equal(f.pending.size, 1);
  f.frame(5010);
  assert.equal(f.draws, draws + 1);
  assert.equal(f.pending.size, 1);
});

test('initially hidden loop waits for visibility, including a queued hidden frame', t => {
  const f = loopFixture(t, true);
  f.loop.start();
  assert.equal(f.pending.size, 0);
  f.visibility(false);
  f.doc.hidden = true; // defensive guard if a queued callback runs before the event
  f.frame(0);
  assert.equal(f.draws, 0);
  assert.equal(f.pending.size, 0);
  f.visibility(false);
  f.frame(10);
  assert.equal(f.draws, 1);
});

test('idle throttle wakes immediately for UI input, live effects, flights, bursts and transitions', t => {
  const f = loopFixture(t);
  f.loop.start(); f.frame(0); f.frame(100);
  assert.equal(f.draws, 2);
  f.frame(110);
  assert.equal(f.draws, 2, 'settled clouds throttle');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'resize']) {
    f.frame(2000); const before = f.draws;
    f.events.dispatchEvent(new Event(type)); f.frame(2001);
    assert.equal(f.draws, before + 1, `${type} on the whole UI wakes the next frame`);
  }
  f.frame(4000);
  for (const [on, off] of [
    [() => f.setLive(true), () => f.setLive(false)],
    [() => f.setFlying(true), () => f.setFlying(false)],
    [() => f.setBursts([{}]), () => f.setBursts([])],
    [() => f.setRing(true), () => f.setRing(false)],
    [() => f.loop.markBusy(), () => {}],
    [() => f.setView('orbit'), () => f.setView('clouds')],
    [() => f.setTransition({ t0: 4000, ms: 1000, from: new Map(), to: new Map() }), () => f.setTransition(null)],
  ]) {
    const before = f.draws; on(); f.frame(4001); off();
    assert.equal(f.draws, before + 1);
  }
});

test('hover, focus, filters and highlight remain full-rate live renderer states', t => {
  const n = node('a', 20);
  const { renderer } = drawing(t, [n]);
  assert.equal(renderer.hasLiveEffects(), false);
  for (const [set, active] of [[renderer.setHover, n], [renderer.setFocus, n],
    [renderer.setFilter, () => true], [renderer.setHighlight, () => true]]) {
    set(active); assert.equal(renderer.hasLiveEffects(), true);
    set(null); assert.equal(renderer.hasLiveEffects(), false);
  }
  renderer.flashNode('a', '#fff');
  assert.equal(renderer.hasLiveEffects(), true);
});
