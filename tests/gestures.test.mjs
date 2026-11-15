// Pruebas unitarias de la lógica de gestos.
// Ejecución: `node --test tests/`  (Node.js ≥ 18, sin dependencias externas).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GESTURE,
  OneEuroFilter,
  classifyGesture,
  fingerStates,
  fingertip,
  palmCenter,
} from "../js/gestures.js";

/**
 * Construye una mano sintética (21 landmarks) apuntando hacia arriba.
 * Un dedo extendido tiene la punta lejos de la muñeca; uno flexionado la tiene
 * replegada hacia la palma.
 */
function makeHand({ index = false, middle = false, ring = false, pinky = false } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8 }));
  lm[0] = { x: 0.5, y: 0.9 }; // muñeca

  const fingers = {
    index: { ids: [5, 6, 7, 8], x: 0.42, extended: index },
    middle: { ids: [9, 10, 11, 12], x: 0.5, extended: middle },
    ring: { ids: [13, 14, 15, 16], x: 0.58, extended: ring },
    pinky: { ids: [17, 18, 19, 20], x: 0.65, extended: pinky },
  };

  for (const { ids: [mcp, pip, dip, tip], x, extended } of Object.values(fingers)) {
    lm[mcp] = { x, y: 0.7 };
    if (extended) {
      lm[pip] = { x, y: 0.6 };
      lm[dip] = { x, y: 0.52 };
      lm[tip] = { x, y: 0.44 };
    } else {
      lm[pip] = { x, y: 0.62 };
      lm[dip] = { x, y: 0.7 };
      lm[tip] = { x, y: 0.74 };
    }
  }
  // Pulgar (no se usa en la clasificación)
  lm[1] = { x: 0.45, y: 0.85 };
  lm[2] = { x: 0.38, y: 0.8 };
  lm[3] = { x: 0.34, y: 0.75 };
  lm[4] = { x: 0.31, y: 0.7 };
  return lm;
}

test("índice extendido → DRAW", () => {
  assert.equal(classifyGesture(makeHand({ index: true })), GESTURE.DRAW);
});

test("índice + medio extendidos → MOVE", () => {
  assert.equal(classifyGesture(makeHand({ index: true, middle: true })), GESTURE.MOVE);
});

test("cuatro dedos extendidos (palma abierta) → ERASE", () => {
  const hand = makeHand({ index: true, middle: true, ring: true, pinky: true });
  assert.equal(classifyGesture(hand), GESTURE.ERASE);
});

test("ningún dedo extendido (puño) → PAUSE", () => {
  assert.equal(classifyGesture(makeHand()), GESTURE.PAUSE);
});

test("combinaciones ambiguas → NONE", () => {
  assert.equal(classifyGesture(makeHand({ middle: true })), GESTURE.NONE);
  assert.equal(classifyGesture(makeHand({ index: true, middle: true, ring: true })), GESTURE.NONE);
  assert.equal(classifyGesture(makeHand({ pinky: true })), GESTURE.NONE);
});

test("entrada inválida → NONE", () => {
  assert.equal(classifyGesture(null), GESTURE.NONE);
  assert.equal(classifyGesture([]), GESTURE.NONE);
});

test("el gesto no depende de la orientación de la mano (rotación de 90°)", () => {
  const rotate = (p) => ({ x: 1 - p.y, y: p.x }); // giro de 90° respecto al origen
  const hand = makeHand({ index: true }).map(rotate);
  assert.equal(classifyGesture(hand), GESTURE.DRAW);
  assert.deepEqual(fingerStates(hand), { index: true, middle: false, ring: false, pinky: false });
});

test("fingertip y palmCenter devuelven puntos coherentes", () => {
  const hand = makeHand({ index: true });
  assert.deepEqual(fingertip(hand), { x: 0.42, y: 0.44 });
  const c = palmCenter(hand);
  assert.ok(c.x > 0.4 && c.x < 0.65, `x fuera de rango: ${c.x}`);
  assert.ok(c.y > 0.7 && c.y < 0.9, `y fuera de rango: ${c.y}`);
});

test("filtro 1€: reduce el temblor de una señal casi constante", () => {
  const filter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.02 });
  const raw = [];
  const filtered = [];
  for (let i = 0; i < 90; i++) {
    const noisy = 100 + (i % 2 === 0 ? 2 : -2); // ruido ±2 px
    raw.push(noisy);
    filtered.push(filter.filter(noisy, i / 30)); // 30 FPS
  }
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const tail = (a) => a.slice(30); // se descarta el transitorio inicial
  assert.ok(
    spread(tail(filtered)) < spread(tail(raw)) / 2,
    "el filtro debería reducir la dispersión al menos a la mitad",
  );
});

test("filtro 1€: sigue de cerca un movimiento rápido (poco retraso)", () => {
  const filter = new OneEuroFilter({ minCutoff: 1.0, beta: 0.02 });
  let out = 0;
  for (let i = 0; i < 10; i++) out = filter.filter(0, i / 30);
  for (let i = 10; i < 14; i++) out = filter.filter(500, i / 30); // salto brusco
  assert.ok(out > 450, `la salida (${out.toFixed(1)}) debería acercarse a 500`);
});

test("filtro 1€: reset() permite reiniciar sin arrastrar el valor anterior", () => {
  const filter = new OneEuroFilter();
  filter.filter(10, 0);
  filter.filter(12, 0.033);
  filter.reset();
  assert.equal(filter.filter(300, 1), 300);
});
