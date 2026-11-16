/**
 * emoji.js
 * -----------------------------------------------------------------------------
 * Lógica pura (sin DOM) del modo "Emojis": reconoce gestos de una o dos manos a
 * partir de los 21 landmarks de MediaPipe y los asocia a un emoji.
 *
 * Los gestos se detectan con REGLAS GEOMÉTRICAS (no hay entrenamiento): longitud
 * de los dedos respecto a la muñeca, distancias entre puntas normalizadas por el
 * tamaño de la palma y posición relativa de los puntos. Los umbrales son
 * aproximados y están calibrados con manos sintéticas; con una cámara real puede
 * ser necesario ajustarlos.
 *
 * Gestos de una mano : 👍 👎 ✌️ 👌 ✊ ✋ ☝️ 🤟 🤘 🤙
 * Gestos de dos manos: ❤️ (corazón) 🙏 (manos juntas) 👏 (aplauso) 🙌 (manos arriba)
 *
 * Convención de landmarks (MediaPipe Hands): 0 muñeca · 1-4 pulgar · 5-8 índice ·
 * 9-12 medio · 13-16 anular · 17-20 meñique. Se espera una escala isotrópica
 * (x e y en las mismas unidades, p. ej. píxeles) y el eje y creciendo hacia abajo.
 *
 * Referencia: Zhang et al. (2020), "MediaPipe Hands: On-device real-time hand
 * tracking", arXiv:2006.10214.
 */

import { palmCenter } from "./gestures.js?v=13";

/** Catálogo de emojis reconocidos. `hands` indica con cuántas manos se hace. */
export const EMOJIS = Object.freeze({
  THUMBS_UP: { emoji: "👍", name: "Pulgar arriba", hands: 1, how: "Puño cerrado con el pulgar hacia arriba." },
  THUMBS_DOWN: { emoji: "👎", name: "Pulgar abajo", hands: 1, how: "Puño cerrado con el pulgar hacia abajo." },
  PEACE: { emoji: "✌️", name: "Paz", hands: 1, how: "Índice y medio extendidos y separados; los demás dedos cerrados." },
  OK: { emoji: "👌", name: "OK", hands: 1, how: "Pulgar e índice formando un círculo; medio, anular y meñique extendidos." },
  FIST: { emoji: "✊", name: "Puño", hands: 1, how: "Mano cerrada, con el pulgar recogido." },
  OPEN_HAND: { emoji: "✋", name: "Mano abierta", hands: 1, how: "Los cuatro dedos extendidos (alto o saludo)." },
  POINT_UP: { emoji: "☝️", name: "Índice arriba", hands: 1, how: "Solo el índice extendido, apuntando hacia arriba." },
  LOVE_YOU: { emoji: "🤟", name: "Te quiero", hands: 1, how: "Pulgar, índice y meñique extendidos; medio y anular cerrados." },
  ROCK: { emoji: "🤘", name: "Rock", hands: 1, how: "Índice y meñique extendidos; pulgar, medio y anular cerrados." },
  CALL_ME: { emoji: "🤙", name: "Llámame", hands: 1, how: "Pulgar y meñique extendidos; los otros tres dedos cerrados." },
  HEART: { emoji: "❤️", name: "Corazón", hands: 2, how: "Con ambas manos: pulgares juntos abajo y puntas de los índices juntas arriba." },
  PRAY: { emoji: "🙏", name: "Manos juntas", hands: 2, how: "Palmas abiertas juntas, con los dedos hacia arriba." },
  CLAP: { emoji: "👏", name: "Aplauso", hands: 2, how: "Junte con rapidez las dos palmas abiertas, como al aplaudir." },
  RAISED_HANDS: { emoji: "🙌", name: "Manos arriba", hands: 2, how: "Ambas manos abiertas y separadas, con los dedos hacia arriba." },
});

/** Umbrales (todas las distancias están normalizadas por el tamaño de la palma). */
export const THRESHOLDS = Object.freeze({
  fingerStraight: 0.8, // rectitud mínima (nudillo→punta / longitud de la cadena) de un dedo extendido
  thumbExtended: 0.8, // distancia punta del pulgar–base del índice
  thumbVertical: 0.7, // desnivel del pulgar respecto a los nudillos para "arriba/abajo"
  pinch: 0.45, // distancia pulgar–índice para el gesto OK
  pointUp: 0.8, // altura de la punta del índice sobre la muñeca (☝️)
  fingersUp: 0.8, // altura de la punta del medio sobre la muñeca ("dedos hacia arriba")
  heartTips: 0.6, // distancia máxima entre puntas de pulgares y entre puntas de índices
  heartAbove: 0.4, // las puntas de los índices deben estar así de arriba de las de los pulgares
  heartConverge: 0.8, // los nudillos deben estar más separados que las puntas (manos inclinadas)
  prayCenters: 1.3, // distancia máxima entre centros de palma para "manos juntas"
  prayParallel: 0.5, // diferencia máxima nudillos–puntas (dedos paralelos)
  raisedApart: 2.5, // distancia mínima entre centros de palma para "manos arriba"
  clapFar: 2.2, // distancia desde la que se considera que las manos estaban separadas
  clapNear: 1.3, // distancia a la que se considera que las manos se juntaron
  clapDropNear: 1.8, // si se pierde una mano estando así de cerca tras acercarse, fue el choque
});

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const isHand = (lm) => Array.isArray(lm) && lm.length >= 21;

/** Tamaño de la palma: promedio de muñeca→nudillo medio y nudillo índice→nudillo meñique. */
export function handSize(lm) {
  return (d2(lm[0], lm[9]) + d2(lm[5], lm[17])) / 2;
}

/**
 * Estado del pulgar: extendido o recogido, y si apunta arriba o abajo.
 * Se compara con la línea de los nudillos (el pulgar apunta arriba si su punta
 * queda claramente por encima de ella).
 */
export function thumbInfo(lm) {
  const size = handSize(lm);
  const tip = lm[4];
  const extended = d2(tip, lm[5]) / size > THRESHOLDS.thumbExtended;
  const knuckleY = (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4;
  return {
    extended,
    up: extended && (knuckleY - tip.y) / size > THRESHOLDS.thumbVertical,
    down: extended && (tip.y - knuckleY) / size > THRESHOLDS.thumbVertical,
  };
}

/**
 * Dedos extendidos por RECTITUD: distancia nudillo→punta dividida entre la longitud
 * de la cadena nudillo→PIP→DIP→punta. Un dedo recto da ≈1 aunque la mano esté
 * inclinada hacia la cámara o con los dedos relajados (la proyección de un segmento
 * recto sigue siendo recta), mientras que un dedo doblado da ≈0.2–0.7. A diferencia
 * del cociente punta/PIP respecto a la muñeca, no depende de la distancia a la muñeca.
 * Además se exige que la punta quede más lejos de la muñeca que el PIP.
 */
export function fingersExtended(lm) {
  const wrist = lm[0];
  const chain = ([mcp, pip, dip, tip]) => {
    const length = d2(lm[mcp], lm[pip]) + d2(lm[pip], lm[dip]) + d2(lm[dip], lm[tip]);
    const straight = length > 1e-9 ? d2(lm[mcp], lm[tip]) / length : 0;
    return straight > THRESHOLDS.fingerStraight && d2(lm[tip], wrist) > d2(lm[pip], wrist);
  };
  return {
    index: chain([5, 6, 7, 8]),
    middle: chain([9, 10, 11, 12]),
    ring: chain([13, 14, 15, 16]),
    pinky: chain([17, 18, 19, 20]),
  };
}

/** ¿Están los cuatro dedos (sin el pulgar) extendidos? */
export function isOpenHand(lm) {
  const f = fingersExtended(lm);
  return f.index && f.middle && f.ring && f.pinky;
}

/** ¿Apuntan los dedos hacia arriba? (punta del medio claramente por encima de la muñeca) */
export function fingersPointUp(lm) {
  return (lm[0].y - lm[12].y) / handSize(lm) > THRESHOLDS.fingersUp;
}

/**
 * Clasifica un gesto de UNA mano.
 * @param {{x:number,y:number}[]} lm 21 landmarks.
 * @returns {string|null} Clave de EMOJIS, o null si no coincide con ninguno.
 */
export function classifyHand(lm) {
  if (!isHand(lm)) return null;
  const size = handSize(lm);
  if (!(size > 1e-6)) return null;

  const f = fingersExtended(lm);
  const t = thumbInfo(lm);
  const pinch = d2(lm[4], lm[8]) / size < THRESHOLDS.pinch;

  // 👌 primero: al cerrar el círculo, el índice puede parecer flexionado
  if (pinch && f.middle && f.ring && f.pinky) return "OK";

  const extendedCount = [f.index, f.middle, f.ring, f.pinky].filter(Boolean).length;

  if (extendedCount === 0) {
    if (t.up) return "THUMBS_UP";
    if (t.down) return "THUMBS_DOWN";
    return t.extended ? null : "FIST"; // pulgar a un lado: gesto ambiguo
  }
  if (extendedCount === 4) return "OPEN_HAND";

  if (f.index && !f.middle && !f.ring && !f.pinky) {
    const up = (lm[0].y - lm[8].y) / size > THRESHOLDS.pointUp;
    return !t.extended && up ? "POINT_UP" : null; // con el pulgar fuera sería una "L"
  }
  if (f.index && f.middle && !f.ring && !f.pinky) return "PEACE";
  if (f.index && f.pinky && !f.middle && !f.ring) return t.extended ? "LOVE_YOU" : "ROCK";
  if (!f.index && !f.middle && !f.ring && f.pinky && t.extended) return "CALL_ME";
  return null;
}

/** Distancia entre los centros de palma de dos manos, en tamaños de palma. */
export function palmDistance(a, b) {
  const size = (handSize(a) + handSize(b)) / 2;
  return d2(palmCenter(a), palmCenter(b)) / size;
}

/**
 * Clasifica un gesto de DOS manos estático (el aplauso es un evento: ver EmojiDetector).
 * @returns {string|null} "HEART" | "PRAY" | "RAISED_HANDS" | null
 */
export function classifyTwoHands(a, b) {
  if (!isHand(a) || !isHand(b)) return null;
  const size = (handSize(a) + handSize(b)) / 2;
  if (!(size > 1e-6)) return null;

  const thumbTips = d2(a[4], b[4]) / size;
  const indexTips = d2(a[8], b[8]) / size;
  const knuckles = d2(a[5], b[5]) / size;
  const indexAbove = ((a[4].y - a[8].y) + (b[4].y - b[8].y)) / 2 / size;

  // ❤️ Pulgares juntos abajo, puntas de los índices juntas arriba y manos inclinadas
  // una hacia la otra (los nudillos más separados que las puntas). Esto último lo
  // distingue de unas palmas juntas, donde los dedos son paralelos.
  if (
    thumbTips < THRESHOLDS.heartTips &&
    indexTips < THRESHOLDS.heartTips &&
    indexAbove > THRESHOLDS.heartAbove &&
    knuckles - indexTips > THRESHOLDS.heartConverge
  ) {
    return "HEART";
  }

  if (isOpenHand(a) && isOpenHand(b) && fingersPointUp(a) && fingersPointUp(b)) {
    const apart = palmDistance(a, b);
    if (apart < THRESHOLDS.prayCenters && Math.abs(knuckles - indexTips) < THRESHOLDS.prayParallel) {
      return "PRAY";
    }
    if (apart > THRESHOLDS.raisedApart) return "RAISED_HANDS";
  }
  return null;
}

/**
 * Clasifica el fotograma actual (sin memoria): dos manos primero y, si no
 * coinciden, el gesto de cada mano por separado.
 * @param {{x:number,y:number}[][]} hands
 */
export function classifyFrame(hands) {
  if (hands.length >= 2) {
    const two = classifyTwoHands(hands[0], hands[1]);
    if (two) return two;
  }
  for (const hand of hands.slice(0, 2)) {
    const one = classifyHand(hand);
    if (one) return one;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Detector temporal                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Convierte la secuencia de fotogramas en emojis estables.
 *
 * - Un gesto estático debe mantenerse `holdMs` para activarse (evita destellos).
 * - Un parpadeo menor a `graceMs` no lo desactiva.
 * - 👏 es un EVENTO: dos palmas abiertas que pasan de estar separadas a juntarse
 *   en menos de `clapWindowMs`. Si al juntarse el detector pierde una mano (las
 *   manos se tapan al chocar), también cuenta. El emoji se muestra `clapShowMs`.
 */
export class EmojiDetector {
  constructor({ holdMs = 350, graceMs = 250, clapWindowMs = 700, clapShowMs = 1500, dropMs = 300 } = {}) {
    this.holdMs = holdMs;
    this.graceMs = graceMs;
    this.clapWindowMs = clapWindowMs;
    this.clapShowMs = clapShowMs;
    this.dropMs = dropMs;
    this.reset();
  }

  reset() {
    this.active = null; // Emoji activo
    this.pending = null; // Candidato aún sin estabilizar
    this.pendingSince = 0;
    this.lastMatch = 0; // Último instante en que el fotograma coincidió con `active`
    this.openHistory = []; // [{t, d}] distancias entre palmas abiertas
    this.lastClose = null; // Último instante con las palmas abiertas muy juntas tras acercarse
    this.clapUntil = 0;
  }

  /**
   * @param {{x:number,y:number}[][]} hands Manos detectadas en este fotograma.
   * @param {number} now Instante (ms).
   * @returns {{active:string|null, activated:string|null, instant:string|null}}
   *   `activated` es la clave del emoji que se activó en ESTE fotograma (o null).
   */
  update(hands, now) {
    this._trackClap(hands, now);

    const instant = now < this.clapUntil ? "CLAP" : classifyFrame(hands);
    let activated = null;

    if (instant === "CLAP") {
      if (this.active !== "CLAP") activated = "CLAP";
      this.active = "CLAP";
      this.lastMatch = now;
      this.pending = null;
    } else if (instant !== null && instant === this.active) {
      this.lastMatch = now;
      this.pending = null;
    } else if (instant !== null) {
      if (instant !== this.pending) {
        this.pending = instant;
        this.pendingSince = now;
      }
      if (now - this.pendingSince >= this.holdMs) {
        this.active = instant;
        activated = instant;
        this.lastMatch = now;
        this.pending = null;
      } else if (this.active && now - this.lastMatch > this.graceMs) {
        this.active = null;
      }
    } else {
      this.pending = null;
      if (this.active && now - this.lastMatch > this.graceMs) this.active = null;
    }
    return { active: this.active, activated, instant };
  }

  _trackClap(hands, now) {
    const both = hands.length >= 2 && isOpenHand(hands[0]) && isOpenHand(hands[1]);

    if (both) {
      const d = palmDistance(hands[0], hands[1]);
      this.openHistory.push({ t: now, d });
      while (this.openHistory.length && now - this.openHistory[0].t > this.clapWindowMs) this.openHistory.shift();

      const wasFar = this.openHistory.some((p) => p.d >= THRESHOLDS.clapFar);
      if (wasFar && d <= THRESHOLDS.clapNear) {
        this._clap(now);
      } else if (wasFar && d <= THRESHOLDS.clapDropNear) {
        this.lastClose = now; // se están acercando: si ahora se pierde una mano, fue el choque
      }
    } else if (hands.length < 2) {
      // Al chocar, las manos se tapan y el detector suele perder una o ambas.
      if (this.lastClose !== null) {
        if (now - this.lastClose <= this.dropMs) this._clap(now);
        else this.lastClose = null;
      }
    } else {
      this.lastClose = null; // dos manos, pero no ambas abiertas
    }
  }

  _clap(now) {
    this.clapUntil = now + this.clapShowMs;
    this.lastClose = null;
    this.openHistory = [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Censura de señas obscenas                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ¿Es la seña del "dedo de en medio" (🖕)? Solo el dedo medio extendido; índice,
 * anular y meñique doblados. El pulgar puede estar recogido o a un lado.
 * Es la única seña obscena reconocible solo con la forma de UNA mano: otras
 * (p. ej. el «corte de manga» o «banderazo») dependen del antebrazo, que el
 * modelo de manos no ve.
 */
export function isMiddleFinger(lm) {
  if (!isHand(lm) || !(handSize(lm) > 1e-6)) return false;
  const f = fingersExtended(lm);
  return f.middle && !f.index && !f.ring && !f.pinky;
}

/** Caja que envuelve la mano, con margen proporcional al tamaño de la palma. */
export function handBox(lm, margin = 0.6) {
  const xs = lm.map((p) => p.x);
  const ys = lm.map((p) => p.y);
  const pad = handSize(lm) * margin;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

const inside = (pt, b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;

/**
 * Censor de señas obscenas. Reacciona de inmediato (un solo fotograma) y mantiene
 * la censura `holdMs` tras la última detección para que un parpadeo del detector
 * no deje la seña a la vista. Las manos censuradas se excluyen del reconocimiento
 * de emojis.
 */
export class ObsceneCensor {
  constructor({ holdMs = 600 } = {}) {
    this.holdMs = holdMs;
    this.reset();
  }

  reset() {
    this.zones = []; // [{box, until}]
  }

  /**
   * @param {{x:number,y:number}[][]} hands
   * @param {number} now
   * @returns {{hands: {x:number,y:number}[][], boxes: {x:number,y:number,w:number,h:number}[], triggered: boolean}}
   *   `hands`: las manos NO censuradas; `boxes`: zonas a tapar; `triggered`: hubo una nueva detección.
   */
  update(hands, now) {
    this.zones = this.zones.filter((z) => z.until > now);
    let triggered = false;
    for (const lm of hands) {
      if (!isMiddleFinger(lm)) continue;
      const box = handBox(lm);
      const center = palmCenter(lm);
      // Reemplaza la zona anterior de la misma mano
      const before = this.zones.length;
      this.zones = this.zones.filter((z) => !inside(center, z.box));
      if (before === this.zones.length) triggered = true;
      this.zones.push({ box, until: now + this.holdMs });
    }
    const free = hands.filter((lm) => !this.zones.some((z) => inside(palmCenter(lm), z.box)));
    return { hands: free, boxes: this.zones.map((z) => z.box), triggered };
  }
}
