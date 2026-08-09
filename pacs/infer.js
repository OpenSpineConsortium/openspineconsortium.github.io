/*
  OpenSpineConsortium — in-browser vertebral corner detection.

  Runs a YOLO11n-Pose model (Ultralytics, exported to ONNX opset 12) entirely on the
  client: WebGPU where the browser has it, single-threaded WASM everywhere else. The
  image never leaves the machine -- there is no upload endpoint, and that is the point
  as much as the latency is.

  Model: one class ("vertebra"), four keypoints per instance, in the fixed order

      0 sup_ant   1 sup_post   2 inf_ant   3 inf_post

  which is the order the training labels were written in (scripts/buu_to_yolo.py).
  Ultralytics keypoints are POSITIONAL, so this order is a contract with the weights,
  not a convention -- permute it and every angle silently reads off the wrong pair.

  Everything below the session boundary is pure and exported, so the decode can be
  tested against the Python reference without a browser (tools/test_decode.mjs).
*/

const ORT_VER = "1.20.1";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;

export const KPT_NAMES = ["sup_ant", "sup_post", "inf_ant", "inf_post"];
export const KPT_LABEL = {
  sup_ant:  "superior endplate, anterior",
  sup_post: "superior endplate, posterior",
  inf_ant:  "inferior endplate, anterior",
  inf_post: "inferior endplate, posterior",
};

/* Bansal et al. score at conf 0.5; scripts/evaluate_yolo.py uses the same, so the
   browser reproduces the reported numbers rather than a prettier threshold. NMS IoU
   is Ultralytics' predict default. */
export const CONF_DEFAULT = 0.5;
export const NMS_IOU = 0.7;
const PAD_GREY = 114;            // Ultralytics LetterBox fill

/* ── letterbox ────────────────────────────────────────────────────────────────
   Aspect ratio is PRESERVED. The 640x640 squash in the published baseline changes
   every angle on the film -- a true 45 deg endplate renders at 58.7 deg on a median
   lumbar lateral -- and this model is measured in degrees. */
export function letterboxParams(w, h, S) {
  const scale = Math.min(S / w, S / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const left = Math.round((S - nw) / 2 - 0.1);
  const top  = Math.round((S - nh) / 2 - 0.1);
  return { scale, nw, nh, left, top };
}

export function preprocess(source, w, h, S) {
  const lb = letterboxParams(w, h, S);
  const cv = new OffscreenCanvas(S, S);
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.fillStyle = `rgb(${PAD_GREY},${PAD_GREY},${PAD_GREY})`;
  cx.fillRect(0, 0, S, S);
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = "high";
  cx.drawImage(source, lb.left, lb.top, lb.nw, lb.nh);
  const px = cx.getImageData(0, 0, S, S).data;
  const n = S * S;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i]         = px[i * 4]     / 255;
    data[i + n]     = px[i * 4 + 1] / 255;
    data[i + 2 * n] = px[i * 4 + 2] / 255;
  }
  return { data, lb };
}

/* ── decode ─────────────────────────────────────────────────────────────────── */

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

export function nms(dets, thr = NMS_IOU) {
  const keep = [];
  for (const d of [...dets].sort((p, q) => q.conf - p.conf))
    if (!keep.some(k => iou(k, d) > thr)) keep.push(d);
  return keep;
}

/**
 * Decode a raw Ultralytics pose head.
 * @param out  Float32Array, layout [1, 4+1+K*3, N], CHANNEL-major (stride N).
 * @param nCh  channel count (17 for one class and four keypoints)
 * @param nAnc anchor count (8400 at 640, 21504 at 1024)
 * @param lb   letterbox params used for preprocessing -- undone here
 */
export function decode(out, nCh, nAnc, lb, conf = CONF_DEFAULT) {
  const K = (nCh - 5) / 3;
  const at = (c, i) => out[c * nAnc + i];
  const raw = [];
  for (let i = 0; i < nAnc; i++) {
    const c = at(4, i);
    if (c < conf) continue;
    const cx = at(0, i), cy = at(1, i), bw = at(2, i), bh = at(3, i);
    const kpts = [];
    for (let k = 0; k < K; k++)
      kpts.push({ name: KPT_NAMES[k] || `k${k}`,
                  x: at(5 + k * 3, i), y: at(6 + k * 3, i), v: at(7 + k * 3, i) });
    raw.push({ conf: c, x0: cx - bw / 2, y0: cy - bh / 2,
               x1: cx + bw / 2, y1: cy + bh / 2, kpts });
  }
  // Undo the letterbox AFTER NMS: IoU is scale-invariant, so doing it here keeps the
  // suppression identical to Ultralytics' (which also suppresses in network space).
  return nms(raw).map(d => ({
    conf: d.conf,
    x0: (d.x0 - lb.left) / lb.scale, y0: (d.y0 - lb.top) / lb.scale,
    x1: (d.x1 - lb.left) / lb.scale, y1: (d.y1 - lb.top) / lb.scale,
    kpts: d.kpts.map(k => ({ name: k.name, v: k.v,
                             x: (k.x - lb.left) / lb.scale,
                             y: (k.y - lb.top) / lb.scale })),
  }));
}

/* ── anatomy ────────────────────────────────────────────────────────────────── */

/** Name the detected instances from the BOTTOM UP.
 *
 *  Bottom-up, not top-down: the caudal end of a lumbar lateral is anchored by the
 *  sacrum, while the cranial end is wherever the collimator happened to stop. Counting
 *  down from the top makes every level name depend on how much thoracic spine the
 *  radiographer included. */
export function assignLevels(dets) {
  const CHAIN = ["S1", "L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9",
                 "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1"];
  const cy = d => (d.y0 + d.y1) / 2;
  return [...dets].sort((a, b) => cy(b) - cy(a))
                  .map((d, i) => ({ ...d, level: CHAIN[i] || `?${i}` }))
                  .reverse();
}

const kp = (d, name) => d.kpts.find(k => k.name === name);

/** Acute angle of a vector to the horizontal, in degrees. Orientation-free: a film
 *  scanned facing the other way gives the same number. */
export function angleToHorizontal(dx, dy) {
  let a = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
  if (a > 90) a = 180 - a;
  return a;
}

/** Acute angle between two lines (a Cobb angle). */
export function cobb(v1, v2) {
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) /
            (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  let a = Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
  if (a > 90) a = 180 - a;
  return a;
}

function endplateVec(d, which = "sup") {
  const a = kp(d, `${which}_ant`), p = kp(d, `${which}_post`);
  if (!a || !p) return null;
  return [p.x - a.x, p.y - a.y];
}

/**
 * SS and LL from named detections.
 *
 * PI and PT are deliberately absent. Both need the femoral head centres, and the
 * model has no hip channel that survives on a real film -- a pelvis class trained on
 * synthetic DRRs fires on 40/40 DRRs and 0/40 radiographs. Reporting a number here
 * would mean inventing the one landmark the film may not even contain.
 */
export function computeAngles(levelled) {
  const byLevel = Object.fromEntries(levelled.map(d => [d.level, d]));
  const out = {};
  const s1 = byLevel.S1, l1 = byLevel.L1;
  const vS1 = s1 && endplateVec(s1, "sup");
  if (vS1) out.SS = angleToHorizontal(vS1[0], vS1[1]);
  const vL1 = l1 && endplateVec(l1, "sup");
  if (vS1 && vL1) out.LL = cobb(vL1, vS1);
  return out;
}

/* ── session ────────────────────────────────────────────────────────────────── */

let ort = null;

async function loadOrt() {
  if (ort) return ort;
  ort = await import(/* @vite-ignore */ `${ORT_BASE}ort.webgpu.bundle.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  // GitHub Pages sends no COOP/COEP, so SharedArrayBuffer is unavailable and a
  // threaded build would fail at startup rather than run slowly. Ask for one thread.
  ort.env.wasm.numThreads = 1;
  // Ask for the discrete card on a dual-GPU machine. Measured on Chrome/Windows this
  // changes NOTHING -- the GPU process exposes exactly one adapter, fixed at launch by
  // --force_high_performance_gpu or the per-app Windows graphics preference, and both
  // powerPreference values then return that same adapter. It is kept because it is the
  // correct request and does select on platforms that do expose both; the machine-level
  // setting is what actually moves the number. Measured on one film, one set of
  // weights, 640 px:  NVIDIA Turing 133 ms  |  Intel Gen-9 445 ms  |  WASM CPU 1093 ms,
  // all three returning the SAME angles to 0.1 deg.
  if (ort.env.webgpu) ort.env.webgpu.powerPreference = "high-performance";
  ort.env.logLevel = "error";
  return ort;
}

/** Which card the browser actually handed out. Worth surfacing: a machine with a
 *  discrete GPU can still be running this on its integrated one, and that is a ~3x
 *  difference the user can fix in one OS setting rather than a limit of the page. */
async function describeAdapter() {
  try {
    if (!navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a) return null;
    const i = a.info || {};
    const s = [i.vendor, i.architecture].filter(Boolean).join(" ");
    return s || null;
  } catch { return null; }
}

export class SpineDetector {
  constructor({ modelUrl, imgsz }) {
    this.modelUrl = modelUrl;
    this.imgsz = imgsz;
    this.session = null;
    this.backend = null;
  }

  async load(onStatus = () => {}) {
    const o = await loadOrt();
    onStatus("fetching model…");
    const buf = await (await fetch(this.modelUrl)).arrayBuffer();
    for (const ep of ["webgpu", "wasm"]) {
      try {
        onStatus(`starting ${ep}…`);
        // A fresh copy per attempt: session creation may take ownership of the buffer,
        // and a failed WebGPU attempt must not leave the WASM fallback with nothing.
        this.session = await o.InferenceSession.create(new Uint8Array(buf), {
          executionProviders: [ep], graphOptimizationLevel: "all",
        });
        this.backend = ep;
        break;
      } catch (e) {
        if (ep === "wasm") throw e;
        console.warn(`[infer] ${ep} unavailable, falling back:`, e.message);
      }
    }
    // First run compiles shaders / warms the allocator; do it now so the number the
    // user sees on their own image is steady-state and not a one-off compile cost.
    onStatus("warming up…");
    const S = this.imgsz;
    await this.session.run({ images: new o.Tensor("float32",
      new Float32Array(3 * S * S).fill(PAD_GREY / 255), [1, 3, S, S]) });
    onStatus("ready");
    this.adapter = await describeAdapter();
    return this.backend;
  }

  /** @returns {{dets:Array, ms:number, backend:string, lb:object}} */
  async infer(source, w, h, conf = CONF_DEFAULT) {
    const o = await loadOrt();
    const S = this.imgsz;
    const { data, lb } = preprocess(source, w, h, S);
    const t0 = performance.now();
    const res = await this.session.run(
      { images: new o.Tensor("float32", data, [1, 3, S, S]) });
    const key = this.session.outputNames[0];
    const out = res[key];
    const ms = performance.now() - t0;
    const [, nCh, nAnc] = out.dims;
    return { dets: decode(out.data, nCh, nAnc, lb, conf), ms, backend: this.backend, lb };
  }
}
