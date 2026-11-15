/**
 * signs-ui.js
 * -----------------------------------------------------------------------------
 * Controlador del modo "Señas (LSM)": conecta la lógica de signs.js con la
 * interfaz (entrenamiento, palabra formada, barra de progreso sobre el video).
 *
 * app.js le entrega cada fotograma:
 *   - processHand(pts3, nowMs): landmarks en escala isotrópica {x, y, z}.
 *   - processNoHand(nowMs): no hay mano en el fotograma.
 */

import {
  CONTROL,
  DYNAMIC_LETTERS,
  STATIC_LETTERS,
  SignClassifier,
  WordBuilder,
  crossValidate,
  extractFeatures,
  parseDataset,
  serializeDataset,
} from "./signs.js?v=13";

const STORAGE_KEY = "aircanvas.signs.v1";
const COUNTDOWN_MS = 3000; // Cuenta regresiva antes de grabar
const RECORD_SAMPLES = 40; // Ejemplos por grabación
const RECORD_INTERVAL_MS = 90; // Separación mínima entre ejemplos
const RECOMMENDED_SAMPLES = 30; // Mínimo recomendado por seña
const SMOOTH_WINDOW = 5; // Fotogramas para el voto de mayoría
const SMOOTH_MIN_VOTES = 3;
const NO_HAND_HINT_MS = 2000;

/** Símbolo que se muestra para cada etiqueta. */
export const symbolFor = (label) =>
  label === CONTROL.SPACE ? "␣" : label === CONTROL.BACKSPACE ? "⌫" : (label ?? "–");

const nameFor = (label) =>
  label === CONTROL.SPACE ? "Espacio" : label === CONTROL.BACKSPACE ? "Borrar" : `Letra ${label}`;

/**
 * @param {object} options
 * @param {(msg:string)=>void} options.showToast
 * @param {()=>boolean} options.isCameraRunning
 */
export function createSignsUI({ showToast = () => {}, isCameraRunning = () => true } = {}) {
  const $ = (id) => document.getElementById(id);
  const el = {
    signBar: $("signBar"),
    signRing: $("signRing"),
    signLetter: $("signLetter"),
    signHint: $("signHint"),
    signWord: $("signWord"),
    wordText: $("wordText"),
    btnSpace: $("btnSpace"),
    btnBackspace: $("btnBackspace"),
    btnClearWord: $("btnClearWord"),
    btnCopyWord: $("btnCopyWord"),
    btnSpeak: $("btnSpeak"),
    dynamicRow: $("dynamicRow"),
    trainGrid: $("trainGrid"),
    trainSelected: $("trainSelected"),
    btnRecord: $("btnRecord"),
    btnClearLabel: $("btnClearLabel"),
    recordStatus: $("recordStatus"),
    btnEvaluate: $("btnEvaluate"),
    btnExport: $("btnExport"),
    btnImport: $("btnImport"),
    fileImport: $("fileImport"),
    btnClearAll: $("btnClearAll"),
    evalResult: $("evalResult"),
  };

  const classifier = new SignClassifier();
  const builder = new WordBuilder();

  let active = false;
  let selected = null; // Etiqueta seleccionada para entrenar
  let recording = null; // { label, phase: "countdown"|"recording", t0, take, count, lastAdd, timer }
  let history = []; // Últimas etiquetas (voto de mayoría)
  let overlay = null; // { label, confidence } para dibujar sobre el video
  let lastSeen = 0;
  let takeCounter = Date.now();
  let clearAllArmed = 0;

  /* ----------------------------- Persistencia ----------------------------- */

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { samples } = parseDataset(raw);
      if (samples) classifier.setSamples(samples);
    } catch {
      /* almacenamiento no disponible: se trabaja solo en memoria */
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, serializeDataset(classifier.samples));
    } catch {
      showToast("No se pudo guardar en este navegador. Use «Guardar entrenamiento».", 3500);
    }
  }

  /* ------------------------------- Interfaz ------------------------------- */

  const trainButtons = new Map();

  function buildGrid() {
    for (const label of [...STATIC_LETTERS, CONTROL.SPACE, CONTROL.BACKSPACE]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "train-btn";
      btn.dataset.label = label;
      btn.title = nameFor(label);
      btn.setAttribute("aria-label", nameFor(label));
      const sym = document.createElement("span");
      sym.className = "tb-sym";
      sym.textContent = symbolFor(label);
      const count = document.createElement("span");
      count.className = "tb-count";
      count.textContent = "0";
      btn.append(sym, count);
      btn.addEventListener("click", () => select(label));
      el.trainGrid.append(btn);
      trainButtons.set(label, { btn, count });
    }

    for (const letter of DYNAMIC_LETTERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = letter;
      btn.title = `Insertar la letra ${letter}`;
      btn.addEventListener("click", () => {
        builder.push(letter);
        renderWord();
      });
      el.dynamicRow.append(btn);
    }
  }

  function renderGrid() {
    const counts = classifier.counts();
    for (const [label, { btn, count }] of trainButtons) {
      const n = counts[label] ?? 0;
      count.textContent = String(n);
      btn.dataset.level = n === 0 ? "none" : n < RECOMMENDED_SAMPLES ? "low" : "ok";
      btn.setAttribute("aria-pressed", String(label === selected));
    }
    const hasSelected = selected !== null;
    el.btnRecord.disabled = !hasSelected && !recording;
    el.btnClearLabel.disabled = !hasSelected || !(counts[selected] > 0) || Boolean(recording);
  }

  function select(label) {
    if (recording) return;
    selected = selected === label ? null : label;
    const isControl = selected === CONTROL.SPACE || selected === CONTROL.BACKSPACE;
    el.trainSelected.textContent = selected
      ? isControl
        ? `${symbolFor(selected)}  ${nameFor(selected)}`
        : nameFor(selected)
      : "Seleccione una seña";
    renderGrid();
  }

  let lastWord = null;
  function renderWord() {
    if (builder.text === lastWord) return;
    lastWord = builder.text;
    el.wordText.textContent = builder.text;
    el.signWord.textContent = builder.text || "";
    el.signWord.dataset.empty = String(!builder.text);
  }

  let lastRing = "";
  function renderRing() {
    let letter;
    let progress = 0;
    if (recording?.phase === "countdown") {
      letter = String(Math.max(1, Math.ceil((COUNTDOWN_MS - (performance.now() - recording.t0)) / 1000)));
    } else if (recording) {
      letter = "●";
      progress = recording.count / RECORD_SAMPLES;
    } else {
      letter = symbolFor(builder.candidate);
      progress = builder.progress;
    }
    const key = `${letter}|${progress.toFixed(2)}`;
    if (key === lastRing) return;
    lastRing = key;
    el.signLetter.textContent = letter;
    el.signRing.style.setProperty("--p", progress.toFixed(3));
  }

  function setHint(text) {
    if (el.signHint.textContent !== text) el.signHint.textContent = text;
  }

  function setRecordStatus(text, kind = "") {
    el.recordStatus.textContent = text;
    el.recordStatus.dataset.kind = kind;
  }

  /* ------------------------------ Grabación ------------------------------ */

  function startRecording() {
    if (!selected || recording) return;
    if (!isCameraRunning()) {
      setRecordStatus("Inicie la cámara para grabar ejemplos.", "warn");
      showToast("Inicie la cámara para grabar ejemplos");
      return;
    }
    recording = {
      label: selected,
      phase: "countdown",
      t0: performance.now(),
      take: ++takeCounter,
      count: 0,
      lastAdd: 0,
      timer: setInterval(tickRecording, 100),
    };
    el.btnRecord.textContent = "Cancelar";
    builder.resetTracking();
    renderGrid();
    tickRecording();
  }

  function tickRecording() {
    if (!recording) return;
    if (recording.phase === "countdown") {
      const left = COUNTDOWN_MS - (performance.now() - recording.t0);
      if (left > 0) {
        setRecordStatus(`Prepare la seña «${symbolFor(recording.label)}»… ${Math.ceil(left / 1000)}`, "info");
      } else {
        recording.phase = "recording";
        recording.t0 = performance.now();
      }
    }
    if (recording?.phase === "recording") {
      const seen = performance.now() - lastSeen < 400;
      setRecordStatus(
        seen
          ? `Grabando «${symbolFor(recording.label)}»: ${recording.count}/${RECORD_SAMPLES}. Mueva ligeramente la mano y cambie un poco el ángulo.`
          : "No se detecta la mano: colóquela completa frente a la cámara.",
        seen ? "info" : "warn",
      );
    }
    renderRing();
  }

  function stopRecording(completed) {
    if (!recording) return;
    clearInterval(recording.timer);
    const { label, count } = recording;
    recording = null;
    el.btnRecord.textContent = "Grabar ejemplos";
    if (completed) {
      save();
      const n = classifier.counts()[label] ?? 0;
      setRecordStatus(
        `Listo: ${count} ejemplos de «${symbolFor(label)}» (total ${n}). ` +
          (n < RECOMMENDED_SAMPLES ? "Grabe otra toma para mejorar la precisión." : "Puede grabar una toma más con otra postura."),
        "ok",
      );
    } else {
      // La toma incompleta ya fue descartada en cancelRecording()
      setRecordStatus("Grabación cancelada.", "warn");
    }
    renderGrid();
    renderRing();
  }

  function cancelRecording() {
    if (!recording) return;
    const takeId = recording.take;
    classifier.setSamples(classifier.samples.filter((s) => s.take !== takeId));
    stopRecording(false);
  }

  function recordSample(features, now) {
    if (now - recording.lastAdd < RECORD_INTERVAL_MS) return;
    recording.lastAdd = now;
    classifier.add(recording.label, features, recording.take);
    recording.count++;
    if (recording.count >= RECORD_SAMPLES) stopRecording(true);
    else renderRing();
  }

  /* ---------------------------- Reconocimiento ---------------------------- */

  /** Voto de mayoría sobre los últimos fotogramas: evita letras por un solo fotograma. */
  function stableLabel() {
    const votes = new Map();
    for (const l of history) if (l) votes.set(l, (votes.get(l) ?? 0) + 1);
    let best = null;
    let top = 0;
    for (const [l, n] of votes) {
      if (n > top) {
        best = l;
        top = n;
      }
    }
    return top >= SMOOTH_MIN_VOTES ? best : null;
  }

  function pushHistory(label) {
    history.push(label);
    if (history.length > SMOOTH_WINDOW) history.shift();
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.applied) {
      renderWord();
      el.signRing.classList.remove("flash");
      void el.signRing.offsetWidth; // reinicia la animación
      el.signRing.classList.add("flash");
    }
  }

  function processHand(pts3, now) {
    lastSeen = now;
    if (!active) return;
    const features = extractFeatures(pts3);

    if (recording) {
      overlay = null;
      if (features && recording.phase === "recording") recordSample(features, now);
      return;
    }

    if (!features || classifier.labelCount < 2) {
      overlay = null;
      builder.update(null, now);
      setHint(
        classifier.labelCount < 2
          ? "Entrene al menos 2 señas en el panel «Entrenamiento»"
          : "Mantenga la mano completa dentro del cuadro",
      );
      renderRing();
      return;
    }

    const result = classifier.classify(features);
    pushHistory(result.label);
    const label = stableLabel();
    overlay = { label, confidence: result.confidence };
    handleEvent(builder.update(label, now));
    setHint(label ? `Mantenga «${symbolFor(label)}» 1 s para confirmarla` : "Haga una seña entrenada");
    renderRing();
  }

  function processNoHand(now) {
    if (!active) return;
    overlay = null;
    if (recording) return;
    pushHistory(null);
    handleEvent(builder.update(null, now));
    if (now - lastSeen > NO_HAND_HINT_MS) {
      setHint("No se detecta la mano: aléjela hasta verla completa, con buena luz");
    } else if (classifier.labelCount >= 2) {
      setHint("Muestre una seña frente a la cámara");
    }
    renderRing();
  }

  /* ------------------------ Evaluación, exportar, etc. ------------------------ */

  function renderEvaluation(cv) {
    el.evalResult.replaceChildren();
    const add = (tag, text, cls) => {
      const node = document.createElement(tag);
      node.textContent = text;
      if (cls) node.className = cls;
      el.evalResult.append(node);
      return node;
    };

    if (cv.overall.accuracy === null) {
      add("p", "No hay datos suficientes: cada seña necesita al menos 2 grabaciones distintas para estimar su precisión.", "eval-warn");
      return;
    }
    const pct = (x) => `${Math.round(x * 100)} %`;
    add("p", `Precisión estimada: ${pct(cv.overall.accuracy)} (${cv.overall.correct}/${cv.overall.total} ejemplos evaluados con grabaciones distintas a la del ejemplo).`, "eval-main");

    const weak = Object.entries(cv.perLabel)
      .filter(([, s]) => s.accuracy < 0.8)
      .sort((a, b) => a[1].accuracy - b[1].accuracy);
    if (weak.length) {
      add("p", "Señas con baja precisión (< 80 %):", "eval-sub");
      const ul = add("ul", "");
      for (const [label, s] of weak) {
        const conf = Object.entries(cv.confusions[label] ?? {}).sort((a, b) => b[1] - a[1])[0];
        const li = document.createElement("li");
        li.textContent = `${symbolFor(label)}: ${pct(s.accuracy)}` + (conf ? ` (se confunde con ${symbolFor(conf[0])})` : "");
        ul.append(li);
      }
      add("p", "Grabe más tomas de esas señas, con distintos ángulos, o revise que sean claramente distintas entre sí.", "eval-hint");
    } else {
      add("p", "Todas las señas evaluadas superan el 80 %.", "eval-ok");
    }
    if (cv.notEvaluated.length) {
      add("p", `Sin evaluar (una sola grabación): ${cv.notEvaluated.map(symbolFor).join(", ")}.`, "eval-hint");
    }
    add("p", "Aviso: es una estimación con sus propias grabaciones. Con otra persona, otra cámara o distinta iluminación, la precisión real puede ser menor.", "eval-hint");
  }

  function evaluate() {
    if (classifier.samples.length < 10) {
      showToast("Grabe ejemplos antes de estimar la precisión");
      return;
    }
    el.evalResult.textContent = "Calculando…";
    setTimeout(() => renderEvaluation(crossValidate(classifier.samples)), 30);
  }

  function exportData() {
    if (!classifier.samples.length) {
      showToast("No hay entrenamiento para guardar");
      return;
    }
    const blob = new Blob([serializeDataset(classifier.samples)], { type: "application/json" });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `entrenamiento-lsm-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Entrenamiento guardado");
  }

  async function importData(file) {
    if (!file) return;
    const { samples, error } = parseDataset(await file.text());
    if (error) {
      showToast(error, 4000);
      return;
    }
    classifier.setSamples(samples);
    save();
    renderGrid();
    el.evalResult.replaceChildren();
    showToast(`Entrenamiento cargado: ${samples.length} ejemplos`);
  }

  function clearAll() {
    const now = performance.now();
    if (now - clearAllArmed > 3000) {
      clearAllArmed = now;
      el.btnClearAll.textContent = "¿Seguro? Pulse otra vez";
      setTimeout(() => {
        if (performance.now() - clearAllArmed >= 2900) el.btnClearAll.textContent = "Borrar todo";
      }, 3100);
      return;
    }
    clearAllArmed = 0;
    el.btnClearAll.textContent = "Borrar todo";
    classifier.clear();
    save();
    renderGrid();
    el.evalResult.replaceChildren();
    showToast("Entrenamiento borrado");
  }

  async function copyWord() {
    if (!builder.text) return showToast("No hay texto para copiar");
    try {
      await navigator.clipboard.writeText(builder.text);
      showToast("Texto copiado");
    } catch {
      showToast("No fue posible copiar automáticamente");
    }
  }

  function speakWord() {
    if (!builder.text) return showToast("No hay texto para leer");
    const u = new SpeechSynthesisUtterance(builder.text);
    u.lang = "es-MX";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  /* ----------------------------- Inicialización ----------------------------- */

  function bind() {
    el.btnRecord.addEventListener("click", () => (recording ? cancelRecording() : startRecording()));
    el.btnClearLabel.addEventListener("click", () => {
      if (!selected) return;
      classifier.removeLabel(selected);
      save();
      renderGrid();
      setRecordStatus(`Se borraron los ejemplos de «${symbolFor(selected)}».`, "warn");
    });
    el.btnSpace.addEventListener("click", () => {
      builder.space();
      renderWord();
    });
    el.btnBackspace.addEventListener("click", () => {
      builder.backspace();
      renderWord();
    });
    el.btnClearWord.addEventListener("click", () => {
      builder.clear();
      renderWord();
    });
    el.btnCopyWord.addEventListener("click", copyWord);
    if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
      el.btnSpeak.addEventListener("click", speakWord);
    } else {
      el.btnSpeak.hidden = true;
    }
    el.btnEvaluate.addEventListener("click", evaluate);
    el.btnExport.addEventListener("click", exportData);
    el.btnImport.addEventListener("click", () => el.fileImport.click());
    el.fileImport.addEventListener("change", async () => {
      await importData(el.fileImport.files[0]);
      el.fileImport.value = "";
    });
    el.btnClearAll.addEventListener("click", clearAll);
  }

  loadSaved();
  buildGrid();
  bind();
  renderGrid();
  renderWord();
  renderRing();

  return {
    processHand,
    processNoHand,
    /** Activa o desactiva el modo (muestra u oculta la barra sobre el video). */
    setActive(value) {
      active = value;
      el.signBar.hidden = !value;
      if (!value) this.reset();
      else {
        lastSeen = performance.now();
        setHint(
          classifier.labelCount < 2
            ? "Entrene al menos 2 señas en el panel «Entrenamiento»"
            : "Muestre una seña frente a la cámara",
        );
      }
    },
    /** Reinicia el seguimiento (no borra la palabra ni el entrenamiento). */
    reset() {
      cancelRecording();
      history = [];
      overlay = null;
      builder.resetTracking();
      renderRing();
    },
    getOverlay: () => overlay,
    symbolFor,
  };
}
