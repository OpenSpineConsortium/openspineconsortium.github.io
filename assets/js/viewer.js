/* ============================================================
   viewer.js — the 3-D specimen viewer.

   WHAT "CLINICAL QUALITY" ACTUALLY MEANS HERE, in decreasing order of how much it
   matters and increasing order of how much it costs:

   1. ORIENTATION IS NEVER AMBIGUOUS. A bone render with no frame of reference is a
      picture; with one it is a reading. The viewer labels the anatomical axes on a
      corner gizmo, offers the standard radiographic views by name, and carries a scale
      bar in millimetres, so any statement about a specimen is checkable.
   2. THE SURFACE READS AS BONE. Flat lambert shading on flat colour turns a vertebra
      into a silhouette. Three-point lighting plus a physical material with real
      roughness gives the cortex a highlight that follows curvature, which is what makes
      a facet joint or a rib head legible at all.
   3. TONE MAPPING. Saturated label colours under three lights clip to white on the
      highlights and lose exactly the geometry the highlight was there to show. ACES
      compresses the top end instead of cutting it.
   4. THE READER CONTROLS OCCLUSION. Any spine hides its own posterior elements from
      most angles. Group toggles and an isolate mode are not decoration; they are how
      you see the structure the case is an example of.

   Colours come from the ITK-SNAP descriptor the annotators use, so the site and the
   segmentation tool never disagree about which vertebra is which.
   ============================================================ */

import * as THREE from "./vendor/three.module.js?v=23f5aba7";
import { OrbitControls } from "./vendor/OrbitControls.js?v=9cf437f1";

const GROUPS = [
  { key: "vertebra", label: "Vertebrae" },
  { key: "rib", label: "Ribs" },
  { key: "pelvis", label: "Pelvis & femora" },
  { key: "hardware", label: "Hardware" },
  { key: "other", label: "Other" },
];

// Standard radiographic views, named as a radiologist would ask for them. Each vector
// is WHERE THE CAMERA SITS, in the patient frame: +x the patient's right, +y anterior,
// +z superior. An anterior view therefore puts the camera in FRONT of the patient, at
// +y — the first version had this inverted and every named view looked at the opposite
// face.
const VIEWS = {
  anterior:  [0, 1, 0],
  posterior: [0, -1, 0],
  left:      [-1, 0, 0],
  right:     [1, 0, 0],
  superior:  [0, 0, 1],
  inferior:  [0, 0, -1],
  oblique:   [0.7, 0.7, 0.25],
};

// Mesh vertices arrive in the LABEL ARRAY's axes, not in a patient frame — these
// volumes are ('P','I','R'), so the first mesh axis runs posterior and the third runs
// right. This builds the rotation from the file's own axis codes into (R, A, S), so the
// views above mean what they say. Reading the codes rather than assuming a frame is the
// same lesson that the sidedness check and the 0179 write both taught.
const AXIS_DIR = { R: [1, 0, 0], L: [-1, 0, 0], A: [0, 1, 0], P: [0, -1, 0],
                   S: [0, 0, 1], I: [0, 0, -1] };

function patientBasis(axcodes) {
  // default to RAS if a mesh predates the header carrying its codes
  const codes = (axcodes && axcodes.length === 3) ? axcodes : ["R", "A", "S"];
  const m = new THREE.Matrix4();
  const c = [];
  for (const k of codes) c.push(AXIS_DIR[k] || [0, 0, 0]);
  // columns are where each mesh axis points in patient space
  m.set(c[0][0], c[1][0], c[2][0], 0,
        c[0][1], c[1][1], c[2][1], 0,
        c[0][2], c[1][2], c[2][2], 0,
        0, 0, 0, 1);
  return m;
}

export function createViewer(host, opts) {
  const { dataUrl, caseId, onFail, onReady } = opts;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true,
                                         powerPreference: "high-performance" });
  } catch (err) {
    onFail && onFail(err);
    return null;
  }
  if (!renderer.getContext()) { onFail && onFail(new Error("no WebGL context")); return null; }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // saturated label colours under three lights clip to white without this, and the
  // highlight that was carrying the curvature is the first thing lost
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);

  // three-point lighting: key for form, fill to keep the shadow side readable, rim to
  // separate the specimen from the ground it sits on
  const key = new THREE.DirectionalLight(0xfff6ec, 2.1);
  const fill = new THREE.DirectionalLight(0xdce9f5, 0.75);
  const rim = new THREE.DirectionalLight(0xffffff, 1.15);
  const amb = new THREE.HemisphereLight(0xf2f6ff, 0x2a2620, 0.55);
  scene.add(key, fill, rim, amb);

  const controls = new OrbitControls(cam, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.9;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.autoRotate = false;              // it holds still until it is asked to move

  // ONE FINGER SCROLLS THE PAGE. TWO FINGERS TURN THE SPECIMEN.
  // touch-action:none plus single-finger rotate meant the viewer swallowed every
  // vertical swipe that started on it, so on a phone the only way past the gallery was
  // to find a gap between cards. That is a trap, and it is the same one every embedded
  // map used to set. OrbitControls treats an unrecognised touches.ONE as "do nothing",
  // which combined with pan-y hands single-finger gestures back to the browser.
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  renderer.domElement.style.touchAction = "pan-y";

  const root = new THREE.Group();
  scene.add(root);

  let parts = [], radius = 100, ready = false, visible = false, raf = 0;
  let mmPerUnit = 1;

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; },
                           { threshold: 0.02 }).observe(host);

  // lights ride with the camera so the specimen is lit from where it is being looked
  // at; a fixed rig leaves half the orbit in shadow
  function placeLights() {
    const d = cam.position.clone().sub(controls.target);
    const up = new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(d, up).normalize();
    key.position.copy(controls.target).add(d).addScaledVector(side, d.length() * 0.55)
       .addScaledVector(up, d.length() * 0.35);
    fill.position.copy(controls.target).add(d).addScaledVector(side, -d.length() * 0.7)
        .addScaledVector(up, -d.length() * 0.15);
    rim.position.copy(controls.target).addScaledVector(d, -0.9)
       .addScaledVector(up, d.length() * 0.5);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible || !ready) return;
    controls.update();
    placeLights();
    renderer.render(scene, cam);
    if (opts.onFrame) opts.onFrame(cam, controls);
  }

  /* ---- payload ----
     LOADED ON APPROACH, NOT ON PAGE LOAD. Eight specimens is twenty-five megabytes of
     geometry. Fetching all of it because the page was opened would cost a phone on
     cellular most of that before it had scrolled to the gallery at all, so the fetch
     waits until the card is within a screen height of the viewport. rootMargin, not
     visibility: by the time a card is actually on screen it is too late to start. */
  let started = false;
  function start() {
    if (started) return;
    started = true;
    load();
  }
  new IntersectionObserver((e, obs) => {
    if (e[0].isIntersecting) { obs.disconnect(); start(); }
  }, { rootMargin: "100% 0px" }).observe(host);

  function load() {
  fetch(`${dataUrl}${caseId}.json`)
    .then((r) => { if (!r.ok) throw new Error(`${caseId}.json ${r.status}`); return r.json(); })
    .then(async (head) => {
      // Stream the payload so the card can show real progress. A few megabytes with no
      // signal at all reads as a broken page, and the reader gives up before it arrives.
      const resp = await fetch(`${dataUrl}${caseId}.bin`);
      if (!resp.ok) throw new Error(`${caseId}.bin ${resp.status}`);
      const total = +(resp.headers.get("content-length") || 0);
      let buf;
      if (resp.body && total && opts.onProgress) {
        const reader = resp.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          opts.onProgress(got / total);
        }
        buf = new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : null;
      }
      if (!buf) buf = await (await fetch(`${dataUrl}${caseId}.bin`)).arrayBuffer();
      const lo = new THREE.Vector3(...head.bbox_lo);
      const hi = new THREE.Vector3(...head.bbox_hi);
      const span = new THREE.Vector3().subVectors(hi, lo);

      for (const st of head.structures) {
        // slice(), not a view: a typed-array VIEW must begin on a multiple of its
        // element size, and an int8 normal run of odd length pushes the next array onto
        // an odd offset. slice() copies into a buffer starting at zero.
        const pos = new Uint16Array(buf.slice(st.pos[0], st.pos[0] + st.pos[1]));
        const nrm = new Int8Array(buf.slice(st.nrm[0], st.nrm[0] + st.nrm[1]));
        const idx = st.idx_bytes === 4
          ? new Uint32Array(buf.slice(st.idx[0], st.idx[0] + st.idx[1]))
          : new Uint16Array(buf.slice(st.idx[0], st.idx[0] + st.idx[1]));

        const pf = new Float32Array(pos.length);
        for (let k = 0; k < pos.length; k += 3) {
          pf[k]     = lo.x + (pos[k]     / head.quant) * span.x;
          pf[k + 1] = lo.y + (pos[k + 1] / head.quant) * span.y;
          pf[k + 2] = lo.z + (pos[k + 2] / head.quant) * span.z;
        }
        const nf = new Float32Array(nrm.length);
        for (let k = 0; k < nrm.length; k++) nf[k] = nrm[k] / 127;

        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pf, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(nf, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));

        const col = new THREE.Color(st.color[0] / 255, st.color[1] / 255, st.color[2] / 255);
        col.convertSRGBToLinear();
        const mat = new THREE.MeshPhysicalMaterial({
          color: col,
          roughness: st.kind === "hardware" ? 0.22 : 0.52,
          metalness: st.kind === "hardware" ? 0.85 : 0.0,
          // a trace of sheen reads as the slight translucency of cortical bone; without
          // it the surface looks like painted plastic
          sheen: st.kind === "hardware" ? 0 : 0.25,
          sheenRoughness: 0.8,
          sheenColor: new THREE.Color(0xfff1e2),
          clearcoat: st.kind === "hardware" ? 0.6 : 0,
          transparent: true,
          opacity: 1,
          // DOUBLE SIDED. A rib is a thin shell; marching cubes on a two-voxel-thick mask
          // leaves facets whose winding faces away, and back-face culling turns those
          // into holes that open and close as the specimen turns.
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(g, mat);
        mesh.userData = st;
        root.add(mesh);
        parts.push({ mesh, meta: st, base: 1 });
      }

      // rotate the specimen into the patient frame before anything measures or frames it
      root.applyMatrix4(patientBasis(head.axcodes));
      root.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(root);
      const mid = box.getCenter(new THREE.Vector3());
      root.position.sub(mid);
      const size = box.getSize(new THREE.Vector3());
      radius = size.length() / 2;
      mmPerUnit = head.mm_per_unit || 1;

      setView("anterior", false);
      controls.minDistance = radius * 0.35;
      controls.maxDistance = radius * 8;
      resize();
      ready = true;
      host.classList.remove("is-loading");
      tick();
      onReady && onReady(api);
    })
    .catch((err) => { onFail && onFail(err); });
  }

  /* ---- camera presets ---- */
  let anim = null;
  function setView(name, animate = true) {
    const v = VIEWS[name] || VIEWS.oblique;
    const dir = new THREE.Vector3(v[0], v[1], v[2]).normalize();
    const dist = radius * 2.6;
    const to = dir.multiplyScalar(dist);
    // superior looks straight down the up-axis, so the camera needs a different up or
    // the orientation is undefined and three.js flips it arbitrarily
    cam.up.set(0, 0, name === "superior" || name === "inferior" ? 0 : 1);
    if (name === "superior") cam.up.set(0, 1, 0);
    if (!animate) {
      cam.position.copy(to);
      controls.target.set(0, 0, 0);
      cam.lookAt(0, 0, 0);
      return;
    }
    const from = cam.position.clone();
    const t0 = performance.now();
    cancelAnimationFrame(anim);
    (function step() {
      const t = Math.min(1, (performance.now() - t0) / 520);
      // ease-in-out: a linear camera move reads as mechanical
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      cam.position.lerpVectors(from, to, e);
      cam.lookAt(0, 0, 0);
      if (t < 1) anim = requestAnimationFrame(step);
    })();
  }

  const api = {
    setView,
    reset() { setView("anterior"); controls.target.set(0, 0, 0); },
    groups() {
      const seen = new Map();
      for (const p of parts) {
        const k = p.meta.kind || "other";
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      return GROUPS.filter((g) => seen.has(g.key))
                   .map((g) => ({ ...g, count: seen.get(g.key) }));
    },
    setGroupVisible(kind, on) {
      for (const p of parts) if ((p.meta.kind || "other") === kind) p.mesh.visible = on;
    },
    // isolate does not HIDE the rest: a structure with no surroundings loses the very
    // relationship the case is an example of. It fades them to a ghost instead.
    isolate(pred) {
      for (const p of parts) {
        const hit = !pred || pred(p.meta);
        p.mesh.material.opacity = pred ? (hit ? 1 : 0.07) : 1;
        p.mesh.material.depthWrite = !pred || hit;
      }
    },
    explode(amount) {
      for (const p of parts) {
        const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
        p.mesh.position.copy(c.sub(root.position).multiplyScalar(amount * 0.35));
      }
    },
    // WHERE EACH ANATOMICAL DIRECTION IS ON SCREEN, right now. Static S/I/L/R labels are
    // only correct for one camera: in an anterior view the patient's left sits on the
    // viewer's RIGHT, which is the radiographic convention and the opposite of what a
    // fixed label would claim. So the gizmo is recomputed per frame, and only the four
    // directions most in the plane of the screen are shown — a label for an axis
    // pointing at the viewer means nothing.
    axisScreen() {
      const fwd = new THREE.Vector3().subVectors(controls.target, cam.position).normalize();
      const up = cam.up.clone().normalize();
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      const dirs = {
        R: [1, 0, 0], L: [-1, 0, 0], A: [0, 1, 0],
        P: [0, -1, 0], S: [0, 0, 1], I: [0, 0, -1],
      };
      const out = [];
      for (const k in dirs) {
        const v = new THREE.Vector3(...dirs[k]);
        const x = v.dot(right), y = v.dot(up), z = v.dot(fwd);
        // in-plane length; an axis pointing down the barrel has almost none
        const inPlane = Math.hypot(x, y);
        if (inPlane > 0.34) out.push({ k, x, y: -y, depth: z, inPlane });
      }
      out.sort((a, b) => b.inPlane - a.inPlane);
      return out.slice(0, 4);
    },

    // pixels per millimetre at the target plane, for the scale bar
    pxPerMm() {
      const d = cam.position.distanceTo(controls.target);
      const vh = 2 * Math.tan((cam.fov * Math.PI / 180) / 2) * d;
      return (host.clientHeight / vh) / mmPerUnit;
    },
    camera: cam,
    controls,
    dispose() { cancelAnimationFrame(raf); cancelAnimationFrame(anim); renderer.dispose(); },
  };
  return api;
}
