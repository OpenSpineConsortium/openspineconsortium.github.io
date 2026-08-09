/*
  Regression test for the browser decoder.

  The page's numbers are only trustworthy if its JS reproduces what the model produces
  under Python -- confidence filter, NMS, keypoint slot order and the letterbox
  inverse. This feeds the SAME raw network output (dumped from onnxruntime under
  Python) into pacs/infer.js and asserts the decoded detections match the Python
  reference. It skips the network entirely, so it is a test of the decode and nothing
  else -- which is where the silent failures live.

    node pacs/tools/test_decode.mjs <ref_dir>

  <ref_dir> holds reference.json + out<N>.bin, built by the block in the session log
  that runs onnxruntime inside the container.
*/
import { readFileSync } from "node:fs";
import { decode, assignLevels, computeAngles, letterboxParams } from "../infer.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node test_decode.mjs <ref_dir>"); process.exit(2); }

const ref = JSON.parse(readFileSync(`${dir}/reference.json`, "utf8"));
const TOL = 1e-3;                       // px; float32 round-trip only
let fails = 0, checks = 0;

const near = (a, b, what) => {
  checks++;
  if (Math.abs(a - b) > TOL) { fails++; console.error(`  FAIL ${what}: ${a} vs ${b}`); }
};

for (let n = 0; n < ref.length; n++) {
  const r = ref[n];
  const buf = readFileSync(`${dir}/out${n}.bin`);
  const out = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const [, nCh, nAnc] = r.dims;

  // the letterbox must be re-derived, not read from the reference -- that is half of
  // what is being tested
  const lb = letterboxParams(r.w, r.h, 640);
  near(lb.scale, r.lb.scale, `${r.image} lb.scale`);
  near(lb.left,  r.lb.left,  `${r.image} lb.left`);
  near(lb.top,   r.lb.top,   `${r.image} lb.top`);

  const dets = decode(out, nCh, nAnc, lb, 0.5);
  checks++;
  if (dets.length !== r.n_dets) {
    fails++; console.error(`  FAIL ${r.image}: ${dets.length} dets vs ${r.n_dets}`);
    continue;
  }
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i], e = r.dets[i];
    near(d.conf, e.conf, `${r.image}[${i}].conf`);
    near(d.x0, e.box[0], `${r.image}[${i}].x0`);
    near(d.y0, e.box[1], `${r.image}[${i}].y0`);
    near(d.x1, e.box[2], `${r.image}[${i}].x1`);
    near(d.y1, e.box[3], `${r.image}[${i}].y1`);
    for (let k = 0; k < 4; k++) {
      near(d.kpts[k].x, e.kpts[k][0], `${r.image}[${i}].kpt${k}.x`);
      near(d.kpts[k].y, e.kpts[k][1], `${r.image}[${i}].kpt${k}.y`);
    }
  }
  const lv = assignLevels(dets);
  const a = computeAngles(lv);
  console.log(`  ${r.image.padEnd(24)} ${dets.length} dets  `
    + `levels ${lv.map(d => d.level).join(",")}  `
    + `SS ${a.SS?.toFixed(1) ?? "n/a"}  LL ${a.LL?.toFixed(1) ?? "n/a"}`);
}

/* Angle helpers, checked against hand-computed values -- these decide what the page
   prints, and a sign or a degrees/radians slip would still "look like an angle". */
const { angleToHorizontal, cobb } = await import("../infer.js");
near(angleToHorizontal(1, 0), 0, "horiz 0");
near(angleToHorizontal(1, 1), 45, "horiz 45");
near(angleToHorizontal(-1, 1), 45, "horiz 45 mirrored");   // orientation-free
near(angleToHorizontal(0, 1), 90, "horiz 90");
near(cobb([1, 0], [0, 1]), 90, "cobb 90");
near(cobb([1, 0], [1, 1]), 45, "cobb 45");
near(cobb([1, 0], [-1, 1]), 45, "cobb 45 mirrored");

console.log(fails ? `\nFAILED ${fails}/${checks}` : `\nOK — ${checks} checks passed`);
process.exit(fails ? 1 : 0);
