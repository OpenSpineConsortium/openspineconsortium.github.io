/* The Docs tab's live parts: the versions of the products whose release is on GitHub, and on
   What's new the pull requests merged lately in the public repositories the page names in
   data-repos. It asks GitHub's public API with no token, which allows 60 reads an hour from one
   address, so each answer is kept in this tab for ten minutes; when GitHub does not answer the
   page says so and the lists the build wrote stand. */
(function () {
  "use strict";
  var OWNER = "OpenSpineConsortium";
  var KEEP_MS = 10 * 60 * 1000;
  var DAYS = 30;
  var SHOWN = 30;

  function remembered(key) {
    try {
      var v = JSON.parse(sessionStorage.getItem(key) || "null");
      return v && Date.now() - v.at < KEEP_MS ? v.data : null;
    } catch (e) { return null; }
  }

  function remember(key, data) {
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* private window */ }
  }

  // a read of GitHub, kept in this tab as `keep` makes it: only the few fields the page shows, since
  // whole pull requests would fill the tab's storage and every reload would ask GitHub again
  function getJSON(url, keep) {
    var kept = remembered(url);
    if (kept) return Promise.resolve(kept);
    return fetch(url, { headers: { Accept: "application/vnd.github+json" } }).then(function (r) {
      if (!r.ok) throw new Error("GitHub answered " + r.status);
      return r.json();
    }).then(function (data) {
      var small = keep ? keep(data) : data;
      remember(url, small);
      return small;
    });
  }

  function showVersion(name, text) {
    document.querySelectorAll('[data-live="' + name + '"]').forEach(function (el) { el.textContent = text; });
  }

  function versions() {
    if (!document.querySelector("[data-live]")) return;
    getJSON("https://api.github.com/repos/" + OWNER + "/symphony-protocol/releases/latest", function (r) { return { tag_name: r.tag_name }; })
      .then(function (r) { showVersion("protocol", r.tag_name.replace(/^v/, "") + " (the latest published release)"); })
      .catch(function () { showVersion("protocol", "not read: GitHub did not answer"); });
    getJSON("https://raw.githubusercontent.com/" + OWNER + "/symphony-marketplace/main/plugins/sdlc/.claude-plugin/plugin.json", function (p) { return { version: p.version }; })
      .then(function (p) { showVersion("plugin", p.version); })
      .catch(function () { showVersion("plugin", "not read: GitHub did not answer"); });
  }

  // the pull requests merged since `since`, newest updated first, a page of 100 at a time until a
  // page reaches back past `since` (a merge is never later than the last update), three at most
  function merged(repo, since) {
    function page(n) {
      var url = "https://api.github.com/repos/" + OWNER + "/" + repo.repo +
        "/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=" + n;
      return getJSON(url, function (prs) {
        return prs.map(function (p) {
          return { at: p.merged_at, updated: p.updated_at, title: p.title, url: p.html_url };
        });
      }).then(function (prs) {
        var done = prs.length < 100 || Date.parse(prs[prs.length - 1].updated) < since || n >= 3;
        return done ? prs : page(n + 1).then(function (more) { return prs.concat(more); });
      });
    }
    return page(1).then(function (prs) {
      return prs.filter(function (p) { return p.at && Date.parse(p.at) >= since; }).map(function (p) {
        return { at: p.at, title: p.title, url: p.url, product: repo.product };
      });
    });
  }

  function item(pr) {
    var li = document.createElement("li");
    var when = document.createElement("time");
    when.dateTime = pr.at;
    when.textContent = pr.at.slice(0, 10);
    var where = document.createElement("span");
    where.className = "docs__repo";
    where.textContent = pr.product;
    var what = document.createElement("a");
    what.href = pr.url;
    what.textContent = pr.title;
    li.append(when, where, what);
    return li;
  }

  function feed() {
    var list = document.getElementById("docs-live");
    var status = document.getElementById("docs-live-status");
    if (!list || !status) return;
    var repos = JSON.parse(list.getAttribute("data-repos") || "[]");
    var since = Date.now() - DAYS * 86400000;
    Promise.allSettled(repos.map(function (r) { return merged(r, since); })).then(function (results) {
      var prs = [], failed = [];
      results.forEach(function (r, i) {
        if (r.status === "fulfilled") prs = prs.concat(r.value);
        else failed.push(repos[i].product);
      });
      prs = prs.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
      prs.forEach(function (p, i) {
        var li = item(p);
        if (i >= SHOWN) li.hidden = true;
        list.appendChild(li);
      });
      if (prs.length > SHOWN) {
        var more = document.createElement("button");
        more.type = "button";
        more.className = "btn btn--ghost docs__showall";
        more.textContent = "Show all " + prs.length;
        more.addEventListener("click", function () {
          list.querySelectorAll("li[hidden]").forEach(function (li) { li.hidden = false; });
          more.remove();
        });
        list.after(more);
      }
      var said = prs.length + " pull request" + (prs.length === 1 ? "" : "s") + " merged in the last " + DAYS +
        " days, newest first.";
      if (failed.length) {
        said += " GitHub did not answer for " + failed.join(", ") +
          " (it allows 60 reads an hour from one address); open the page again later for those.";
      }
      status.textContent = said;
    });
  }

  versions();
  feed();
})();
