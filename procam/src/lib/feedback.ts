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
 * Ascolta in fase di "bubbling", cioè DOPO i gestori dei pulsanti: se un pulsante ha già fatto il suo tic
 * (otturatore, doppio click del loop...) qui non se ne aggiunge un secondo.
 */
export function installButtonHaptics() {
  const onClick = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target.closest("button, [role='button'], [role='switch']") : null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    if (performance.now() - lastHapticAt < 120) return;
    haptic("light", true);
  };
  window.addEventListener("click", onClick);
  return () => window.removeEventListener("click", onClick);
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
