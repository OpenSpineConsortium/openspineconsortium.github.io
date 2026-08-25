/*
  pacs/tools/reference_corners_decode.mjs — turn the network's raw output into the
  reference case's landmarks, using the page's own decoder.

  The decode is NOT reimplemented. Confidence filtering, NMS, keypoint slot order and the
  letterbox inverse all live in pacs/infer.js, the browser runs exactly those, and a second
  copy in Python or here would be a second thing to keep in step. pacs/tools/test_decode.mjs
  exists because that drift is where the silent failures live.

  What this writes into metrics.json:

    FOUR CORNERS PER VERTEBRA, from the network, replacing the two projected endplate
    extremes that were there. The reference pane now shows what the model is actually asked
    to predict, and it shows it in the place the model puts it.

    THE BICOXOFEMORAL POINT UNTOUCHED. It is a 3-D construction -- femoral heads fitted as
    spheres in the volume -- and no lateral-radiograph model predicts it. It keeps coming
    from ostk, which is the existing process.

    THE ANGLES LEFT ALONE. They are ostk's constructions, measured in the volume, and they
    are what the reference pane exists to show. The network's own SS and LL are computed and
    recorded alongside for comparison -- on this case 34.2 against 32.3 and 44.9 against
    45.7, which is the demo's real point: the film agrees with the volume to about two
    degrees.

    net.* METADATA so the page knows the default overlay was precomputed, with which model,
    and can re-run the network live when a reader picks a different one.

    node pacs/tools/reference_corners_decode.mjs data/xr/0003
*/
import { readFileSync, writeFileSync } from "node:fs";
import { decode, assignLevels, computeAngles, KPT_NAMES, KPT_LABEL } from "../infer.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node reference_corners_decode.mjs <case_dir>"); process.exit(2); }

const meta = JSON.parse(readFileSync(`${dir}/_net_meta.json`, "utf8"));
const buf = readFileSync(`${dir}/_net_raw.bin`);
const out = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

const conf = Number(process.env.CONF || 0.5);
const dets = decode(out, meta.nCh, meta.nAnc, meta.lb, conf);
const levelled = assignLevels(dets);
console.log(`  ${dets.length} detections at conf ${conf} -> levels ` +
            levelled.map(d => d.level).join(", "));

const metricsPath = `${dir}/metrics.json`;
const m = JSON.parse(readFileSync(metricsPath, "utf8"));
const prev = m.geometry.landmarks || [];

/* the one landmark that does not come from the network */
const bicox = prev.find(l => l.cls === "hip_axis" || l.id === "bicox");
if (!bicox) { console.error("  ! no bicoxofemoral landmark in the existing bundle"); process.exit(1); }

/* the palette xr.js uses for live predictions -- precomputed and re-inferred corners must
   be the same colour, or switching between them looks like a change in the anatomy */
const COLOR = { sup_ant: "#34d399", sup_post: "#60a5fa",
                inf_ant: "#fbbf24", inf_post: "#f472b6" };
const LEVEL_NOTE = {
  L1: " — cranial end of the lumbar lordosis Cobb construction.",
  L3: " — the apex level in most Roussouly types.",
  S1: " — the sacral plate. Sacral slope is its angle to the horizontal, and it is the "
      + "caudal end of the lordosis.",
};

const landmarks = [];
for (const d of levelled) {
  for (const name of KPT_NAMES) {
    const k = d.kpts.find(q => q.name === name);
    if (!k || !isFinite(k.x) || !isFinite(k.y)) continue;
    // the inferior pair of the bottom-most vertebra is annotated invisible in the training
    // data (BUU marks S1's superior plate only), so the model has nothing to predict there
    if (d.level === "S1" && name.startsWith("inf")) continue;
    landmarks.push({
      id: `${d.level}_${name}`,
      level: d.level,
      cls: name,
      label: `${d.level} ${KPT_LABEL[name]}`,
      xy: [Math.round(k.x * 100) / 100, Math.round(k.y * 100) / 100],
      color: COLOR[name] || "#f8fafc",
      conf: Math.round((k.v ?? d.conf) * 1000) / 1000,
      desc: `${d.level} ${KPT_LABEL[name]}${LEVEL_NOTE[d.level] || "."}`,
    });
  }
}
landmarks.push(bicox);

/* THE ANGLES ARE NOT REPLACED. They are ostk's constructions, measured in the volume,
   and they are what the reference pane exists to show: the CT's own answer. The network's
   corners are markers of what the model predicts, drawn on the same film -- two overlays
   that belong together precisely because they come from different places.

   The model's own SS and LL are computed anyway and recorded, because a reader comparing
   the panes will want to know how far the prediction sits from the volume, and because a
   large disagreement here is the first sign the corners landed badly. */
const netAngles = computeAngles(levelled);
const ref = Object.fromEntries((m.geometry.angles || []).map(a => [a.id, a.value]));
const cmp = Object.entries(netAngles).map(([k, v]) => {
  const r = ref[k];
  const d = (typeof r === "number") ? ` (ostk ${r}, delta ${(v - r).toFixed(1)})` : "";
  return `${k} ${v.toFixed(1)}${d}`;
});
console.log("  from the predicted corners: " + cmp.join(", "));

m.geometry.landmarks = landmarks;
m.geometry.net = {
  model: meta.model,
  imgsz: meta.imgsz,
  conf,
  detections: levelled.length,
  precomputed: true,
  angles_from_net: Object.fromEntries(
    Object.entries(netAngles).map(([k, v]) => [k, Math.round(v * 10) / 10])),
  note: "Corners predicted by the same network the user pane runs, on this DRR. The "
      + "bicoxofemoral point is a 3-D construction from ostk and is not predicted.",
};
writeFileSync(metricsPath, JSON.stringify(m, null, 1) + "\n");
console.log(`  wrote ${metricsPath}: ${landmarks.length} landmarks ` +
            `(${landmarks.length - 1} predicted + bicoxofemoral)`);
