/**
 * Tic sonori + feedback aptico.
 * - Suono: Web Audio (un breve "tic").
 * - Aptico: navigator.vibrate dove esiste (Android); su iPhone (Safari 17.4+)
 *   si usa il trucco dell'<input type="checkbox" switch>, che fa il tic aptico quando viene toccato.
 */
let ctx: AudioContext | null = null;
let hapticEl: HTMLLabelElement | null = null;

/** Da chiamare dentro un tocco dell'utente (serve a iOS per sbloccare l'audio). */
export function unlockFeedback() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* ignore */
  }
}

/** Intensità del feedback: su Android cambia la durata della vibrazione; su iPhone il "tic" è unico. */
export type HapticKind = "light" | "medium" | "heavy";
const HAPTIC_MS: Record<HapticKind, number> = { light: 8, medium: 15, heavy: 28 };
let lastHapticAt = 0;
/** Intervallo minimo tra due tic: evita che il motore vibrante "impasti" i tic durante uno scorrimento veloce. */
const HAPTIC_MIN_GAP = 22;

/** Un singolo tic aptico. Se `force` è falso, i tic troppo ravvicinati vengono saltati. */
export function haptic(kind: HapticKind = "light", force = false) {
  const now = performance.now();
  if (!force && now - lastHapticAt < HAPTIC_MIN_GAP) return;
  lastHapticAt = now;
  try {
    if (navigator.vibrate) {
      navigator.vibrate(HAPTIC_MS[kind]);
      return;
    }
    if (!hapticEl) {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      label.appendChild(input);
      document.body.appendChild(label);
      hapticEl = label;
    }
    hapticEl.click();
  } catch {
    /* ignore */
  }
}

/**
 * Feedback aptico automatico su ogni pulsante dell'app: basta chiamarla una volta (restituisce la funzione di pulizia).
 *
 * - Android: un tic con navigator.vibrate a ogni click.
 * - iPhone: Safari fa vibrare SOLO se il dito tocca davvero un interruttore (<input switch>); un clic simulato
 *   da codice non basta. Quindi sopra ogni pulsante mettiamo un interruttore trasparente: il dito tocca quello
 *   (vibra), e il clic risale fino al pulsante, che esegue la sua azione normalmente.
 */
const HOST_SELECTOR = "button, [role='button'], [role='switch']";
/** Elementi su cui NON mettere l'interruttore trasparente (selettore CSS). Lascia vuoto per metterlo ovunque. */
const SKIP_SELECTOR = "";

export function installButtonHaptics() {
  if (typeof document === "undefined") return () => {};

  if (navigator.vibrate) {
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest(HOST_SELECTOR) : null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      if (performance.now() - lastHapticAt < 120) return;
      haptic("light", true);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }

  const style = document.createElement("style");
  style.textContent =
    ".hx-ov{position:absolute;left:0;top:0;width:100%;height:100%;margin:0;padding:0;opacity:0;z-index:2;-webkit-tap-highlight-color:transparent}" +
    "button:disabled>.hx-ov{pointer-events:none}";
  document.head.appendChild(style);

  const attach = () => {
    document.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach((host) => {
      if (host.querySelector(":scope > input.hx-ov")) return;
      if (SKIP_SELECTOR && host.matches(SKIP_SELECTOR)) return;
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.setAttribute("aria-hidden", "true");
      input.tabIndex = -1;
      input.className = "hx-ov";
      host.appendChild(input);
    });
  };

  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; attach(); });
  };
  attach();
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });

  return () => {
    mo.disconnect();
    if (raf) cancelAnimationFrame(raf);
    style.remove();
    document.querySelectorAll("input.hx-ov").forEach((n) => n.remove());
  };
}

function sound() {
  if (!ctx) return;
  try {
    // iOS sospende l'audio quando la fotocamera cambia sessione audio: lo riattiviamo a ogni tic.
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 1800;
    gain.gain.setValueAtTime(0.7, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  } catch {
    /* ignore */
  }
}

/**
 * Suono "orologio da polso" per lo scorrimento dello zoom: un tic brevissimo, acuto e metallico, che alterna
 * due toni (tic / tock). Il tono sale leggermente con lo zoom (t da 0 a 1).
 * Tre tipi: tacca normale, tacca principale (più piena e più grave), limite (ancora più grave e lunga).
 * Per regolarlo: VOLUME = volume generale, PITCH_RISE = quanto sale il tono con lo zoom (0 = per niente).
 */
export type ZoomTickKind = "minor" | "major" | "limit";
const VOLUME = 0.8;
const PITCH_RISE = 0.25;
let lastTickAt = 0;
let tickFlip = false;
let noiseBuf: AudioBuffer | null = null;

export function zoomTick(kind: ZoomTickKind, t = 0.5) {
  if (!ctx) return;
  const now = performance.now();
  if (kind !== "limit" && now - lastTickAt < 18) return;
  lastTickAt = now;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const k = kind === "major" ? { g: 1.5, d: 1.5, p: 0.85 } : kind === "limit" ? { g: 1.4, d: 2, p: 0.6 } : { g: 1, d: 1, p: 1 };
    k.p *= 1 + (Math.min(1, Math.max(0, t)) - 0.5) * PITCH_RISE;
    tickFlip = !tickFlip;
    const t0 = ctx.currentTime + 0.001;

    // 1) fruscio filtrato (il "tic" metallico)
    const dur1 = 0.012 * k.d;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const flt = ctx.createBiquadFilter();
    flt.type = "bandpass";
    flt.frequency.value = (tickFlip ? 4800 : 5600) * k.p;
    flt.Q.value = 9;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.linearRampToValueAtTime(0.4 * k.g * VOLUME, t0 + 0.0008);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + dur1);
    src.connect(flt).connect(g1).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur1 + 0.02);

    // 2) piccolo tono acuto sotto il fruscio
    const dur2 = 0.02 * k.d;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = (tickFlip ? 3500 : 4100) * k.p;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t0);
    g2.gain.linearRampToValueAtTime(0.06 * k.g * VOLUME, t0 + 0.002);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur2);
    osc.connect(g2).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur2 + 0.02);
  } catch {
    /* ignore */
  }
}

function tics(count: number, gapMs: number) {
  for (let i = 0; i < count; i++) {
    // Il primo tic parte subito, dentro il tocco dell'utente: iOS accetta l'aptico solo così.
    if (i === 0) {
      sound();
      haptic("medium", true);
      continue;
    }
    setTimeout(() => {
      sound();
      haptic("medium", true);
    }, i * gapMs);
  }
}

/** Durata totale (ms) di ogni sequenza: serve a silenziare il microfono mentre suona. */
export const TIC_MS = 60;
export const DOUBLE_TIC_MS = 110 + 60;
export const TRIPLE_TIC_MS = 2 * 140 + 60;

/** 1 tic */
export const tic = () => tics(1, 0);
/** doppio click */
export const doubleTic = () => tics(2, 110);
/** 3 tic */
export const tripleTic = () => tics(3, 140);
