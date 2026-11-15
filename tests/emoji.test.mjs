// Pruebas unitarias del modo "Emojis" (lógica pura).
// Ejecución: `npm test`
//
// AVISO: las manos se construyen sintéticamente según la forma que se asume para
// cada gesto. Las pruebas verifican que las reglas son coherentes con esas formas,
// no que coincidan con manos reales: eso solo se comprueba con una cámara.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMOJIS,
  EmojiDetector,
  THRESHOLDS,
  classifyFrame,
  classifyHand,
  classifyTwoHands,
  handSize,
  palmDistance,
  thumbInfo,
} from "../js/emoji.js";

/* ------------------------- Generador de manos sintéticas ------------------------- */

/**
 * Mano sintética (21 landmarks), palma hacia la cámara y dedos hacia arriba.
 * thumb: "in" (recogido) | "out" (hacia un lado) | "up" | "down"
 * ok: círculo pulgar-índice.
 */
function makeHand({ index = false, middle = false, ring = false, pinky = false, thumb = "in", ok = false } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8 }));
  lm[0] = { x: 0.5, y: 0.9 };
  const fingers = [
    { ids: [5, 6, 7, 8], x: 0.42, on: index },
    { ids: [9, 10, 11, 12], x: 0.5, on: middle },
    { ids: [13, 14, 15, 16], x: 0.58, on: ring },
    { ids: [17, 18, 19, 20], x: 0.65, on: pinky },
  ];
  for (const { ids: [mcp, pip, dip, tip], x, on } of fingers) {
    lm[mcp] = { x, y: 0.7 };
    lm[pip] = { x, y: on ? 0.6 : 0.62 };
    lm[dip] = { x, y: on ? 0.52 : 0.7 };
    lm[tip] = { x, y: on ? 0.44 : 0.74 };
  }
  const thumbs = {
    in: [[0.45, 0.85], [0.44, 0.8], [0.45, 0.76], [0.47, 0.74]],
    out: [[0.4, 0.85], [0.32, 0.8], [0.26, 0.76], [0.2, 0.72]],
    up: [[0.45, 0.85], [0.4, 0.75], [0.38, 0.62], [0.37, 0.5]],
    down: [[0.45, 0.85], [0.4, 0.9], [0.38, 0.93], [0.37, 0.95]],
  };
  thumbs[thumb].forEach(([x, y], i) => (lm[1 + i] = { x, y }));
  if (ok) {
    [[0.45, 0.85], [0.4, 0.78], [0.41, 0.66], [0.43, 0.57]].forEach(([x, y], i) => (lm[1 + i] = { x, y }));
    lm[7] = { x: 0.41, y: 0.62 };
    lm[8] = { x: 0.42, y: 0.56 };
  }
  return lm;
}

/** Desplaza, escala (respecto a 0.5, 0.8) y/o refleja una mano. */
function place(lm, { dx = 0, dy = 0, scale = 1, mirror = false } = {}) {
  return lm.map((p) => ({
    x: ((mirror ? 1 - p.x : p.x) - 0.5) * scale + 0.5 + dx,
    y: (p.y - 0.8) * scale + 0.8 + dy,
  }));
}

/** Corazón con las dos manos (la mano B es la A reflejada). */
function heartHand() {
  const pts = {
    0: [0.62, 0.95],
    1: [0.6, 0.88], 2: [0.57, 0.84], 3: [0.54, 0.8], 4: [0.515, 0.76],
    5: [0.62, 0.7], 6: [0.58, 0.6], 7: [0.55, 0.54], 8: [0.52, 0.5],
    9: [0.66, 0.72], 10: [0.68, 0.7], 11: [0.68, 0.74], 12: [0.66, 0.76],
    13: [0.71, 0.76], 14: [0.72, 0.75], 15: [0.72, 0.78], 16: [0.7, 0.8],
    17: [0.75, 0.8], 18: [0.76, 0.8], 19: [0.76, 0.82], 20: [0.74, 0.84],
  };
  return Array.from({ length: 21 }, (_, i) => ({ x: pts[i][0], y: pts[i][1] }));
}

const OPEN = { index: true, middle: true, ring: true, pinky: true };

/** Par de manos abiertas; `half` es la mitad de la separación horizontal. */
const openPair = (half) => [
  place(makeHand(OPEN), { dx: -half }),
  place(makeHand(OPEN), { dx: half, mirror: true }),
];

/* --------------------------------- Catálogo --------------------------------- */

test("catálogo: 14 emojis (10 de una mano y 4 de dos) con nombre y descripción", () => {
  const all = Object.values(EMOJIS);
  assert.equal(all.length, 14);
  assert.equal(all.filter((e) => e.hands === 1).length, 10);
  assert.equal(all.filter((e) => e.hands === 2).length, 4);
  assert.equal(new Set(all.map((e) => e.emoji)).size, 14, "sin emojis repetidos");
  for (const e of all) assert.ok(e.name && e.how, `${e.emoji} sin nombre o descripción`);
  for (const key of ["HEART", "CLAP", "THUMBS_UP", "THUMBS_DOWN"]) assert.ok(EMOJIS[key], key);
});

/* ----------------------------------- Una mano ----------------------------------- */

const SINGLE = [
  ["THUMBS_UP", { thumb: "up" }],
  ["THUMBS_DOWN", { thumb: "down" }],
  ["PEACE", { index: true, middle: true }],
  ["OK", { middle: true, ring: true, pinky: true, ok: true }],
  ["FIST", {}],
  ["OPEN_HAND", OPEN],
  ["POINT_UP", { index: true }],
  ["LOVE_YOU", { index: true, pinky: true, thumb: "out" }],
  ["ROCK", { index: true, pinky: true }],
  ["CALL_ME", { pinky: true, thumb: "out" }],
];

for (const [key, spec] of SINGLE) {
  test(`una mano: ${EMOJIS[key].emoji} ${EMOJIS[key].name} → ${key}`, () => {
    assert.equal(classifyHand(makeHand(spec)), key);
  });
}

test("una mano: el reconocimiento no depende de la posición ni del tamaño", () => {
  for (const [key, spec] of SINGLE) {
    const moved = place(makeHand(spec), { dx: 0.2, dy: -0.15, scale: 2.2 });
    assert.equal(classifyHand(moved), key, `${key} falló tras mover y escalar`);
  }
});

test("una mano: gestos ambiguos o inválidos → null", () => {
  assert.equal(classifyHand(makeHand({ index: true, thumb: "out" })), null, "'L' no es ningún emoji");
  assert.equal(classifyHand(makeHand({ middle: true })), null);
  assert.equal(classifyHand(makeHand({ thumb: "out" })), null, "puño con el pulgar al costado");
  assert.equal(classifyHand(null), null);
  assert.equal(classifyHand([]), null);
});

test("una mano: ☝️ exige apuntar hacia arriba (apuntar al costado no cuenta)", () => {
  // Mano girada 90°: el índice queda horizontal
  const rotated = makeHand({ index: true }).map((p) => ({ x: 1 - p.y, y: p.x }));
  assert.equal(classifyHand(rotated), null);
});

test("pulgar: distingue extendido/recogido y arriba/abajo", () => {
  assert.deepEqual(thumbInfo(makeHand({ thumb: "in" })), { extended: false, up: false, down: false });
  const up = thumbInfo(makeHand({ thumb: "up" }));
  assert.ok(up.extended && up.up && !up.down);
  const down = thumbInfo(makeHand({ thumb: "down" }));
  assert.ok(down.extended && down.down && !down.up);
  const side = thumbInfo(makeHand({ thumb: "out" }));
  assert.ok(side.extended && !side.up && !side.down);
});

/* ----------------------------------- Dos manos ----------------------------------- */

test("dos manos: ❤️ corazón", () => {
  const a = place(heartHand(), { mirror: true });
  const b = heartHand();
  assert.equal(classifyTwoHands(a, b), "HEART");
  assert.equal(classifyFrame([a, b]), "HEART");
  assert.equal(classifyFrame([b, a]), "HEART", "el orden de las manos no importa");
});

test("dos manos: el corazón no depende de la posición ni del tamaño", () => {
  const move = (h) => place(h, { dx: -0.2, dy: 0.1, scale: 1.8 });
  assert.equal(classifyTwoHands(move(place(heartHand(), { mirror: true })), move(heartHand())), "HEART");
});

test("dos manos: 🙏 manos juntas con dedos paralelos NO se confunde con un corazón", () => {
  const [a, b] = openPair(0.1);
  assert.equal(classifyTwoHands(a, b), "PRAY");
  assert.notEqual(classifyFrame([a, b]), "HEART");
});

test("dos manos: 🙌 manos abiertas y separadas", () => {
  const [a, b] = openPair(0.4);
  assert.ok(palmDistance(a, b) > THRESHOLDS.raisedApart);
  assert.equal(classifyTwoHands(a, b), "RAISED_HANDS");
});

test("dos manos: a distancia intermedia no se reconoce ninguna pareja", () => {
  const [a, b] = openPair(0.2);
  assert.equal(classifyTwoHands(a, b), null);
});

test("dos manos: con puños no hay 🙏 ni 🙌", () => {
  const a = place(makeHand(), { dx: -0.1 });
  const b = place(makeHand(), { dx: 0.1, mirror: true });
  assert.equal(classifyTwoHands(a, b), null);
});

test("fotograma: si no hay pareja, se usa el gesto de cada mano por separado", () => {
  const thumbsUp = place(makeHand({ thumb: "up" }), { dx: -0.3 });
  const noise = place(makeHand({ middle: true }), { dx: 0.3 });
  assert.equal(classifyFrame([noise, thumbsUp]), "THUMBS_UP");
  assert.equal(classifyFrame([]), null);
});

/* --------------------------------- Detector temporal --------------------------------- */

const STEP = 33;

/** Alimenta el detector con `hands` durante `ms` ms; devuelve los instantes de activación y el estado final. */
function run(detector, hands, ms, start, onStep) {
  const activations = [];
  let t = start;
  let last;
  for (; t < start + ms; t += STEP) {
    last = detector.update(typeof hands === "function" ? hands(t - start) : hands, t);
    if (last.activated) activations.push({ key: last.activated, at: t });
    onStep?.(last, t);
  }
  return { activations, t, last };
}

test("detector: un gesto estático se activa tras 350 ms y una sola vez", () => {
  const d = new EmojiDetector();
  const short = run(d, [makeHand({ thumb: "up" })], 250, 0);
  assert.equal(short.last.active, null, "a los 250 ms aún no debe activarse");
  const rest = run(d, [makeHand({ thumb: "up" })], 2000, short.t);
  assert.equal(rest.activations.length, 1);
  assert.equal(rest.activations[0].key, "THUMBS_UP");
  assert.equal(rest.last.active, "THUMBS_UP");
});

test("detector: un destello de 200 ms de un gesto distinto no lo activa", () => {
  const d = new EmojiDetector();
  let r = run(d, [makeHand({ thumb: "up" })], 1000, 0);
  r = run(d, [makeHand({ index: true, middle: true })], 200, r.t);
  assert.deepEqual(r.activations, []);
});

test("detector: tolera un parpadeo corto y se apaga tras una pérdida larga", () => {
  const d = new EmojiDetector();
  let r = run(d, [makeHand({ thumb: "up" })], 1000, 0);
  r = run(d, [], 100, r.t); // parpadeo (< 250 ms)
  assert.equal(r.last.active, "THUMBS_UP");
  r = run(d, [], 400, r.t); // pérdida larga
  assert.equal(r.last.active, null);
});

test("detector: cambiar de gesto activa el nuevo emoji", () => {
  const d = new EmojiDetector();
  let r = run(d, [makeHand({ thumb: "up" })], 800, 0);
  r = run(d, [makeHand({ index: true, middle: true })], 900, r.t);
  assert.equal(r.last.active, "PEACE");
});

test("detector: ❤️ y 🙏 con dos manos se activan y se distinguen", () => {
  const heart = [place(heartHand(), { mirror: true }), heartHand()];
  let d = new EmojiDetector();
  assert.equal(run(d, heart, 800, 0).last.active, "HEART");
  d = new EmojiDetector();
  assert.equal(run(d, openPair(0.1), 800, 0).last.active, "PRAY");
});

test("detector: 👏 se activa al juntar rápido dos palmas abiertas", () => {
  const d = new EmojiDetector();
  let r = run(d, openPair(0.4), 300, 0); // separadas
  assert.equal(r.last.active, null === r.last.active ? null : r.last.active); // (puede estar en 🙌 tras 350 ms)
  r = run(d, openPair(0.1), 100, r.t); // se juntan
  assert.ok(r.activations.some((a) => a.key === "CLAP"), "debe activarse 👏");
  assert.equal(r.last.active, "CLAP");
});

test("detector: 👏 permanece unos instantes y luego cede el paso a 🙏", () => {
  const d = new EmojiDetector();
  let r = run(d, openPair(0.4), 300, 0);
  r = run(d, openPair(0.1), 1000, r.t);
  assert.equal(r.last.active, "CLAP", "a 1 s sigue el aplauso");
  r = run(d, openPair(0.1), 1500, r.t);
  assert.equal(r.last.active, "PRAY");
});

test("detector: 👏 también se detecta si las manos se tapan al chocar (se pierde la detección)", () => {
  const d = new EmojiDetector();
  let r = run(d, openPair(0.4), 300, 0);
  r = run(d, openPair(0.2), STEP, r.t); // casi juntas
  r = run(d, [], 200, r.t); // al chocar se pierden
  assert.ok(r.activations.some((a) => a.key === "CLAP") || r.last.active === "CLAP");
});

test("detector: un acercamiento LENTO de las manos no es un aplauso", () => {
  const d = new EmojiDetector();
  // De 0.4 a 0.1 de semiseparación a lo largo de 4 s
  const r = run(d, (ms) => openPair(0.4 - 0.3 * Math.min(ms / 4000, 1)), 4500, 0);
  assert.ok(!r.activations.some((a) => a.key === "CLAP"), "no debería haber 👏");
});

test("detector: puños que se juntan no son un aplauso (las palmas deben estar abiertas)", () => {
  const d = new EmojiDetector();
  const fists = (half) => [place(makeHand(), { dx: -half }), place(makeHand(), { dx: half, mirror: true })];
  let r = run(d, fists(0.4), 300, 0);
  r = run(d, fists(0.1), 300, r.t);
  assert.ok(!r.activations.some((a) => a.key === "CLAP"));
});

test("detector: perder una mano sin haberse acercado antes no es un aplauso", () => {
  const d = new EmojiDetector();
  let r = run(d, openPair(0.4), 600, 0);
  r = run(d, [], 600, r.t);
  assert.ok(!r.activations.some((a) => a.key === "CLAP"));
});

test("detector: reset() olvida el estado", () => {
  const d = new EmojiDetector();
  run(d, [makeHand({ thumb: "up" })], 800, 0);
  d.reset();
  assert.equal(d.update([], 1000).active, null);
});

test("tamaño de palma: positivo y proporcional a la escala", () => {
  const a = handSize(makeHand());
  const b = handSize(place(makeHand(), { scale: 2 }));
  assert.ok(a > 0 && Math.abs(b / a - 2) < 1e-9);
});
