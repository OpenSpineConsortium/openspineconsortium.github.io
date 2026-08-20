/* ============================================================
   Gallery — interactive 3-D label surfaces + count-free distributions.

   WHY SURFACES AND NOT SLICES. Every point this gallery makes is a SHAPE fact: a
   thirteenth rib on a lumbar body, a cage bridging an interspace, a transitional
   vertebra part-fused to the ala. A surface shows shape; a slice viewer makes you
   reconstruct it. Per-structure meshes also let the page isolate the one bone the
   case is an example of and fade everything else, which a volume viewer cannot do.

   THE PAYLOAD. One .bin per case holding every structure back to back, with a .json
   index naming the byte ranges. Positions are uint16 quantised into the case's own
   bounding box, normals int8. One request, no decompression, no per-structure fetch.

   NO LEVEL NAMES IN THE COPY. Sacralisation and lumbarisation are one morphology
   under two counts, so the captions describe what is visible and never assert which
   vertebra is which.
   ============================================================ */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DATA = "assets/gallery/";

const CASES = [
  { id: "0431", title: "A rib on a lumbar body",
    blurb: "Both sides carry an extra rib below the last thoracic pair. Class 74/75 " +
           "in the release, kept separate from the numbered ribs so it stays countable.",
    focus: (s) => s.name.includes("lumbar") },
  { id: "0033", title: "A part-fused transitional vertebra",
    blurb: "Six rib-free bodies above the sacrum, the lowest incompletely fused on the " +
           "left. Whether that is a sacralised or lumbarised segment depends on where " +
           "the count starts — the fusion itself does not.",
    focus: (s) => s.name === "L6" || s.name === "sacrum" },
  { id: "0631", title: "A hypoplastic twelfth rib",
    blurb: "The lowest rib is a tenth the length of the one above it — the extreme of " +
           "a distribution that turns out to be bimodal across the cohort.",
    focus: (s) => /rib_(left|right)_12$/.test(s.name) },
  { id: "1035", title: "Instrumentation",
    blurb: "Surgical hardware detected by density and confirmed by geometry. It matters " +
           "for more than completeness: metal bridging an interspace reads as fusion to " +
           "any distance measurement.",
    focus: (s) => s.kind === "hardware" },
  { id: "0004", title: "Unremarkable, for reference",
    blurb: "Five rib-free bodies above the sacrum, twelve rib pairs, nothing transitional.",
    focus: () => false },
];

/* ---------------------------------------------------------- mesh loading */
async function loadCase(id) {
  const [head, buf] = await Promise.all([
    fetch(`${DATA}${id}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(`${DATA}${id}.bin`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
  ]);
  const lo = new THREE.Vector3(...head.bbox_lo);
  const hi = new THREE.Vector3(...head.bbox_hi);
  const span = new THREE.Vector3().subVectors(hi, lo);
  const group = new THREE.Group();
  const parts = [];

  for (const s of head.structures) {
    const pos = new Uint16Array(buf, s.pos[0], s.pos[1] / 2);
    const nrm = new Int8Array(buf, s.nrm[0], s.nrm[1]);
    const idx = s.idx_bytes === 4
      ? new Uint32Array(buf, s.idx[0], s.idx[1] / 4)
      : new Uint16Array(buf, s.idx[0], s.idx[1] / 2);

    const p = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      p[i]     = lo.x + (pos[i]     / head.quant) * span.x;
      p[i + 1] = lo.y + (pos[i + 1] / head.quant) * span.y;
      p[i + 2] = lo.z + (pos[i + 2] / head.quant) * span.z;
    }
    const n = new Float32Array(nrm.length);
    for (let i = 0; i < nrm.length; i++) n[i] = nrm[i] / 127;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));

    const c = new THREE.Color(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255);
    const mat = new THREE.MeshStandardMaterial({
      color: c, roughness: 0.62, metalness: 0.05,
      transparent: true, opacity: 1,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData = s;
    group.add(mesh);
    parts.push({ mesh, meta: s });
  }
  // centre on the origin so orbiting feels like turning the specimen, not the camera
  const box = new THREE.Box3().setFromObject(group);
  const mid = box.getCenter(new THREE.Vector3());
  group.position.sub(mid);
  return { group, parts, radius: box.getSize(new THREE.Vector3()).length() / 2 };
}

/* ---------------------------------------------------------- one viewer */
function makeViewer(host, spec) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(38, 1, 1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x555044, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 0.6, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd4cc, 0.5);
  rim.position.set(-1, -0.3, -0.8);
  scene.add(rim);

  const controls = new OrbitControls(cam, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.9;
  // stop the drag from scrolling the page on touch, but let a plain swipe scroll
  renderer.domElement.style.touchAction = "pan-y";

  function size() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(size).observe(host);

  let parts = [];
  let raf = 0, visible = false;
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible) return;
    controls.update();
    renderer.render(scene, cam);
  }

  // only render what is on screen: five WebGL canvases all spinning is wasted battery
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    controls.autoRotate = visible;
  }, { threshold: 0.05 }).observe(host);

  loadCase(spec.id).then(({ group, parts: ps, radius }) => {
    parts = ps;
    scene.add(group);
    cam.position.set(radius * 2.0, radius * 0.35, radius * 2.0);
    cam.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    size();
    host.classList.remove("is-loading");
    tick();
    host.dispatchEvent(new CustomEvent("ready", { detail: { parts } }));
  }).catch((err) => {
    host.classList.remove("is-loading");
    host.classList.add("is-error");
    host.innerHTML = `<p class="gal__err">Could not load case ${spec.id} (${err.message}).</p>`;
  });

  return {
    highlight(on) {
      for (const { mesh, meta } of parts) {
        const isFocus = spec.focus(meta);
        mesh.material.opacity = on ? (isFocus ? 1 : 0.12) : 1;
        mesh.material.depthWrite = !on || isFocus;
      }
    },
    reset() { controls.autoRotate = true; },
    dispose() { cancelAnimationFrame(raf); renderer.dispose(); },
  };
}

/* ---------------------------------------------------------- distributions */
const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

/* Axis ticks are chosen to land on round numbers rather than at fixed fractions of the
   range: "0, 50, 100, 150" reads instantly where "0, 47, 94, 141" does not. */
function niceTicks(lo, hi, want) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));
  }
  return out;
}

function drawPanel(host, p) {
  // drawn large so the type survives being scaled into a card
  const W = 760, H = 430, L = 92, R = 26, T = 26, B = 88;
  const pw = W - L - R, ph = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "gal__svg",
                          role: "img", "aria-label": p.title });

  const counts = p.counts;
  const max = Math.max(...counts, 1);
  const bw = pw / counts.length;

  // horizontal gridlines first, so bars sit on top of them
  const yt = niceTicks(0, max, 4);
  for (const v of yt) {
    const y = T + ph - (v / max) * ph;
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 12, y: y + 6, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }

  counts.forEach((c, i) => {
    const h = (c / max) * ph;
    const r = el("rect", { x: L + i * bw + 1, y: T + ph - h,
                           width: Math.max(1.5, bw - 2), height: h, class: "gal__bar" });
    r.appendChild(el("title", null,
      p.type === "categorical"
        ? `${p.categories[i]}: ${c} cases`
        : `${p.edges[i].toFixed(2)}\u2013${p.edges[i + 1].toFixed(2)}: ${c} cases`));
    svg.appendChild(r);
  });

  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));

  if (p.type === "categorical") {
    p.categories.forEach((c, i) => {
      svg.appendChild(el("text", { x: L + i * bw + bw / 2, y: T + ph + 28,
                                   class: "gal__tick", "text-anchor": "middle" }, c));
    });
  } else {
    const lo = p.edges[0], hi = p.edges[p.edges.length - 1];
    for (const v of niceTicks(lo, hi, 5)) {
      const x = L + ((v - lo) / (hi - lo)) * pw;
      svg.appendChild(el("line", { x1: x, x2: x, y1: T + ph, y2: T + ph + 7,
                                   class: "gal__axis" }));
      svg.appendChild(el("text", { x, y: T + ph + 28, class: "gal__tick",
                                   "text-anchor": "middle" }, v));
    }
  }

  // axis TITLES -- without them a reader cannot tell what is counted, or in what unit
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 26, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 26, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 26 ${T + ph / 2})` }, "cases"));

  const wrap = document.createElement("figure");
  wrap.className = "gal__panel";
  wrap.appendChild(el2("h4", p.title));
  wrap.appendChild(el2("p", p.subtitle, "gal__sub"));
  wrap.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = p.caption;
  wrap.appendChild(cap);
  host.appendChild(wrap);
}

function el2(tag, text, cls) {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function drawScatter(host, p) {
  const W = 760, H = 470, L = 92, R = 26, T = 26, B = 92;
  const pw = W - L - R, ph = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "gal__svg",
                          role: "img", "aria-label": p.title });

  const xs = p.points.map((q) => q.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ys = p.points.map((q) => q.y);
  const yhi = Math.max(...ys);
  // log y: the gap spans two orders of magnitude and CONTACT is the interesting end
  const ly = (v) => Math.log10(Math.max(v, 0.2));
  const l0 = ly(0.2), l1 = ly(yhi);

  for (const v of [0.2, 0.5, 1, 2, 5, 10, 20, 50]) {
    if (v > yhi) break;
    const y = T + ph - ((ly(v) - l0) / (l1 - l0)) * ph;
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 12, y: y + 6, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }
  for (const v of niceTicks(x0, x1, 5)) {
    const x = L + ((v - x0) / (x1 - x0)) * pw;
    svg.appendChild(el("line", { x1: x, x2: x, y1: T + ph, y2: T + ph + 7, class: "gal__axis" }));
    svg.appendChild(el("text", { x, y: T + ph + 28, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }

  for (const q of p.points) {
    const cx = L + ((q.x - x0) / (x1 - x0 || 1)) * pw;
    const cy = T + ph - ((ly(q.y) - l0) / (l1 - l0 || 1)) * ph;
    svg.appendChild(el("circle", { cx, cy, r: q.f ? 4.2 : 2.6,
                                   class: q.f ? "gal__dot gal__dot--flag" : "gal__dot" }));
  }

  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 30, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel));
  svg.appendChild(el("text", { x: 26, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 26 ${T + ph / 2})` }, p.ylabel));

  // legend, because two dot sizes carrying meaning need saying out loud
  const lg = el("g", { transform: `translate(${L + pw - 210} ${T + 6})` });
  lg.appendChild(el("circle", { cx: 6, cy: -4, r: 2.6, class: "gal__dot" }));
  lg.appendChild(el("text", { x: 18, y: 0, class: "gal__tick" }, "no source LSTV label"));
  lg.appendChild(el("circle", { cx: 6, cy: 18, r: 4.2, class: "gal__dot gal__dot--flag" }));
  lg.appendChild(el("text", { x: 18, y: 22, class: "gal__tick" }, "carries an LSTV label"));
  svg.appendChild(lg);

  const wrap = document.createElement("figure");
  wrap.className = "gal__panel gal__panel--wide";
  wrap.appendChild(el2("h4", p.title));
  wrap.appendChild(el2("p", p.subtitle, "gal__sub"));
  wrap.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = p.caption;
  wrap.appendChild(cap);
  host.appendChild(wrap);
}

/* ---------------------------------------------------------- boot */
export function initGallery() {
  const grid = document.getElementById("gal-cases");
  if (!grid) return;

  for (const spec of CASES) {
    const card = document.createElement("article");
    card.className = "gal__case reveal";
    card.innerHTML = `
      <div class="gal__stage is-loading" data-case="${spec.id}">
        <span class="gal__spin" aria-hidden="true"></span>
      </div>
      <div class="gal__meta">
        <h3>${spec.title}</h3>
        <p>${spec.blurb}</p>
        <div class="gal__row">
          <button class="gal__btn" type="button" data-act="focus">Isolate</button>
          <span class="gal__id">case ${spec.id}</span>
        </div>
      </div>`;
    grid.appendChild(card);

    const stage = card.querySelector(".gal__stage");
    const v = makeViewer(stage, spec);
    const btn = card.querySelector('[data-act="focus"]');
    let on = false;
    btn.addEventListener("click", () => {
      on = !on;
      v.highlight(on);
      btn.textContent = on ? "Show all" : "Isolate";
      btn.classList.toggle("is-on", on);
    });
  }

  const dist = document.getElementById("gal-dist");
  if (!dist) return;
  fetch(`${DATA}distributions.json`)
    .then((r) => r.json())
    .then((d) => {
      const n = document.getElementById("gal-n");
      if (n) {
        n.textContent = `${d.n_cases} cases · ${d.n_lstv_labelled} carrying a source ` +
                        `LSTV label · ${d.n_lumbar_rib} with a rib on a lumbar body`;
      }
      for (const p of d.panels) {
        if (p.type === "scatter") drawScatter(dist, p);
        else drawPanel(dist, p);
      }
    })
    .catch(() => {
      dist.innerHTML = '<p class="gal__err">Distributions are still being generated.</p>';
    });
}

initGallery();
