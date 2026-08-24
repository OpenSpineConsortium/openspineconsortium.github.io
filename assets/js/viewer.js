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

// Shared across every viewer instance on the page: two cases showing the same structure
// should compile that shader once, not twice. Keyed by appearance, so it is safe to share.
const matCache = new Map();

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

  // 2x device pixel ratio is FOUR TIMES the fragments shaded. On a mesh this
  // smooth the difference is not visible and the cost is the whole frame budget
  // on an integrated GPU.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  // saturated label colours under three lights clip to white without this, and the
  // highlight that was carrying the curvature is the first thing lost
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  // THE PATIENT'S SUPERIOR AXIS IS +Z HERE, NOT +Y. patientBasis maps S to [0,0,1], and
  // three.js defaults camera.up to +Y, which in this frame is ANTERIOR -- so OrbitControls
  // built its azimuth around an axis running out through the specimen's belly and a
  // sideways drag rolled it through a U rather than turning it. It was also degenerate at
  // the opening view, since VIEWS.anterior puts the camera on +Y while up was +Y: looking
  // along your own up vector, where orientation is undefined.
  cam.up.set(0, 0, 1);

  // three-point lighting: key for form, fill to keep the shadow side readable, rim to
  // separate the specimen from the ground it sits on
  const key = new THREE.DirectionalLight(0xfff6ec, 2.1);
  const fill = new THREE.DirectionalLight(0xdce9f5, 0.75);
  const rim = new THREE.DirectionalLight(0xffffff, 1.15);
  const amb = new THREE.HemisphereLight(0xf2f6ff, 0x2a2620, 0.55);
  scene.add(key, fill, rim, amb);

  const controls = new OrbitControls(cam, renderer.domElement);
  // declared here, before anything can ask for a frame: `let` is not hoisted,
  // so a resize firing during setup would otherwise hit the temporal dead zone
  let needsRender = true;
  function invalidate() { needsRender = true; }
  controls.addEventListener("change", invalidate);

  controls.enableDamping = true;
  controls.dampingFactor = 0.16;   // 0.085 lagged behind the pointer badly
  controls.rotateSpeed = 1.0;
  // and damp the vertical component so a diagonal drag reads as the horizontal spin it
  // was almost certainly meant to be. OrbitControls has no per-axis speed, so the polar
  // step is scaled by intercepting its rotateUp.
  if (typeof controls.rotateUp === "function") {
    const rotateUp = controls.rotateUp.bind(controls);
    controls.rotateUp = (angle) => rotateUp(angle * 0.45);
  }
  // A TURNTABLE, NOT A FREE ORBIT. Six degrees off the poles kept the camera out of the
  // singularity but still allowed it most of the sphere, so a drag that was meant to spin
  // the specimen left-right also swung it overhead, and near the top a small horizontal
  // movement moves it enormously. That is what a "combined AP and LR swivel" feels like.
  //
  // What a reader wants from an anatomical specimen is a turntable: spin it about its own
  // long axis, tilt a little to see over the iliac crest or under the sacral promontory,
  // and never end up looking down the axis of rotation. Azimuth stays unlimited; polar is
  // held to roughly 40 degrees either side of the equator.
  // With up on the superior axis, polar is a tilt toward the superior or inferior view and
  // 55 degrees either side of the equator is a proper look down onto the promontory or up
  // under it, while stopping short of the pole. The previous 40 was compensating for a
  // rotation that felt wrong for an entirely different reason.
  controls.minPolarAngle = Math.PI * 0.19;
  controls.maxPolarAngle = Math.PI * 0.81;
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
    invalidate();   // resize changes the projection
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; },
                           { threshold: 0.02 }).observe(host);

  // PART FIXED, PART FOLLOWING. Lights locked to the camera mean the shading never
  // changes as the specimen turns, so it reads as sliding rather than rotating -- the
  // motion cue that tells you it is a solid object disappears. A fully fixed rig has the
  // opposite problem and leaves half the orbit in shadow. So the key light trails the
  // camera by a fixed angle in world space, which keeps every side lit while letting the
  // highlight travel across the surface as it turns.
  const KEY_LAG = 0.55;      // radians the key light trails the camera azimuth
  function placeLights() {
    const d = cam.position.clone().sub(controls.target);
    const up = new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(d, up).normalize();
    // rotate the key direction about the world up by a fixed lag, so the highlight
    // sweeps across the specimen instead of staying pinned to the viewer
    const kd = d.clone().applyAxisAngle(up, KEY_LAG);
    key.position.copy(controls.target).add(kd).addScaledVector(up, d.length() * 0.42);
    fill.position.copy(controls.target).add(d).addScaledVector(side, -d.length() * 0.7)
        .addScaledVector(up, -d.length() * 0.15);
    rim.position.copy(controls.target).addScaledVector(d, -0.9)
       .addScaledVector(up, d.length() * 0.5);
  }

  // RENDER ON DEMAND, NOT EVERY FRAME.
  //
  // This drew a full frame sixty times a second whether or not anything had moved --
  // recomputing four light positions, re-shading every triangle, and handing the GPU a
  // fresh frame of identical pixels. On a desktop that is merely wasteful. On a laptop or
  // a phone it saturates the GPU, heats the device, and the browser responds by throttling
  // the whole tab, which is felt as exactly the sluggishness this was meant to avoid.
  //
  // A viewer only needs a frame when something changed: the pointer moved the camera,
  // damping is still coasting, an animation is running, or the canvas resized. OrbitControls
  // reports the first two through its change event and by returning true from update()
  // while damping is still settling.
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible || !ready) return;
    // update() returns true while damping is still moving the camera; that is the signal
    // to keep drawing until it settles, and to stop when it has
    const moving = controls.update();
    if (!moving && !needsRender) return;
    needsRender = false;
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
      // ASK FOR THE GZIPPED COPY FIRST. The payload is quantised integers so gzip only
      // returns about a quarter -- there is little redundancy left in it -- but a quarter
      // off the wire is free here: DecompressionStream is native in every current browser
      // and needs no library. If the .gz is absent, or the browser is old enough to lack
      // DecompressionStream, the plain .bin is fetched instead and nothing else changes.
      const canGunzip = typeof DecompressionStream === "function";
      let resp = null;
      if (canGunzip) {
        try {
          const g = await fetch(`${dataUrl}${caseId}.bin.gz`);
          if (g.ok && g.body) {
            resp = new Response(g.body.pipeThrough(new DecompressionStream("gzip")), {
              // content-length on the compressed response describes the COMPRESSED bytes,
              // so it is deliberately not carried over -- progress falls back to
              // indeterminate rather than reporting a percentage that would exceed 100
              headers: {},
            });
          }
        } catch (_) { /* fall through to the plain file */ }
      }
      if (!resp) resp = await fetch(`${dataUrl}${caseId}.bin`);
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
      } else if (resp.body) {
        // NO LENGTH MEANS THE GZIP PATH, AND THIS RESPONSE STILL HAS TO BE CONSUMED.
        // It previously fell straight through to the .bin fetch below, so every card
        // downloaded the compressed copy, discarded it, and then downloaded the
        // uncompressed one -- about 2.3x MORE on the wire than before compression was
        // added, and on a slow link the cards still in flight read as models that never
        // render. Progress is indeterminate here on purpose: the only length the server
        // offered describes the compressed bytes and would exceed 100%.
        if (opts.onProgress) opts.onProgress(-1);
        buf = await resp.arrayBuffer();
      }
      // last resort only: a browser without DecompressionStream, or a body-less response
      if (!buf) buf = await (await fetch(`${dataUrl}${caseId}.bin`)).arrayBuffer();
      const lo = new THREE.Vector3(...head.bbox_lo);
      const hi = new THREE.Vector3(...head.bbox_hi);
      const span = new THREE.Vector3().subVectors(hi, lo);

      for (const st of head.structures) {
        // slice(), not a view: a typed-array VIEW must begin on a multiple of its
        // element size, and an int8 normal run of odd length pushes the next array onto
        // an odd offset. slice() copies into a buffer starting at zero.
        const pos = new Uint16Array(buf.slice(st.pos[0], st.pos[0] + st.pos[1]));
        const idx = st.idx_bytes === 4
          ? new Uint32Array(buf.slice(st.idx[0], st.idx[0] + st.idx[1]))
          : new Uint16Array(buf.slice(st.idx[0], st.idx[0] + st.idx[1]));

        const pf = new Float32Array(pos.length);
        for (let k = 0; k < pos.length; k += 3) {
          pf[k]     = lo.x + (pos[k]     / head.quant) * span.x;
          pf[k + 1] = lo.y + (pos[k + 1] / head.quant) * span.y;
          pf[k + 2] = lo.z + (pos[k + 2] / head.quant) * span.z;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pf, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));

        // NORMALS ARE RECONSTRUCTED, NOT DOWNLOADED. The exporter computed them as face
        // normals averaged per vertex -- which is exactly what computeVertexNormals()
        // does, from data already present here. Shipping them spent 14% of the payload on
        // something the client can rebuild. Files written before this change still carry
        // the stream and are used as they are.
        if (head.normals === false || !st.nrm) {
          g.computeVertexNormals();
        } else {
          const nrm = new Int8Array(buf.slice(st.nrm[0], st.nrm[0] + st.nrm[1]));
          const nf = new Float32Array(nrm.length);
          for (let k = 0; k < nrm.length; k++) nf[k] = nrm[k] / 127;
          g.setAttribute("normal", new THREE.BufferAttribute(nf, 3));
        }

        const col = new THREE.Color(st.color[0] / 255, st.color[1] / 255, st.color[2] / 255);
        col.convertSRGBToLinear();

        // WHY NOT MeshPhysicalMaterial ANY MORE. It was one physical material PER
        // STRUCTURE -- 37 of them -- each carrying sheen and clearcoat, each marked
        // transparent, each double-sided, under four lights. Every one of those is a
        // multiplier on fragment cost, and they compound:
        //
        //   sheen + clearcoat  two extra BRDF lobes evaluated per fragment
        //   transparent:true   forces the alpha pipeline, so no early-z rejection and a
        //                      depth sort every frame -- and opacity was 1, so it bought
        //                      exactly nothing
        //   DoubleSide         doubles the fragment work and disables backface culling
        //   37 materials       37 distinct shader programs to compile before first paint,
        //                      which is why it took so long to appear
        //
        // Phong with the same colour and lights is visually near-identical on opaque
        // bone -- this is roughly what ITK-SNAP itself draws -- and costs a small
        // fraction. Materials are cached by appearance so structures that look alike
        // share one shader program and one upload.
        // EVERYTHING IS DOUBLE SIDED. This was limited to ribs and hardware on the
        // grounds that a vertebral body is a closed solid and costs half as much to shade
        // when culled -- true, but the iliac wing is thin bone, often one or two voxels
        // through, and so are the sacral ala and a vertebral lamina. Culling a surface
        // whose facets are wound away from the camera is exactly how a hip ends up with
        // holes in it. The shading cost predates render-on-demand: frames are drawn only
        // while the pointer moves, so it is paid during a drag rather than at rest.
        const thin = true;
        const key = st.color.join(",") + "|" + (st.kind === "hardware" ? "h" : "b")
                    + "|" + (thin ? "d" : "f");
        let mat = matCache.get(key);
        if (!mat) {
          mat = new THREE.MeshPhongMaterial({
            color: col,
            specular: st.kind === "hardware" ? 0x8a8a8a : 0x2a2622,
            shininess: st.kind === "hardware" ? 90 : 18,
            // DOUBLE SIDED ONLY WHERE IT IS EARNED. A rib is a thin shell and marching
            // cubes on a two-voxel-thick mask leaves facets wound away from the camera;
            // culling those opens holes that flicker as the specimen turns. A vertebral
            // body is a closed solid and has no such facets, so it is culled normally
            // and costs half as much to shade.
            side: thin ? THREE.DoubleSide : THREE.FrontSide,
          });
          matCache.set(key, mat);
        }
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
    // UP IS NEVER ZERO. This line used to evaluate to (0,0,0) for the inferior view --
    // a degenerate camera basis, and OrbitControls builds its whole orbit frame from
    // object.up, so the rotation became undefined the moment that view was selected.
    // Looking straight down the up-axis needs a DIFFERENT up, not an absent one.
    if (name === "superior" || name === "inferior") {
      cam.up.set(0, 1, 0);          // looking along z: anterior becomes screen-up
    } else {
      cam.up.set(0, 0, 1);          // everything else: superior is up, as it should be
    }
    if (!animate) {
      cam.position.copy(to);
      controls.target.set(0, 0, 0);
      cam.lookAt(0, 0, 0);
      controls.update();
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
      // OrbitControls re-derives its spherical frame from the camera position on every
      // update, so telling it now keeps the preset move and the controller in step
      // instead of letting them argue for a frame
      controls.update();
      if (t < 1) anim = requestAnimationFrame(step);
    invalidate();   // the fly-to animation
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
      // CHANGING THE SCENE IS A REASON TO DRAW. Render-on-demand only hears about camera
      // movement, so without this the checkbox appeared to do nothing until the next drag.
      invalidate();
    },
    // isolate does not HIDE the rest: a structure with no surroundings loses the very
    // relationship the case is an example of. It fades them to a ghost instead.
    isolate(pred) {
      for (const p of parts) {
        const hit = !pred || pred(p.meta);
        p.mesh.material.opacity = pred ? (hit ? 1 : 0.07) : 1;
        p.mesh.material.depthWrite = !pred || hit;
      }
      invalidate();
    },
    explode(amount) {
      for (const p of parts) {
        const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
        p.mesh.position.copy(c.sub(root.position).multiplyScalar(amount * 0.35));
      }
      invalidate();
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
