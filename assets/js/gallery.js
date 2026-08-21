/* ============================================================
   Gallery — 3-D turntables + count-free distributions.

   WHY STILLS RATHER THAN WebGL. The mesh viewer failed in the browser across several
   attempts for reasons that were not visible from the build side, and a gallery that
   does not render is worth less than one that cannot be zoomed. These frames are
   rendered on the cluster, so every browser variable disappears at once: no GPU, no
   import map, no typed-array alignment, no WebGL context limit. What ships is <img>.

   STILL INTERACTIVE. Sixteen frames on a turntable, swapped under a drag, is an object
   movie — the trick QuickTime VR used. It needs a pointer handler and nothing else, and
   with no JavaScript at all the first frame is still a picture of the specimen.

   NO LEVEL NAMES IN THE COPY. Sacralisation and lumbarisation are one morphology under
   two counts, so the captions describe what is visible and never assert which vertebra
   is which.
   ============================================================ */

const DATA = "assets/gallery/";
const STILLS = DATA + "stills/";
const NFRAMES = 16;

const CASES = [
  { id: "0431", title: "A rib on a lumbar body",
    blurb: "An extra rib pair below the last thoracic one. Given its own class in the " +
           "release rather than being forced to be a twelfth rib, so it stays countable." },
  { id: "0033", title: "A part-fused transitional vertebra",
    blurb: "Six rib-free bodies above the sacrum, the lowest incompletely fused on the " +
           "left. Whether that is a sacralised or a lumbarised segment depends on where " +
           "the count starts — the fusion itself does not." },
  { id: "0631", title: "A hypoplastic twelfth rib",
    blurb: "The lowest rib is a fraction of the length of the one above it — the extreme " +
           "of a distribution that turns out to be bimodal across the cohort." },
  { id: "1035", title: "Instrumentation",
    blurb: "Surgical hardware, found by density and confirmed by geometry. It matters " +
           "beyond completeness: metal bridging an interspace reads as fusion to any " +
           "distance measurement." },
  { id: "0004", title: "Unremarkable, for reference",
    blurb: "Five rib-free bodies above the sacrum, twelve rib pairs, nothing transitional." },
];

const pad2 = (i) => String(i).padStart(2, "0");

/* ---------------------------------------------------------- turntable */
function makeTurntable(host, spec) {
  const img = new Image();
  img.className = "gal__frame";
  img.alt = `Three-dimensional reconstruction of the segmented spine and pelvis, case ${spec.id}`;
  img.draggable = false;
  img.src = `${STILLS}${spec.id}_00.png`;
  host.appendChild(img);

  img.addEventListener("load", () => host.classList.remove("is-loading"), { once: true });
  img.addEventListener("error", () => {
    host.classList.remove("is-loading");
    host.classList.add("is-error");
    host.innerHTML = `<p class="gal__err">Case ${spec.id} did not load.</p>`;
  }, { once: true });

  // Preload the rest so the first drag does not stutter. The Image objects are KEPT --
  // an unreferenced in-flight decode can be collected, and then the first turn refetches.
  const pre = [img];
  const srcs = [img.src];
  for (let i = 1; i < NFRAMES; i++) {
    const f = new Image();
    f.src = `${STILLS}${spec.id}_${pad2(i)}.png`;
    pre.push(f);
    srcs.push(f.src);
  }

  let idx = 0, dragging = false, lastX = 0, acc = 0, touched = false;
  function show(i) {
    idx = ((i % NFRAMES) + NFRAMES) % NFRAMES;
    img.src = srcs[idx];
  }
  // one full turn per ~1.4 stage widths of travel: enough control to stop on a view
  const step = () => Math.max(22, host.clientWidth * 1.4 / NFRAMES);

  function down(e) {
    dragging = true;
    touched = true;
    lastX = e.touches ? e.touches[0].clientX : e.clientX;
    acc = 0;
    host.classList.add("is-dragging");
  }
  function move(e) {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    acc += x - lastX;
    lastX = x;
    const s = step();
    let moved = false;
    while (Math.abs(acc) >= s) {
      show(idx + (acc > 0 ? -1 : 1));
      acc -= Math.sign(acc) * s;
      moved = true;
    }
    // only swallow the gesture once it is clearly horizontal, so a vertical swipe
    // still scrolls the page on a phone
    if (moved && e.cancelable) e.preventDefault();
  }
  function up() { dragging = false; host.classList.remove("is-dragging"); }

  // ONE family of events, not both. Binding pointer* AND touch* means a touch device
  // fires each handler twice and the object turns at double speed.
  if (window.PointerEvent) {
    host.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  } else {
    host.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    host.addEventListener("touchstart", down, { passive: true });
    host.addEventListener("touchmove", move, { passive: false });
    host.addEventListener("touchend", up);
  }

  // keyboard: the turntable is a control, so it has to be operable without a pointer
  host.tabIndex = 0;
  host.setAttribute("role", "slider");
  host.setAttribute("aria-label", `Rotate case ${spec.id}`);
  host.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { touched = true; show(idx - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { touched = true; show(idx + 1); e.preventDefault(); }
  });

  let timer = null;
  return {
    // a slow idle turn while the card is on screen, so it reads as manipulable.
    // It stops for good once the reader takes hold of it.
    spin(on) {
      if (on && timer === null) {
        timer = setInterval(() => {
          if (dragging || touched) return;
          show(idx + 1);
        }, 160);
      } else if (!on && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
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

function el2(tag, text, cls) {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
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
  const W = 760, H = 430, L = 96, R = 30, T = 34, B = 92;
  const pw = W - L - R, ph = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "gal__svg",
                          role: "img", "aria-label": p.title });

  const counts = p.counts;
  const max = Math.max(...counts, 1);
  const nonzero = counts.filter((c) => c > 0);
  const min = nonzero.length ? Math.min(...nonzero) : 1;
  // a 734 bar beside a 35 bar leaves the small ones a couple of pixels tall; sqrt keeps
  // the tall bar honest while giving the short ones height you can compare
  const skew = p.type === "categorical" && max / min > 20;
  const scale = (v) => (skew ? Math.sqrt(v / max) : v / max) * ph;
  const bw = pw / counts.length;

  for (const v of niceTicks(0, max, 4)) {
    const y = T + ph - scale(v);
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: y + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }

  counts.forEach((c, i) => {
    const h = scale(c);
    const r = el("rect", { x: L + i * bw + 2, y: T + ph - h,
                           width: Math.max(2, bw - 4), height: h, class: "gal__bar" });
    r.appendChild(el("title", null,
      p.type === "categorical"
        ? `${p.categories[i]}: ${c} cases`
        : `${p.edges[i].toFixed(2)}–${p.edges[i + 1].toFixed(2)}: ${c} cases`));
    svg.appendChild(r);
    // THE COUNT, on the bar. With this the reader never has to estimate a height against
    // an axis -- which is what made 35-versus-26 unreadable.
    if (c > 0 && (p.type === "categorical" || bw > 26)) {
      svg.appendChild(el("text", { x: L + i * bw + bw / 2, y: T + ph - h - 9,
                                   class: "gal__val", "text-anchor": "middle" }, c));
    }
  });

  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));

  if (p.type === "categorical") {
    p.categories.forEach((c, i) => {
      svg.appendChild(el("text", { x: L + i * bw + bw / 2, y: T + ph + 32,
                                   class: "gal__tick", "text-anchor": "middle" }, c));
    });
  } else {
    const lo = p.edges[0], hi = p.edges[p.edges.length - 1];
    for (const v of niceTicks(lo, hi, 5)) {
      const x = L + ((v - lo) / (hi - lo)) * pw;
      svg.appendChild(el("line", { x1: x, x2: x, y1: T + ph, y2: T + ph + 8, class: "gal__axis" }));
      svg.appendChild(el("text", { x, y: T + ph + 32, class: "gal__tick",
                                   "text-anchor": "middle" }, v));
    }
  }

  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` },
                     skew ? "cases (√ scale)" : "cases"));

  const wrap = document.createElement("figure");
  wrap.className = "gal__panel";
  wrap.appendChild(el2("h4", p.title));
  wrap.appendChild(el2("p", p.subtitle, "gal__sub"));
  wrap.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = p.caption + (skew
    ? "  Bar heights use a square-root scale so the small categories stay visible; the "
      + "number on each bar is the exact count."
    : "");
  wrap.appendChild(cap);
  host.appendChild(wrap);
}

function drawScatter(host, p) {
  const W = 760, H = 470, L = 96, R = 30, T = 30, B = 92;
  const pw = W - L - R, ph = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "gal__svg",
                          role: "img", "aria-label": p.title });

  const xs = p.points.map((q) => q.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yhi = Math.max(...p.points.map((q) => q.y));
  // log y: the gap spans two orders of magnitude and CONTACT is the interesting end
  const ly = (v) => Math.log10(Math.max(v, 0.2));
  const l0 = ly(0.2), l1 = ly(yhi);

  for (const v of [0.2, 0.5, 1, 2, 5, 10, 20, 50]) {
    if (v > yhi) break;
    const y = T + ph - ((ly(v) - l0) / (l1 - l0)) * ph;
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: y + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }
  for (const v of niceTicks(x0, x1, 5)) {
    const x = L + ((v - x0) / (x1 - x0)) * pw;
    svg.appendChild(el("line", { x1: x, x2: x, y1: T + ph, y2: T + ph + 8, class: "gal__axis" }));
    svg.appendChild(el("text", { x, y: T + ph + 32, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }
  for (const q of p.points) {
    svg.appendChild(el("circle", {
      cx: L + ((q.x - x0) / (x1 - x0 || 1)) * pw,
      cy: T + ph - ((ly(q.y) - l0) / (l1 - l0 || 1)) * ph,
      r: q.f ? 4.4 : 2.8,
      class: q.f ? "gal__dot gal__dot--flag" : "gal__dot" }));
  }

  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, p.ylabel));

  // legend, because two dot sizes carrying meaning need saying out loud
  const lg = el("g", { transform: `translate(${L + pw - 250} ${T + 10})` });
  lg.appendChild(el("circle", { cx: 8, cy: -5, r: 2.8, class: "gal__dot" }));
  lg.appendChild(el("text", { x: 24, y: 1, class: "gal__tick" }, "no source LSTV label"));
  lg.appendChild(el("circle", { cx: 8, cy: 22, r: 4.4, class: "gal__dot gal__dot--flag" }));
  lg.appendChild(el("text", { x: 24, y: 28, class: "gal__tick" }, "carries an LSTV label"));
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
function initGallery() {
  const grid = document.getElementById("gal-cases");
  if (grid) {
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
            <span class="gal__hint">drag to turn</span>
            <span class="gal__id">case ${spec.id}</span>
          </div>
        </div>`;
      grid.appendChild(card);

      const stage = card.querySelector(".gal__stage");
      const tt = makeTurntable(stage, spec);
      // idle spin only while on screen: five cards cycling images off-screen is
      // bandwidth and battery spent on nothing
      new IntersectionObserver((es) => tt.spin(es[0].isIntersecting),
                               { threshold: 0.25 }).observe(stage);
    }
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

// A failure anywhere in this module previously left an empty section that looked exactly
// like "still loading". Say so on the page instead.
try {
  initGallery();
} catch (err) {
  const g = document.getElementById("gal-cases");
  if (g) {
    g.innerHTML = `<p class="gal__err">The gallery failed to start: ${err.message}. ` +
                  `The published labels are unaffected.</p>`;
  }
  console.error("[gallery]", err);
}
