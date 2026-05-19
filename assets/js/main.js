/* ============================================================
   OpenSpineConsortium — interaction layer
   - sticky nav state on scroll
   - mobile menu toggle
   - scroll-triggered reveal animations
   - active-section highlighting in the nav
   - contributors + research outputs rendered from
     contributions/manifest.json
   ============================================================ */

(function () {
  "use strict";

  /* ---- current year in footer ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- nav: scrolled state ---- */
  var nav = document.getElementById("nav");
  function onScroll() {
    nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- mobile menu ---- */
  var toggle = document.getElementById("navToggle");
  var links = document.querySelector(".nav__links");
  toggle.addEventListener("click", function () {
    var open = links.classList.toggle("is-open");
    toggle.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  links.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () {
      links.classList.remove("is-open");
      toggle.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });

  /* ---- scroll reveal (observer is reused for dynamically added nodes) ---- */
  var io = null;
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
  }
  function observe(el) {
    if (io) io.observe(el);
    else el.classList.add("is-visible");
  }
  document.querySelectorAll(".reveal").forEach(observe);

  /* ---- active section highlighting ---- */
  var sections = document.querySelectorAll("section[id]");
  var navItems = document.querySelectorAll('.nav__links a[href^="#"]');
  function setActive() {
    var pos = window.scrollY + window.innerHeight * 0.32;
    var current = "";
    sections.forEach(function (sec) {
      if (pos >= sec.offsetTop) current = sec.id;
    });
    navItems.forEach(function (item) {
      item.classList.toggle(
        "is-active",
        item.getAttribute("href") === "#" + current
      );
    });
  }
  window.addEventListener("scroll", setActive, { passive: true });
  setActive();

  /* ============================================================
     CONTRIBUTIONS MANIFEST
     Renders the People grid and the CNS outputs list from
     contributions/manifest.json. Headshots are looked up in
     /headshots by the convention lastname,firstname[,mi].ext
     ============================================================ */

  var HEADSHOT_EXTS = ["jpg", "jpeg", "png", "webp", "JPG", "JPEG", "PNG"];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function initials(p) {
    return (((p.first || "")[0] || "") + ((p.last || "")[0] || "")).toUpperCase();
  }

  function displayName(p) {
    var mid = p.mi ? " " + p.mi.replace(/\.+$/, "") + ". " : " ";
    return (p.first || "") + mid + (p.last || "");
  }

  /* Probe headshots/<base>.<ext> across extensions; swap the image
     in on the first hit, otherwise leave the initials avatar. */
  function loadHeadshot(portrait, base) {
    if (!base) return;
    var idx = 0;
    var img = new Image();
    img.alt = "";
    img.onload = function () { portrait.appendChild(img); };
    img.onerror = function () {
      if (idx < HEADSHOT_EXTS.length) {
        img.src = "headshots/" + encodeURIComponent(base) + "." + HEADSHOT_EXTS[idx++];
      }
    };
    img.onerror(); /* kick off the first attempt */
  }

  function renderPeople(people, abstracts) {
    var grid = document.getElementById("peopleGrid");
    if (!grid) return;
    grid.innerHTML = "";

    people.forEach(function (p, i) {
      var card = el("article", "person reveal" + (p.lead ? " person--lead" : ""));
      card.style.setProperty("--d", String(i % 3));

      /* portrait: initials avatar, upgraded to a headshot if one exists */
      var portrait = el("div", "person__portrait");
      portrait.setAttribute("aria-hidden", "true");
      portrait.appendChild(el("span", "person__portrait-initials", initials(p)));
      loadHeadshot(portrait, p.headshot);
      card.appendChild(portrait);

      var body = el("div", "person__body");

      var h = el("h3");
      h.appendChild(document.createTextNode(displayName(p)));
      if (p.suffix) {
        h.appendChild(document.createTextNode(", "));
        h.appendChild(el("span", "person__suffix", p.suffix));
      }
      body.appendChild(h);

      if (p.role) body.appendChild(el("p", "person__role", p.role));
      if (p.bio) body.appendChild(el("p", "person__bio", p.bio));
      if (p.affiliation) body.appendChild(el("p", "person__affil", p.affiliation));

      /* contributions: resolve each id against the abstracts table */
      var contribs = (p.contributions || [])
        .map(function (id) { return abstracts[id]; })
        .filter(Boolean);

      if (contribs.length) {
        var list = el("ul", "person__contribs");
        list.appendChild(
          el("li", "person__contribs-label",
             "Contributions to OSC (" + contribs.length + ")")
        );
        contribs.forEach(function (c) {
          var prep = (c.status || "").toLowerCase().indexOf("prep") !== -1;
          var li = el("li", "contrib" + (prep ? " contrib--prep" : ""));
          li.appendChild(el("span", "contrib__title", c.title));
          var meta = el("span", "contrib__meta");
          meta.appendChild(document.createTextNode((c.venue || "") + " \u2014 "));
          meta.appendChild(el("span", "contrib__status", c.status || ""));
          if (c.cns_id) {
            meta.appendChild(document.createTextNode(" \u00b7 #" + c.cns_id));
          }
          li.appendChild(meta);
          list.appendChild(li);
        });
        body.appendChild(list);
      }

      card.appendChild(body);
      grid.appendChild(card);
      observe(card);
    });
  }

  function renderOutputs(abstracts) {
    var ul = document.getElementById("outputsList");
    if (!ul) return;
    ul.innerHTML = "";
    Object.keys(abstracts)
      .filter(function (id) { return abstracts[id].cns_id; })
      .sort()
      .forEach(function (id) {
        var a = abstracts[id];
        var li = document.createElement("li");
        li.appendChild(el("span", "outputs__year", "#" + a.cns_id));
        li.appendChild(document.createTextNode(a.title + " "));
        li.appendChild(el("em", null, "(" + a.status + ")"));
        ul.appendChild(li);
      });
  }

  function manifestError(message) {
    var grid = document.getElementById("peopleGrid");
    if (grid) {
      grid.innerHTML = "";
      grid.appendChild(el("p", "people__status people__status--error", message));
    }
  }

  fetch("contributions/manifest.json", { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      renderPeople(data.people || [], data.abstracts || {});
      renderOutputs(data.abstracts || {});
    })
    .catch(function (err) {
      manifestError(
        "Could not load contributions/manifest.json (" + err.message +
        "). The site must be served over http \u2014 see README.md."
      );
    });
})();
