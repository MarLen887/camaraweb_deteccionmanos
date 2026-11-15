/**
 * emoji-ui.js
 * -----------------------------------------------------------------------------
 * Interfaz del modo "Emojis": muestra el emoji que forman las manos sobre el
 * video, mantiene un historial y presenta la guía de gestos. La lógica de
 * reconocimiento vive en emoji.js (sin DOM).
 */

import { EMOJIS, EmojiDetector } from "./emoji.js?v=13";

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 12;

export function createEmojiUI({ showToast, isCameraRunning } = {}) {
  const el = {
    bar: $("emojiBar"),
    big: $("emojiBig"),
    name: $("emojiName"),
    hint: $("emojiHint"),
    live: $("emojiLive"),
    liveName: $("emojiLiveName"),
    liveHow: $("emojiLiveHow"),
    handsInfo: $("emojiHands"),
    history: $("emojiHistory"),
    btnClear: $("btnEmojiClear"),
    btnCopy: $("btnEmojiCopy"),
    guide: $("emojiGuide"),
  };

  const detector = new EmojiDetector();
  let active = false;
  let current = null; // clave del emoji activo
  let history = []; // claves, la más reciente al final
  let overlay = null;

  function buildGuide() {
    const item = (key) => {
      const e = EMOJIS[key];
      return `<li><span class="eg-emoji" aria-hidden="true">${e.emoji}</span><span><strong>${e.name}</strong><small>${e.how}</small></span></li>`;
    };
    const keys = Object.keys(EMOJIS);
    el.guide.innerHTML =
      `<h3>Una mano</h3><ul>${keys.filter((k) => EMOJIS[k].hands === 1).map(item).join("")}</ul>` +
      `<h3>Dos manos</h3><ul>${keys.filter((k) => EMOJIS[k].hands === 2).map(item).join("")}</ul>`;
  }

  function renderHistory() {
    el.history.innerHTML = history.length
      ? history.map((k) => `<span title="${EMOJIS[k].name}">${EMOJIS[k].emoji}</span>`).join("")
      : '<em>Aún no se ha detectado ningún emoji.</em>';
    el.btnCopy.disabled = history.length === 0;
    el.btnClear.disabled = history.length === 0;
  }

  function render() {
    const e = current ? EMOJIS[current] : null;
    el.big.textContent = e ? e.emoji : "🖐️";
    el.name.textContent = e ? e.name : "Haz un gesto frente a la cámara";
    el.bar.dataset.on = String(Boolean(e));
    el.live.textContent = e ? e.emoji : "–";
    el.liveName.textContent = e ? e.name : "Sin gesto reconocido";
    el.liveHow.textContent = e ? e.how : "Muestre una o dos manos completas, a unos 40–80 cm de la cámara.";
  }

  function setCurrent(key) {
    if (key === current) return;
    current = key;
    render();
    if (key) {
      el.big.classList.remove("pop");
      void el.big.offsetWidth; // reinicia la animación
      el.big.classList.add("pop");
    }
  }

  /** @param {{x:number,y:number}[][]} hands Manos en píxeles (vista espejo). */
  function processHands(hands, now) {
    if (!active) return;
    const r = detector.update(hands, now);
    overlay = { hands: hands.length };
    el.handsInfo.textContent = `Manos detectadas: ${hands.length}`;
    if (r.activated) {
      history.push(r.activated);
      if (history.length > HISTORY_MAX) history.shift();
      renderHistory();
    }
    setCurrent(r.active);
  }

  function processNoHand(now) {
    processHands([], now);
    overlay = null;
  }

  el.btnClear.addEventListener("click", () => {
    history = [];
    renderHistory();
  });
  el.btnCopy.addEventListener("click", async () => {
    const text = history.map((k) => EMOJIS[k].emoji).join(" ");
    try {
      await navigator.clipboard.writeText(text);
      showToast?.("Emojis copiados");
    } catch {
      showToast?.("No se pudo copiar al portapapeles");
    }
  });

  buildGuide();
  renderHistory();
  render();

  return {
    processHands,
    processNoHand,
    setActive(value) {
      active = value;
      el.bar.hidden = !value;
      if (!value) this.reset();
    },
    /** Reinicia el seguimiento (conserva el historial). */
    reset() {
      detector.reset();
      overlay = null;
      current = null;
      render();
      el.handsInfo.textContent = "Manos detectadas: 0";
    },
    getOverlay: () => ({ key: current, ...(overlay ?? {}) }),
    symbolFor: (key) => EMOJIS[key]?.emoji ?? "",
    isCameraRunning,
  };
}
