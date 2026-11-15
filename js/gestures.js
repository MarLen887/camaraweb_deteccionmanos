/**
 * gestures.js
 * -----------------------------------------------------------------------------
 * Lógica pura (sin DOM) para interpretar los 21 puntos de referencia (landmarks)
 * que entrega MediaPipe Hand Landmarker y convertirlos en gestos de dibujo.
 *
 * Al no depender del navegador, este módulo se puede probar con Node.js
 * (ver /tests/gestures.test.mjs).
 *
 * Convención de índices de los landmarks (MediaPipe Hands):
 *   0 muñeca · 1-4 pulgar · 5-8 índice · 9-12 medio · 13-16 anular · 17-20 meñique
 *   (en cada dedo: MCP → PIP → DIP → TIP).
 *
 * Referencia: Zhang et al. (2020), "MediaPipe Hands: On-device real-time hand
 * tracking", arXiv:2006.10214.
 */

/** Gestos reconocidos por la aplicación. */
export const GESTURE = Object.freeze({
  DRAW: "draw", // Solo el índice extendido
  MOVE: "move", // Índice y medio extendidos (cursor sin dibujar / selección)
  ERASE: "erase", // Palma abierta (cuatro dedos extendidos)
  PAUSE: "pause", // Puño cerrado
  NONE: "none", // Cualquier otra combinación
});

/** Índices de los landmarks utilizados. */
export const LANDMARK = Object.freeze({
  WRIST: 0,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
});

/** Pares de landmarks que forman el "esqueleto" de la mano. */
export const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]);

/**
 * Cociente mínimo (distancia muñeca→punta) / (distancia muñeca→PIP) para
 * considerar que un dedo está extendido. En un dedo extendido el cociente ronda
 * 1.5–1.8; en uno flexionado, 0.6–1.0. El umbral 1.2 queda en medio.
 */
export const EXTENSION_RATIO = 1.2;

/** Distancia euclidiana entre dos puntos {x, y}. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Determina qué dedos (excepto el pulgar) están extendidos.
 * Se usa la distancia a la muñeca, por lo que el resultado no depende de la
 * orientación de la mano (apuntando hacia arriba, de lado, etc.).
 *
 * IMPORTANTE: los puntos deben estar en una escala isotrópica (por ejemplo, en
 * píxeles) para que las distancias no se deformen en imágenes no cuadradas.
 *
 * @param {{x:number,y:number}[]} lm 21 landmarks.
 * @returns {{index:boolean, middle:boolean, ring:boolean, pinky:boolean}}
 */
export function fingerStates(lm) {
  const wrist = lm[LANDMARK.WRIST];
  const check = (pip, tip) => {
    const dPip = distance(lm[pip], wrist);
    return dPip > 0 && distance(lm[tip], wrist) / dPip > EXTENSION_RATIO;
  };
  return {
    index: check(LANDMARK.INDEX_PIP, LANDMARK.INDEX_TIP),
    middle: check(LANDMARK.MIDDLE_PIP, LANDMARK.MIDDLE_TIP),
    ring: check(LANDMARK.RING_PIP, LANDMARK.RING_TIP),
    pinky: check(LANDMARK.PINKY_PIP, LANDMARK.PINKY_TIP),
  };
}

/**
 * Clasifica el gesto a partir de los landmarks de una mano.
 * El pulgar se ignora deliberadamente: su detección es poco fiable y no es
 * necesario para distinguir los cuatro gestos definidos.
 *
 * @param {{x:number,y:number}[]} lm 21 landmarks (escala isotrópica).
 * @returns {string} Uno de los valores de GESTURE.
 */
export function classifyGesture(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return GESTURE.NONE;
  const { index, middle, ring, pinky } = fingerStates(lm);

  if (index && !middle && !ring && !pinky) return GESTURE.DRAW;
  if (index && middle && !ring && !pinky) return GESTURE.MOVE;
  if (index && middle && ring && pinky) return GESTURE.ERASE;
  if (!index && !middle && !ring && !pinky) return GESTURE.PAUSE;
  return GESTURE.NONE;
}

/** Punta del dedo índice (punto con el que se dibuja). */
export function fingertip(lm) {
  return lm[LANDMARK.INDEX_TIP];
}

/** Centro aproximado de la palma (promedio de muñeca y bases de los dedos). */
export function palmCenter(lm) {
  const ids = [
    LANDMARK.WRIST,
    LANDMARK.INDEX_MCP,
    LANDMARK.MIDDLE_MCP,
    LANDMARK.RING_MCP,
    LANDMARK.PINKY_MCP,
  ];
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

/* -------------------------------------------------------------------------- */
/*  Filtro 1€ (One Euro Filter)                                                */
/* -------------------------------------------------------------------------- */

/** Filtro paso bajo exponencial con factor alfa variable. */
class LowPassFilter {
  constructor() {
    this.value = null;
  }

  filter(x, alpha) {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

/** Factor de suavizado α para una frecuencia de corte y un periodo dados. */
function smoothingFactor(period, cutoff) {
  const r = 2 * Math.PI * cutoff * period;
  return r / (r + 1);
}

/**
 * Filtro 1€ para señales ruidosas en interacción humano-computadora.
 * Suaviza mucho cuando el movimiento es lento (elimina el temblor) y poco
 * cuando es rápido (evita retraso al trazar).
 *
 * Referencia: Casiez, Roussel y Vogel (2012), "1€ filter: A simple
 * speed-based low-pass filter for noisy input in interactive systems",
 * CHI '12, pp. 2527–2530, https://doi.org/10.1145/2207676.2208639
 */
export class OneEuroFilter {
  /**
   * @param {object} [options]
   * @param {number} [options.minCutoff=1.0] Frecuencia de corte mínima (Hz). Menor = más suavizado.
   * @param {number} [options.beta=0.02] Coeficiente de velocidad. Mayor = menos retraso al moverse rápido.
   * @param {number} [options.dCutoff=1.0] Frecuencia de corte para la derivada (Hz).
   */
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.previousTime = null;
    this.previousRaw = null;
  }

  /**
   * @param {number} x Valor medido.
   * @param {number} t Instante de la medición, en segundos (monótono creciente).
   * @returns {number} Valor filtrado.
   */
  filter(x, t) {
    if (this.previousTime === null) {
      this.previousTime = t;
      this.previousRaw = x;
      return this.xFilter.filter(x, 1);
    }

    const period = Math.max(t - this.previousTime, 1e-3);
    const dx = (x - this.previousRaw) / period;
    const edx = this.dxFilter.filter(dx, smoothingFactor(period, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const result = this.xFilter.filter(x, smoothingFactor(period, cutoff));

    this.previousTime = t;
    this.previousRaw = x;
    return result;
  }

  /** Reinicia el estado interno (p. ej., al cambiar de gesto o perder la mano). */
  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.previousTime = null;
    this.previousRaw = null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Rechazo de saltos bruscos (valores atípicos de seguimiento)                */
/* -------------------------------------------------------------------------- */

/**
 * Descarta saltos de posición físicamente implausibles entre fotogramas.
 *
 * El seguimiento de la mano puede producir, durante uno o varios fotogramas,
 * una posición errónea de la punta del dedo (p. ej., por desenfoque o por un
 * dedo escorzado) que luego "regresa" a su sitio. Los filtros de suavizado no
 * lo corrigen porque, al ser un cambio rápido, los diseñados para seguir el
 * movimiento lo dejan pasar.
 *
 * Mientras un punto exceda el límite de desplazamiento, se mantiene la última
 * posición válida. Si el punto nuevo persiste de forma consistente durante
 * `confirmFrames` fotogramas, se considera un desplazamiento real y se acepta.
 */
export class JumpRejector {
  /**
   * @param {object} [options]
   * @param {number} [options.confirmFrames=4] Fotogramas consecutivos y coherentes para aceptar un salto.
   * @param {number} [options.frameMs=33.3] Duración nominal de un fotograma (ms).
   * @param {number} [options.maxFrameScale=3] Máximo de fotogramas nominales que amplían el límite si hubo retraso.
   */
  constructor({ confirmFrames = 4, frameMs = 1000 / 30, maxFrameScale = 3 } = {}) {
    this.confirmFrames = confirmFrames;
    this.frameMs = frameMs;
    this.maxFrameScale = maxFrameScale;
    this.reset();
  }

  /** Olvida el estado (p. ej., al perder la mano o cambiar de gesto). */
  reset() {
    this.last = null; // Última posición aceptada
    this.pending = null; // Posición candidata tras un salto
    this.count = 0; // Fotogramas coherentes con la candidata
    this.time = null; // Instante del fotograma anterior (ms)
  }

  /**
   * @param {{x:number,y:number}} p Posición medida.
   * @param {number} t Instante de la medición (ms).
   * @param {number} limit Desplazamiento máximo plausible por fotograma nominal (px).
   * @returns {{x:number,y:number}} Posición aceptada (la medida o la última válida).
   */
  filter(p, t, limit) {
    if (!this.last) {
      this.last = p;
      this.time = t;
      return p;
    }

    // Si hubo retraso entre fotogramas, el desplazamiento plausible es mayor.
    const frames = Math.min(Math.max((t - this.time) / this.frameMs, 1), this.maxFrameScale);
    this.time = t;

    if (Math.hypot(p.x - this.last.x, p.y - this.last.y) <= limit * frames) {
      this.last = p;
      this.pending = null;
      this.count = 0;
      return p;
    }

    // Salto sospechoso: se cuenta cuántos fotogramas seguidos coinciden en el nuevo sitio.
    const coherent =
      this.pending && Math.hypot(p.x - this.pending.x, p.y - this.pending.y) <= limit * frames;
    this.count = coherent ? this.count + 1 : 1;
    this.pending = p;

    if (this.count >= this.confirmFrames) {
      this.last = p;
      this.pending = null;
      this.count = 0;
      return p;
    }
    return this.last;
  }
}
