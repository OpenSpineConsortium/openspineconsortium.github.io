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
function drawPanel(host, p) {
  const W = 520, H = 210, PADL = 46, PADB = 34, PADT = 12, PADR = 12;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "gal__svg");
  const plotW = W - PADL - PADR, plotH = H - PADT - PADB;

  const counts = p.type === "categorical" ? p.counts : p.counts;
  const labels = p.type === "categorical"
    ? p.categories
    : p.edges.slice(0, -1).map((e, i) => (i % 6 === 0 ? e.toFixed(2) : ""));
  const max = Math.max(...counts, 1);
  const bw = plotW / counts.length;

  counts.forEach((c, i) => {
    const h = (c / max) * plotH;
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", PADL + i * bw + 0.6);
    r.setAttribute("y", PADT + plotH - h);
    r.setAttribute("width", Math.max(1, bw - 1.2));
    r.setAttribute("height", h);
    r.setAttribute("class", "gal__bar");
    const t = document.createElementNS(ns, "title");
    t.textContent = p.type === "categorical"
      ? `${p.categories[i]}: ${c} cases`
      : `${p.edges[i].toFixed(2)}–${p.edges[i + 1].toFixed(2)}: ${c} cases`;
    r.appendChild(t);
    svg.appendChild(r);
  });

  // axis line + sparse ticks; a dense axis on a small chart is noise
  const ax = document.createElementNS(ns, "line");
  ax.setAttribute("x1", PADL); ax.setAttribute("x2", W - PADR);
  ax.setAttribute("y1", PADT + plotH); ax.setAttribute("y2", PADT + plotH);
  ax.setAttribute("class", "gal__axis");
  svg.appendChild(ax);

  labels.forEach((lb, i) => {
    if (!lb) return;
    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", PADL + i * bw + bw / 2);
    tx.setAttribute("y", PADT + plotH + 15);
    tx.setAttribute("class", "gal__tick");
    tx.setAttribute("text-anchor", "middle");
    tx.textContent = lb;
    svg.appendChild(tx);
  });
  [0, max].forEach((v) => {
    const ty = document.createElementNS(ns, "text");
    ty.setAttribute("x", PADL - 8);
    ty.setAttribute("y", PADT + plotH - (v / max) * plotH + 4);
    ty.setAttribute("class", "gal__tick");
    ty.setAttribute("text-anchor", "end");
    ty.textContent = v;
    svg.appendChild(ty);
  });

  const wrap = document.createElement("figure");
  wrap.className = "gal__panel";
  wrap.innerHTML = `<h4>${p.title}</h4><p class="gal__sub">${p.subtitle}</p>`;
  wrap.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = p.caption;
  wrap.appendChild(cap);
  host.appendChild(wrap);
}

function drawScatter(host, p) {
  const W = 520, H = 260, PADL = 52, PADB = 38, PADT = 12, PADR = 12;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "gal__svg");
  const pw = W - PADL - PADR, ph = H - PADT - PADB;
  const xs = p.points.map((q) => q.x), ys = p.points.map((q) => q.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  // log y: the gap spans two orders of magnitude and contact is the interesting end
  const ly = (v) => Math.log10(Math.max(v, 0.2));
  const ly0 = ly(0.2), ly1 = ly(y1);
  for (const q of p.points) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", PADL + ((q.x - x0) / (x1 - x0 || 1)) * pw);
    c.setAttribute("cy", PADT + ph - ((ly(q.y) - ly0) / (ly1 - ly0 || 1)) * ph);
    c.setAttribute("r", q.f ? 3.1 : 2);
    c.setAttribute("class", q.f ? "gal__dot gal__dot--flag" : "gal__dot");
    svg.appendChild(c);
  }
  const ax = document.createElementNS(ns, "line");
  ax.setAttribute("x1", PADL); ax.setAttribute("x2", W - PADR);
  ax.setAttribute("y1", PADT + ph); ax.setAttribute("y2", PADT + ph);
  ax.setAttribute("class", "gal__axis");
  svg.appendChild(ax);
  [[PADL + pw / 2, PADT + ph + 26, p.xlabel, "middle"]].forEach(([x, y, t, a]) => {
    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", x); tx.setAttribute("y", y);
    tx.setAttribute("class", "gal__tick"); tx.setAttribute("text-anchor", a);
    tx.textContent = t; svg.appendChild(tx);
  });
  const wrap = document.createElement("figure");
  wrap.className = "gal__panel gal__panel--wide";
  wrap.innerHTML = `<h4>${p.title}</h4><p class="gal__sub">${p.subtitle}</p>`;
  wrap.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = p.caption + "  Larger warm dots carry a source LSTV label.";
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
