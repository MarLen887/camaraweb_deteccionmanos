/**
 * app.js · AirCanvas
 * -----------------------------------------------------------------------------
 * Aplicación web que muestra la cámara en tiempo real y permite dibujar con
 * gestos de la mano. La detección de manos se realiza con MediaPipe Hand
 * Landmarker (@mediapipe/tasks-vision) directamente en el navegador.
 *
 * Flujo general por cada fotograma de video:
 *   1. detectForVideo() → 21 landmarks de la mano.
 *   2. Se espeja la coordenada X (la vista es tipo espejo) y se escala a píxeles.
 *   3. classifyGesture() → DRAW / MOVE / ERASE / PAUSE / NONE.
 *   4. Un gesto debe mantenerse STABLE_FRAMES fotogramas para ser aceptado.
 *   5. El punto de trabajo (punta del índice o centro de la palma) se suaviza
 *      con un filtro 1€ y se usa para trazar, borrar o seleccionar botones.
 */

import {
  GESTURE,
  HAND_CONNECTIONS,
  JumpRejector,
  LazyLeash,
  OneEuroFilter,
  classifyGesture,
  fingertip,
  palmCenter,
} from "./gestures.js?v=13";
import { createSignsUI } from "./signs-ui.js?v=13";
import { createEmojiUI } from "./emoji-ui.js?v=13";

/* ========================================================================== */
/*  Configuración                                                              */
/* ========================================================================== */

const MEDIAPIPE_VERSION = "0.10.14";
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Paleta de colores. */
const COLORS = [
  { name: "Negro", value: "#111827" },
  { name: "Blanco", value: "#ffffff" },
  { name: "Rojo", value: "#ef4444" },
  { name: "Naranja", value: "#f97316" },
  { name: "Amarillo", value: "#facc15" },
  { name: "Verde", value: "#22c55e" },
  { name: "Cian", value: "#06b6d4" },
  { name: "Azul", value: "#3b82f6" },
  { name: "Violeta", value: "#8b5cf6" },
  { name: "Rosa", value: "#ec4899" },
];

/** Tamaños de pincel (grosor en píxeles sobre un lienzo de referencia de 1280 px). */
const BRUSHES = [
  { name: "Fino", value: 4 },
  { name: "Medio", value: 10 },
  { name: "Grueso", value: 20 },
  { name: "Extra grueso", value: 36 },
];

const REF_SIZE = 1280; // Resolución de referencia para escalar los grosores.
const STABLE_FRAMES = 3; // Fotogramas consecutivos para aceptar un cambio de gesto.
const LEAVE_FRAMES = 5; // Fotogramas para SALIR de dibujar/borrar (más tolerante: evita cortes por parpadeo).
const HAND_LOST_MS = 450; // Tiempo sin mano antes de cortar el trazo; si reaparece antes, el trazo continúa.
const NO_HAND_HINT_MS = 2000; // Tiempo sin mano tras el cual se muestra la sugerencia de distancia.
const DETECTION_CONFIDENCE = 0.5; // Umbral de MediaPipe (valor por defecto): menor = más alcance, pero más "saltos".
const JUMP_RATIO = 0.08; // Desplazamiento máximo plausible por fotograma, como fracción del lado mayor del lienzo.
const JUMP_CONFIRM_FRAMES = 4; // Fotogramas coherentes para aceptar un desplazamiento brusco como real.
const DWELL_MS = 800; // Tiempo de permanencia para activar un botón con gestos.
const MIN_POINT_DISTANCE = 1.5; // Distancia mínima (px) entre puntos de un trazo.
const DEFAULT_COLOR = 7; // Azul
const DEFAULT_BRUSH = 1; // Medio

/** Textos que se muestran para cada estado de gesto. */
const GESTURE_INFO = {
  idle: {
    icon: "📷",
    name: "Cámara apagada",
    desc: "Inicia la cámara para comenzar a dibujar.",
  },
  nohand: {
    icon: "🔍",
    name: "Buscando mano…",
    desc: "Muestra tu mano frente a la cámara, con buena iluminación.",
  },
  [GESTURE.DRAW]: {
    icon: "☝️",
    name: "Dibujando",
    desc: "El trazo sigue la punta de tu dedo índice.",
  },
  [GESTURE.MOVE]: {
    icon: "✌️",
    name: "Mover cursor",
    desc: "Sin dibujar. Mantén el cursor sobre un botón de la paleta para activarlo.",
  },
  [GESTURE.ERASE]: {
    icon: "🖐️",
    name: "Borrando",
    desc: "Pasa la palma abierta sobre lo que quieras borrar.",
  },
  [GESTURE.PAUSE]: {
    icon: "✊",
    name: "Pausa",
    desc: "Puño cerrado: no se dibuja ni se borra.",
  },
  [GESTURE.NONE]: {
    icon: "❔",
    name: "Gesto no reconocido",
    desc: "Consulta la guía de gestos y ajusta la posición de tus dedos.",
  },
};

/* ========================================================================== */
/*  Referencias al DOM                                                         */
/* ========================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  stageWrap: $("stageWrap"),
  stage: $("stage"),
  video: $("video"),
  drawCanvas: $("drawCanvas"),
  overlayCanvas: $("overlayCanvas"),
  emptyState: $("emptyState"),
  errorText: $("errorText"),
  hud: $("hud"),
  hudIcon: $("hudIcon"),
  hudText: $("hudText"),
  hudFps: $("hudFps"),
  status: $("status"),
  statusText: $("statusText"),
  btnCamera: $("btnCamera"),
  btnCameraLabel: $("btnCameraLabel"),
  btnStart: $("btnStart"),
  btnFullscreen: $("btnFullscreen"),
  dock: $("dock"),
  colorGroup: $("colorGroup"),
  brushGroup: $("brushGroup"),
  btnEraser: $("btnEraser"),
  btnUndo: $("btnUndo"),
  btnClear: $("btnClear"),
  btnSave: $("btnSave"),
  gestureLive: $("gestureLive"),
  glIcon: $("glIcon"),
  glName: $("glName"),
  glDesc: $("glDesc"),
  bgGroup: $("bgGroup"),
  smooth: $("smooth"),
  smoothOut: $("smoothOut"),
  chkSkeleton: $("chkSkeleton"),
  toast: $("toast"),
  modeTabs: document.querySelectorAll("#modeTabs [data-mode]"),
};

const dctx = el.drawCanvas.getContext("2d");
const octx = el.overlayCanvas.getContext("2d");

/** Modo "Señas (LSM)": reconocimiento del alfabeto y formación de palabras (ver signs-ui.js). */
const signs = createSignsUI({
  showToast: (msg, ms) => showToast(msg, ms),
  isCameraRunning: () => state.running,
});

/** Modo "Emojis": gestos de una o dos manos → emoji (ver emoji-ui.js). */
const emojis = createEmojiUI({
  showToast: (msg, ms) => showToast(msg, ms),
  isCameraRunning: () => state.running,
});

/* ========================================================================== */
/*  Estado                                                                     */
/* ========================================================================== */

const state = {
  size: { w: 1280, h: 720 }, // Resolución interna de los lienzos (= resolución del video)
  stream: null,
  landmarker: null,
  running: false,
  starting: false,
  rafId: 0,
  lastVideoTime: -1,
  detectionErrors: 0,

  colorIndex: DEFAULT_COLOR,
  brushIndex: DEFAULT_BRUSH,
  tool: "draw", // "draw" | "erase" (borrador seleccionado manualmente)
  bg: "camera", // "camera" | "light" | "dark"
  showSkeleton: false,
  mode: "draw", // "draw" | "signs" | "emoji"

  strokes: [], // Trazos con puntos normalizados [0..1] (independientes de la resolución)
  backup: null, // Trazos previos a "Limpiar", para poder restaurarlos
  current: null, // Trazo en curso

  gesture: null, // Gesto aceptado (estable)
  candidate: null, // Gesto candidato (aún sin estabilizar)
  candidateFrames: 0,
  lastSeen: 0, // Instante (ms) del último fotograma con mano detectada
  hintShown: false, // true mientras se muestra la sugerencia "aleja la mano"
  cursor: null, // Punto suavizado en píxeles del lienzo
  viaGesture: false, // true mientras un botón se activa por gestos

  fps: { frames: 0, t0: 0 },
  leashRatio: 0, // Radio de la correa como fracción del lado mayor del lienzo (según el control de suavizado)
};

// beta bajo: en píxeles, el temblor de la mano quieta parece "movimiento rápido" y abriría el filtro.
const filterX = new OneEuroFilter({ minCutoff: 1.35, beta: 0.002, dCutoff: 1 });
const filterY = new OneEuroFilter({ minCutoff: 1.35, beta: 0.002, dCutoff: 1 });
const leash = new LazyLeash();
const jumpGate = new JumpRejector({ confirmFrames: JUMP_CONFIRM_FRAMES });

/** Reinicia todo el seguimiento del cursor (filtros y rechazo de saltos). */
function resetCursorTracking() {
  filterX.reset();
  filterY.reset();
  jumpGate.reset();
  leash.reset();
}

/** Factor de escala de grosores respecto a la resolución de referencia. */
const scale = () => Math.max(state.size.w, state.size.h) / REF_SIZE;

/* ========================================================================== */
/*  Utilidades de interfaz                                                     */
/* ========================================================================== */

let toastTimer = 0;

function showToast(message, ms = 2200) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
}

/** Muestra un aviso solo cuando la acción se activó mediante gestos. */
function notifyIfGesture(message) {
  if (state.viaGesture) showToast(message);
}

function setStatus(kind, text) {
  el.status.dataset.state = kind;
  el.statusText.textContent = text;
}

function updateGestureUI(key) {
  state.hintShown = false;
  const info = GESTURE_INFO[key] ?? GESTURE_INFO.idle;
  el.gestureLive.dataset.gesture = key;
  el.glIcon.textContent = info.icon;
  el.glName.textContent = info.name;
  el.glDesc.textContent = info.desc;
  el.hudIcon.textContent = info.icon;
  el.hudText.textContent = info.name;
}

function showError(message) {
  el.errorText.textContent = message;
  el.errorText.hidden = false;
  el.emptyState.hidden = false;
  setStatus("error", "Error");
}

function describeError(err) {
  if (err?.userMessage) return err.userMessage;
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permiso de cámara denegado. Habilítalo en la configuración del navegador (icono del candado junto a la dirección) y vuelve a intentarlo.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No se encontró ninguna cámara disponible en este dispositivo.";
    case "NotReadableError":
      return "No fue posible acceder a la cámara: es posible que otra aplicación la esté utilizando.";
    default:
      return `No fue posible iniciar la aplicación (${err?.message ?? "error desconocido"}).`;
  }
}

function withUserMessage(err, userMessage) {
  const error = err instanceof Error ? err : new Error(String(err));
  error.userMessage = userMessage;
  return error;
}

/* ========================================================================== */
/*  Dimensionado del escenario                                                 */
/* ========================================================================== */

/**
 * Ajusta el escenario a la relación de aspecto del video, de modo que las
 * coordenadas normalizadas de MediaPipe coincidan exactamente con lo que se ve
 * (sin recortes por object-fit).
 */
function fitStage() {
  const { w: vw, h: vh } = state.size;
  const aspect = vw / vh;
  const stacked = window.matchMedia("(max-width: 960px)").matches && !document.fullscreenElement;
  const cw = el.stageWrap.clientWidth;
  const ch = el.stageWrap.clientHeight;

  let width = cw;
  let height = width / aspect;
  if (!stacked && ch > 0 && height > ch) {
    height = ch;
    width = height * aspect;
  }
  el.stage.style.width = `${Math.floor(width)}px`;
  el.stage.style.height = `${Math.floor(height)}px`;
}

function setCanvasSize(w, h) {
  if (state.size.w === w && state.size.h === h && el.drawCanvas.width === w) return;
  state.size = { w, h };
  for (const canvas of [el.drawCanvas, el.overlayCanvas]) {
    canvas.width = w;
    canvas.height = h;
  }
  redrawAll();
}

/* ========================================================================== */
/*  Dibujo (trazos)                                                            */
/* ========================================================================== */

/** Pinta el punto i de un trazo (un círculo si es el primero; si no, un segmento). */
function paintPoint(ctx, stroke, i) {
  const { w, h } = state.size;
  const width = stroke.size * scale();
  const p = stroke.pts[i];

  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.fillStyle = stroke.erase ? "#000" : stroke.color;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.beginPath();
  if (i === 0) {
    ctx.arc(p.x * w, p.y * h, width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const q = stroke.pts[i - 1];
    ctx.moveTo(q.x * w, q.y * h);
    ctx.lineTo(p.x * w, p.y * h);
    ctx.stroke();
  }
  ctx.restore();
}

function redrawAll() {
  dctx.clearRect(0, 0, state.size.w, state.size.h);
  for (const stroke of state.strokes) {
    for (let i = 0; i < stroke.pts.length; i++) paintPoint(dctx, stroke, i);
  }
}

const normalize = (p) => ({ x: p.x / state.size.w, y: p.y / state.size.h });

function beginStroke(spec, p) {
  state.backup = null; // Un trazo nuevo invalida la restauración tras "Limpiar"
  state.current = {
    color: COLORS[state.colorIndex].value,
    size: spec.size,
    erase: spec.erase,
    pts: [normalize(p)],
  };
  state.strokes.push(state.current);
  paintPoint(dctx, state.current, 0);
}

function extendStroke(p) {
  const stroke = state.current;
  const last = stroke.pts[stroke.pts.length - 1];
  const next = normalize(p);
  const moved = Math.hypot((next.x - last.x) * state.size.w, (next.y - last.y) * state.size.h);
  if (moved < MIN_POINT_DISTANCE) return;
  stroke.pts.push(next);
  paintPoint(dctx, stroke, stroke.pts.length - 1);
}

function endStroke() {
  state.current = null;
}

/** Parámetros del trazo según el gesto activo (null si el gesto no dibuja). */
function strokeSpec(gesture) {
  const brush = BRUSHES[state.brushIndex].value;
  if (gesture === GESTURE.ERASE) return { erase: true, size: Math.max(brush * 4, 80) };
  if (gesture === GESTURE.DRAW) {
    return state.tool === "erase"
      ? { erase: true, size: Math.max(brush * 2, 24) }
      : { erase: false, size: brush };
  }
  return null;
}

function undo() {
  endStroke();
  if (state.strokes.length) {
    state.strokes.pop();
    redrawAll();
    showToast("Trazo deshecho");
  } else if (state.backup) {
    state.strokes = state.backup;
    state.backup = null;
    redrawAll();
    showToast("Dibujo restaurado");
  } else {
    showToast("No hay nada que deshacer");
  }
}

function clearAll() {
  endStroke();
  if (!state.strokes.length) {
    showToast("El lienzo ya está vacío");
    return;
  }
  state.backup = state.strokes;
  state.strokes = [];
  redrawAll();
  showToast("Lienzo limpiado · usa Deshacer para restaurarlo");
}

function saveImage() {
  const { w, h } = state.size;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");

  if (state.bg === "camera" && state.running && el.video.readyState >= 2) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1); // Misma vista espejo que se observa en pantalla
    ctx.drawImage(el.video, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = { light: "#f8fafc", dark: "#0b1020", camera: "#05070f" }[state.bg];
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(el.drawCanvas, 0, 0);

  out.toBlob((blob) => {
    if (!blob) {
      showToast("No se pudo generar la imagen");
      return;
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dibujo-${stamp}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Imagen guardada (PNG)");
  }, "image/png");
}

/* ========================================================================== */
/*  Paleta y herramientas                                                      */
/* ========================================================================== */

function buildDock() {
  COLORS.forEach((color, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dock-btn swatch";
    btn.style.setProperty("--c", color.value);
    btn.dataset.dwell = "";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-label", `Color ${color.name}`);
    btn.title = color.name;
    btn.addEventListener("click", () => selectColor(i));
    el.colorGroup.append(btn);
  });

  BRUSHES.forEach((brush, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dock-btn brush";
    btn.dataset.dwell = "";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-label", `Pincel ${brush.name.toLowerCase()}`);
    btn.title = `${brush.name} (${i + 1})`;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.setProperty("--dot", `${Math.round(3 + brush.value * 0.58)}px`);
    btn.append(dot);
    btn.addEventListener("click", () => selectBrush(i));
    el.brushGroup.append(btn);
  });
}

function refreshDock() {
  el.colorGroup.querySelectorAll(".swatch").forEach((btn, i) => {
    btn.setAttribute("aria-checked", String(i === state.colorIndex));
  });
  el.brushGroup.querySelectorAll(".brush").forEach((btn, i) => {
    btn.setAttribute("aria-checked", String(i === state.brushIndex));
  });
  el.btnEraser.setAttribute("aria-pressed", String(state.tool === "erase"));
  el.dock.style.setProperty("--active-color", COLORS[state.colorIndex].value);
}

function selectColor(i) {
  endStroke();
  state.colorIndex = i;
  state.tool = "draw"; // Elegir un color vuelve al modo de dibujo
  refreshDock();
  notifyIfGesture(`Color: ${COLORS[i].name}`);
}

function selectBrush(i) {
  endStroke();
  state.brushIndex = i;
  refreshDock();
  notifyIfGesture(`Pincel: ${BRUSHES[i].name}`);
}

function toggleEraser() {
  endStroke();
  state.tool = state.tool === "erase" ? "draw" : "erase";
  refreshDock();
  showToast(state.tool === "erase" ? "Borrador activado" : "Modo dibujo activado");
}

function setBackground(bg) {
  state.bg = bg;
  el.stage.dataset.bg = bg;
  el.bgGroup.querySelectorAll("[data-bg]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.bg === bg));
  });
}

function applySmoothing() {
  const v = Number(el.smooth.value);
  // Escala geométrica: 0 → 6 Hz (poco suavizado) · 100 → 0.4 Hz (mucho suavizado)
  const minCutoff = 6 * Math.pow(0.4 / 6, v / 100);
  filterX.minCutoff = minCutoff;
  filterY.minCutoff = minCutoff;
  state.leashRatio = (v / 100) * 0.014; // 0 → sin correa · 55 → ≈10 px · 100 → ≈18 px (en 1280 px)
  el.smoothOut.textContent = v < 34 ? "Bajo" : v < 67 ? "Medio" : "Alto";
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (el.stageWrap.requestFullscreen) {
      await el.stageWrap.requestFullscreen();
    } else if (el.stageWrap.webkitRequestFullscreen) {
      el.stageWrap.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn("Pantalla completa no disponible:", err);
    showToast("No fue posible activar la pantalla completa");
  }
}

/* ========================================================================== */
/*  Selección por gestos (permanencia sobre un botón)                          */
/* ========================================================================== */

const dwell = { target: null, start: 0, fired: false };

function setDwellTarget(next, now) {
  if (dwell.target === next) return;
  if (dwell.target) {
    dwell.target.classList.remove("is-hover");
    dwell.target.style.setProperty("--dwell", "0");
  }
  dwell.target = next;
  dwell.start = now;
  dwell.fired = false;
  if (next) next.classList.add("is-hover");
}

const clearDwell = () => setDwellTarget(null, 0);

function updateDwell(now) {
  let target = null;
  if (state.gesture === GESTURE.MOVE && state.cursor) {
    const rect = el.stage.getBoundingClientRect();
    const x = rect.left + (state.cursor.x / state.size.w) * rect.width;
    const y = rect.top + (state.cursor.y / state.size.h) * rect.height;
    target = document.elementFromPoint(x, y)?.closest("[data-dwell]") ?? null;
  }

  setDwellTarget(target, now);
  if (!target || dwell.fired) return;

  const progress = Math.min((now - dwell.start) / DWELL_MS, 1);
  target.style.setProperty("--dwell", String(progress));
  if (progress >= 1) {
    dwell.fired = true; // No se repite hasta que el cursor salga del botón
    state.viaGesture = true;
    try {
      target.click();
    } finally {
      state.viaGesture = false;
    }
  }
}

/* ========================================================================== */
/*  Procesamiento de cada fotograma                                            */
/* ========================================================================== */

function setGesture(next) {
  if (state.gesture === next) return;
  endStroke();
  state.gesture = next;
  resetCursorTracking(); // El punto de anclaje cambia (índice ↔ palma): se reinicia el seguimiento
  updateGestureUI(next);
}

function handleHandLost(nowMs) {
  // Se concede un margen: si la mano reaparece pronto, el trazo sigue sin cortarse.
  if (state.gesture === null || nowMs - state.lastSeen < HAND_LOST_MS) return;

  endStroke();
  clearDwell();
  resetCursorTracking();
  state.gesture = null;
  state.candidate = null;
  state.candidateFrames = 0;
  state.cursor = null;
  updateGestureUI("nohand");
}

/**
 * Si pasan unos segundos sin detectar la mano, sugiere la causa más común:
 * el modelo necesita ver la palma completa, por lo que acercar demasiado la
 * mano a la cámara (o dejarla en el borde del cuadro) impide la detección.
 */
function maybeShowDistanceHint(nowMs) {
  if (state.gesture !== null || state.hintShown || nowMs - state.lastSeen < NO_HAND_HINT_MS) return;
  state.hintShown = true;
  el.glIcon.textContent = "↔️";
  el.glName.textContent = "No se detecta la mano";
  el.glDesc.textContent =
    "Aleja la mano hasta que se vea completa (palma, dedos y muñeca), a unos 40–80 cm, con buena luz y sin recortarla en los bordes.";
  el.hudIcon.textContent = "↔️";
  el.hudText.textContent = "Aleja la mano";
}

function processFrame(result, nowMs) {
  if (state.mode === "emoji") {
    // Hasta dos manos, en píxeles y vista espejo
    const { w, h } = state.size;
    const hands = (result?.landmarks ?? []).map((lm) => lm.map((p) => ({ x: (1 - p.x) * w, y: p.y * h })));
    if (hands.length) state.lastSeen = nowMs;
    emojis.processHands(hands, nowMs);
    octx.clearRect(0, 0, w, h);
    if (state.showSkeleton) for (const pts of hands) drawSkeleton(pts); // oculto por defecto
    return;
  }
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) {
    if (state.mode === "signs") {
      signs.processNoHand(nowMs);
      renderOverlay(null);
      return;
    }
    handleHandLost(nowMs);
    maybeShowDistanceHint(nowMs);
    renderOverlay(null);
    return;
  }
  state.lastSeen = nowMs;

  // Vista espejo: X invertida; coordenadas en píxeles (escala isotrópica).
  const { w, h } = state.size;
  const pts = landmarks.map((p) => ({ x: (1 - p.x) * w, y: p.y * h }));

  if (state.mode === "signs") {
    // z de MediaPipe usa aproximadamente la misma escala que x (normalizada por el ancho)
    signs.processHand(
      landmarks.map((p) => ({ x: (1 - p.x) * w, y: p.y * h, z: p.z * w })),
      nowMs,
    );
    renderOverlay(pts);
    return;
  }

  // Estabilización del gesto (anti-parpadeo)
  const raw = classifyGesture(pts);
  if (raw === state.candidate) {
    state.candidateFrames++;
  } else {
    state.candidate = raw;
    state.candidateFrames = 1;
  }
  // Histéresis: entrar a un gesto exige STABLE_FRAMES; salir de dibujar/borrar exige más.
  const needed =
    state.gesture === GESTURE.DRAW || state.gesture === GESTURE.ERASE ? LEAVE_FRAMES : STABLE_FRAMES;
  if (raw !== state.gesture && state.candidateFrames >= needed) setGesture(raw);

  // Punto de trabajo suavizado
  // Los saltos bruscos de un solo fotograma (errores de seguimiento) se descartan antes de suavizar.
  const measured = state.gesture === GESTURE.ERASE ? palmCenter(pts) : fingertip(pts);
  const anchor = jumpGate.filter(measured, nowMs, JUMP_RATIO * Math.max(w, h));
  const t = nowMs / 1000;
  // Se limita al lienzo: con la mano en el borde, MediaPipe puede estimar puntos fuera del cuadro.
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  const smoothed = {
    x: clamp(filterX.filter(anchor.x, t), w),
    y: clamp(filterY.filter(anchor.y, t), h),
  };
  // Correa: con la mano quieta, el temblor dentro del radio no mueve el cursor.
  state.cursor = leash.filter(smoothed, state.leashRatio * Math.max(w, h));

  // Solo se traza cuando el fotograma coincide con el gesto aceptado: durante
  // las transiciones se "congela" el trazo para evitar garabatos al cambiar de gesto.
  if (raw === state.gesture) {
    const spec = strokeSpec(state.gesture);
    if (!spec) endStroke();
    else if (!state.current) beginStroke(spec, state.cursor);
    else extendStroke(state.cursor);
  }

  updateDwell(nowMs);
  renderOverlay(pts);
}

/* ========================================================================== */
/*  Capa superior (cursor y esqueleto)                                         */
/* ========================================================================== */

function renderOverlay(pts) {
  octx.clearRect(0, 0, state.size.w, state.size.h);
  if (!pts) return;
  if (state.mode === "signs") {
    if (state.showSkeleton) drawSkeleton(pts); // oculto por defecto
    drawSignTag(pts);
    return;
  }
  if (state.showSkeleton) drawSkeleton(pts);
  if (state.cursor) drawCursor(state.cursor);
}

/** Recuadro alrededor de la mano con la letra reconocida y su confianza. */
function drawSignTag(pts) {
  const info = signs.getOverlay();
  const s = scale();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 14 * s;
  const x = minX - pad;
  const y = minY - pad;
  const recognized = Boolean(info?.label);

  octx.save();
  // El recuadro punteado se eliminó: solo se muestra la etiqueta con la letra reconocida.

  if (recognized) {
    const text = `${signs.symbolFor(info.label)}  ${Math.round(info.confidence * 100)} %`;
    octx.font = `800 ${26 * s}px ${getComputedStyle(document.body).fontFamily}`;
    octx.textBaseline = "middle";
    const chipW = octx.measureText(text).width + 24 * s;
    const chipH = 40 * s;
    const cx = Math.min(Math.max(x, 4 * s), state.size.w - chipW - 4 * s);
    const cy = Math.max(4 * s, y - chipH - 6 * s);
    octx.setLineDash([]);
    octx.fillStyle = "#22d3ee";
    octx.beginPath();
    if (octx.roundRect) octx.roundRect(cx, cy, chipW, chipH, 12 * s);
    else octx.rect(cx, cy, chipW, chipH);
    octx.fill();
    octx.fillStyle = "#04121a";
    octx.fillText(text, cx + 12 * s, cy + chipH / 2 + 1 * s);
  }
  octx.restore();
}

/** Cambia entre el modo Dibujo y el modo Señas (la cámara sigue encendida). */
function setMode(mode) {
  if (state.mode === mode) return;
  endStroke();
  clearDwell();
  resetCursorTracking();
  Object.assign(state, { gesture: null, candidate: null, candidateFrames: 0, cursor: null });
  state.mode = mode;
  document.body.dataset.mode = mode;
  el.stage.dataset.mode = mode;
  el.modeTabs.forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.mode === mode)));
  signs.setActive(mode === "signs");
  emojis.setActive(mode === "emoji");
  // Dos manos solo se detectan en el modo Emojis (en los demás se mantiene 1 por rendimiento)
  try {
    state.landmarker?.setOptions({ numHands: mode === "emoji" ? 2 : 1 });
  } catch (err) {
    console.warn("No se pudo cambiar numHands", err);
  }
  octx.clearRect(0, 0, state.size.w, state.size.h);
  updateGestureUI(state.running ? "nohand" : "idle");
  showToast({ signs: "Modo Señas (LSM)", emoji: "Modo Emojis", draw: "Modo Dibujo" }[mode]);
}

function drawSkeleton(pts) {
  const s = scale();
  octx.save();
  octx.lineCap = "round";
  octx.lineWidth = 2 * s;
  octx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  octx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    octx.moveTo(pts[a].x, pts[a].y);
    octx.lineTo(pts[b].x, pts[b].y);
  }
  octx.stroke();
  octx.fillStyle = "#22d3ee";
  for (const p of pts) {
    octx.beginPath();
    octx.arc(p.x, p.y, 3.2 * s, 0, Math.PI * 2);
    octx.fill();
  }
  octx.restore();
}

/** Dibuja un círculo con doble contorno (oscuro + claro) legible sobre cualquier fondo. */
function ring(x, y, radius, { fill, dash = [], width = 2 } = {}) {
  const s = scale();
  octx.save();
  octx.setLineDash(dash.map((d) => d * s));
  octx.beginPath();
  octx.arc(x, y, radius, 0, Math.PI * 2);
  if (fill) {
    octx.fillStyle = fill;
    octx.fill();
  }
  octx.lineWidth = (width + 2) * s;
  octx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  octx.stroke();
  octx.lineWidth = width * s;
  octx.strokeStyle = "#ffffff";
  octx.stroke();
  octx.restore();
}

/**
 * Mira tipo videojuego (círculo + cuatro marcas en cruz + punto central) para
 * el modo de selección. Se traza con doble contorno (oscuro + claro) para que
 * sea legible sobre cualquier fondo, y se tiñe de cian al apuntar a un botón.
 */
function drawCrosshair(x, y, active) {
  const s = scale();
  const r = 15 * s; // radio del círculo
  const outer = 27 * s; // extremo exterior de las marcas
  const inner = 6 * s; // extremo interior de las marcas (deja hueco en el centro)
  const main = active ? "#22d3ee" : "#ffffff";

  const tracePath = () => {
    octx.beginPath();
    octx.arc(x, y, r, 0, Math.PI * 2);
    octx.moveTo(x, y - outer);
    octx.lineTo(x, y - inner);
    octx.moveTo(x, y + inner);
    octx.lineTo(x, y + outer);
    octx.moveTo(x - outer, y);
    octx.lineTo(x - inner, y);
    octx.moveTo(x + inner, y);
    octx.lineTo(x + outer, y);
  };

  octx.save();
  octx.lineCap = "round";
  octx.fillStyle = "rgba(0, 0, 0, 0.12)";
  tracePath();
  octx.lineWidth = 5 * s;
  octx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  octx.stroke();
  octx.lineWidth = 2.4 * s;
  octx.strokeStyle = main;
  octx.stroke();

  // Punto central
  octx.beginPath();
  octx.arc(x, y, 2.6 * s, 0, Math.PI * 2);
  octx.fillStyle = main;
  octx.lineWidth = 1.5 * s;
  octx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  octx.stroke();
  octx.fill();
  octx.restore();
}

/**
 * Lápiz como cursor del modo de dibujo. La punta queda exactamente sobre el
 * punto de trazo y el cuerpo toma el color activo. Alrededor de la punta se
 * dibuja un círculo fino con el grosor real del pincel.
 */
function drawPencil(x, y, brushSize) {
  const s = scale();
  const color = COLORS[state.colorIndex].value;

  ring(x, y, Math.max((brushSize * s) / 2, 2 * s), { width: 1.5 });

  // Piezas del lápiz en coordenadas locales (punta en el origen, apuntando hacia arriba)
  const shapes = [
    { pts: [[0, 0], [-4.5, -13], [4.5, -13]], fill: "#f1d3a5" }, // madera tallada
    { pts: [[0, 0], [-1.8, -5.2], [1.8, -5.2]], fill: color }, // punta (color del trazo)
    { pts: [[-4.5, -13], [4.5, -13], [4.5, -45], [-4.5, -45]], fill: color }, // cuerpo
    { pts: [[-4.5, -45], [4.5, -45], [4.5, -49], [-4.5, -49]], fill: "#cbd5e1" }, // casquillo
    { pts: [[-4.5, -49], [4.5, -49], [4.5, -55], [-4.5, -55]], fill: "#f472b6" }, // goma
  ];
  const silhouette = [[0, 0], [-4.5, -13], [-4.5, -55], [4.5, -55], [4.5, -13]];

  const trace = (pts) => {
    octx.beginPath();
    pts.forEach(([px, py], i) => (i ? octx.lineTo(px, py) : octx.moveTo(px, py)));
    octx.closePath();
  };

  octx.save();
  octx.translate(x, y);
  octx.rotate((35 * Math.PI) / 180); // inclinado hacia la derecha, como al escribir
  octx.scale(s, s);
  octx.lineJoin = "round";

  // Contorno doble (oscuro + claro): legible sobre fondos claros, oscuros o la cámara
  trace(silhouette);
  octx.lineWidth = 4.6;
  octx.strokeStyle = "rgba(0, 0, 0, 0.65)";
  octx.stroke();
  octx.lineWidth = 2.4;
  octx.strokeStyle = "#ffffff";
  octx.stroke();

  for (const { pts, fill } of shapes) {
    trace(pts);
    octx.fillStyle = fill;
    octx.fill();
    octx.lineWidth = 0.8;
    octx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    octx.stroke();
  }
  octx.restore();
}

function drawCursor({ x, y }) {
  const s = scale();
  const spec = strokeSpec(state.gesture);

  switch (state.gesture) {
    case GESTURE.DRAW:
      if (spec?.erase) {
        ring(x, y, (spec.size * s) / 2, { fill: "rgba(255,255,255,0.15)", dash: [6, 5] });
      } else {
        drawPencil(x, y, spec.size);
      }
      break;
    case GESTURE.ERASE:
      ring(x, y, (spec.size * s) / 2, { fill: "rgba(255,255,255,0.15)", dash: [8, 6] });
      break;
    case GESTURE.MOVE:
      drawCrosshair(x, y, Boolean(dwell.target));
      break;
    case GESTURE.PAUSE:
      ring(x, y, 12 * s, { dash: [4, 4] });
      break;
    default:
      ring(x, y, 8 * s, { width: 1.5 });
  }
}

/* ========================================================================== */
/*  Cámara y modelo                                                            */
/* ========================================================================== */

async function loadLandmarker() {
  let vision;
  let fileset;
  try {
    vision = await import(VISION_BUNDLE_URL);
    fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  } catch (err) {
    throw withUserMessage(
      err,
      "No se pudieron descargar los componentes de detección de manos. Verifica tu conexión a Internet e inténtalo de nuevo.",
    );
  }

  const create = (delegate) =>
    vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: state.mode === "emoji" ? 2 : 1,
      minHandDetectionConfidence: DETECTION_CONFIDENCE,
      minHandPresenceConfidence: DETECTION_CONFIDENCE,
      minTrackingConfidence: DETECTION_CONFIDENCE,
    });

  try {
    return await create("GPU");
  } catch (gpuError) {
    console.warn("Delegado GPU no disponible; se usará CPU.", gpuError);
    try {
      return await create("CPU");
    } catch (cpuError) {
      throw withUserMessage(
        cpuError,
        "No se pudo cargar el modelo de detección de manos. Verifica tu conexión a Internet e inténtalo de nuevo.",
      );
    }
  }
}

async function startCamera() {
  if (state.starting || state.running) return;
  state.starting = true;
  el.btnCamera.disabled = true;
  el.btnStart.disabled = true;
  el.errorText.hidden = true;

  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw withUserMessage(
        new Error("Contexto no seguro"),
        "El navegador solo permite usar la cámara en páginas seguras. Abre la aplicación desde https:// o desde http://localhost (no abriendo el archivo directamente).",
      );
    }

    setStatus("loading", "Solicitando acceso a la cámara…");
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    state.stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      stopCamera();
      showError("Se perdió la conexión con la cámara. Vuelve a iniciarla.");
    });

    const metadata = new Promise((resolve) =>
      el.video.addEventListener("loadedmetadata", resolve, { once: true }),
    );
    el.video.srcObject = state.stream;
    await metadata;
    await el.video.play();

    setCanvasSize(el.video.videoWidth, el.video.videoHeight);
    fitStage();

    setStatus("loading", "Cargando modelo de detección…");
    state.landmarker ??= await loadLandmarker();

    // Todo listo: se inicia la detección en tiempo real
    el.emptyState.hidden = true;
    el.hud.hidden = false;
    el.btnCameraLabel.textContent = "Detener cámara";
    el.btnCamera.dataset.active = "true";
    state.running = true;
    state.lastVideoTime = -1;
    state.lastSeen = performance.now();
    state.detectionErrors = 0;
    state.fps = { frames: 0, t0: 0 };
    updateGestureUI("nohand");
    setStatus("live", "En vivo");
    state.rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    stopCamera({ keepStatus: true });
    showError(describeError(err));
  } finally {
    state.starting = false;
    el.btnCamera.disabled = false;
    el.btnStart.disabled = false;
  }
}

function stopCamera({ keepStatus = false } = {}) {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  el.video.srcObject = null;

  endStroke();
  clearDwell();
  resetCursorTracking();
  signs.reset();
  emojis.reset();
  Object.assign(state, { gesture: null, candidate: null, candidateFrames: 0, lastSeen: 0, cursor: null });
  octx.clearRect(0, 0, state.size.w, state.size.h);

  el.hud.hidden = true;
  el.btnCameraLabel.textContent = "Iniciar cámara";
  el.btnCamera.dataset.active = "false";
  updateGestureUI("idle");
  if (!keepStatus) setStatus("off", "Cámara apagada");
}

function tickFps(now) {
  const f = state.fps;
  f.frames++;
  if (!f.t0) f.t0 = now;
  if (now - f.t0 >= 1000) {
    const value = Math.round((f.frames * 1000) / (now - f.t0));
    f.frames = 0;
    f.t0 = now;
    el.hudFps.textContent = `${value} FPS`;
    setStatus("live", `En vivo · ${value} FPS`);
  }
}

function loop() {
  if (!state.running) return;

  const video = el.video;
  if (video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    const now = performance.now();
    try {
      processFrame(state.landmarker.detectForVideo(video, now), now);
      state.detectionErrors = 0;
    } catch (err) {
      console.error("Error durante la detección:", err);
      if (++state.detectionErrors > 30) {
        stopCamera({ keepStatus: true });
        showError("Se produjeron errores repetidos en la detección. Recarga la página e inténtalo de nuevo.");
        return;
      }
    }
    tickFps(now);
  }
  state.rafId = requestAnimationFrame(loop);
}

/* ========================================================================== */
/*  Eventos e inicialización                                                   */
/* ========================================================================== */

function bindEvents() {
  const toggleCamera = () => (state.running ? stopCamera() : startCamera());
  el.btnCamera.addEventListener("click", toggleCamera);
  el.btnStart.addEventListener("click", startCamera);

  el.modeTabs.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

  el.btnEraser.addEventListener("click", toggleEraser);
  el.btnUndo.addEventListener("click", undo);
  el.btnClear.addEventListener("click", clearAll);
  el.btnSave.addEventListener("click", saveImage);

  el.bgGroup.querySelectorAll("[data-bg]").forEach((btn) => {
    btn.addEventListener("click", () => setBackground(btn.dataset.bg));
  });
  el.smooth.addEventListener("input", applySmoothing);
  el.chkSkeleton.addEventListener("change", () => {
    state.showSkeleton = el.chkSkeleton.checked;
  });

  const fullscreenSupported = document.fullscreenEnabled || el.stageWrap.webkitRequestFullscreen;
  if (fullscreenSupported) el.btnFullscreen.addEventListener("click", toggleFullscreen);
  else el.btnFullscreen.hidden = true;

  new ResizeObserver(fitStage).observe(el.stageWrap);
  window.addEventListener("resize", fitStage);
  document.addEventListener("fullscreenchange", fitStage);

  window.addEventListener("keydown", (event) => {
    const key = event.key?.toLowerCase() ?? "";
    if (state.mode !== "draw") {
      // Fuera del modo Dibujo los atajos de dibujo no aplican
      if (key === "f" && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFullscreen();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (/^[1-9]$/.test(key) && Number(key) <= BRUSHES.length) selectBrush(Number(key) - 1);
    else if (key === "z") undo();
    else if (key === "e") toggleEraser();
    else if (key === "s") saveImage();
    else if (key === "f") toggleFullscreen();
    else if (key === "delete") clearAll();
  });

  window.addEventListener("pagehide", () => state.stream?.getTracks().forEach((t) => t.stop()));
}

function init() {
  buildDock();
  refreshDock();
  setCanvasSize(state.size.w, state.size.h);
  applySmoothing();
  updateGestureUI("idle");
  bindEvents();
  fitStage();
}

init();
