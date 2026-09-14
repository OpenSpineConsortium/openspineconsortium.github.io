/* Remote detector: the model runs on a server and this page only sends pixels.
 *
 * WHY. Anything a browser loads, a visitor can save: a model served as a file is a model
 * given away. The detector and the level model therefore live behind one endpoint and no
 * parameter ever reaches the client. This class keeps the SpineDetector interface the
 * page already used (load / infer -> {dets, ms, backend, tiles, mode, band}) so the
 * drawing and measurement code did not change; what changed is that every detection now
 * also carries the model's level name (`level`, `level_conf`, `level_run`, `top3`).
 *
 * The endpoint is chosen in this order: ?service=URL on the page, localStorage
 * "levelIdService", then SERVICE_DEFAULT. The service answers GET /health and
 * POST /infer (multipart image, conf, imgsz).
 */

export const SERVICE_DEFAULT = "https://level-id.openspineconsortium.org";

export function serviceURL() {
  const q = new URLSearchParams(location.search).get("service");
  if (q) { try { localStorage.setItem("levelIdService", q); } catch {} return q.replace(/\/$/, ""); }
  try { const s = localStorage.getItem("levelIdService"); if (s) return s.replace(/\/$/, ""); } catch {}
  return SERVICE_DEFAULT;
}

export class RemoteDetector {
  constructor({ url = serviceURL(), imgsz = 640 } = {}) {
    this.url = url; this.imgsz = imgsz; this.health = null; this.backend = "server";
  }

  async load(onStatus = () => {}) {
    onStatus("contacting the level service…");
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${this.url}/health`, { signal: ctl.signal, mode: "cors" });
      if (!r.ok) throw new Error(`service answered ${r.status}`);
      this.health = await r.json();
    } catch (e) {
      throw new Error(`level service unreachable at ${this.url} (${e.message}). `
        + "The model runs on a server, not in this page; when the server is down there is nothing to run.");
    } finally { clearTimeout(t); }
    onStatus("ready");
    this.adapter = this.health.device === "cuda" ? "server GPU" : "server CPU";
    return this.backend;
  }

  /** Same signature as SpineDetector.infer; `mode` is decided server-side. */
  async infer(source, w, h, conf = 0.3, mode = "auto") {
    const t0 = performance.now();
    const blob = source instanceof Blob ? source
      : await (source.convertToBlob ? source.convertToBlob({ type: "image/png" })
                                    : new Promise(res => source.toBlob(res, "image/png")));
    const fd = new FormData();
    fd.append("image", blob, "film.png");
    fd.append("conf", String(conf));
    fd.append("imgsz", String(this.imgsz));
    const r = await fetch(`${this.url}/infer`, { method: "POST", body: fd, mode: "cors" });
    if (!r.ok) throw new Error(`service answered ${r.status}`);
    const out = await r.json();
    // the server works on the image as sent; the page's overlay is in the same pixel grid,
    // except when the server downscaled a very large upload
    const sx = w / (out.width || w), sy = h / (out.height || h);
    const dets = out.dets.map(d => ({
      ...d,
      x0: d.x0 * sx, y0: d.y0 * sy, x1: d.x1 * sx, y1: d.y1 * sy,
      kpts: d.kpts.map(k => ({ ...k, x: k.x * sx, y: k.y * sy })),
    }));
    return { dets, ms: performance.now() - t0, serverMs: out.ms, backend: this.backend,
             tiles: 1, mode: "server", band: null, model: out.model, run: out.run };
  }
}

/** Level names from the model, in the page's naming convention (the sacrum is "S1"). */
export function modelLevels(dets) {
  const cy = d => (d.y0 + d.y1) / 2;
  return [...dets].sort((a, b) => cy(b) - cy(a))
    .map(d => ({ ...d, level: (d.level_run || d.level || "?").replace("sacrum", "S1"), named: Boolean(d.level_run || d.level),
                 modelNamed: true }))
    .reverse();
}
