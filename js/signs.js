/**
 * signs.js
 * -----------------------------------------------------------------------------
 * Lógica pura (sin DOM) del modo "Señas": reconocimiento del alfabeto
 * dactilológico de la Lengua de Señas Mexicana (LSM) mediante entrenamiento en
 * el navegador, y formación de palabras.
 *
 * Método
 *   1. Los 21 landmarks de MediaPipe se convierten en un vector de 60
 *      características invariante a la posición y al tamaño de la mano.
 *   2. Un clasificador de k vecinos más cercanos (k-NN; Cover y Hart, 1967)
 *      compara el vector con los ejemplos que la persona grabó.
 *   3. Un autómata temporal (WordBuilder) confirma una letra cuando se
 *      mantiene la seña durante un tiempo, y forma la palabra.
 *
 * Alcance: solo letras ESTÁTICAS. Según la fuente consultada (López-Nava, s. f.),
 * de las 27 letras del alfabeto de la LSM, 21 son estáticas y 6 son dinámicas
 * (J, K, Ñ, Q, X, Z). Las dinámicas requieren seguir el movimiento de la mano
 * y NO se reconocen en esta versión.
 *
 * Referencias
 *   Cover, T., & Hart, P. (1967). Nearest neighbor pattern classification.
 *   IEEE Transactions on Information Theory, 13(1), 21–27.
 *   https://doi.org/10.1109/TIT.1967.1053964
 */

/** Letras estáticas del alfabeto de la LSM (21). */
export const STATIC_LETTERS = Object.freeze([
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "L", "M",
  "N", "O", "P", "R", "S", "T", "U", "V", "W", "Y",
]);

/** Letras dinámicas (6): requieren movimiento; no se reconocen por la forma de la mano. */
export const DYNAMIC_LETTERS = Object.freeze(["J", "K", "Ñ", "Q", "X", "Z"]);

/** Señas de control entrenables: la persona elige qué seña usar para cada una. */
export const CONTROL = Object.freeze({ SPACE: "ESPACIO", BACKSPACE: "BORRAR" });

/** Etiquetas que se pueden entrenar. */
export const TRAINABLE = Object.freeze([...STATIC_LETTERS, CONTROL.SPACE, CONTROL.BACKSPACE]);

/* -------------------------------------------------------------------------- */
/*  Características                                                            */
/* -------------------------------------------------------------------------- */

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

/** Número de características: 20 puntos (sin la muñeca) × 3 coordenadas. */
export const FEATURE_DIM = 60;

/** La coordenada z de MediaPipe es más ruidosa que x e y: se le da menos peso. */
const Z_WEIGHT = 0.5;

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

/**
 * Convierte los 21 landmarks en un vector invariante a posición y tamaño:
 * se resta la muñeca y se divide entre el tamaño de la palma. Se conserva la
 * orientación, porque algunas letras difieren por ella.
 *
 * @param {{x:number,y:number,z?:number}[]} lm 21 landmarks en una escala isotrópica
 *   (x, y, z en las mismas unidades, p. ej. píxeles).
 * @returns {number[]|null} Vector de FEATURE_DIM valores, o null si la entrada no es válida.
 */
export function extractFeatures(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return null;
  const size = (dist3(lm[WRIST], lm[MIDDLE_MCP]) + dist3(lm[INDEX_MCP], lm[PINKY_MCP])) / 2;
  if (!Number.isFinite(size) || size < 1e-6) return null;

  const w = lm[WRIST];
  const f = new Array(FEATURE_DIM);
  let k = 0;
  for (let i = 1; i < 21; i++) {
    f[k++] = (lm[i].x - w.x) / size;
    f[k++] = (lm[i].y - w.y) / size;
    f[k++] = (Z_WEIGHT * ((lm[i].z ?? 0) - (w.z ?? 0))) / size;
  }
  return f.every(Number.isFinite) ? f : null;
}

/** Distancia euclidiana entre dos vectores de características. */
export function featureDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/* -------------------------------------------------------------------------- */
/*  Clasificador k-NN                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Devuelve los k vecinos más cercanos de `features`.
 * @param {number[]} features
 * @param {{label:string,take:number,features:number[]}[]} samples
 * @param {number} k
 * @param {(s:object)=>boolean} [skip] Si devuelve true, la muestra se ignora.
 * @returns {{label:string,take:number,d:number}[]} Ordenados de menor a mayor distancia.
 */
export function nearestNeighbors(features, samples, k, skip) {
  const best = [];
  for (const s of samples) {
    if (skip?.(s)) continue;
    const d = featureDistance(features, s.features);
    if (best.length < k || d < best[best.length - 1].d) {
      let i = best.length;
      while (i > 0 && best[i - 1].d > d) i--;
      best.splice(i, 0, { label: s.label, take: s.take, d });
      if (best.length > k) best.pop();
    }
  }
  return best;
}

/** Voto ponderado por el inverso de la distancia. */
export function weightedVote(neighbors) {
  if (!neighbors.length) return { label: null, confidence: 0 };
  const weights = new Map();
  let total = 0;
  for (const n of neighbors) {
    const w = 1 / (n.d + 0.05);
    weights.set(n.label, (weights.get(n.label) ?? 0) + w);
    total += w;
  }
  let label = null;
  let top = -1;
  for (const [l, w] of weights) {
    if (w > top) {
      top = w;
      label = l;
    }
  }
  return { label, confidence: top / total };
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class SignClassifier {
  /**
   * @param {object} [options]
   * @param {number} [options.k=5] Vecinos considerados.
   * @param {number} [options.minConfidence=0.6] Fracción mínima del voto para aceptar una etiqueta.
   * @param {number} [options.minReject=0.6] Distancia mínima del umbral de rechazo.
   * @param {number} [options.rejectFactor=2.5] El umbral es rejectFactor × (distancia típica entre ejemplos de una misma seña).
   */
  constructor({ k = 5, minConfidence = 0.6, minReject = 0.6, rejectFactor = 2.5 } = {}) {
    this.k = k;
    this.minConfidence = minConfidence;
    this.minReject = minReject;
    this.rejectFactor = rejectFactor;
    this.samples = [];
    this._reject = null;
  }

  setSamples(samples) {
    this.samples = samples.slice();
    this._reject = null;
  }

  add(label, features, take) {
    this.samples.push({ label, features, take });
    this._reject = null;
  }

  removeLabel(label) {
    this.samples = this.samples.filter((s) => s.label !== label);
    this._reject = null;
  }

  clear() {
    this.samples = [];
    this._reject = null;
  }

  /** Número de ejemplos por etiqueta. */
  counts() {
    const c = {};
    for (const s of this.samples) c[s.label] = (c[s.label] ?? 0) + 1;
    return c;
  }

  /** Número de señas distintas con al menos un ejemplo. */
  get labelCount() {
    return new Set(this.samples.map((s) => s.label)).size;
  }

  /**
   * Umbral de rechazo: una mano más lejos que esto de cualquier ejemplo no se
   * reconoce (p. ej., una transición entre señas). Se calcula a partir de la
   * variación real entre las grabaciones de una misma seña.
   */
  rejectDistance() {
    if (this._reject !== null) return this._reject;
    const stride = Math.max(1, Math.floor(this.samples.length / 300));
    const typical = [];
    for (let i = 0; i < this.samples.length; i += stride) {
      const q = this.samples[i];
      const sameLabel = (s) => s.label !== q.label;
      let n = nearestNeighbors(q.features, this.samples, 1, (s) => sameLabel(s) || s.take === q.take);
      if (!n.length) n = nearestNeighbors(q.features, this.samples, 1, (s) => sameLabel(s) || s === q);
      if (n.length) typical.push(n[0].d);
    }
    this._reject = typical.length
      ? Math.max(this.minReject, this.rejectFactor * median(typical))
      : this.minReject;
    return this._reject;
  }

  /**
   * @param {number[]} features
   * @returns {{label:string|null, confidence:number, distance:number}}
   *   `label` es null si no hay ejemplos, si la mano está demasiado lejos de todos
   *   ellos o si los vecinos no coinciden lo suficiente.
   */
  classify(features) {
    if (!features || !this.samples.length) return { label: null, confidence: 0, distance: Infinity };
    const neighbors = nearestNeighbors(features, this.samples, this.k);
    const { label, confidence } = weightedVote(neighbors);
    const distance = neighbors[0].d;
    const accepted = confidence >= this.minConfidence && distance <= this.rejectDistance();
    return { label: accepted ? label : null, confidence, distance };
  }
}

/**
 * Estima la precisión con validación cruzada "dejando fuera la grabación":
 * cada ejemplo se clasifica usando solo ejemplos de OTRAS grabaciones. Así se
 * evita el sesgo optimista de comparar fotogramas casi idénticos de una misma
 * toma. Las señas con una sola grabación no se pueden evaluar.
 *
 * @param {{label:string,take:number,features:number[]}[]} samples
 * @param {object} [options]
 * @param {number} [options.k=5]
 * @param {number} [options.stride=3] Se evalúa 1 de cada `stride` ejemplos (acelera el cálculo).
 * @returns {{overall:{total:number,correct:number,accuracy:number|null},
 *            perLabel:Object<string,{total:number,correct:number,accuracy:number}>,
 *            confusions:Object<string,Object<string,number>>,
 *            notEvaluated:string[]}}
 */
export function crossValidate(samples, { k = 5, stride = 3 } = {}) {
  const takesByLabel = new Map();
  for (const s of samples) {
    if (!takesByLabel.has(s.label)) takesByLabel.set(s.label, new Set());
    takesByLabel.get(s.label).add(s.take);
  }
  const evaluable = new Set([...takesByLabel].filter(([, t]) => t.size >= 2).map(([l]) => l));
  const notEvaluated = [...takesByLabel.keys()].filter((l) => !evaluable.has(l));

  const perLabel = {};
  const confusions = {};
  let total = 0;
  let correct = 0;
  let counter = 0;

  for (const q of samples) {
    if (!evaluable.has(q.label)) continue;
    if (counter++ % stride !== 0) continue;
    const neighbors = nearestNeighbors(q.features, samples, k, (s) => s.take === q.take);
    const { label: predicted } = weightedVote(neighbors);

    perLabel[q.label] ??= { total: 0, correct: 0, accuracy: 0 };
    perLabel[q.label].total++;
    total++;
    if (predicted === q.label) {
      perLabel[q.label].correct++;
      correct++;
    } else if (predicted) {
      confusions[q.label] ??= {};
      confusions[q.label][predicted] = (confusions[q.label][predicted] ?? 0) + 1;
    }
  }
  for (const stats of Object.values(perLabel)) stats.accuracy = stats.correct / stats.total;

  return {
    overall: { total, correct, accuracy: total ? correct / total : null },
    perLabel,
    confusions,
    notEvaluated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Formación de palabras                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Autómata que convierte la secuencia de señas reconocidas en texto.
 *
 * - Una seña se CONFIRMA al mantenerla `holdMs` ms (por defecto 1 s).
 * - Un parpadeo del reconocimiento menor a `graceMs` no reinicia la cuenta.
 * - Tras confirmar, la misma seña no se repite hasta "soltarla": mostrar otra
 *   seña o retirar la mano durante `releaseMs`. Así se pueden escribir letras
 *   dobles (p. ej., «OO») sin repeticiones accidentales.
 * - Las señas de control añaden un espacio o borran la última letra.
 */
export class WordBuilder {
  constructor({ holdMs = 1000, releaseMs = 300, graceMs = 200, maxLength = 200 } = {}) {
    this.holdMs = holdMs;
    this.releaseMs = releaseMs;
    this.graceMs = graceMs;
    this.maxLength = maxLength;
    this.text = "";
    this.resetTracking();
  }

  /** Reinicia el seguimiento de la seña actual (no borra el texto). */
  resetTracking() {
    this.candidate = null;
    this.holdStart = null;
    this.lastMatch = 0;
    this.lastLabel = null; // Última etiqueta cruda recibida
    this.labelSince = 0; // Instante en que esa etiqueta apareció por primera vez
    this.committed = null;
    this.armed = true;
    this.differentSince = null;
    this.progress = 0;
  }

  /**
   * @param {string|null} label Seña reconocida en este instante (null = ninguna).
   * @param {number} now Instante (ms).
   * @returns {{type:"letter"|"space"|"backspace", value?:string, applied:boolean}|null}
   *   Evento si en este instante se confirmó una seña.
   */
  update(label, now) {
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.labelSince = now;
    }

    // 1) ¿Se "soltó" la última seña confirmada?
    if (label !== this.committed) {
      this.differentSince ??= now;
      if (now - this.differentSince >= this.releaseMs) this.armed = true;
    } else {
      this.differentSince = null;
    }

    // 2) Seña candidata, tolerando parpadeos breves
    if (label !== null && label === this.candidate) {
      this.lastMatch = now;
    } else if (this.candidate !== null && now - this.lastMatch <= this.graceMs) {
      // parpadeo: se conserva la candidata
    } else {
      this.candidate = label;
      // La cuenta parte del primer instante en que se vio la nueva seña (no tras el margen de tolerancia).
      this.holdStart = label === null ? null : this.labelSince;
      this.lastMatch = now;
    }

    // 3) Progreso y confirmación
    const ratio =
      this.candidate !== null && this.holdStart !== null
        ? Math.min((now - this.holdStart) / this.holdMs, 1)
        : 0;
    const counts = this.armed || this.candidate !== this.committed;
    this.progress = counts ? ratio : 0;

    if (this.candidate !== null && this.armed && ratio >= 1) {
      const event = this._apply(this.candidate);
      this.committed = this.candidate;
      this.armed = false;
      this.differentSince = null;
      this.holdStart = now;
      this.progress = 0;
      return event;
    }
    return null;
  }

  _apply(label) {
    if (label === CONTROL.SPACE) return { type: "space", applied: this.space() };
    if (label === CONTROL.BACKSPACE) return { type: "backspace", applied: this.backspace() };
    return { type: "letter", value: label, applied: this.push(label) };
  }

  push(letter) {
    if (this.text.length >= this.maxLength) return false;
    this.text += letter;
    return true;
  }

  space() {
    if (!this.text || this.text.endsWith(" ") || this.text.length >= this.maxLength) return false;
    this.text += " ";
    return true;
  }

  backspace() {
    if (!this.text) return false;
    this.text = Array.from(this.text).slice(0, -1).join("");
    return true;
  }

  clear() {
    this.text = "";
  }
}

/* -------------------------------------------------------------------------- */
/*  Conjunto de datos (exportar / importar)                                    */
/* -------------------------------------------------------------------------- */

export const DATASET_VERSION = 1;
const MAX_SAMPLES = 20000;

/** Serializa los ejemplos a JSON (valores redondeados a 3 decimales). */
export function serializeDataset(samples) {
  return JSON.stringify({
    app: "AirCanvas",
    version: DATASET_VERSION,
    featureDim: FEATURE_DIM,
    createdAt: new Date().toISOString(),
    samples: samples.map((s) => ({
      l: s.label,
      t: s.take,
      f: s.features.map((v) => Math.round(v * 1000) / 1000),
    })),
  });
}

/**
 * Valida y convierte un JSON exportado.
 * @returns {{samples:object[], error:null}|{samples:null, error:string}}
 */
export function parseDataset(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { samples: null, error: "El archivo no es un JSON válido." };
  }
  if (!data || typeof data !== "object" || data.version !== DATASET_VERSION) {
    return { samples: null, error: "El archivo no corresponde a un entrenamiento de AirCanvas (versión no compatible)." };
  }
  if (data.featureDim !== FEATURE_DIM || !Array.isArray(data.samples)) {
    return { samples: null, error: "El archivo tiene un formato de características distinto al esperado." };
  }
  if (data.samples.length > MAX_SAMPLES) {
    return { samples: null, error: `El archivo excede el máximo de ${MAX_SAMPLES} ejemplos.` };
  }

  const samples = [];
  for (const [i, s] of data.samples.entries()) {
    const ok =
      s &&
      TRAINABLE.includes(s.l) &&
      Number.isFinite(s.t) &&
      Array.isArray(s.f) &&
      s.f.length === FEATURE_DIM &&
      s.f.every(Number.isFinite);
    if (!ok) return { samples: null, error: `El ejemplo n.º ${i + 1} del archivo no es válido.` };
    samples.push({ label: s.l, take: s.t, features: s.f });
  }
  return { samples, error: null };
}
