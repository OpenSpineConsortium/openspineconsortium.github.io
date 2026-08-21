/* ============================================================
   deck.js — slide viewer for a presented deck, and a lightbox for photographs.

   WHY EXPORTED SLIDES RATHER THAN AN EMBEDDED POWERPOINT. The obvious route is the
   Office Online embed, which needs the .pptx to be publicly fetchable by a Microsoft
   server, renders in a third-party iframe, and on a phone gives you a scaled-down
   desktop UI inside a box. Exported images have none of that: they are just pictures,
   they lazy-load, they pinch-zoom the way a phone user expects, and nothing outside
   this domain has to be reachable for the page to work.

   The .pptx stays downloadable for anyone who wants the original.
   ============================================================ */

/* ---------------------------------------------------------- deck */
export function mountDeck(host) {
  const base = host.dataset.slides || "slides/";
  fetch(`${base}index.json`)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => build(host, base, d.slides))
    .catch((err) => {
      host.innerHTML = `<p class="deck__err">The slides did not load (${err.message}). ` +
        `The original deck is still available below.</p>`;
    });
}

function build(host, base, slides) {
  let i = 0;
  host.innerHTML = `
    <div class="deck__stage">
      <img class="deck__img" alt="">
      <button class="deck__nav deck__nav--prev" type="button" aria-label="Previous slide">&#8249;</button>
      <button class="deck__nav deck__nav--next" type="button" aria-label="Next slide">&#8250;</button>
      <button class="deck__full" type="button" aria-label="View full screen">&#9974;</button>
    </div>
    <div class="deck__bar">
      <span class="deck__count"></span>
      <input class="deck__range" type="range" min="1" step="1" aria-label="Slide">
    </div>`;

  const img = host.querySelector(".deck__img");
  const count = host.querySelector(".deck__count");
  const range = host.querySelector(".deck__range");
  range.max = String(slides.length);

  // Preload only the neighbours. Twenty-five slides is several megabytes, and a phone
  // on cellular should not fetch all of it to look at slide one.
  function warm(n) {
    for (const k of [n - 1, n + 1]) {
      if (k >= 0 && k < slides.length) { const p = new Image(); p.src = base + slides[k]; }
    }
  }
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    img.src = base + slides[i];
    img.alt = `Slide ${i + 1} of ${slides.length}`;
    count.textContent = `${i + 1} / ${slides.length}`;
    range.value = String(i + 1);
    warm(i);
  }

  host.querySelector(".deck__nav--prev").addEventListener("click", () => show(i - 1));
  host.querySelector(".deck__nav--next").addEventListener("click", () => show(i + 1));
  range.addEventListener("input", (e) => show(parseInt(e.target.value, 10) - 1));
  host.querySelector(".deck__full").addEventListener("click", () => openLightbox(img.src, img.alt));
  img.addEventListener("click", () => openLightbox(img.src, img.alt));

  host.tabIndex = 0;
  host.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(i - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(i + 1); e.preventDefault(); }
  });

  // horizontal swipe advances; a vertical drag must still scroll the page
  let x0 = null, y0 = null;
  host.addEventListener("touchstart", (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  host.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) show(i + (dx < 0 ? 1 : -1));
    x0 = y0 = null;
  }, { passive: true });

  show(0);
}

/* ---------------------------------------------------------- lightbox */
let box = null;

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "lb";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.innerHTML = `
    <button class="lb__close" type="button" aria-label="Close">&times;</button>
    <img class="lb__img" alt="">`;
  // click the backdrop to dismiss, but not a click that lands on the picture itself
  box.addEventListener("click", (e) => { if (e.target !== box.querySelector(".lb__img")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.body.appendChild(box);
  return box;
}

let lastFocus = null;
function close() {
  if (!box) return;
  box.classList.remove("is-open");
  document.documentElement.style.overflow = "";
  if (lastFocus) { lastFocus.focus(); lastFocus = null; }
}

export function openLightbox(src, alt) {
  const b = ensureBox();
  b.querySelector(".lb__img").src = src;
  b.querySelector(".lb__img").alt = alt || "";
  b.classList.add("is-open");
  // stop the page scrolling behind the overlay, which on a phone reads as the image
  // sliding away under your finger
  document.documentElement.style.overflow = "hidden";
  lastFocus = document.activeElement;
  b.querySelector(".lb__close").focus();
}

/* Any image marked data-zoom becomes clickable. Keyboard too: an image that only
   responds to a mouse is a control that half the readers cannot use. */
export function enableZoom(selector) {
  for (const el of document.querySelectorAll(selector)) {
    if (el.dataset.zoomBound) continue;
    el.dataset.zoomBound = "1";
    el.classList.add("is-zoomable");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", (el.alt || "Image") + " — click to enlarge");
    el.addEventListener("click", () => openLightbox(el.currentSrc || el.src, el.alt));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        openLightbox(el.currentSrc || el.src, el.alt);
        e.preventDefault();
      }
    });
  }
}

/* ---------------------------------------------------------- boot */
try {
  const deck = document.getElementById("deck");
  if (deck) mountDeck(deck);
  // race photographs, and anything else opted in with data-zoom
  enableZoom(".race__media img, img[data-zoom]");
} catch (err) {
  console.error("[deck]", err);
}
