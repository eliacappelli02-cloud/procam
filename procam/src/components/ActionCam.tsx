import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronLeft,
  ChevronUp,
  Grid3x3,
  Maximize,
  Play,
  RefreshCw,
  Ruler,
  Settings,
  Share,
  Square,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import { LoopRecorder, SimpleRecorder, pickMime, uid, type Clip } from "@/lib/recorder";
import { TIC_MS, doubleTic, haptic, installButtonHaptics, tic, tripleTic, unlockFeedback } from "@/lib/feedback";

type Mode = "timelapse" | "loop" | "video" | "photo" | "burst";
// Stesso ordine del selettore di iOS: i modi video a sinistra, quelli foto a destra.
const MODES: { id: Mode; label: string }[] = [
  { id: "timelapse", label: "Time-lapse" },
  { id: "loop", label: "Loop" },
  { id: "video", label: "Video" },
  { id: "photo", label: "Foto" },
  { id: "burst", label: "Raffica" },
];
const RES = { "4K": [3840, 2160], "1080p": [1920, 1080], "720p": [1280, 720] } as const;
type ResKey = keyof typeof RES;
const RES_LABEL: Record<ResKey, string> = { "4K": "4K", "1080p": "HD", "720p": "720p" };
const FPS_OPTIONS = [24, 30, 60, 120];

/** Altezza (px) occupata dai comandi in basso (otturatore + selettore): zoom e opzioni stanno sopra. */
const CONTROLS_H = 134;
const SHUTTER_BOTTOM = 14;
const TOP_BAR = 44;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const zoomLabel = (z: number) => String(z).replace(".", ",");
const MAX_ZOOM = 15;
/** Quadrante dello zoom ad arco: raggio in px e gradi di rotazione per ogni "e-fold" di zoom.
 *  DIAL_K = quanto è "larga" la mezza luna disegnata (le tacche sono distanziate come nell'originale).
 *  DIAL_INPUT_K = quanto il dito deve muoversi: più basso = zoom più veloce. Con 20 da 1× a 15× bastano ~54° di
 *  arco (circa 120 px di pollice); con 40 servivano ~108°. Le tacche scorrono quindi ~2× più veloci del dito.
 *  Per regolare la sensibilità cambia solo DIAL_INPUT_K (es. 16 = molto veloce, 26 = più preciso). */
const DIAL_R = 170;
const DIAL_K = 40;
const DIAL_INPUT_K = 20;
/** L'arco viene disegnato sollevato di questi px sopra i pulsanti, così non copre il selettore dei modi. */
const DIAL_SHIFT = 84;
const DIAL_SPAN = 50;
const DIAL_TICKS: { v: number; major?: boolean }[] = [
  { v: 0.5, major: true }, { v: 0.6 }, { v: 0.7 }, { v: 0.8 }, { v: 0.9 },
  { v: 1, major: true }, { v: 1.25 }, { v: 1.5 }, { v: 1.75 },
  { v: 2, major: true }, { v: 2.5 }, { v: 3, major: true }, { v: 4 },
  { v: 5, major: true }, { v: 6 }, { v: 7 }, { v: 8 }, { v: 9 },
  { v: 10, major: true }, { v: 12.5 }, { v: 15, major: true },
];
const ZOOM_PRESETS = [0.5, 1, 2, 3];
/** Valore dello zoom con una cifra decimale, in italiano (es. 2,4). */
const fmtZoom = (z: number) => String(Math.round(z * 10) / 10).replace(".", ",");

export function ActionCam() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const vfRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<SimpleRecorder | null>(null);
  const loopRef = useRef<LoopRecorder | null>(null);
  const tlRef = useRef<{ stop: () => void } | null>(null);
  // true mentre parte la registrazione (il tic iniziale sta suonando): evita doppi avvii.
  const startingRef = useRef(false);

  const [mode, setMode] = useState<Mode>("photo");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [res, setRes] = useState<ResKey>("1080p");
  const [fps, setFps] = useState(60);
  const [audio, setAudio] = useState(true);
  const [loopMin, setLoopMin] = useState(5);
  const [tlInterval, setTlInterval] = useState(1);
  const [timer, setTimer] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sub, setSub] = useState<null | "timer" | "lens">(null);
  const [grid, setGrid] = useState(false);
  const [level, setLevel] = useState(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lens, setLens] = useState<"wide" | "linear">("wide");

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [loopLocked, setLoopLocked] = useState(false);
  const [loopBuf, setLoopBuf] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [flash, setFlash] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [panel, setPanel] = useState<"none" | "settings" | "gallery">("none");
  const [viewing, setViewing] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [tilt, setTilt] = useState(0);
  const [hwZoom, setHwZoom] = useState<{ min: number; max: number } | null>(null);
  const [ultraId, setUltraId] = useState<string | null>(null);
  const [useUltra, setUseUltra] = useState(false);
  const [flipTurns, setFlipTurns] = useState(0);
  const [pinching, setPinching] = useState(false);
  const [dialOn, setDialOn] = useState(false);
  const [focus, setFocus] = useState<{ x: number; y: number; id: number } | null>(null);
  const ultraIdRef = useRef<string | null>(null);

  // Schermata bloccata in verticale: se il browser gira la pagina, la ricontro-giriamo. Ruotano solo le icone.
  const shellRef = useRef<HTMLElement>(null);
  const [orient, setOrient] = useState({ angle: 0, w: 0, h: 0 });
  useEffect(() => {
    const read = () => {
      const raw = window.screen?.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
      const a = ((raw % 360) + 360) % 360;
      const w = shellRef.current?.clientWidth || window.innerWidth;
      const h = shellRef.current?.clientHeight || window.innerHeight;
      const landscapeViewport = w > h;
      // Ruotiamo solo se il browser ha davvero girato la pagina in orizzontale.
      const angle = landscapeViewport && (a === 90 || a === 270) ? a : 0;
      setOrient((o) => (o.angle === angle && o.w === w && o.h === h ? o : { angle, w, h }));
    };
    read();
    const later = () => setTimeout(read, 150);
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", later);
    const ro = typeof ResizeObserver !== "undefined" && shellRef.current ? new ResizeObserver(read) : null;
    if (ro && shellRef.current) ro.observe(shellRef.current);
    window.screen?.orientation?.addEventListener?.("change", later);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", later);
      window.screen?.orientation?.removeEventListener?.("change", later);
    };
  }, []);
  // Margini di sicurezza (notch, barra home): sul riquadro ruotato vanno spostati sul lato giusto.
  const E = (side: "top" | "right" | "bottom" | "left") => `env(safe-area-inset-${side})`;
  const sa = orient.angle === 90
    ? { top: E("left"), right: E("top"), bottom: E("right"), left: E("bottom") }
    : orient.angle === 270
      ? { top: E("right"), right: E("bottom"), bottom: E("left"), left: E("top") }
      : { top: E("top"), right: E("right"), bottom: E("bottom"), left: E("left") };
  const uiStyle = {
    ...(orient.angle === 0
      ? { inset: 0 }
      : {
          left: "50%", top: "50%", width: orient.h, height: orient.w,
          transform: `translate(-50%, -50%) rotate(${-orient.angle}deg)`,
        }),
    "--icon-rot": `${orient.angle}deg`,
    "--sa-top": sa.top, "--sa-right": sa.right, "--sa-bottom": sa.bottom, "--sa-left": sa.left,
  } as unknown as React.CSSProperties;
  const actionsRef = useRef<{ shutter: () => void; stop: () => void }>({ shutter: () => {}, stop: () => {} });

  const startCamera = useCallback(async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const [w, h] = RES[res];
      const s = await navigator.mediaDevices.getUserMedia({
        video: { ...(useUltra && ultraIdRef.current ? { deviceId: { exact: ultraIdRef.current } } : { facingMode: facing }), width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
        audio,
      });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
      const track = s.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      setHwZoom(caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null);
      setError(null);
      // Cerca la fotocamera ultra-grandangolare (0,5×): le etichette sono disponibili solo dopo il permesso.
      navigator.mediaDevices.enumerateDevices().then((d) => {
        const u = d.find((x) => x.kind === "videoinput" && /ultra|0[.,]5\s?x|grandangolo/i.test(x.label));
        ultraIdRef.current = u?.deviceId ?? null;
        setUltraId(u?.deviceId ?? null);
      }).catch(() => {});
    } catch (e) {
      setError("Impossibile accedere alla fotocamera. Consenti l'accesso e usa HTTPS.");
      console.error(e);
    }
  }, [facing, res, fps, audio, useUltra]);

  useEffect(() => { if (started && !recording) startCamera(); }, [started, startCamera]); // eslint-disable-line react-hooks/exhaustive-deps

  // hardware zoom + torch
  useEffect(() => {
    const t = streamRef.current?.getVideoTracks()[0];
    if (!t) return;
    const adv: Record<string, unknown> = {};
    if (hwZoom) adv["zoom"] = Math.min(hwZoom.max, Math.max(hwZoom.min, zoom));
    adv["torch"] = torch;
    t.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] }).catch(() => {});
  }, [zoom, torch, hwZoom]);

  // horizon level
  useEffect(() => {
    if (!level) return;
    const h = (e: DeviceOrientationEvent) => setTilt(e.gamma ?? 0);
    window.addEventListener("deviceorientation", h);
    return () => window.removeEventListener("deviceorientation", h);
  }, [level]);

  const enableLevel = async () => {
    const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (!level && D.requestPermission) { try { await D.requestPermission(); } catch { /* ignore */ } }
    setLevel((v) => !v);
  };

  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const i = setInterval(() => setElapsed((Date.now() - start) / 1000), 250);
    return () => clearInterval(i);
  }, [recording]);

  // Il quadrato di messa a fuoco sparisce da solo.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => setFocus(null), 1600);
    return () => clearTimeout(t);
  }, [focus]);

  const addClip = (blob: Blob, kind: Clip["kind"], label: string) => {
    const ext = kind === "photo" ? "jpg" : pickMime().ext;
    setClips((c) => [{ id: uid(), url: URL.createObjectURL(blob), blob, kind, label, at: Date.now(), ext }, ...c]);
  };

  const lensScale = lens === "linear" ? 1.15 : 1;
  // Zoom hardware fin dove arriva la camera, il resto (fino a 15×) è digitale.
  const hwApplied = hwZoom ? Math.min(hwZoom.max, Math.max(hwZoom.min, zoom)) : 1;
  const digitalZoom = useUltra ? 1 : hwZoom ? Math.max(1, zoom / hwApplied) : zoom;
  const minZoom = hwZoom && hwZoom.min <= 0.5 ? 0.5 : 1;
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(minZoom, z));

  /** Scatta ciò che si vede nel mirino (stesso ritaglio e stesso zoom dell'anteprima). */
  const snap = (): Promise<Blob | null> => {
    const v = videoRef.current;
    const box = vfRef.current;
    if (!v || !v.videoWidth || !box || !box.offsetHeight) return Promise.resolve(null);
    const vw = v.videoWidth, vh = v.videoHeight;
    const boxAspect = box.offsetWidth / box.offsetHeight;
    const videoAspect = vw / vh;
    let sw = videoAspect > boxAspect ? vh * boxAspect : vw;
    let sh = videoAspect > boxAspect ? vh : vw / boxAspect;
    const dz = digitalZoom * lensScale;
    sw /= dz; sh /= dz;
    const c = document.createElement("canvas");
    c.width = Math.round(sw); c.height = Math.round(sh);
    const ctx = c.getContext("2d")!;
    if (facing === "user") { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  };

  const doFlash = () => { setFlash(true); setTimeout(() => setFlash(false), 120); navigator.vibrate?.(30); };

  const withTimer = async () => {
    for (let i = timer; i > 0; i--) { setCountdown(i); await new Promise((r) => setTimeout(r, 1000)); }
    setCountdown(0);
  };

  const bitrate = res === "4K" ? 40e6 : res === "1080p" ? 16e6 : 8e6;

  const shutter = async () => {
    const s = streamRef.current;
    if (!s || startingRef.current) return;
    unlockFeedback();
    if (recording && mode === "loop" && loopRef.current && !loopRef.current.locked) {
      loopRef.current.lock(); setLoopLocked(true); doFlash(); doubleTic(); return;
    }
    if (recording) return stopRec();
    if (timer) await withTimer();
    if (mode === "photo") { const b = await snap(); if (b) { addClip(b, "photo", "Foto"); doFlash(); } return; }
    if (mode === "burst") {
      for (let i = 0; i < 10; i++) { const b = await snap(); if (b) addClip(b, "photo", `Raffica ${i + 1}/10`); doFlash(); await new Promise((r) => setTimeout(r, 100)); }
      return;
    }
    // 1 tic di partenza. Il tic suona PRIMA che parta la registrazione, così non finisce nel video.
    startingRef.current = true;
    tic();
    await new Promise((r) => setTimeout(r, TIC_MS + 120));
    startingRef.current = false;
    setElapsed(0);
    setRecording(true);
    setOptionsOpen(false); setSub(null);
    if (mode === "video") recRef.current = new SimpleRecorder(s, (b) => addClip(b, "video", `Video ${res} ${fps}fps`), bitrate);
    if (mode === "loop") {
      setLoopLocked(false);
      loopRef.current = new LoopRecorder(s, loopMin * 60, bitrate);
      loopRef.current.start();
    }
    if (mode === "timelapse") tlRef.current = startTimelapse();
  };

  const startTimelapse = () => {
    const v = videoRef.current!;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d")!;
    // Cattura i fotogrammi a intervalli, poi li riproduce a 30 fps nel clip finale.
    const frames: ImageBitmap[] = [];
    const grab = () => createImageBitmap(v).then((b) => frames.push(b)).catch(() => {});
    grab();
    const tick = setInterval(grab, tlInterval * 1000);
    return {
      stop: () => {
        clearInterval(tick);
        if (!frames.length) return;
        const cs = c.captureStream(30);
        const rec = new SimpleRecorder(cs, (b) => addClip(b, "video", `Time-lapse ${tlInterval}s · ${frames.length} fotogrammi`), bitrate);
        let i = 0;
        const play = setInterval(() => {
          if (i >= frames.length) { clearInterval(play); setTimeout(() => rec.stop(), 200); return; }
          ctx.drawImage(frames[i++]!, 0, 0, c.width, c.height);
        }, 1000 / 30);
      },
    };
  };

  const stopRec = async () => {
    setRecording(false);
    // Prima si ferma la registrazione, poi suonano i 3 tic finali: così non finiscono nel video.
    recRef.current?.stop(); recRef.current = null;
    tlRef.current?.stop(); tlRef.current = null;
    const loopStop = loopRef.current ? loopRef.current.stop() : null;
    tripleTic();
    if (loopStop) {
      const r = await loopStop;
      loopRef.current = null;
      setLoopLocked(false);
      if (r) addClip(r.blob, "video", `Loop · dalle ${new Date(r.at).toLocaleTimeString()}`);
    }
  };

  /** Foto scattata mentre si registra un video (il pulsantino bianco accanto all'otturatore). */
  const stillWhileRecording = async () => {
    const b = await snap();
    if (b) { addClip(b, "photo", "Foto"); doFlash(); }
  };

  useEffect(() => {
    if (!recording || mode !== "loop") return;
    const i = setInterval(() => setLoopBuf(loopRef.current?.buffered() ?? 0), 500);
    return () => clearInterval(i);
  }, [recording, mode]);

  // Tasti volume (+ = scatto / avvia / blocca loop / stop, − = stop). Funziona dove il browser li passa alla pagina.
  useEffect(() => { actionsRef.current = { shutter: () => { if (countdown === 0) void shutter(); }, stop: () => { if (recording) void stopRec(); } }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = `${e.key} ${e.code}`;
      if (/VolumeUp/.test(k)) { e.preventDefault(); unlockFeedback(); actionsRef.current.shutter(); }
      else if (/VolumeDown/.test(k)) { e.preventDefault(); unlockFeedback(); actionsRef.current.stop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickZoom = (z: number) => {
    if (z === 0.5 && !(hwZoom && hwZoom.min <= 0.5)) {
      if (facing !== "environment" || !ultraId) {
        setError("0,5× richiede la fotocamera ultra-grandangolare posteriore, non disponibile su questo dispositivo o browser.");
        setTimeout(() => setError(null), 3500);
        return;
      }
      if (recording) return;
      setUseUltra(true); setZoom(0.5);
      return;
    }
    if (useUltra) { if (recording) return; setUseUltra(false); }
    setZoom(z);
  };

  const share = async (c: Clip) => {
    const file = new File([c.blob], `procam-${c.at}.${c.ext}`, { type: c.blob.type });
    const n = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (n.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
    const a = document.createElement("a"); a.href = c.url; a.download = file.name; a.click();
  };

  const flip = () => {
    setUseUltra(false);
    if (zoom < 1) setZoom(1);
    setFacing(facing === "user" ? "environment" : "user");
    setFlipTurns((n) => n + 1);
  };

  const isVideoMode = mode === "video" || mode === "loop" || mode === "timelapse";

  // --- Selettore dei modi: la voce attiva resta al centro, come su iPhone ---
  const pickerRef = useRef<HTMLDivElement>(null);
  const modeRefs = useRef<Partial<Record<Mode, HTMLButtonElement | null>>>({});
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = modeRefs.current[mode];
    const box = pickerRef.current;
    if (!el || !box) return;
    setShift(box.clientWidth / 2 - (el.offsetLeft + el.offsetWidth / 2));
  }, [mode, started, orient.w, orient.h]);

  const changeMode = (delta: number) => {
    if (recording) return;
    const i = MODES.findIndex((m) => m.id === mode);
    const next = MODES[i + delta];
    if (next) { setMode(next.id); haptic("light", true); }
  };

  // Swipe orizzontale su mirino e selettore = cambia modo. Il gesto va letto nelle coordinate dell'interfaccia (che può essere ruotata).
  const gestureRef = useRef<{ x: number; y: number } | null>(null);
  const onGestureDown = (e: React.PointerEvent) => { gestureRef.current = { x: e.clientX, y: e.clientY }; };
  const onGestureUp = (e: React.PointerEvent, onTap?: (e: React.PointerEvent) => void) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    const th = (orient.angle * Math.PI) / 180;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    const ux = dx * Math.cos(th) - dy * Math.sin(th);
    const uy = dx * Math.sin(th) + dy * Math.cos(th);
    if (Math.abs(ux) > 40 && Math.abs(ux) > Math.abs(uy) * 1.5) changeMode(ux < 0 ? 1 : -1);
    else if (Math.abs(ux) < 10 && Math.abs(uy) < 10) onTap?.(e);
  };

  // Feedback aptico su tutti i pulsanti.
  useEffect(() => installButtonHaptics(), []);

  // Feedback aptico durante lo zoom continuo (pizzico e mezza luna): un tic a ogni tacca che passa,
  // più deciso sulle tacche principali (1×, 2×, 3×, 5×, 10×, 15×) e un colpo forte ai limiti.
  const zoomBucketRef = useRef(0);
  const zoomLimitRef = useRef<"min" | "max" | null>(null);
  const zoomStops = (majorsOnly: boolean) => (majorsOnly ? DIAL_TICKS.filter((t) => t.major) : DIAL_TICKS);
  const zoomBucket = (z: number, majorsOnly: boolean) => zoomStops(majorsOnly).filter((t) => z >= t.v - 1e-6).length;
  const zoomLimit = (z: number) => (z >= MAX_ZOOM - 1e-6 ? "max" : z <= minZoom + 1e-6 ? "min" : null);
  /** Da chiamare all'inizio del gesto: memorizza la posizione di partenza senza vibrare. */
  const zoomHapticInit = (z: number, majorsOnly = false) => {
    zoomBucketRef.current = zoomBucket(z, majorsOnly);
    zoomLimitRef.current = zoomLimit(z);
  };
  const zoomHaptic = (z: number, majorsOnly = false) => {
    const limit = zoomLimit(z);
    const b = zoomBucket(z, majorsOnly);
    const prevB = zoomBucketRef.current;
    zoomBucketRef.current = b;
    if (limit !== zoomLimitRef.current) {
      zoomLimitRef.current = limit;
      if (limit) { haptic("heavy", true); return; }
    }
    if (b === prevB) return;
    const crossed = zoomStops(majorsOnly)[Math.max(b, prevB) - 1];
    haptic(crossed?.major ? "medium" : "light");
  };

  // Pizzico con due dita sul mirino = zoom continuo.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const leaveUltra = () => { if (useUltra) { setUseUltra(false); return true; } return false; };
  const pinchDist = () => {
    const [a, b] = [...pointersRef.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const vfDown = (e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      if (useUltra && recording) return;
      const wasUltra = leaveUltra();
      pinchRef.current = { dist: pinchDist() || 1, zoom: wasUltra ? 1 : zoom };
      zoomHapticInit(wasUltra ? 1 : zoom, true);
      gestureRef.current = null;
      setPinching(true);
    } else if (pointersRef.current.size === 1) onGestureDown(e);
  };
  const vfMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinchRef.current;
    if (p && pointersRef.current.size >= 2) {
      const nz = clampZoom(p.zoom * (pinchDist() / p.dist));
      setZoom(nz);
      zoomHaptic(nz, true);
    }
  };
  const vfUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) { pinchRef.current = null; setPinching(false); }
      gestureRef.current = null;
      return;
    }
    onGestureUp(e, tapViewfinder);
  };
  const vfCancel = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    gestureRef.current = null;
    if (pointersRef.current.size < 2) { pinchRef.current = null; setPinching(false); }
  };

  // Quadrante ad arco (∩): tieni premuto o trascina sui pulsanti dello zoom e segui la curva col dito,
  // anche scendendo ai lati. Verso sinistra = avvicina, verso destra = allontana.
  type ZoomDrag = { cx: number; cy: number; z: number; ang0: number; active: boolean; target: HTMLElement; pointerId: number; timer: ReturnType<typeof setTimeout> | undefined; x0: number; y0: number };
  const zoomDragRef = useRef<ZoomDrag | null>(null);
  const dialEndedAtRef = useRef(0);
  /** Posizione del dito rispetto al centro dei pulsanti, nelle coordinate dell'interfaccia (che può essere ruotata). */
  const dialOffset = (d: ZoomDrag, e: { clientX: number; clientY: number }) => {
    const th = (orient.angle * Math.PI) / 180;
    const sx = e.clientX - d.cx, sy = e.clientY - d.cy;
    return { ux: sx * Math.cos(th) - sy * Math.sin(th), uy: sx * Math.sin(th) + sy * Math.cos(th) };
  };
  const dialAngle = (ux: number, uy: number) => (Math.atan2(DIAL_R - DIAL_SHIFT - uy, ux) * 180) / Math.PI;
  const activateDial = (d: ZoomDrag) => {
    if (d.active || (useUltra && recording)) return;
    d.active = true;
    if (leaveUltra()) d.z = 1;
    try { d.target.setPointerCapture(d.pointerId); } catch { /* ignore */ }
    zoomHapticInit(d.z);
    haptic("medium", true);
    setDialOn(true);
    setPinching(true);
  };
  const pillsDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d: ZoomDrag = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, z: zoom, ang0: 90, active: false, target: e.currentTarget, pointerId: e.pointerId, timer: undefined, x0: e.clientX, y0: e.clientY };
    const o = dialOffset(d, e);
    d.ang0 = dialAngle(o.ux, o.uy);
    d.timer = setTimeout(() => activateDial(d), 250);
    zoomDragRef.current = d;
  };
  const pillsMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = zoomDragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return;
      activateDial(d);
      if (!d.active) return;
    }
    const { ux, uy } = dialOffset(d, e);
    const nz = clampZoom(Math.exp(Math.log(d.z) + (dialAngle(ux, uy) - d.ang0) / DIAL_INPUT_K));
    setZoom(nz);
    zoomHaptic(nz);
  };
  const pillsUp = () => {
    const d = zoomDragRef.current;
    zoomDragRef.current = null;
    if (!d) return;
    clearTimeout(d.timer);
    if (d.active) {
      setDialOn(false);
      setPinching(false);
      dialEndedAtRef.current = Date.now();
    }
  };

  const tapViewfinder = (e: React.PointerEvent) => {
    haptic("light", true);
    setOptionsOpen(false); setSub(null);
    setFocus({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, id: Date.now() });
  };

  // --- Schermata iniziale ---
  if (!started) {
    return (
      <main className="cam-shell flex flex-col items-center justify-center gap-6 p-8 text-center">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white/10">
          <Camera size={44} strokeWidth={1.5} />
        </div>
        <div className="space-y-2">
          <h1 className="text-[34px] font-bold tracking-tight">ProCam</h1>
          <p className="mx-auto max-w-xs text-[17px] leading-snug text-white/60">
            Video, foto, raffica, time-lapse e registrazione in loop.
          </p>
        </div>
        <button
          onClick={() => {
            unlockFeedback();
            try { void (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("portrait")?.catch(() => {}); } catch { /* non supportato su iPhone */ }
            setStarted(true);
          }}
          className="rounded-full bg-ios-yellow px-8 py-3 text-[17px] font-semibold text-black active:opacity-80"
        >
          Apri fotocamera
        </button>
        <p className="max-w-xs text-[13px] text-white/40">
          Su iPhone aggiungi la pagina alla schermata Home da Safari per usarla a schermo intero.
        </p>
      </main>
    );
  }

  // Il mirino occupa tutto lo schermo; i comandi stanno sopra l'immagine.
  const vfTop = "0px";
  const vfHeight = "100cqh";
  const levelOk = Math.abs(tilt) < 2;

  return (
    <main ref={shellRef} className="cam-shell">
      <div className="cam-ui absolute overflow-hidden bg-black" style={uiStyle}>
        {/* Mirino */}
        <div
          ref={vfRef}
          className="absolute inset-x-0 overflow-hidden bg-neutral-900"
          style={{ top: vfTop, height: vfHeight }}
        >
          <video
            ref={videoRef}
            autoPlay playsInline muted
            className={`pointer-events-none h-full w-full object-cover ${pinching ? "" : "transition-transform duration-200"}`}
            style={{ transform: `scale(${digitalZoom * lensScale}) ${facing === "user" ? "scaleX(-1)" : ""}` }}
          />
          {grid && (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/35" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/35" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/35" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/35" />
            </div>
          )}
          {level && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={`h-[2px] rounded-full transition-all ${levelOk ? "w-24 bg-ios-yellow" : "w-24 bg-white"}`}
                style={{ transform: `rotate(${levelOk ? 0 : -tilt}deg)` }}
              />
            </div>
          )}

          {/* Livello di tocco: tap = fuoco, swipe = cambia modo. Sta sotto ai pulsanti. */}
          <div
            className="absolute inset-0"
            style={{ touchAction: "none" }}
            onPointerDown={vfDown}
            onPointerMove={vfMove}
            onPointerUp={vfUp}
            onPointerCancel={vfCancel}
          />
          {focus && (
            <div
              key={focus.id}
              className="focus-ring pointer-events-none absolute h-[76px] w-[76px] -translate-x-1/2 -translate-y-1/2 border-[1.5px] border-ios-yellow"
              style={{ left: focus.x, top: focus.y }}
            />
          )}
          {flash && <div className="pointer-events-none absolute inset-0 bg-white" />}
          {countdown > 0 && (
            <div className="tnum pointer-events-none absolute inset-0 flex items-center justify-center text-[140px] font-extralight text-white drop-shadow-lg">
              {countdown}
            </div>
          )}

          {/* Opzioni (chevron) o zoom, in fondo al mirino */}
          {optionsOpen ? (
            <div className="fade-in absolute inset-x-0 flex justify-center px-3" style={{ bottom: `calc(var(--sa-bottom) + ${CONTROLS_H + 10}px)` }}>
              {sub === null ? (
                <div className="glass flex items-center gap-3 rounded-full px-3 py-2">
                  <OptBtn label="Timer" on={timer > 0} onClick={() => setSub("timer")}>
                    <Timer size={22} strokeWidth={1.8} />
                  </OptBtn>
                  <OptBtn label="Griglia" on={grid} onClick={() => setGrid(!grid)}>
                    <Grid3x3 size={22} strokeWidth={1.8} />
                  </OptBtn>
                  <OptBtn label="Livella" on={level} onClick={enableLevel}>
                    <Ruler size={22} strokeWidth={1.8} />
                  </OptBtn>
                  <OptBtn label="Lente" on={lens === "linear"} onClick={() => setSub("lens")}>
                    <Maximize size={22} strokeWidth={1.8} />
                  </OptBtn>
                  <OptBtn label="Impostazioni" on={false} onClick={() => setPanel("settings")}>
                    <Settings size={22} strokeWidth={1.8} />
                  </OptBtn>
                </div>
              ) : (
                <div className="glass flex items-center gap-1 rounded-full px-2 py-1.5 text-[15px] font-medium">
                  {(sub === "timer"
                    ? [{ l: "No", v: 0 }, { l: "3 s", v: 3 }, { l: "10 s", v: 10 }]
                    : [{ l: "Wide", v: "wide" }, { l: "Lineare", v: "linear" }]
                  ).map((o) => {
                    const active = sub === "timer" ? timer === o.v : lens === o.v;
                    return (
                      <button
                        key={o.l}
                        onClick={() => { if (sub === "timer") setTimer(o.v as number); else setLens(o.v as "wide" | "linear"); setSub(null); }}
                        className={`rot rounded-full px-4 py-1.5 ${active ? "text-ios-yellow" : "text-white"}`}
                      >
                        {o.l}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="absolute inset-x-0 flex justify-center" style={{ bottom: `calc(var(--sa-bottom) + ${CONTROLS_H + 10}px)` }}>
              <div
                className={`glass flex touch-none items-center gap-1 rounded-full p-[3px] transition-opacity ${dialOn ? "opacity-0" : ""}`}
                onPointerDown={pillsDown}
                onPointerMove={pillsMove}
                onPointerUp={pillsUp}
                onPointerCancel={pillsUp}
              >
                {ZOOM_PRESETS.map((z) => {
                  const active = [...ZOOM_PRESETS].reverse().find((q) => zoom >= q - 0.001) ?? 0.5;
                  const on = z === active;
                  return (
                    <button
                      key={z}
                      onClick={() => { if (Date.now() - dialEndedAtRef.current > 600) pickZoom(z); }}
                      className={`rot cam-btn tnum text-[13px] font-semibold ${on ? "h-[38px] min-w-[38px] bg-black/55 px-1.5 text-ios-yellow" : "h-[30px] w-[30px] text-white"}`}
                    >
                      {on ? `${fmtZoom(zoom)}×` : zoomLabel(z)}
                    </button>
                  );
                })}
              </div>
              {dialOn && <ZoomDial zoom={zoom} minZoom={minZoom} />}
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 h-[120px] bg-gradient-to-b from-black/40 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[300px] bg-gradient-to-t from-black/55 to-transparent" />

        {error && (
          <div className="glass-strong fade-in absolute inset-x-4 z-30 rounded-2xl p-3 text-center text-[14px]" style={{ top: `calc(var(--sa-top) + ${TOP_BAR + 8}px)` }}>
            {error}
          </div>
        )}

        <div className="pointer-events-none absolute" style={{ inset: "var(--sa-top) var(--sa-right) var(--sa-bottom) var(--sa-left)" }}>
          {/* Barra in alto */}
          <header className="pointer-events-auto absolute inset-x-0 top-0 grid h-[44px] grid-cols-[1fr_auto_1fr] items-center px-5">
            <div className="flex">
              <button
                onClick={() => setTorch(!torch)}
                aria-label="Torcia"
                className={`rot flex h-10 w-10 items-center justify-start drop-shadow ${torch ? "text-ios-yellow" : "text-white"}`}
              >
                <Zap size={22} strokeWidth={1.8} fill={torch ? "currentColor" : "none"} />
              </button>
            </div>
            <div className="flex justify-center">
              {recording ? (
                <div className="rot tnum rounded-md bg-ios-red px-2.5 py-[3px] text-[17px] font-semibold leading-tight">{fmt(elapsed)}</div>
              ) : (
                <button onClick={() => { setOptionsOpen(!optionsOpen); setSub(null); }} aria-label={optionsOpen ? "Nascondi opzioni" : "Mostra opzioni"} className="rot flex h-10 w-12 items-center justify-center text-white drop-shadow">
                  <ChevronUp size={22} strokeWidth={2.2} className={`transition-transform duration-200 ${optionsOpen ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 text-[15px] font-semibold drop-shadow">
              {isVideoMode ? (
                <>
                  <button
                    disabled={recording}
                    onClick={() => { const k = Object.keys(RES) as ResKey[]; setRes(k[(k.indexOf(res) + 1) % k.length]!); }}
                    className="rot tnum disabled:opacity-50"
                  >
                    {RES_LABEL[res]}
                  </button>
                  <button
                    disabled={recording}
                    onClick={() => setFps(FPS_OPTIONS[(FPS_OPTIONS.indexOf(fps) + 1) % FPS_OPTIONS.length]!)}
                    className="rot tnum disabled:opacity-50"
                  >
                    {fps}
                  </button>
                </>
              ) : (
                timer > 0 && (
                  <button onClick={() => { setOptionsOpen(true); setSub("timer"); }} className="rot flex items-center gap-1 text-ios-yellow">
                    <Timer size={20} strokeWidth={1.8} />
                    <span className="tnum">{timer}</span>
                  </button>
                )
              )}
            </div>
          </header>

          {mode === "loop" && recording && (
            <div className="rot glass absolute left-1/2 top-[48px] -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium tnum">
              {loopLocked ? "Loop bloccato · registrazione" : `Loop ${fmt(Math.min(loopBuf, loopMin * 60))} / ${fmt(loopMin * 60)}`}
            </div>
          )}

          {/* Selettore dei modi */}
          <div
            ref={pickerRef}
            className="pointer-events-auto absolute inset-x-0 overflow-hidden"
            style={{ bottom: SHUTTER_BOTTOM + 76 + 12, height: 32, touchAction: "none" }}
            onPointerDown={onGestureDown}
            onPointerUp={(e) => onGestureUp(e)}
            onPointerCancel={() => { gestureRef.current = null; }}
          >
            <div className="relative flex h-full w-max items-center gap-[6px] transition-transform duration-300 ease-out" style={{ transform: `translateX(${shift}px)` }}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  ref={(el) => { modeRefs.current[m.id] = el; }}
                  disabled={recording}
                  onClick={() => setMode(m.id)}
                  className={`rot px-[10px] py-1 text-[13px] font-semibold uppercase tracking-[0.04em] transition-colors disabled:opacity-100 ${mode === m.id ? "text-ios-yellow" : "text-white"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Anteprima ultimo scatto · otturatore · cambia camera */}
          <footer className="pointer-events-auto absolute inset-x-0 flex items-center justify-between px-8" style={{ bottom: SHUTTER_BOTTOM, height: 76 }}>
            <button onClick={() => setPanel("gallery")} aria-label="Libreria" className="rot h-[48px] w-[48px] overflow-hidden rounded-[10px] bg-ios-sheet">
              {clips[0] && (clips[0].kind === "photo" ? <img src={clips[0].url} className="h-full w-full object-cover" alt="" /> : <video src={clips[0].url} muted playsInline className="h-full w-full object-cover" />)}
            </button>

            <button onClick={shutter} aria-label="Scatta" className="group relative h-[76px] w-[76px] rounded-full border-[4px] border-white outline-none [-webkit-tap-highlight-color:transparent]">
              {/* Cerchio (pronto a scattare) e quadrato (in registrazione) sono due elementi che si scambiano con scala + opacità: niente animazione degli angoli, quindi niente residui grafici su Safari. */}
              <span
                className={`absolute inset-0 m-auto block h-[60px] w-[60px] rounded-full transition-[scale,opacity] duration-200 ease-out group-active:scale-[0.86] ${isVideoMode ? "bg-ios-red" : "bg-white"} ${recording ? "scale-50 opacity-0" : "opacity-100"}`}
              />
              <span
                className={`absolute inset-0 m-auto block h-[30px] w-[30px] rounded-[8px] bg-ios-red transition-[scale,opacity] duration-200 ease-out ${recording ? "opacity-100" : "scale-50 opacity-0"}`}
              />
            </button>

            {recording && mode === "loop" ? (
              <button onClick={stopRec} aria-label="Stop" className="rot cam-btn h-[48px] w-[48px] bg-ios-red">
                <Square size={18} fill="white" strokeWidth={0} />
              </button>
            ) : recording && mode === "video" ? (
              <button onClick={stillWhileRecording} aria-label="Scatta foto" className="rot flex h-[48px] w-[48px] items-center justify-center rounded-full">
                <span className="block h-[34px] w-[34px] rounded-full bg-white transition-transform active:scale-90" />
              </button>
            ) : recording ? (
              <span className="h-[48px] w-[48px]" aria-hidden="true" />
            ) : (
              <button onClick={flip} aria-label="Cambia fotocamera" className="rot cam-btn glass-strong h-[48px] w-[48px]">
                <RefreshCw size={22} strokeWidth={1.8} className="transition-transform duration-500 ease-out" style={{ transform: `rotate(${flipTurns * 180}deg)` }} />
              </button>
            )}
          </footer>
        </div>

        {/* Impostazioni */}
        {panel === "settings" && (
          <>
            <div className="fade-in absolute inset-0 z-40 bg-black/50" onClick={() => setPanel("none")} />
            <div className="sheet-in absolute inset-x-0 bottom-0 z-40 max-h-[88%] overflow-y-auto rounded-t-[14px] bg-black" style={{ paddingBottom: "max(var(--sa-bottom), 20px)" }}>
              <div className="sticky top-0 z-10 flex h-[52px] items-center justify-between bg-ios-sheet px-4">
                <span className="w-16" />
                <h2 className="text-[17px] font-semibold">Impostazioni</h2>
                <button onClick={() => setPanel("none")} className="w-16 text-right text-[17px] font-semibold text-ios-blue">Fine</button>
              </div>
              <div className="space-y-6 px-4 pb-4 pt-5">
                <Group title="Video">
                  <Row label="Risoluzione"><Seg options={Object.keys(RES)} value={res} onChange={(v) => setRes(v as ResKey)} disabled={recording} /></Row>
                  <Row label="Frame rate"><Seg options={FPS_OPTIONS.map(String)} value={String(fps)} onChange={(v) => setFps(+v)} disabled={recording} /></Row>
                  <Row label="Audio"><Switch on={audio} onChange={setAudio} disabled={recording} /></Row>
                  <Row label="Lente digitale"><Seg options={["Wide", "Linear"]} value={lens === "wide" ? "Wide" : "Linear"} onChange={(v) => setLens(v === "Wide" ? "wide" : "linear")} /></Row>
                </Group>
                <Group title="Loop recording" note={`1° tocco: avvia il loop (tiene sempre gli ultimi ${loopMin} min). 2° tocco: blocca il loop e continua a registrare da lì. 3° tocco: stop e salva un unico video.`}>
                  <Row label="Minuti recenti"><Seg options={["1", "2", "5", "10", "20"]} value={String(loopMin)} onChange={(v) => setLoopMin(+v)} disabled={recording} /></Row>
                </Group>
                <Group title="Time-lapse">
                  <Row label="Intervallo (s)"><Seg options={["0.5", "1", "2", "5"]} value={String(tlInterval)} onChange={(v) => setTlInterval(+v)} disabled={recording} /></Row>
                </Group>
                <p className="px-4 text-[13px] leading-snug text-white/50">Risoluzione e fps reali dipendono dal supporto di Safari sul tuo iPhone.</p>
              </div>
            </div>
          </>
        )}

        {/* Libreria */}
        {panel === "gallery" && (
          <div className="sheet-in absolute inset-0 z-40 flex flex-col bg-black" style={{ paddingTop: "var(--sa-top)" }}>
            <div className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4">
              <span />
              <div className="text-center leading-tight">
                <div className="text-[17px] font-semibold">Recenti</div>
                <div className="text-[12px] text-white/50">{clips.length} {clips.length === 1 ? "elemento" : "elementi"}</div>
              </div>
              <button onClick={() => setPanel("none")} className="justify-self-end text-[17px] font-semibold text-ios-blue">Fine</button>
            </div>
            {clips.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
                <p className="text-[22px] font-semibold">Nessuna foto o video</p>
                <p className="text-[15px] text-white/50">Foto e video che scatti appaiono qui.</p>
              </div>
            ) : (
              <div className="grid flex-1 grid-cols-4 content-start gap-[2px] overflow-y-auto" style={{ paddingBottom: "var(--sa-bottom)" }}>
                {clips.map((c) => (
                  <button key={c.id} onClick={() => setViewing(c)} className="relative aspect-square overflow-hidden bg-ios-sheet">
                    {c.kind === "photo" ? <img src={c.url} className="h-full w-full object-cover" alt={c.label} /> : <video src={c.url} muted playsInline className="h-full w-full object-cover" />}
                    {c.kind === "video" && <Play size={13} fill="white" strokeWidth={0} className="absolute bottom-1 left-1 drop-shadow" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Visualizzatore */}
        {viewing && (
          <div className="fade-in absolute inset-0 z-50 flex flex-col bg-black">
            <div className="glass-strong grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-2 pb-2" style={{ paddingTop: "calc(var(--sa-top) + 6px)" }}>
              <button onClick={() => setViewing(null)} className="flex items-center justify-self-start text-[17px] text-ios-blue">
                <ChevronLeft size={28} strokeWidth={2.2} />Recenti
              </button>
              <div className="text-center leading-tight">
                <div className="text-[15px] font-semibold">{new Date(viewing.at).toLocaleDateString("it-IT", { day: "numeric", month: "long" })}</div>
                <div className="text-[12px] text-white/60">{new Date(viewing.at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</div>
              </div>
              <span />
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              {viewing.kind === "photo" ? <img src={viewing.url} className="max-h-full max-w-full" alt="" /> : <video src={viewing.url} controls playsInline autoPlay className="max-h-full max-w-full" />}
            </div>
            <div className="glass-strong flex shrink-0 items-center justify-between px-6 pt-3" style={{ paddingBottom: "max(var(--sa-bottom), 12px)" }}>
              <button onClick={() => share(viewing)} aria-label="Condividi" className="p-1 text-ios-blue"><Share size={24} strokeWidth={1.8} /></button>
              <span className="text-[12px] text-white/50">{viewing.label}</span>
              <button
                onClick={() => { setClips((cs) => cs.filter((x) => x.id !== viewing.id)); URL.revokeObjectURL(viewing.url); setViewing(null); }}
                aria-label="Elimina"
                className="p-1 text-ios-blue"
              >
                <Trash2 size={24} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function OptBtn({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} className={`rot cam-btn h-10 w-10 ${on ? "text-ios-yellow" : "text-white"}`}>
      {children}
    </button>
  );
}

/** Gruppo di righe in stile "Impostazioni" di iOS (elenco raggruppato). */
function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 px-4 text-[13px] uppercase text-white/50">{title}</h3>
      <div className="divide-y divide-white/10 overflow-hidden rounded-[10px] bg-ios-sheet">{children}</div>
      {note && <p className="mt-1.5 px-4 text-[13px] leading-snug text-white/50">{note}</p>}
    </section>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex min-h-[48px] items-center justify-between gap-3 px-4 py-1.5"><span className="text-[17px]">{label}</span>{children}</div>;
}
/** Controllo segmentato iOS. */
function Seg({ options, value, onChange, disabled }: { options: string[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className={`flex rounded-lg bg-[rgb(118_118_128/0.24)] p-[2px] ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => (
        <button
          key={o}
          disabled={disabled}
          onClick={() => onChange(o)}
          className={`tnum min-w-[38px] rounded-[7px] px-2.5 py-[5px] text-[13px] font-medium transition-colors ${value === o ? "bg-[#636366] text-white shadow" : "text-white"}`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
/** Interruttore iOS. */
function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[31px] w-[51px] rounded-full transition-colors duration-200 disabled:opacity-50 ${on ? "bg-ios-green" : "bg-[rgb(120_120_128/0.36)]"}`}
    >
      <span className={`absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-md transition-transform duration-200 ${on ? "translate-x-5" : ""}`} />
    </button>
  );
}

/** Quadrante dello zoom ad arco (∩) con tacche e numeri, in stile iOS. L'origine è il centro dei pulsanti dello zoom. */
function ZoomDial({ zoom, minZoom }: { zoom: number; minZoom: number }) {
  const R = DIAL_R;
  const SPAN = DIAL_SPAN;
  const lnz = Math.log(zoom);
  const phi = (v: number) => 90 - DIAL_K * (Math.log(v) - lnz);
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: r * Math.cos(a), y: R - r * Math.sin(a) };
  };
  const band = (() => {
    const o = R + 8, i = R - 44;
    const a = pt(90 + SPAN, o), b = pt(90 - SPAN, o), c = pt(90 - SPAN, i), d = pt(90 + SPAN, i);
    return `M ${a.x} ${a.y} A ${o} ${o} 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${i} ${i} 0 0 0 ${d.x} ${d.y} Z`;
  })();
  return (
    <svg className="fade-in pointer-events-none absolute left-1/2 top-1/2 overflow-visible" width="1" height="1" aria-hidden="true">
      <g transform={`translate(0 ${-DIAL_SHIFT})`} style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.65)) drop-shadow(0 0 5px rgba(0,0,0,0.35))" }}>
        <path d={band} fill="none" />
        {DIAL_TICKS.filter((t) => t.v >= minZoom - 1e-6 && t.v <= MAX_ZOOM + 1e-6).map((t) => {
          const f = phi(t.v);
          const off = Math.abs(f - 90);
          if (off > SPAN - 2) return null;
          const p1 = pt(f, R + 1), p2 = pt(f, R - (t.major ? 13 : 8));
          const lab = pt(f, R - 29);
          const op = Math.max(0.15, 1 - off / 65);
          return (
            <g key={t.v} opacity={op}>
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#fff" strokeWidth={t.major ? 2 : 1.4} strokeLinecap="round" />
              {t.major && (
                <text x={lab.x} y={lab.y} fill="#fff" fontSize="13" fontWeight="600" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${90 - f} ${lab.x} ${lab.y})`}>
                  {String(t.v).replace(".", ",")}
                </text>
              )}
            </g>
          );
        })}
        {/* indicatore fisso al centro e valore attuale */}
        <line x1="0" y1={-5} x2="0" y2={19} stroke="#FFD60A" strokeWidth="3" strokeLinecap="round" />
        <text x="0" y={-24} fill="#FFD60A" fontSize="17" fontWeight="600" textAnchor="middle">{fmtZoom(zoom)}×</text>
      </g>
    </svg>
  );
}
