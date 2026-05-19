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

  var HEADSHOT_EXTS = ["jpg", "jpeg", "png", "webp"];

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

  /* ============================================================
     EDUCATION OUTCOMES
     Renders the before/after competence chart, headline stats,
     and participant quotes from meded/survey-summary.json
     ============================================================ */

  var reducedMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function pctOnScale(value, scale) {
    var span = (scale.max - scale.min) || 1;
    return ((value - scale.min) / span) * 100;
  }

  function renderComfortChart(competencies, scale) {
    var chart = document.getElementById("comfortChart");
    if (!chart) return;
    chart.innerHTML = "";

    competencies.forEach(function (c) {
      var before = pctOnScale(c.before, scale);
      var now = pctOnScale(c.now, scale);

      var row = el("div", "dumbbell");
      row.appendChild(el("div", "dumbbell__label", c.label));

      var track = el("div", "dumbbell__track");

      var bar = el("span", "dumbbell__bar");
      bar.style.left = before + "%";          /* starts collapsed */
      bar.style.width = "0%";

      var dotBefore = el("span", "dumbbell__dot dumbbell__dot--before");
      dotBefore.style.left = before + "%";

      var dotNow = el("span", "dumbbell__dot dumbbell__dot--now");
      dotNow.style.left = before + "%";       /* animates out to `now` */

      track.appendChild(bar);
      track.appendChild(dotBefore);
      track.appendChild(dotNow);
      row.appendChild(track);

      var delta = (c.delta >= 0 ? "+" : "") + c.delta.toFixed(1);
      row.appendChild(el("div", "dumbbell__delta", delta));

      row.dataset.before = before;
      row.dataset.now = now;
      chart.appendChild(row);
    });

    function animate() {
      chart.querySelectorAll(".dumbbell").forEach(function (row) {
        var b = parseFloat(row.dataset.before);
        var n = parseFloat(row.dataset.now);
        row.querySelector(".dumbbell__dot--now").style.left = n + "%";
        var bar = row.querySelector(".dumbbell__bar");
        bar.style.left = Math.min(b, n) + "%";
        bar.style.width = Math.abs(n - b) + "%";
      });
    }

    if (reducedMotion || !("IntersectionObserver" in window)) {
      animate();
    } else {
      var co = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) { animate(); co.disconnect(); }
          });
        },
        { threshold: 0.25 }
      );
      co.observe(chart);
    }
  }

  function renderMedStats(stats) {
    var wrap = document.getElementById("medEdStats");
    if (!wrap) return;
    wrap.innerHTML = "";
    stats.forEach(function (s) {
      var card = el("div", "medstat reveal");
      card.appendChild(el("div", "medstat__value", s.value));
      card.appendChild(el("div", "medstat__label", s.label));
      wrap.appendChild(card);
      observe(card);
    });
  }

  function renderMedQuotes(quotes) {
    var wrap = document.getElementById("medEdQuotes");
    if (!wrap) return;
    wrap.innerHTML = "";
    quotes.forEach(function (q) {
      var card = el("div", "medquote reveal");
      card.appendChild(el("span", "medquote__mark", "\u201C"));
      card.appendChild(el("p", "medquote__text", q.text));
      card.appendChild(el("p", "medquote__by", "\u2014 " + (q.by || "OSC participant")));
      wrap.appendChild(card);
      observe(card);
    });
  }

  fetch("meded/survey-summary.json", { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (d) {
      var scale = d.scale || { min: 1, max: 5 };
      renderComfortChart(d.competencies || [], scale);
      renderMedStats(d.headline_stats || []);
      renderMedQuotes(d.quotes || []);

      var nEl = document.getElementById("medEdN");
      if (nEl && d.meta && d.meta.respondents) {
        nEl.textContent = "(n = " + d.meta.respondents + ")";
      }
      var baseEl = document.getElementById("medEdBaseline");
      if (baseEl && d.baseline) baseEl.textContent = d.baseline;
    })
    .catch(function (err) {
      var chart = document.getElementById("comfortChart");
      if (chart) {
        chart.innerHTML = "";
        chart.appendChild(
          el("p", "meded__status meded__status--error",
             "Could not load meded/survey-summary.json (" + err.message +
             "). The site must be served over http \u2014 see README.md.")
        );
      }
    });
})();
