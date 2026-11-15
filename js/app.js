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
  OneEuroFilter,
  classifyGesture,
  fingertip,
  palmCenter,
} from "./gestures.js";

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
const LOST_FRAMES = 6; // Fotogramas sin mano para considerarla perdida.
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
};

const dctx = el.drawCanvas.getContext("2d");
const octx = el.overlayCanvas.getContext("2d");

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

  strokes: [], // Trazos con puntos normalizados [0..1] (independientes de la resolución)
  backup: null, // Trazos previos a "Limpiar", para poder restaurarlos
  current: null, // Trazo en curso

  gesture: null, // Gesto aceptado (estable)
  candidate: null, // Gesto candidato (aún sin estabilizar)
  candidateFrames: 0,
  lostFrames: 0,
  cursor: null, // Punto suavizado en píxeles del lienzo
  viaGesture: false, // true mientras un botón se activa por gestos

  fps: { frames: 0, t0: 0 },
};

const filterX = new OneEuroFilter({ minCutoff: 1.35, beta: 0.02, dCutoff: 1 });
const filterY = new OneEuroFilter({ minCutoff: 1.35, beta: 0.02, dCutoff: 1 });

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
  filterX.reset(); // El punto de anclaje cambia (índice ↔ palma): se reinicia el filtro
  filterY.reset();
  updateGestureUI(next);
}

function handleHandLost() {
  state.lostFrames++;
  if (state.lostFrames < LOST_FRAMES || state.gesture === null) return;

  endStroke();
  clearDwell();
  filterX.reset();
  filterY.reset();
  state.gesture = null;
  state.candidate = null;
  state.candidateFrames = 0;
  state.cursor = null;
  updateGestureUI("nohand");
}

function processFrame(result, nowMs) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) {
    handleHandLost();
    renderOverlay(null);
    return;
  }
  state.lostFrames = 0;

  // Vista espejo: X invertida; coordenadas en píxeles (escala isotrópica).
  const { w, h } = state.size;
  const pts = landmarks.map((p) => ({ x: (1 - p.x) * w, y: p.y * h }));

  // Estabilización del gesto (anti-parpadeo)
  const raw = classifyGesture(pts);
  if (raw === state.candidate) {
    state.candidateFrames++;
  } else {
    state.candidate = raw;
    state.candidateFrames = 1;
  }
  if (raw !== state.gesture && state.candidateFrames >= STABLE_FRAMES) setGesture(raw);

  // Punto de trabajo suavizado
  const anchor = state.gesture === GESTURE.ERASE ? palmCenter(pts) : fingertip(pts);
  const t = nowMs / 1000;
  state.cursor = { x: filterX.filter(anchor.x, t), y: filterY.filter(anchor.y, t) };

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
  if (state.showSkeleton) drawSkeleton(pts);
  if (state.cursor) drawCursor(state.cursor);
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

function drawCursor({ x, y }) {
  const s = scale();
  const spec = strokeSpec(state.gesture);

  switch (state.gesture) {
    case GESTURE.DRAW:
      if (spec?.erase) {
        ring(x, y, (spec.size * s) / 2, { fill: "rgba(255,255,255,0.15)", dash: [6, 5] });
      } else {
        ring(x, y, Math.max((spec.size * s) / 2, 4 * s) + 1.5 * s, {
          fill: COLORS[state.colorIndex].value,
        });
      }
      break;
    case GESTURE.ERASE:
      ring(x, y, (spec.size * s) / 2, { fill: "rgba(255,255,255,0.15)", dash: [8, 6] });
      break;
    case GESTURE.MOVE:
      ring(x, y, 16 * s, { fill: "rgba(34, 211, 238, 0.25)", width: 3 });
      ring(x, y, 3 * s, { fill: "#ffffff", width: 1 });
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
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
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
  filterX.reset();
  filterY.reset();
  Object.assign(state, { gesture: null, candidate: null, candidateFrames: 0, lostFrames: 0, cursor: null });
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
