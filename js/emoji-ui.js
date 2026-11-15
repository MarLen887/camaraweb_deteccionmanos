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
    burst: $("emojiBurst"),
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

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const rand = (a, b) => a + Math.random() * (b - a);

  /**
   * Explosión de reacciones tipo videollamada: los emojis nacen en la parte
   * inferior, suben con vaivén, giran y se desvanecen.
   */
  function spawnBurst(key, count) {
    const symbol = EMOJIS[key]?.emoji;
    if (!symbol || !el.burst) return;
    const n = reduceMotion ? Math.ceil(count / 4) : count;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("span");
      p.className = "emoji-particle";
      p.textContent = symbol;
      p.style.setProperty("--x", `${rand(4, 96).toFixed(1)}%`);
      p.style.setProperty("--size", `${rand(28, 72).toFixed(0)}px`);
      p.style.setProperty("--rise", rand(60, 105).toFixed(0));
      p.style.setProperty("--sway", `${rand(-60, 60).toFixed(0)}px`);
      p.style.setProperty("--rot", `${rand(-40, 40).toFixed(0)}deg`);
      p.style.animationDuration = `${rand(1.8, 3.2).toFixed(2)}s`;
      p.style.animationDelay = `${rand(0, 0.45).toFixed(2)}s`;
      p.addEventListener("animationend", () => p.remove(), { once: true });
      el.burst.appendChild(p);
    }
    // Límite de partículas simultáneas (rendimiento)
    while (el.burst.childElementCount > 120) el.burst.firstElementChild.remove();
  }

  let lastTrickle = 0;

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
      spawnBurst(r.activated, 26);
      lastTrickle = now;
      history.push(r.activated);
      if (history.length > HISTORY_MAX) history.shift();
      renderHistory();
    }
    setCurrent(r.active);
    // Mientras se mantiene el gesto, siguen cayendo emojis (como al sostener una reacción)
    if (r.active && !r.activated && now - lastTrickle > 600) {
      spawnBurst(r.active, 5);
      lastTrickle = now;
    }
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
      el.burst?.replaceChildren();
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
