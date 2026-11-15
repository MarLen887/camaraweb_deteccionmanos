// Pruebas unitarias del modo "Señas" (lógica pura).
// Ejecución: `npm test`

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL,
  DYNAMIC_LETTERS,
  FEATURE_DIM,
  SignClassifier,
  STATIC_LETTERS,
  TRAINABLE,
  WordBuilder,
  crossValidate,
  extractFeatures,
  parseDataset,
  serializeDataset,
} from "../js/signs.js";

/* ------------------------- Generador de manos sintéticas ------------------------- */

/** Generador pseudoaleatorio determinista (LCG). */
function makeRandom(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Mano sintética (21 landmarks) con la palma hacia la cámara, apuntando hacia arriba.
 * Cada dedo puede estar extendido o flexionado; el pulgar, afuera o adentro.
 */
function makeHand({ index = false, middle = false, ring = false, pinky = false, thumb = false },
                  { noise = 0, rand = Math.random, scale = 1, dx = 0, dy = 0 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };

  const fingers = [
    { ids: [5, 6, 7, 8], x: 0.42, on: index },
    { ids: [9, 10, 11, 12], x: 0.5, on: middle },
    { ids: [13, 14, 15, 16], x: 0.58, on: ring },
    { ids: [17, 18, 19, 20], x: 0.65, on: pinky },
  ];
  for (const { ids: [mcp, pip, dip, tip], x, on } of fingers) {
    lm[mcp] = { x, y: 0.7, z: 0 };
    lm[pip] = { x, y: on ? 0.6 : 0.62, z: 0 };
    lm[dip] = { x, y: on ? 0.52 : 0.7, z: 0 };
    lm[tip] = { x, y: on ? 0.44 : 0.74, z: 0 };
  }
  const t = thumb
    ? [[0.4, 0.85], [0.32, 0.8], [0.26, 0.76], [0.2, 0.72]]
    : [[0.45, 0.85], [0.44, 0.8], [0.45, 0.76], [0.47, 0.74]];
  t.forEach(([x, y], i) => (lm[1 + i] = { x, y, z: 0 }));

  // Ruido de seguimiento, cambio de tamaño y de posición
  return lm.map((p) => ({
    x: (p.x - 0.5) * scale + 0.5 + dx + (rand() * 2 - 1) * noise,
    y: (p.y - 0.8) * scale + 0.8 + dy + (rand() * 2 - 1) * noise,
    z: (rand() * 2 - 1) * noise,
  }));
}

/** Seis señas sintéticas bien diferenciadas, con nombres de letras. */
const POSES = {
  A: {}, // puño
  B: { index: true, middle: true, ring: true, pinky: true },
  L: { index: true, thumb: true },
  V: { index: true, middle: true },
  W: { index: true, middle: true, ring: true },
  Y: { pinky: true, thumb: true },
};

/** Construye ejemplos: `takes` grabaciones × `perTake` fotogramas por seña. */
function buildSamples({ takes = 3, perTake = 10, noise = 0.008, seed = 1 } = {}) {
  const rand = makeRandom(seed);
  const samples = [];
  let take = 0;
  for (let t = 0; t < takes; t++) {
    for (const [label, pose] of Object.entries(POSES)) {
      take++;
      for (let i = 0; i < perTake; i++) {
        const opts = { noise, rand, scale: 0.8 + rand() * 0.5, dx: (rand() - 0.5) * 0.2, dy: (rand() - 0.5) * 0.1 };
        samples.push({ label, take, features: extractFeatures(makeHand(pose, opts)) });
      }
    }
  }
  return samples;
}

/* --------------------------------- Constantes --------------------------------- */

test("el alfabeto suma 27 letras: 21 estáticas + 6 dinámicas, sin repetidas", () => {
  assert.equal(STATIC_LETTERS.length, 21);
  assert.equal(DYNAMIC_LETTERS.length, 6);
  const all = [...STATIC_LETTERS, ...DYNAMIC_LETTERS];
  assert.equal(new Set(all).size, 27);
  assert.deepEqual([...DYNAMIC_LETTERS], ["J", "K", "Ñ", "Q", "X", "Z"]);
  assert.equal(TRAINABLE.length, 23); // 21 letras + espacio + borrar
});

/* --------------------------------- Características --------------------------------- */

test("características: vector de 60 valores y entrada inválida → null", () => {
  const f = extractFeatures(makeHand(POSES.B));
  assert.equal(f.length, FEATURE_DIM);
  assert.equal(extractFeatures(null), null);
  assert.equal(extractFeatures([]), null);
  assert.equal(extractFeatures(Array.from({ length: 21 }, () => ({ x: 1, y: 1, z: 0 }))), null); // tamaño 0
});

test("características: invariantes a la posición y al tamaño de la mano", () => {
  const a = extractFeatures(makeHand(POSES.V));
  const b = extractFeatures(makeHand(POSES.V, { scale: 2.5, dx: 0.3, dy: -0.2 }));
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `diferencia en ${i}`));
});

test("características: señas distintas producen vectores claramente distintos", () => {
  const a = extractFeatures(makeHand(POSES.A));
  const b = extractFeatures(makeHand(POSES.B));
  const d = Math.hypot(...a.map((v, i) => v - b[i]));
  assert.ok(d > 1.5, `distancia demasiado pequeña: ${d}`);
});

/* ----------------------------------- Clasificador ----------------------------------- */

test("clasificador: sin ejemplos no reconoce nada", () => {
  const c = new SignClassifier();
  assert.equal(c.classify(extractFeatures(makeHand(POSES.A))).label, null);
});

test("clasificador: reconoce señas nuevas con otro tamaño y posición (≥ 95 %)", () => {
  const c = new SignClassifier();
  c.setSamples(buildSamples({ seed: 1 }));
  const rand = makeRandom(99);
  let ok = 0;
  let n = 0;
  for (const [label, pose] of Object.entries(POSES)) {
    for (let i = 0; i < 20; i++) {
      const f = extractFeatures(makeHand(pose, { noise: 0.01, rand, scale: 0.7 + rand() * 0.8, dx: (rand() - 0.5) * 0.3 }));
      n++;
      if (c.classify(f).label === label) ok++;
    }
  }
  assert.ok(ok / n >= 0.95, `exactitud ${(ok / n * 100).toFixed(1)} %`);
});

test("clasificador: rechaza una mano que no se parece a ninguna seña entrenada", () => {
  const c = new SignClassifier();
  c.setSamples(buildSamples({ seed: 2 }));
  const unknown = extractFeatures(makeHand({ middle: true })); // solo el dedo medio: no entrenado
  assert.equal(c.classify(unknown).label, null);
});

test("clasificador: contadores, borrado por etiqueta y vaciado", () => {
  const c = new SignClassifier();
  c.setSamples(buildSamples({ takes: 1, perTake: 5 }));
  assert.equal(c.counts().A, 5);
  assert.equal(c.labelCount, 6);
  c.removeLabel("A");
  assert.equal(c.counts().A, undefined);
  assert.equal(c.labelCount, 5);
  c.clear();
  assert.equal(c.samples.length, 0);
});

/* -------------------------------- Validación cruzada -------------------------------- */

test("validación cruzada: alta exactitud con señas bien diferenciadas y 3 grabaciones", () => {
  const cv = crossValidate(buildSamples({ takes: 3 }));
  assert.ok(cv.overall.accuracy >= 0.95, `exactitud ${cv.overall.accuracy}`);
  assert.equal(Object.keys(cv.perLabel).length, 6);
  assert.deepEqual(cv.notEvaluated, []);
});

test("validación cruzada: una seña con una sola grabación no se evalúa", () => {
  const samples = buildSamples({ takes: 2 });
  const extra = extractFeatures(makeHand({ pinky: true, ring: true }));
  for (let i = 0; i < 5; i++) samples.push({ label: "F", take: 9999, features: extra });
  const cv = crossValidate(samples);
  assert.deepEqual(cv.notEvaluated, ["F"]);
  assert.equal(cv.perLabel.F, undefined);
});

test("validación cruzada: detecta la confusión entre dos señas casi idénticas", () => {
  // V y una "V" con el dedo medio apenas más corto: indistinguibles por diseño
  const rand = makeRandom(5);
  const samples = [];
  let take = 0;
  for (let t = 0; t < 3; t++) {
    for (const label of ["G", "H"]) {
      take++;
      for (let i = 0; i < 12; i++) {
        const f = extractFeatures(makeHand({ index: true, middle: false }, { noise: 0.05, rand }));
        samples.push({ label, take, features: f }); // ambas etiquetas con la MISMA seña
      }
    }
  }
  const cv = crossValidate(samples);
  assert.ok(cv.overall.accuracy < 0.8, `debería detectar baja exactitud, obtuvo ${cv.overall.accuracy}`);
  assert.ok(Object.keys(cv.confusions).length > 0, "debería registrar confusiones");
});

/* ----------------------------------- WordBuilder ----------------------------------- */

const STEP = 33;

/** Alimenta el autómata con `label` durante `ms` ms; devuelve los eventos y el instante final. */
function feed(builder, label, ms, start) {
  const events = [];
  let t = start;
  for (; t < start + ms; t += STEP) {
    const e = builder.update(label, t);
    if (e) events.push(e);
  }
  return { events, t };
}

test("palabras: mantener una seña 1 s confirma la letra una sola vez", () => {
  const b = new WordBuilder();
  const { events, t } = feed(b, "A", 3000, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "letter", value: "A", applied: true });
  assert.equal(b.text, "A");
  assert.ok(t > 0);
});

test("palabras: menos de 1 s no confirma nada", () => {
  const b = new WordBuilder();
  const { events } = feed(b, "A", 900, 0);
  assert.equal(events.length, 0);
  assert.equal(b.text, "");
  assert.ok(b.progress > 0.8 && b.progress < 1);
});

test("palabras: repetir la misma letra exige soltar la seña (letras dobles)", () => {
  const b = new WordBuilder();
  let r = feed(b, "O", 1500, 0); // confirma la primera O
  r = feed(b, null, 500, r.t); // se retira la mano
  r = feed(b, "O", 1500, r.t); // segunda O
  assert.equal(b.text, "OO");
});

test("palabras: un parpadeo breve tras confirmar NO repite la letra", () => {
  const b = new WordBuilder();
  let r = feed(b, "A", 1500, 0);
  r = feed(b, null, 100, r.t); // parpadeo (< releaseMs)
  r = feed(b, "A", 3000, r.t);
  assert.equal(b.text, "A");
});

test("palabras: cambiar directamente de una seña a otra forma la secuencia", () => {
  const b = new WordBuilder();
  let r = feed(b, "H", 1300, 0);
  r = feed(b, "O", 1300, r.t);
  r = feed(b, "L", 1300, r.t);
  r = feed(b, "A", 1300, r.t);
  assert.equal(b.text, "HOLA");
});

test("palabras: un fallo puntual de reconocimiento no reinicia la cuenta", () => {
  const b = new WordBuilder();
  let r = feed(b, "A", 500, 0);
  r = feed(b, null, 99, r.t); // fotograma perdido (< graceMs)
  r = feed(b, "A", 700, r.t);
  assert.equal(b.text, "A");
});

test("palabras: una seña errónea de 400 ms no se confirma y reinicia la cuenta", () => {
  const b = new WordBuilder();
  let r = feed(b, "A", 600, 0);
  r = feed(b, "B", 400, r.t);
  assert.equal(b.text, "");
  r = feed(b, "B", 700, r.t);
  assert.equal(b.text, "B", "B debe confirmarse tras 1 s propio, no heredar la cuenta de A");
});

test("palabras: señas de control (espacio y borrar)", () => {
  const b = new WordBuilder();
  let r = feed(b, CONTROL.SPACE, 1300, 0); // espacio al inicio: se ignora
  assert.equal(b.text, "");
  r = feed(b, "S", 1300, r.t);
  r = feed(b, "I", 1300, r.t);
  r = feed(b, CONTROL.SPACE, 1300, r.t);
  assert.equal(b.text, "SI ");
  r = feed(b, CONTROL.BACKSPACE, 1300, r.t);
  assert.equal(b.text, "SI");
  r = feed(b, CONTROL.BACKSPACE, 1300, r.t); // misma seña: exige soltar antes de repetir
  assert.equal(b.text, "SI");
  r = feed(b, null, 400, r.t);
  r = feed(b, CONTROL.BACKSPACE, 1300, r.t);
  assert.equal(b.text, "S");
});

test("palabras: no se acumulan espacios dobles y el borrado tolera texto vacío", () => {
  const b = new WordBuilder();
  b.push("A");
  assert.equal(b.space(), true);
  assert.equal(b.space(), false);
  b.clear();
  assert.equal(b.backspace(), false);
});

test("palabras: respeta la longitud máxima", () => {
  const b = new WordBuilder({ maxLength: 3 });
  for (const c of "ABCDE") b.push(c);
  assert.equal(b.text, "ABC");
});

test("palabras: la Ñ se borra completa", () => {
  const b = new WordBuilder();
  b.push("A");
  b.push("Ñ");
  b.backspace();
  assert.equal(b.text, "A");
});

/* ------------------------------------- Dataset ------------------------------------- */

test("dataset: exportar e importar conserva los ejemplos", () => {
  const samples = buildSamples({ takes: 1, perTake: 3 });
  const { samples: back, error } = parseDataset(serializeDataset(samples));
  assert.equal(error, null);
  assert.equal(back.length, samples.length);
  assert.equal(back[0].label, samples[0].label);
  back[0].features.forEach((v, i) => assert.ok(Math.abs(v - samples[0].features[i]) < 0.001));
});

test("dataset: rechaza JSON inválido, versión ajena, etiquetas desconocidas y vectores corruptos", () => {
  assert.match(parseDataset("no es json").error, /JSON/);
  assert.match(parseDataset(JSON.stringify({ version: 99 })).error, /versión/);
  const good = JSON.parse(serializeDataset(buildSamples({ takes: 1, perTake: 1 })));

  const badLabel = structuredClone(good);
  badLabel.samples[0].l = "J"; // dinámica: no entrenable
  assert.match(parseDataset(JSON.stringify(badLabel)).error, /n\.º 1/);

  const badVector = structuredClone(good);
  badVector.samples[1].f = [1, 2, 3];
  assert.match(parseDataset(JSON.stringify(badVector)).error, /n\.º 2/);

  const nanVector = structuredClone(good);
  nanVector.samples[0].f[5] = null;
  assert.match(parseDataset(JSON.stringify(nanVector)).error, /n\.º 1/);
});
