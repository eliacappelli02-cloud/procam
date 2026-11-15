export type Clip = { id: string; url: string; blob: Blob; kind: "video" | "photo"; label: string; at: number; ext: string };

export function pickMime(): { mime: string; ext: string } {
  const opts = [
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm", "webm"],
  ] as const;
  if (typeof MediaRecorder === "undefined") return { mime: "", ext: "mp4" };
  for (const [m, e] of opts) if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: e };
  return { mime: "", ext: "mp4" };
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Records a stream as one clip. */
export class SimpleRecorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  constructor(stream: MediaStream, private onDone: (b: Blob) => void, bitrate?: number) {
    const { mime } = pickMime();
    this.rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(bitrate ? { videoBitsPerSecond: bitrate } : {}) });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.onDone(new Blob(this.chunks, { type: this.rec.mimeType || mime || "video/mp4" }));
    this.rec.start(1000);
  }
  stop() { if (this.rec.state !== "inactive") this.rec.stop(); }
}

/**
 * Loop recording (single continuous file).
 * Two overlapping recorders: a new one starts every `windowSec`, and the older one is
 * discarded once a newer one has `windowSec` of footage. So at any moment the oldest
 * live recorder holds between windowSec and 2*windowSec of the most recent footage.
 * lock(): stop the overwriting; keep the oldest recorder and keep recording.
 * stop(): finish and return one single video.
 */
export class LoopRecorder {
  private recs: { rec: SimpleRecorder; at: number; done: Promise<Blob> }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  locked = false;
  constructor(private stream: MediaStream, private windowSec: number, private bitrate?: number) {}
  private spawn() {
    let resolve!: (b: Blob) => void;
    const done = new Promise<Blob>((r) => (resolve = r));
    this.recs.push({ rec: new SimpleRecorder(this.stream, resolve, this.bitrate), at: Date.now(), done });
    while (this.recs.length > 2) this.recs.shift()!.rec.stop(); // discard oldest
  }
  start() {
    this.spawn();
    this.timer = setInterval(() => this.spawn(), this.windowSec * 1000);
  }
  /** Seconds of footage currently buffered (in the oldest recorder). */
  buffered() { return this.recs[0] ? (Date.now() - this.recs[0].at) / 1000 : 0; }
  lock() {
    if (this.locked) return;
    this.locked = true;
    clearInterval(this.timer);
    while (this.recs.length > 1) this.recs.pop()!.rec.stop();
  }
  async stop(): Promise<{ blob: Blob; at: number } | null> {
    clearInterval(this.timer);
    const keep = this.recs[0];
    this.recs.slice(1).forEach((r) => r.rec.stop());
    this.recs = [];
    if (!keep) return null;
    keep.rec.stop();
    return { blob: await keep.done, at: keep.at };
  }
}
