/* ============================================================
   symphony-panel.js: the Symphony control panel (/symphony/control/) and
   the cost page (/symphony/cost.html). One script serves both, so the
   sign-in and the GitHub client are shared: a token given on one page
   serves the other.

   How it works. The page calls GitHub's REST API from this browser as the
   signed-in person, with a token that stays in this browser (localStorage
   when "keep me signed in" is ticked, sessionStorage otherwise) and goes
   to api.github.com and nowhere else. The site is static files, so
   nothing of the site ever sees the token. The one exception is the
   sign-in service, once it is deployed (symphony-app/signin): it turns
   GitHub's one-time code into a token, renews it, revokes it when asked,
   and keeps nothing. Until SIGNIN_SERVICE and CLIENT_ID name it, the page
   offers the token box alone. The sign-in uses PKCE: the page keeps a
   secret for each sign-in and sends GitHub its hash, so only this page
   can turn the code GitHub returns into a token.

   What it never does: it never takes a Claude token, never stores
   anything but the GitHub token (and the refresh token that came with
   it) and the names of the repositories you listed, and never sends
   anything anywhere but GitHub and, for the sign-in, that service.

   Every state on the page is written in words and every action is a
   button or a link with a name, so a person and a browsing agent read
   and drive it alike. /symphony/control/?repo=OWNER/NAME lands on one
   repository.
   ============================================================ */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  // The stateless sign-in service and SymphonyBoard's client id. Both are empty until the service is
  // deployed; then "Sign in with GitHub" appears beside the token box.
  var SIGNIN_SERVICE = '';
  var CLIENT_ID = '';
  var APP_SLUG = 'symphonyboard';
  var FORM_URL = 'https://github.com/OpenSpineConsortium/symphony-start/issues/new?template=adopt.yml';
  var TOPIC = 'symphony';
  var KEY_TOKEN = 'symphony_panel_token';
  var KEY_OAUTH = 'symphony_panel_oauth';
  var KEY_STATE = 'symphony_panel_oauth_state';
  var KEY_REPOS = 'symphony_panel_repos';
  var KEY_REPO = 'symphony_panel_repo';
  var KEY_PLAN = 'symphony_panel_plan';
  var REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/;
  var GITHUB_ID = /^[0-9]{1,20}$/;
  // the colour the protocol library gives a worker's label (sdlc_protocol/labels.py)
  var LABEL_COLOR = 'c5def5';
  // the raw media type gives a file's text whatever its size; the JSON form stops at 1 MB
  var RAW = { 'Accept': 'application/vnd.github.raw+json' };

  /* ---------- small helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var x = arguments[i];
      if (x) parent.appendChild(typeof x === 'string' ? document.createTextNode(x) : x);
    }
    return parent;
  }
  function btn(label, quiet, onClick) {
    var b = el('button', quiet ? 'quiet' : '', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function link(href, text) {
    var a = el('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function none(parent, text) { return add(parent, el('p', 'admin__none', text)); }
  function say(text, warn) {
    var m = $('msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = warn ? 'admin__box admin__warn' : 'admin__box';
  }
  function stamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function ago(iso) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' minutes ago';
    if (s < 129600) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }
  function timeEl(iso) {
    var t = el('time', '', ago(iso));
    if (iso) { t.dateTime = iso; t.title = stamp(iso); }
    return t;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function money(x) {
    if (x == null || isNaN(x)) return 'n/a';
    return '$' + (x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US'));
  }
  function count(x) { return x == null ? 'n/a' : Number(x).toLocaleString('en-US'); }
  function hours(seconds) {
    if (seconds == null) return 'n/a';
    var h = seconds / 3600;
    return h < 10 ? h.toFixed(1) + ' hours' : Math.round(h).toLocaleString('en-US') + ' hours';
  }
  function labelName(l) { return typeof l === 'string' ? l : (l && l.name) || ''; }

  /* ---------- storage: the token and the lists, in this browser only ---------- */
  function readKey(key) {
    try { return sessionStorage.getItem(key) || localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function writeKey(key, value, keep) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
      (keep ? localStorage : sessionStorage).setItem(key, value);
    } catch (e) { /* storage refused: the value lives for this page only */ }
  }
  function dropKey(key) {
    try { sessionStorage.removeItem(key); localStorage.removeItem(key); } catch (e) { /* nothing to drop */ }
  }
  function keepSignedIn() {
    try { return !!localStorage.getItem(KEY_TOKEN) || !!localStorage.getItem(KEY_OAUTH); } catch (e) { return false; }
  }

  var token = '';
  function oauthRecord() {
    try { return JSON.parse(readKey(KEY_OAUTH) || 'null'); } catch (e) { return null; }
  }
  function loadToken() {
    token = readKey(KEY_TOKEN);
    if (!token) {
      var o = oauthRecord();
      if (o && o.access_token) token = o.access_token;
    }
    return token;
  }
  function forgetToken() {
    token = '';
    dropKey(KEY_TOKEN);
    dropKey(KEY_OAUTH);
  }

  /* ---------- the sign-in service (symphony-app/signin), when it is deployed ---------- */
  function signinAvailable() { return !!(SIGNIN_SERVICE && CLIENT_ID); }
  // the page's own address, as the App's callback URL names it (no index.html, no query)
  function pageAddress() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  function randomHex(bytes) {
    var out = '';
    var b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    for (var i = 0; i < b.length; i++) out += (b[i] + 256).toString(16).slice(1);
    return out;
  }
  function base64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // PKCE: a secret for this one sign-in stays in this tab, GitHub gets its hash, and only the holder
  // of the secret can turn the code GitHub sends back into a token. The "keep me signed in" tick
  // travels with it, since the page that comes back from GitHub is a fresh load.
  function startOauth() {
    if (!window.crypto || !crypto.subtle || !crypto.getRandomValues) { say('This browser cannot make the sign-in\'s secret (no Web Crypto); paste a token instead.', true); return; }
    var state = randomHex(16);
    var verifier = randomHex(32);
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      var challenge = base64url(new Uint8Array(hash));
      var keep = $('cp-keep') ? $('cp-keep').checked : false;
      try {
        sessionStorage.setItem(KEY_STATE, JSON.stringify({ state: state, verifier: verifier, keep: keep }));
      } catch (e) { say('This browser refuses session storage, which the sign-in needs to come back; paste a token instead.', true); return; }
      location.href = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent(pageAddress()) + '&state=' + encodeURIComponent(state)
        + '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
    }).catch(function (e) { say('The sign-in could not start: ' + e.message, true); });
  }
  // an answer of the service that means "not now" rather than "this token is dead"
  var TEMPORARY = { github_unreachable: true, too_many_requests: true, not_configured: true };
  function exchange(route, body) {
    return fetch(SIGNIN_SERVICE + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(function () { var err = new Error('The sign-in service could not be reached.'); err.kind = 'unreachable'; throw err; })
      .then(function (r) {
        return r.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
          if (!data || typeof data !== 'object') {
            var e1 = new Error('The sign-in service answered ' + r.status + ' with nothing readable; the address the page holds for it may be wrong.');
            e1.kind = 'unreachable';
            throw e1;
          }
          if (!r.ok || data.error) {
            var e2 = new Error('The sign-in service answered ' + r.status + (data.error ? ': ' + data.error : '') + (data.error_description ? ' (' + data.error_description + ')' : '') + '.');
            e2.kind = data.error && !TEMPORARY[data.error] ? 'refused' : 'unreachable';
            throw e2;
          }
          return data;
        });
      });
  }
  function keepOauth(answer, keep) {
    var now = Date.now();
    var record = {
      access_token: answer.access_token,
      refresh_token: answer.refresh_token || '',
      expires_at: answer.expires_in ? now + Number(answer.expires_in) * 1000 : 0,
      refresh_expires_at: answer.refresh_token_expires_in ? now + Number(answer.refresh_token_expires_in) * 1000 : 0
    };
    writeKey(KEY_OAUTH, JSON.stringify(record), keep);
    dropKey(KEY_TOKEN);
    token = record.access_token;
  }
  function finishOauth() {
    var q = new URLSearchParams(location.search);
    var code = q.get('code'), state = q.get('state'), error = q.get('error'), description = q.get('error_description') || '';
    if (!code && !error) return Promise.resolve(false);
    var kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(KEY_STATE) || 'null'); sessionStorage.removeItem(KEY_STATE); } catch (e) { kept = null; }
    // the code and GitHub's words leave the address before anything else, so neither stays in the history
    ['code', 'state', 'error', 'error_description', 'error_uri'].forEach(function (k) { q.delete(k); });
    var clean = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
    try { history.replaceState(null, '', clean); } catch (e2) { /* the address stays */ }
    if (error) { say('GitHub did not sign you in (' + error + (description ? ': ' + description : '') + '). Try again, or paste a token.', true); return Promise.resolve(false); }
    if (!signinAvailable()) return Promise.resolve(false);
    if (!kept || !state || kept.state !== state || !kept.verifier) { say('The sign-in did not come back the way it left (its state differs); start it again.', true); return Promise.resolve(false); }
    return exchange('/exchange', { code: code, code_verifier: kept.verifier, redirect_uri: pageAddress() }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      keepOauth(answer, !!kept.keep);
      return true;
    }).catch(function (e) { say(e.message, true); return false; });
  }
  // one renewal at a time: GitHub's refresh tokens are single use, so two renewals at once would
  // spend the same one twice and leave the page signed out
  var refreshing = null;
  function expired(message) {
    forgetToken();
    showGate();
    say(message, true);
    return new Error(message);
  }
  function ensureToken() {
    var o = oauthRecord();
    if (!o || !o.refresh_token || !o.expires_at || Date.now() < o.expires_at - 60000 || !signinAvailable()) return Promise.resolve(token);
    if (refreshing) return refreshing;
    if (o.refresh_expires_at && Date.now() >= o.refresh_expires_at) return Promise.reject(expired('Your sign-in expired (its six months are over); sign in again.'));
    refreshing = exchange('/refresh', { refresh_token: o.refresh_token }).then(function (answer) {
      refreshing = null;
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      keepOauth(answer, keepSignedIn());
      return token;
    }).catch(function (e) {
      refreshing = null;
      if (e.kind === 'refused') throw expired('Your sign-in expired or was revoked; sign in again.');
      say('The token could not be renewed: ' + e.message + ' Try again in a moment.', true);
      throw e;
    });
    return refreshing;
  }

  /* ---------- the GitHub client ---------- */
  function explain(status, data, path) {
    var m = data && data.message ? String(data.message) : '';
    if (status === 401) return 'GitHub refused the token (401). Sign in again with a token that is still valid.';
    if (status === 429 || (status === 403 && /rate limit|secondary/i.test(m))) return 'GitHub\'s rate limit for this token is reached (' + status + '). Wait a minute, then press Refresh.';
    if (status === 403) return 'The token may not do this (403' + (m ? ': ' + m : '') + '). A fine-grained token needs the permission the sign-in box names for it.';
    if (status === 404) return 'GitHub has nothing at ' + path + ' (404): the repository, the branch or the file is not there, or the token does not reach it.';
    if (status === 422) return 'GitHub refused the request (422' + (m ? ': ' + m : '') + ').';
    return 'GitHub answered ' + status + (m ? ': ' + m : '') + '.';
  }
  function gh(method, path, body, headers, raw) {
    return ensureToken().then(function () {
      var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) h['Authorization'] = 'Bearer ' + token;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      var k;
      for (k in (headers || {})) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      return fetch(API + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    }).then(function (r) {
      if (r.status === 204 || r.status === 205) return { status: r.status, data: null, headers: r.headers };
      return r.text().then(function (t) {
        if (raw && r.ok) return { status: r.status, data: t, headers: r.headers };
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        if (!r.ok) {
          var err = new Error(explain(r.status, data, path));
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return { status: r.status, data: data, headers: r.headers };
      });
    });
  }
  function nextPage(headers) {
    var l = headers && headers.get ? headers.get('Link') : '';
    if (!l) return '';
    var m = /<([^>]+)>;\s*rel="next"/.exec(l);
    return m ? m[1].replace(API, '') : '';
  }
  // the pages of a list, up to a number of them; the array says .more when GitHub had another page
  function ghList(path, pages) {
    var out = [];
    function step(p, left) {
      return gh('GET', p).then(function (r) {
        if (Array.isArray(r.data)) out = out.concat(r.data);
        var n = nextPage(r.headers);
        if (n && left <= 1) { out.more = true; return out; }
        return n ? step(n, left - 1) : out;
      });
    }
    return step(path, pages || 3);
  }
  function file(repo, path, ref) {
    return gh('GET', '/repos/' + repo + '/contents/' + path + (ref ? '?ref=' + encodeURIComponent(ref) : ''), undefined, RAW, true)
      .then(function (r) { return typeof r.data === 'string' ? r.data : ''; });
  }

  /* ---------- a small, safe Markdown renderer for the board ---------- */
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>';
    });
    return s;
  }
  function markdown(src) {
    var lines = escapeHtml(String(src).replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '')).split('\n');
    var out = [], i = 0, para = [], list = null, table = null, code = false;
    function flushPara() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<ul>' + list.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>'); list = null; } }
    function cells(row) {
      var t = row.trim();
      if (t.charAt(0) === '|') t = t.slice(1);
      if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
      // the board writes a pipe inside a cell as \|, which is no column break
      return t.replace(/\\\|/g, '\u0001').split('|').map(function (c) { return c.replace(/\u0001/g, '|').trim(); });
    }
    function flushTable() {
      if (!table) return;
      var rows = table.filter(function (r) { return !/^\|?\s*:?-{2,}/.test(r.trim()); });
      if (!rows.length) { table = null; return; }
      var html = '<div class="table-scroll"><table><thead><tr>' + cells(rows[0]).map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
      for (var r = 1; r < rows.length; r++) html += '<tr>' + cells(rows[r]).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
      out.push(html + '</tbody></table></div>');
      table = null;
    }
    for (; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); flushList(); flushTable();
        if (code) { out.push('</pre>'); code = false; } else { out.push('<pre class="admin__text">'); code = true; }
        continue;
      }
      if (code) { out.push(line); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); flushTable(); var n = Math.min(h[1].length + 1, 6); out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); continue; }
      if (/^\s*\|/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
      var li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) { flushPara(); flushTable(); (list = list || []).push(li[1]); continue; }
      if (!line.trim()) { flushPara(); flushList(); flushTable(); continue; }
      flushList(); flushTable();
      para.push(line.trim());
    }
    flushPara(); flushList(); flushTable();
    if (code) out.push('</pre>');
    return out.join('\n');
  }

  /* ---------- the repositories listed on the page ---------- */
  function repos() {
    try {
      var l = JSON.parse(readKey(KEY_REPOS) || '[]');
      return Array.isArray(l) ? l.filter(function (r) { return typeof r === 'string' && REPOSITORY.test(r); }) : [];
    } catch (e) { return []; }
  }
  function saveRepos(list) { writeKey(KEY_REPOS, JSON.stringify(list), true); }
  function rememberRepo(name) {
    var list = repos();
    if (list.indexOf(name) < 0) { list.push(name); saveRepos(list); }
    writeKey(KEY_REPO, name, true);
  }
  function chosenRepo() {
    var q = new URLSearchParams(location.search).get('repo') || '';
    if (REPOSITORY.test(q)) return q;
    var kept = readKey(KEY_REPO);
    if (REPOSITORY.test(kept) && repos().indexOf(kept) >= 0) return kept;
    return repos()[0] || '';
  }
  function fillRepoSelect(select, current) {
    clear(select);
    var list = repos();
    if (!list.length) add(select, el('option', '', 'No repository listed yet')).firstChild.value = '';
    list.forEach(function (name) {
      var o = el('option', '', name);
      o.value = name;
      if (name === current) o.selected = true;
      select.appendChild(o);
    });
    select.disabled = !list.length;
  }

  /* ---------- the sign-in box, shared by both pages ---------- */
  function wireGate(onSignedIn) {
    var gate = $('cp-gate');
    if (!gate) return;
    if (signinAvailable() && $('cp-oauth')) {
      $('cp-oauth').classList.remove('hidden');
      $('cp-signin').addEventListener('click', startOauth);
    }
    $('cp-open').addEventListener('click', function () {
      var t = ($('cp-token').value || '').trim();
      if (!t) { say('Paste a token first.', true); return; }
      writeKey(KEY_TOKEN, t, $('cp-keep').checked);
      dropKey(KEY_OAUTH);
      token = t;
      $('cp-token').value = '';
      onSignedIn();
    });
    $('cp-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('cp-open').click(); });
  }
  function showGate() {
    if ($('cp-gate')) $('cp-gate').classList.remove('hidden');
    if ($('cp-app')) $('cp-app').classList.add('hidden');
    if ($('cp-who')) $('cp-who').textContent = '';
  }
  function showApp() {
    if ($('cp-gate')) $('cp-gate').classList.add('hidden');
    if ($('cp-app')) $('cp-app').classList.remove('hidden');
  }
  function whoAmI() {
    return gh('GET', '/user').then(function (r) {
      var login = r.data && r.data.login ? r.data.login : '';
      if ($('cp-who')) $('cp-who').textContent = login ? 'Signed in as ' + login + (keepSignedIn() ? ', kept on this browser.' : ', for this tab.') : '';
      return login;
    });
  }
  // forgetting a token from "Sign in with GitHub" also asks GitHub, through the service, to revoke it
  function signOut() {
    var o = oauthRecord();
    forgetToken();
    showGate();
    if (o && o.access_token && signinAvailable()) {
      say('The token is forgotten here; asking GitHub to revoke it...');
      exchange('/revoke', { access_token: o.access_token }).then(function () {
        say('The token is forgotten and revoked at GitHub; the repositories you listed stay.');
      }).catch(function (e) {
        say('The token is forgotten here, but GitHub could not be asked to revoke it (' + e.message + '). It expires within eight hours; Settings, Applications, Authorized GitHub Apps revokes the App\'s authorization now.', true);
      });
      return;
    }
    say('The token is forgotten; the repositories you listed stay.');
  }

  /* ============================================================
     The control panel
     ============================================================ */
  // one state per load; a loader that finds its state is no longer the page's drops its answer, so
  // switching repositories while one is still loading cannot mix the two
  function emptyState(name) { return { repo: name, meta: null, issues: [], workers: [], runs: [], pulls: [], boardAt: '', ready: false, failed: [] }; }
  var state = emptyState('');
  function stale(s) { return s !== state; }
  function failed(s, what, e) { s.failed.push(what + ' (' + e.message + ')'); }

  function labelsOf(issue) { return (issue.labels || []).map(labelName); }
  function workerOf(labels) {
    var names = labels.filter(function (l) { return /^(worker|account|agent):/.test(l); }).map(function (l) { return l.replace(/^[a-z]+:/, ''); });
    return names.join(', ');
  }
  function sortIssues(issues) {
    var g = { blockers: [], epics: [], claimed: [], review: [], blocked: [], given: [], queue: [], other: [] };
    issues.forEach(function (it) {
      if (it.pull_request) return;
      var l = labelsOf(it);
      var worker = workerOf(l);
      if (l.indexOf('blocker') >= 0) g.blockers.push(it);
      else if (l.indexOf('epic') >= 0) g.epics.push(it);
      else if (l.indexOf('in-review') >= 0) g.review.push(it);
      else if (l.indexOf('claimed') >= 0) g.claimed.push(it);
      else if (l.indexOf('blocked') >= 0) g.blocked.push(it);
      else if (worker) g.given.push(it);
      else if (l.indexOf('todo') >= 0) g.queue.push(it);
      else g.other.push(it);
    });
    return g;
  }

  function issueRow(it, acts) {
    var tr = el('tr');
    var l = labelsOf(it);
    add(tr, add(el('td'), link(it.html_url, '#' + it.number)));
    add(tr, el('td', '', it.title));
    add(tr, el('td', '', l.join(', ') || ''));
    add(tr, el('td', '', workerOf(l) || ''));
    add(tr, add(el('td'), timeEl(it.updated_at)));
    var act = el('td', 'admin__act');
    if (acts) acts(act, it);
    add(tr, act);
    return tr;
  }
  function issueTable(id, list, acts) {
    var body = $(id).querySelector('tbody');
    clear(body);
    if (!list.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'None.')).firstChild.colSpan = 6; body.appendChild(tr); return; }
    list.forEach(function (it) { body.appendChild(issueRow(it, acts)); });
  }
  function workerNames() {
    return state.workers.map(function (w) { return w.name; }).filter(Boolean);
  }
  function giveTo(issue, name) {
    if (!WORKER_NAME.test(name)) { say('A worker\'s name is lower-case letters, digits and inner dashes, up to 39.', true); return; }
    var label = 'worker:' + name;
    var s = state;
    say('Giving #' + issue.number + ' to ' + name + '...');
    gh('GET', '/repos/' + s.repo + '/labels/' + encodeURIComponent(label)).catch(function (e) {
      if (e.status !== 404) throw e;
      return gh('POST', '/repos/' + s.repo + '/labels', { name: label, color: LABEL_COLOR, description: 'Held or given to the worker ' + name });
    }).then(function () {
      return gh('POST', '/repos/' + s.repo + '/issues/' + issue.number + '/labels', { labels: [label] });
    }).then(function () {
      if (stale(s)) return;
      say('#' + issue.number + ' is given to ' + name + '; a worker in Actions wakes on the label.');
      return loadIssues(s);
    }).catch(function (e) { say(e.message, true); });
  }
  function askButton(it) {
    return btn('Ask Claude on it', true, function () {
      $('cp-prompt-target').value = String(it.number);
      $('cp-prompt').focus();
      $('cp-prompt').scrollIntoView();
    });
  }
  // "Give to" is offered where the protocol lets a label give the issue: the queue, the issues given
  // and the blocked ones; a claimed issue names its holder alone, and an epic is the coordinator's
  function issueActions(act, it) {
    var sel = el('select');
    var names = workerNames();
    add(sel, el('option', '', names.length ? 'Give to...' : 'No worker registered')).firstChild.value = '';
    names.forEach(function (n) { var o = el('option', '', n); o.value = n; sel.appendChild(o); });
    sel.setAttribute('aria-label', 'Give #' + it.number + ' to a worker');
    sel.disabled = !names.length;
    sel.addEventListener('change', function () { if (sel.value) giveTo(it, sel.value); sel.value = ''; });
    add(act, sel, ' ', askButton(it));
  }
  function askOnly(act, it) { add(act, askButton(it)); }

  function loadMeta(s) {
    return gh('GET', '/repos/' + s.repo).then(function (r) { if (!stale(s)) s.meta = r.data; return r.data; });
  }
  function loadIssues(s) {
    return ghList('/repos/' + s.repo + '/issues?state=open&per_page=100', 5).then(function (list) {
      if (stale(s)) return;
      s.issues = list;
      var g = sortIssues(list);
      issueTable('cp-queue', g.queue, issueActions);
      issueTable('cp-given', g.given, issueActions);
      issueTable('cp-claimed', g.claimed, askOnly);
      issueTable('cp-review', g.review, askOnly);
      issueTable('cp-blocked', g.blocked.concat(g.blockers), issueActions);
      issueTable('cp-epics', g.epics, askOnly);
      $('cp-other').textContent = (g.other.length ? plural(g.other.length, 'other open issue') + ' carries none of the protocol\'s labels: ' + g.other.slice(0, 8).map(function (it) { return '#' + it.number + ' ' + it.title; }).join('; ') + (g.other.length > 8 ? '; ...' : '') + '.' : '')
        + (list.more ? ' Only the first ' + list.length + ' open issues were read; the rest are on GitHub.' : '');
      // the summary is written once everything of the first load is in, and again after each change
      if (s.ready) summary();
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the issues', e);
      $('cp-other').textContent = 'The issues could not be read: ' + e.message;
      if (s.ready) summary();
    });
  }
  function loadBoard(s) {
    var box = $('cp-board');
    return file(s.repo, 'STATE.md', 'board').then(function (text) {
      if (stale(s)) return;
      box.innerHTML = markdown(text);
      return gh('GET', '/repos/' + s.repo + '/branches/board').then(function (r) {
        if (stale(s)) return;
        var when = r.data && r.data.commit && r.data.commit.commit && r.data.commit.commit.committer ? r.data.commit.commit.committer.date : '';
        if (when) { s.boardAt = when; $('cp-board-when').textContent = 'Written ' + ago(when) + ' (' + stamp(when) + ').'; }
      }).catch(function () { /* the board is shown; its date is not known */ });
    }).catch(function (e) {
      if (stale(s)) return;
      clear(box);
      $('cp-board-when').textContent = '';
      if (e.status === 404) none(box, 'The board has not been written yet: the branch board appears after the first run of the board workflow, on the first issue, push or pull request.');
      else { failed(s, 'the board', e); none(box, e.message); }
    });
  }
  function loadWorkers(s) {
    var body = $('cp-workers').querySelector('tbody');
    return gh('GET', '/repos/' + s.repo + '/contents/.github/symphony/workers').then(function (r) {
      var files = (Array.isArray(r.data) ? r.data : []).filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name); });
      return Promise.all(files.map(function (f) {
        return file(s.repo, '.github/symphony/workers/' + f.name).then(function (text) {
          try { return JSON.parse(text); } catch (e) { return { name: f.name.replace(/\.json$/, ''), about: 'this file does not parse as JSON' }; }
        });
      }));
    }).catch(function (e) {
      if (e.status === 404) return [];
      if (!stale(s)) failed(s, 'the workers', e);
      return [{ name: '', about: 'The workers could not be read: ' + e.message }];
    }).then(function (workers) {
      if (stale(s)) return;
      s.workers = workers.filter(function (w) { return w && w.name; });
      clear(body);
      if (!workers.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'None registered: people\'s sessions work under their own GitHub logins and need no file.')).firstChild.colSpan = 8; body.appendChild(tr); }
      workers.forEach(function (w) {
        var tr = el('tr');
        add(tr, el('td', '', w.name || ''));
        add(tr, el('td', '', w.runs || ''));
        add(tr, el('td', '', w.about || ''));
        add(tr, el('td', '', Array.isArray(w.area) ? w.area.join(', ') : (w.area || 'anywhere')));
        add(tr, el('td', '', w.lands || ''));
        add(tr, el('td', '', w.model || 'default'));
        add(tr, el('td', '', w.max_turns != null ? String(w.max_turns) : ''));
        add(tr, el('td', '', w.rounds != null ? String(w.rounds) : ''));
        body.appendChild(tr);
      });
      return loadIssues(s);
    });
  }
  function conclusionWord(run) {
    if (run.status !== 'completed') return run.status.replace(/_/g, ' ');
    return run.conclusion ? run.conclusion.replace(/_/g, ' ') : 'completed';
  }
  function loadRuns(s) {
    var body = $('cp-runs').querySelector('tbody');
    var note = $('cp-runs-note');
    return gh('GET', '/repos/' + s.repo + '/actions/runs?per_page=15').then(function (r) {
      if (stale(s)) return;
      var runs = r.data && r.data.workflow_runs ? r.data.workflow_runs : [];
      s.runs = runs;
      clear(body);
      note.textContent = '';
      if (!runs.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'No run yet.')).firstChild.colSpan = 6; body.appendChild(tr); }
      runs.forEach(function (run) {
        var tr = el('tr');
        add(tr, add(el('td'), link(run.html_url, run.name || run.display_title || 'run')));
        add(tr, el('td', '', run.event));
        add(tr, el('td', '', run.head_branch || ''));
        var w = conclusionWord(run);
        add(tr, el('td', '', w)).lastChild.className = w === 'success' ? 'admin__tag admin__tag--ok' : (w === 'failure' ? 'admin__tag admin__tag--wait' : 'admin__tag admin__tag--mid');
        add(tr, el('td', '', run.actor && run.actor.login ? run.actor.login : ''));
        add(tr, add(el('td'), timeEl(run.run_started_at || run.created_at)));
        body.appendChild(tr);
      });
    }).catch(function (e) {
      if (stale(s)) return;
      s.runs = [];
      clear(body);
      if (e.status === 403 || e.status === 404) {
        note.textContent = 'The token cannot list Actions runs (' + e.status + '); showing the check runs on the default branch instead. A fine-grained token with Actions: read lists the runs.';
        return checkRunsFallback(s, body);
      }
      failed(s, 'the Actions runs', e);
      var tr = el('tr'); add(tr, el('td', 'admin__none', e.message)).firstChild.colSpan = 6; body.appendChild(tr);
    });
  }
  function checkRunsFallback(s, body) {
    var branch = s.meta && s.meta.default_branch ? s.meta.default_branch : 'main';
    return gh('GET', '/repos/' + s.repo + '/commits/' + encodeURIComponent(branch) + '/check-runs?per_page=30').then(function (r) {
      if (stale(s)) return;
      var runs = r.data && r.data.check_runs ? r.data.check_runs : [];
      if (!runs.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'No check run on ' + branch + ' yet.')).firstChild.colSpan = 6; body.appendChild(tr); }
      runs.forEach(function (run) {
        var tr2 = el('tr');
        add(tr2, add(el('td'), link(run.html_url, run.name)));
        add(tr2, el('td', '', 'check run'));
        add(tr2, el('td', '', branch));
        add(tr2, el('td', '', run.status === 'completed' ? (run.conclusion || 'completed') : run.status));
        add(tr2, el('td', '', run.app && run.app.slug ? run.app.slug : ''));
        add(tr2, add(el('td'), timeEl(run.completed_at || run.started_at)));
        body.appendChild(tr2);
      });
    }).catch(function (e) { if (stale(s)) return; var tr = el('tr'); add(tr, el('td', 'admin__none', e.message)).firstChild.colSpan = 6; body.appendChild(tr); });
  }
  function checksOf(s, pr, cell, mergeBtn) {
    gh('GET', '/repos/' + s.repo + '/commits/' + pr.head.sha + '/check-runs?per_page=100').then(function (r) {
      if (stale(s)) return;
      var runs = r.data && r.data.check_runs ? r.data.check_runs : [];
      var total = r.data && r.data.total_count != null ? Number(r.data.total_count) : runs.length;
      if (!runs.length) { cell.textContent = 'no checks yet'; return; }
      var ok = 0, bad = 0, wait = 0;
      runs.forEach(function (c) {
        if (c.status !== 'completed') wait++;
        else if (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral') ok++;
        else bad++;
      });
      var unread = total > runs.length ? total - runs.length : 0;
      cell.textContent = (bad ? bad + ' failed, ' : '') + (wait ? wait + ' running, ' : '') + ok + ' of ' + runs.length + ' passed' + (unread ? ' (' + unread + ' more not read; see GitHub)' : '');
      cell.className = bad ? 'admin__tag admin__tag--wait' : (wait || unread ? 'admin__tag admin__tag--mid' : 'admin__tag admin__tag--ok');
      pr._green = !bad && !wait && !unread;
      mergeBtn.disabled = !(pr._green && !pr.draft);
    }).catch(function (e) { if (!stale(s)) cell.textContent = e.status === 403 ? 'checks not readable' : e.message; });
  }
  // a merge takes two presses on the same named button, so a browsing agent reads and confirms it
  // in the page, where a dialog would be invisible to it
  function mergePull(pr, button, act) {
    if (!button.getAttribute('data-armed')) {
      button.setAttribute('data-armed', '1');
      button.textContent = 'Confirm: merge #' + pr.number + ' into ' + pr.base.ref;
      var cancel = btn('Cancel', true, function () { button.removeAttribute('data-armed'); button.textContent = 'Merge'; act.removeChild(cancel); });
      act.appendChild(cancel);
      return;
    }
    var s = state;
    button.disabled = true;
    say('Merging #' + pr.number + ' into ' + pr.base.ref + ' with a merge commit...');
    gh('PUT', '/repos/' + s.repo + '/pulls/' + pr.number + '/merge', { merge_method: 'merge', sha: pr.head.sha }).then(function () {
      if (stale(s)) return;
      say('#' + pr.number + ' is merged.');
      return loadPulls(s).then(function () { return loadIssues(s); }).then(summary);
    }).catch(function (e) {
      say(e.message + (e.status === 403 ? ' Merging needs Contents: read and write on the token.' : (e.status === 405 ? ' GitHub does not allow this merge yet: a required check or review is missing.' : '')), true);
      button.disabled = false;
    });
  }
  function loadPulls(s) {
    var body = $('cp-pulls').querySelector('tbody');
    return ghList('/repos/' + s.repo + '/pulls?state=open&per_page=100', 2).then(function (pulls) {
      if (stale(s)) return;
      s.pulls = pulls;
      clear(body);
      if (!pulls.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'No open pull request.')).firstChild.colSpan = 7; body.appendChild(tr); }
      pulls.forEach(function (pr) {
        var tr = el('tr');
        add(tr, add(el('td'), link(pr.html_url, '#' + pr.number)));
        add(tr, el('td', '', pr.title));
        add(tr, el('td', '', pr.head.ref));
        add(tr, el('td', '', pr.draft ? 'draft' : 'ready'));
        var checks = el('td', '', 'reading...');
        add(tr, checks);
        add(tr, add(el('td'), timeEl(pr.updated_at)));
        var act = el('td', 'admin__act');
        var m = btn('Merge', true, function () { mergePull(pr, m, act); });
        m.disabled = true;
        m.title = 'Enabled once the pull request is ready and every check has passed';
        add(act, m);
        add(tr, act);
        body.appendChild(tr);
        checksOf(s, pr, checks, m);
      });
      if (pulls.more) { var more = el('tr'); add(more, el('td', 'admin__none', 'Only the first ' + pulls.length + ' open pull requests were read; the rest are on GitHub.')).firstChild.colSpan = 7; body.appendChild(more); }
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the pull requests', e);
      clear(body);
      var tr = el('tr'); add(tr, el('td', 'admin__none', 'The pull requests could not be read: ' + e.message)).firstChild.colSpan = 7; body.appendChild(tr);
    });
  }

  function summary() {
    var p = $('cp-summary');
    if (!p) return;
    var s = state;
    if (!s.meta) {
      p.textContent = s.failed.length ? 'Could not read ' + s.repo + ': ' + s.failed.join('; ') + '.' : 'Reading ' + s.repo + '...';
      return;
    }
    var g = sortIssues(s.issues);
    var inActions = s.workers.filter(function (w) { return w.runs === 'actions'; }).map(function (w) { return w.name; });
    var routines = s.workers.filter(function (w) { return w.runs === 'routine'; }).map(function (w) { return w.name; });
    var claimedBy = g.claimed.map(function (it) { return '#' + it.number + (workerOf(labelsOf(it)) ? ' by ' + workerOf(labelsOf(it)) : ''); });
    var last = s.runs[0];
    var atLeast = s.issues.more ? 'at least ' : '';
    var parts = [
      s.repo + ', default branch ' + s.meta.default_branch + ', ' + (s.meta.private ? 'private' : 'public') + (s.meta.archived ? ', archived (read-only on GitHub, so nothing here can write to it)' : '') + (s.meta.fork ? ', a fork' : '') + (s.meta.topics && s.meta.topics.indexOf(TOPIC) >= 0 ? ', adopted (topic symphony).' : ', without the topic symphony.'),
      'Board: ' + (s.boardAt ? 'written ' + ago(s.boardAt) + '.' : 'not written yet.'),
      'Queue: ' + atLeast + plural(g.queue.length, 'unclaimed issue') + '; given to workers: ' + g.given.length + '; claimed: ' + g.claimed.length + (claimedBy.length ? ' (' + claimedBy.join(', ') + ')' : '') + '; in review: ' + g.review.length + '; blocked: ' + g.blocked.length + '; blockers: ' + g.blockers.length + '; epics: ' + g.epics.length + '.',
      'Open pull requests: ' + (s.pulls.more ? 'at least ' : '') + s.pulls.length + (s.pulls.length ? ' (' + s.pulls.filter(function (x) { return x.draft; }).length + ' drafts)' : '') + '.',
      'Workers in Actions: ' + (inActions.length ? inActions.join(', ') : 'none') + '; routines: ' + (routines.length ? routines.join(', ') : 'none') + '.',
      last ? 'Last run: ' + (last.name || 'run') + ', ' + conclusionWord(last) + ', ' + ago(last.run_started_at || last.created_at) + '.' : 'Runs: none listed.',
      s.failed.length ? 'Not read: ' + s.failed.join('; ') + '.' : ''
    ];
    p.textContent = parts.filter(Boolean).join(' ');
  }

  function loadRepo(name) {
    var s = state = emptyState(name);
    $('cp-repo-name').textContent = name;
    $('cp-on-github').href = 'https://github.com/' + name;
    $('cp-board-link').href = 'https://github.com/' + name + '/blob/board/STATE.md';
    $('cp-actions-link').href = 'https://github.com/' + name + '/actions';
    $('cp-issues-link').href = 'https://github.com/' + name + '/issues';
    $('cp-worker-form-link').href = 'https://github.com/' + name + '/issues/new?template=worker.yml';
    $('cp-task-form-link').href = 'https://github.com/' + name + '/issues/new?template=task.yml';
    $('cp-summary').textContent = 'Reading ' + name + '...';
    try { history.replaceState(null, '', location.pathname + '?repo=' + encodeURIComponent(name) + location.hash); } catch (e) { /* the address stays */ }
    rememberRepo(name);
    fillRepoSelect($('cp-repo'), name);
    return loadMeta(s).then(function () {
      if (stale(s)) return;
      return Promise.all([loadBoard(s), loadWorkers(s), loadRuns(s), loadPulls(s)]);
    }).then(function () {
      if (stale(s)) return;
      s.ready = true;
      summary();
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the repository', e);
      s.ready = true;
      say(e.message, true);
      summary();
    });
  }

  /* ---------- adding a repository ---------- */
  function installLink(meta) {
    var ownerId = meta.owner && meta.owner.id != null ? String(meta.owner.id) : '';
    var repoId = meta.id != null ? String(meta.id) : '';
    var base = 'https://github.com/apps/' + APP_SLUG + '/installations/new';
    var stateQ = 'state=' + encodeURIComponent(meta.full_name);
    if (!GITHUB_ID.test(ownerId)) return base + '?' + stateQ;
    var address = base + '/permissions?target_id=' + ownerId + '&suggested_target_id=' + ownerId;
    if (GITHUB_ID.test(repoId)) address += '&repository_ids[]=' + repoId;
    return address + '&' + stateQ;
  }
  function addRepository(name) {
    var box = $('cp-add-answer');
    clear(box);
    if (!REPOSITORY.test(name)) { say('Write the repository as OWNER/NAME.', true); return; }
    say('Reading ' + name + '...');
    gh('GET', '/repos/' + name).then(function (r) {
      var meta = r.data;
      say('');
      if (meta.topics && meta.topics.indexOf(TOPIC) >= 0) {
        add(box, el('p', '', meta.full_name + ' is adopted already (it carries the topic symphony); it is on the list now.'));
        loadRepo(meta.full_name);
        return;
      }
      add(box, el('p', '', meta.full_name + ' does not carry the topic symphony, so Symphony is not set up on it yet. Two steps, on GitHub:'));
      var ol = el('ol');
      add(ol, add(el('li'), link(installLink(meta), 'Install SymphonyBoard on ' + meta.full_name), ' (the page comes with this one repository selected; it sends you on to Symphony Setup\'s install page, then to the form).'));
      add(ol, add(el('li'), 'On ', link(FORM_URL, 'the form'), ', press Create: the pull request lands within about two minutes and merges unless you asked to review it. Then come back here and press Add again.'));
      add(box, ol);
      add(box, btn('Add it to the list anyway', true, function () { clear(box); loadRepo(meta.full_name); }));
    }).catch(function (e) { say(e.message, true); });
  }
  function discover() {
    say('Looking for repositories with the topic symphony among those this token reaches...');
    ghList('/user/repos?per_page=100&sort=pushed', 3).then(function (list) {
      var found = list.filter(function (r) { return r.topics && r.topics.indexOf(TOPIC) >= 0; }).map(function (r) { return r.full_name; });
      if (!found.length) { say('None found' + (list.more ? ' among the 300 most recently pushed' : '') + '. A fine-grained token lists only the repositories it was made for; add one by name below.'); return; }
      var kept = repos();
      found.forEach(function (n) { if (kept.indexOf(n) < 0) kept.push(n); });
      saveRepos(kept);
      say('Found ' + plural(found.length, 'adopted repository', 'adopted repositories') + ': ' + found.join(', ') + (list.more ? ' (among the 300 most recently pushed; add an older one by name).' : '.'));
      loadRepo(state.repo || found[0]);
    }).catch(function (e) { say(e.message, true); });
  }

  /* ---------- the actions: a task, a worker, a prompt, the workflows ---------- */
  function formBody(pairs) {
    return pairs.map(function (p) { return '### ' + p[0] + '\n\n' + (p[1] && String(p[1]).trim() ? String(p[1]).trim() : '_No response_'); }).join('\n\n') + '\n';
  }
  // GitHub drops a label from a new issue, with no error, when the token may not label issues
  function queuedWords(data) {
    var has = (data.labels || []).map(labelName).indexOf('todo') >= 0;
    return has ? 'Queued as #' + data.number + '; a worker in Actions wakes on the label todo, and any session may claim it.'
      : 'Opened #' + data.number + ', but GitHub did not set the label todo: the token may not label issues (that takes push access to the repository), so add the label on GitHub for a worker to wake.';
  }
  function queueTask() {
    var title = ($('cp-task-title').value || '').trim();
    var goal = ($('cp-task-goal').value || '').trim();
    var acceptance = ($('cp-task-acceptance').value || '').trim();
    var files = ($('cp-task-files').value || '').trim();
    if (!title || !goal || !acceptance) { say('A task needs a title, a goal and an acceptance.', true); return; }
    var s = state;
    say('Queueing the task...');
    gh('POST', '/repos/' + s.repo + '/issues', {
      title: /^Task: /.test(title) ? title : 'Task: ' + title,
      body: formBody([['Goal', goal], ['Acceptance', acceptance], ['Files likely touched', files]]),
      labels: ['todo']
    }).then(function (r) {
      say(queuedWords(r.data));
      ['cp-task-title', 'cp-task-goal', 'cp-task-acceptance', 'cp-task-files'].forEach(function (id) { $(id).value = ''; });
      if (!stale(s)) return loadIssues(s);
    }).catch(function (e) { say(e.message, true); });
  }
  function addWorker() {
    var name = ($('cp-w-name').value || '').trim();
    if (!WORKER_NAME.test(name)) { say('A worker\'s name is lower-case letters, digits and inner dashes, up to 39.', true); return; }
    var runs = $('cp-w-runs').value;
    var lands = $('cp-w-lands').value;
    say('Opening the "Add a worker" issue...');
    gh('POST', '/repos/' + state.repo + '/issues', {
      title: 'Add a worker: ' + name,
      body: formBody([
        ['Name', name],
        ['Where it runs', runs],
        ['What it is for', $('cp-w-about').value],
        ['Area', $('cp-w-area').value],
        ['How its pull requests land', lands],
        ['Model', $('cp-w-model').value],
        ['Turns per run', $('cp-w-turns').value],
        ['Rounds in a row', $('cp-w-rounds').value],
        ['Claude account', $('cp-w-account').value]
      ])
    }).then(function (r) {
      say('Issue #' + r.data.number + ' is open; the add-worker workflow checks the answers, opens the pull request that adds the file and answers there with what to do next.');
      $('cp-w-name').value = '';
    }).catch(function (e) { say(e.message, true); });
  }
  function askClaude(asTask) {
    var text = ($('cp-prompt').value || '').trim();
    var target = ($('cp-prompt-target').value || '').trim();
    if (!text) { say('Write the prompt first.', true); return; }
    var firstLine = text.split('\n')[0].replace(/^@claude\s*/i, '').slice(0, 100) || 'From the control panel';
    var s = state;
    say('Sending...');
    var p;
    if (asTask) {
      p = gh('POST', '/repos/' + s.repo + '/issues', { title: 'Task: ' + firstLine, body: formBody([['Goal', text], ['Acceptance', 'The goal above holds and bash scripts/check.sh passes.'], ['Files likely touched', '']]), labels: ['todo'] })
        .then(function (r) { return queuedWords(r.data); });
    } else if (/^[0-9]{1,9}$/.test(target)) {
      p = gh('POST', '/repos/' + s.repo + '/issues/' + target + '/comments', { body: (/@claude/i.test(text) ? '' : '@claude ') + text })
        .then(function () { return 'Commented on #' + target + '; the Claude workflow answers there on the repository\'s own Claude token.'; });
    } else {
      p = gh('POST', '/repos/' + s.repo + '/issues', { title: firstLine, body: (/@claude/i.test(text) ? '' : '@claude ') + text })
        .then(function (r) { return 'Opened #' + r.data.number + '; the Claude workflow answers there on the repository\'s own Claude token.'; });
    }
    p.then(function (m) { say(m); $('cp-prompt').value = ''; $('cp-prompt-target').value = ''; if (!stale(s)) return loadIssues(s); }).catch(function (e) { say(e.message, true); });
  }
  function dispatch(workflow, label) {
    var s = state;
    var branch = s.meta && s.meta.default_branch ? s.meta.default_branch : 'main';
    say('Starting ' + label + '...');
    gh('POST', '/repos/' + s.repo + '/actions/workflows/' + workflow + '/dispatches', { ref: branch }).then(function () {
      say(label + ' is queued on ' + branch + '; the runs list shows it within a minute.');
      setTimeout(function () { if (!stale(s)) loadRuns(s); }, 4000);
    }).catch(function (e) { say(e.message + (e.status === 403 ? ' Starting a workflow needs Actions: read and write on the token.' : ''), true); });
  }

  function initPanel() {
    wireGate(function () { whoAmI().then(function () { showApp(); start(); }).catch(function (e) { say(e.message, true); }); });
    $('cp-signout').addEventListener('click', signOut);
    $('cp-refresh').addEventListener('click', function () { if (state.repo) loadRepo(state.repo); });
    $('cp-repo').addEventListener('change', function () { if ($('cp-repo').value) loadRepo($('cp-repo').value); });
    $('cp-add').addEventListener('click', function () { addRepository(($('cp-add-name').value || '').trim()); });
    $('cp-add-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('cp-add').click(); });
    $('cp-discover').addEventListener('click', discover);
    $('cp-forget-repo').addEventListener('click', function () {
      if (!state.repo) return;
      saveRepos(repos().filter(function (n) { return n !== state.repo; }));
      dropKey(KEY_REPO);
      say(state.repo + ' is off the list.');
      var next = repos()[0];
      if (next) loadRepo(next); else { state = emptyState(''); fillRepoSelect($('cp-repo'), ''); $('cp-summary').textContent = 'No repository listed. Add one below.'; }
    });
    $('cp-task-queue').addEventListener('click', queueTask);
    $('cp-w-add').addEventListener('click', addWorker);
    $('cp-prompt-ask').addEventListener('click', function () { askClaude(false); });
    $('cp-prompt-task').addEventListener('click', function () { askClaude(true); });
    $('cp-run-workers').addEventListener('click', function () { dispatch('workers.yml', 'the workers'); });
    $('cp-run-board').addEventListener('click', function () { dispatch('board.yml', 'the board'); });
    $('cp-run-ci').addEventListener('click', function () { dispatch('ci.yml', 'the checks'); });
    $('cp-run-metrics').addEventListener('click', function () { dispatch('metrics.yml', 'the metrics'); });

    function start() {
      var name = chosenRepo();
      fillRepoSelect($('cp-repo'), name);
      if (name) loadRepo(name); else $('cp-summary').textContent = 'No repository listed yet. Find them, or add one by name, below.';
    }
    finishOauth().then(function () {
      if (!loadToken()) { showGate(); return; }
      whoAmI().then(function () { showApp(); start(); }).catch(function (e) { say(e.message, true); showGate(); });
    });
  }

  /* ============================================================
     The cost page
     ============================================================ */
  // Anthropic's API list prices per million tokens: uncached input, cache writes kept five minutes,
  // kept an hour, cache reads, output. Read from platform.claude.com/docs/en/about-claude/pricing on
  // 2026-10-15. The field metrics in METRICS.json are priced by the Symphony template's own table
  // (tools/economics.py) as of the date its prices_as_of says, which this page prints beside them.
  var PRICES_AS_OF = '2026-10-15';
  var MODELS = {
    'claude-sonnet-5-5': { label: 'Sonnet 5.5', rates: [2.0, 2.5, 4.0, 0.10, 10.0] },
    'claude-opus-5-5': { label: 'Opus 5.5', rates: [4.0, 5.0, 8.0, 0.20, 20.0] },
    'claude-fable-5-1': { label: 'Fable 5.1', rates: [10.0, 12.5, 20.0, 0.25, 50.0] },
    'claude-haiku-5-5': { label: 'Haiku 5.5', rates: [0.10, 0.125, 0.20, 0.01, 0.50] }
  };
  // The flat plans a Symphony repository's workers run on (claude.com/pricing, 2026-10-15, monthly billing).
  var PLANS = {
    pro: { label: 'Claude Pro', usd: 20 },
    max5: { label: 'Claude Max 5x', usd: 100 },
    max20: { label: 'Claude Max 20x', usd: 200 }
  };
  // GitHub Copilot's plans and their monthly AI credits in dollars (1 credit = $0.01; github/docs,
  // data/variables/copilot.yml at commit 12691d2, 2026-10-15). Copilot prices Claude at Anthropic's
  // list prices (github/docs, copilot/reference/copilot-billing/models-and-pricing.md), so the same
  // tokens cost the same dollars in credits.
  var COPILOT = {
    pro: { label: 'Copilot Pro', usd: 10, credits: 15 },
    proplus: { label: 'Copilot Pro+', usd: 39, credits: 70 },
    max: { label: 'Copilot Max', usd: 100, credits: 200 }
  };
  // GitHub Actions: free and unlimited on public repositories; a private one on the Free plan has
  // 2,000 minutes a month, 3,000 on Pro and Team, then $0.006 a minute on a Linux 2-core runner
  // (github/docs at 12691d2, prices of 2026-01-01).
  var ACTIONS_MINUTE_USD = 0.006;
  var ACTIONS_INCLUDED = { free: 2000, pro: 3000 };

  function tokensCost(model, t) {
    var r = MODELS[model] ? MODELS[model].rates : MODELS['claude-sonnet-5-5'].rates;
    return (t.input * r[0] + t.write * r[1] + t.read * r[3] + t.output * r[4]) / 1e6;
  }
  function num(id, fallback) {
    var v = parseFloat($(id).value);
    return isNaN(v) || v < 0 ? fallback : v;
  }
  function row(table, cells, cls) {
    var tr = el('tr', cls || '');
    cells.forEach(function (c, i) { add(tr, i === 0 ? el('th', '', c) : el('td', '', c)); });
    table.appendChild(tr);
  }
  function calculate() {
    var runsPerDay = num('cc-runs', 10), days = num('cc-days', 30), minutes = num('cc-minutes', 10);
    var model = $('cc-model').value;
    var t = { input: num('cc-input', 20000), write: num('cc-write', 100000), read: num('cc-read', 1600000), output: num('cc-output', 25000) };
    var visibility = $('cc-visibility').value, plan = $('cc-plan').value, copilot = $('cc-copilot').value;
    var runs = runsPerDay * days;
    var tokensUsd = tokensCost(model, t) * runs;
    var minutesTotal = runs * minutes;
    var actionsUsd = visibility === 'public' ? 0 : Math.max(0, minutesTotal - ACTIONS_INCLUDED[visibility === 'private-pro' ? 'pro' : 'free']) * ACTIONS_MINUTE_USD;
    var body = $('cc-out').querySelector('tbody');
    clear(body);
    var planUsd = PLANS[plan].usd;
    row(body, ['Symphony (' + PLANS[plan].label + ', workers in Actions)', money(planUsd), money(actionsUsd), money(planUsd + actionsUsd),
      'The plan is the whole inference bill while the month\'s runs fit its five-hour and weekly windows; past them, usage credits bill the rest at the API prices below (' + money(tokensUsd) + ' for all of it).'], 'cost__us');
    row(body, ['An API key in Actions (gh-aw\'s Claude engine, claude-code-action with a key)', money(tokensUsd), money(actionsUsd), money(tokensUsd + actionsUsd),
      'Every token at Anthropic\'s list prices; no flat plan covers it, and gh-aw refuses the subscription token.']);
    var cp = COPILOT[copilot];
    var over = Math.max(0, tokensUsd - cp.credits);
    row(body, ['GitHub Copilot coding agent (' + cp.label + ')', money(cp.usd + over), money(actionsUsd), money(cp.usd + over + actionsUsd),
      cp.label + ' includes ' + money(cp.credits) + ' of AI credits a month; Copilot prices Claude at the same list prices, so ' + money(tokensUsd) + ' of tokens leaves ' + money(over) + ' to pay at $0.01 a credit.']);
    row(body, ['unsorry (volunteers\' own agents, coordination in Actions)', money(tokensUsd) + ' spread over the volunteers', visibility === 'public' ? '$0' : 'n/a (a public swarm)', money(tokensUsd),
      'The board, the dispatcher and the reaper run free in a public repository\'s Actions; each volunteer pays for their own claude -p, Codex or Gemini runs, at their plan or at API prices, which this column prices at the list.']);
    row(body, ['openai/codex-action, openai/symphony (an API key)', 'OpenAI\'s rates', money(actionsUsd), 'OpenAI\'s rates + ' + money(actionsUsd),
      'Codex in Actions needs an OpenAI API key; the dollars depend on OpenAI\'s price list, outside this table.']);
    $('cc-note').textContent = count(runs) + ' runs a month of ' + count(t.input + t.write + t.read + t.output) + ' tokens each on ' + MODELS[model].label + ' (' + count(minutesTotal) + ' runner minutes); tokens alone would cost ' + money(tokensUsd) + ' at the list prices of ' + PRICES_AS_OF + '.';
  }
  // the measured window into the calculator: its tokens spread over its sessions and runs, the
  // repository's visibility from GitHub, the plan from the selector above; the runner minutes are
  // not recorded, so the calculator's own figure stays
  function fromMeasured(e, windowDays, isPrivate, plan) {
    if (!e) return;
    var days = windowDays || 30;
    var runs = Math.max(1, (e.sessions || 0) + (e.actions_runs || 0));
    $('cc-runs').value = (runs / days).toFixed(2);
    $('cc-days').value = days;
    $('cc-input').value = Math.round((e.tokens_input || 0) / runs);
    $('cc-write').value = Math.round((e.tokens_cache_write || 0) / runs);
    $('cc-read').value = Math.round((e.tokens_cache_read || 0) / runs);
    $('cc-output').value = Math.round((e.tokens_output || 0) / runs);
    var fam = e.tokens_by_family || {};
    var top = Object.keys(fam).sort(function (a, b) { return (fam[b] || 0) - (fam[a] || 0); })[0];
    var pick = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }[top];
    if (pick) $('cc-model').value = pick;
    if (isPrivate != null && $('cc-visibility').value === 'public' === !!isPrivate) $('cc-visibility').value = isPrivate ? 'private' : 'public';
    if (plan && PLANS[plan]) $('cc-plan').value = plan;
    calculate();
    $('cc-note').textContent += ' These inputs are the last ' + days + ' days of ' + $('cost-repo').value + ', spread over its ' + count(runs) + ' recorded sessions and runs, priced here at the newest model of each family and the five-minute cache-write rate, so the figure can differ from the measured one' + (isPrivate ? '; the included Actions minutes depend on the repository\'s GitHub plan, which this page cannot read, so choose Pro or Team above if that applies' : '') + '.';
  }
  function measured() {
    var repo = $('cost-repo').value;
    var box = $('cost-measured');
    clear(box);
    if (!repo) { none(box, 'Choose a repository from the control panel\'s list first.'); return; }
    writeKey(KEY_REPO, repo, true);
    none(box, 'Reading the branch metrics of ' + repo + '...');
    var metaRead = gh('GET', '/repos/' + repo).then(function (r) { return r.data; }).catch(function () { return null; });
    Promise.all([file(repo, 'METRICS.json', 'metrics'), metaRead]).then(function (both) {
      var m = JSON.parse(both[0]);
      var meta = both[1];
      var isPrivate = meta ? !!meta.private : null;
      clear(box);
      if (m.sharing !== 'on') { none(box, 'Sharing is off in ' + repo + ' (' + (m.sharing || 'no value') + '), so the metrics workflow records nothing to read.'); return; }
      var e = m.economics, c = m.coordination;
      if (!e) { none(box, 'The record of ' + stamp(m.generated_at) + ' has no economics block yet: a run that reached the board\'s API reserve leaves it out, and the next day\'s run writes it.'); return; }
      var plan = readKey(KEY_PLAN) || 'max5';
      var days = m.window_days || 30;
      var table = el('table', 'cost__facts');
      var tb = el('tbody');
      row(tb, ['Window', 'The ' + days + ' days to ' + stamp(m.generated_at) + ' (priced by the template\'s table as of ' + (e.prices_as_of || 'an unknown date') + ')']);
      row(tb, ['Repository', meta ? (isPrivate ? 'private: its Actions minutes count against the included ones' : 'public: its Actions minutes are free') + (meta.archived ? '; archived' : '') : 'not readable with this token']);
      row(tb, ['Work', count(e.pull_requests) + ' pull requests ended, ' + count(e.merged) + ' merged, ' + count(e.pull_requests_measured) + ' with usage recorded; ' + count(e.sessions) + ' sessions and ' + count(e.actions_runs) + ' Actions runs recorded']);
      row(tb, ['Tokens', count(e.tokens_total) + ' (input ' + count(e.tokens_input) + ', cache writes ' + count(e.tokens_cache_write) + ', cache reads ' + count(e.tokens_cache_read) + ', output ' + count(e.tokens_output) + ')' + (e.tokens_unpriced ? '; ' + count(e.tokens_unpriced) + ' of a model the price table does not know' : '')]);
      row(tb, ['Time at work', hours(e.claude_seconds) + ' of Claude at work; ' + count(e.commits) + ' commits, ' + count(e.check_failures) + ' failed checks, ' + count(e.reverts) + ' reverts']);
      row(tb, ['At API list prices', money(e.estimated_usd) + ' for the window, of which the coordinator spent ' + money(e.coordinator_usd) + '; ' + money(e.usd_per_merge) + ' per merged pull request']);
      add(table, tb);
      add(box, el('h3', '', 'What the last ' + days + ' days cost on ' + repo));
      add(box, table);

      var sel = el('select');
      sel.id = 'cost-plan';
      Object.keys(PLANS).forEach(function (k) { var o = el('option', '', PLANS[k].label + ', ' + money(PLANS[k].usd) + ' a month'); o.value = k; if (k === plan) o.selected = true; sel.appendChild(o); });
      sel.setAttribute('aria-label', 'The Claude plan the workers run on');
      var cmp = el('table', 'cost__facts');
      function fill() {
        clear(cmp);
        var tb2 = el('tbody');
        var p = PLANS[sel.value];
        writeKey(KEY_PLAN, sel.value, true);
        var x = e.estimated_usd || 0;
        var minutesWords = isPrivate === false ? 'Actions minutes free on a public repository.'
          : (isPrivate ? 'Plus the Actions minutes past the included ones on this private repository (2,000 a month on GitHub Free, 3,000 on Pro and Team, then $0.006 a minute).' : 'Plus the Actions minutes on a private repository; none on a public one.');
        row(tb2, ['Symphony, as run', money(p.usd) + ' for ' + p.label + '. ' + minutesWords + ' Past the plan\'s windows, usage credits at the same list prices: at most ' + money(x) + ' more.'], 'cost__us');
        row(tb2, ['The same tokens on an API key (gh-aw, claude-code-action with a key)', money(x) + ', plus the same Actions minutes']);
        row(tb2, ['The same tokens on GitHub Copilot\'s coding agent', 'Copilot Pro ' + money(10 + Math.max(0, x - 15)) + ', Pro+ ' + money(39 + Math.max(0, x - 70)) + ', Max ' + money(100 + Math.max(0, x - 200)) + ' (the plan, plus the tokens past its included credits at $0.01 a credit), plus the same Actions minutes']);
        row(tb2, ['The same tokens under unsorry', money(x) + ' at the list, paid by the volunteers who ran the agents; coordination free in Actions']);
        if (c && c.ratios) {
          var r = c.ratios;
          var words = [];
          if (r.usd_per_merge != null) words.push('dollars per merge ' + r.usd_per_merge.toFixed(2));
          if (r.latency != null) words.push('latency ' + r.latency.toFixed(2));
          if (r.throughput != null) words.push('throughput ' + r.throughput.toFixed(2));
          if (r.first_check_pass != null) words.push('first check passed ' + r.first_check_pass.toFixed(2));
          if (r.commits_per_merge != null) words.push('commits per merge ' + r.commits_per_merge.toFixed(2));
          if (r.failures_per_pull_request != null) words.push('failures per pull request ' + r.failures_per_pull_request.toFixed(2));
          row(tb2, ['Parallel against alone', words.length ? words.join('; ') + ' (over 1, working in parallel did better; alone ' + count(c.alone.pull_requests) + ' pull requests, parallel ' + count(c.parallel.pull_requests) + ')' : 'no ratio yet: a side has nothing to divide (alone ' + count(c.alone.pull_requests) + ' pull requests, parallel ' + count(c.parallel.pull_requests) + ')']);
        }
        add(cmp, tb2);
      }
      sel.addEventListener('change', fill);
      fill();
      add(box, add(el('p', 'admin__lead'), 'The workers run on: ', sel));
      add(box, cmp);
      add(box, btn('Price this work in the calculator', true, function () { fromMeasured(e, days, isPrivate, sel.value); $('cc-out').scrollIntoView(); }));
    }).catch(function (e) {
      clear(box);
      if (e.status === 404) none(box, repo + ' has no branch metrics yet: the metrics workflow writes it daily at 03:43 UTC, or now from the control panel\'s "Run the metrics now".');
      else none(box, e.message);
    });
  }
  function initCost() {
    wireGate(function () { whoAmI().then(function () { showApp(); startCost(); }).catch(function (e) { say(e.message, true); }); });
    $('cp-signout').addEventListener('click', signOut);
    ['cc-runs', 'cc-days', 'cc-minutes', 'cc-input', 'cc-write', 'cc-read', 'cc-output', 'cc-model', 'cc-visibility', 'cc-plan', 'cc-copilot'].forEach(function (id) {
      $(id).addEventListener('change', calculate);
      $(id).addEventListener('input', calculate);
    });
    $('cc-prices-as-of').textContent = PRICES_AS_OF;
    calculate();
    function startCost() {
      fillRepoSelect($('cost-repo'), chosenRepo());
      $('cost-repo').addEventListener('change', measured);
      measured();
    }
    finishOauth().then(function () {
      if (!loadToken()) { showGate(); return; }
      whoAmI().then(function () { showApp(); startCost(); }).catch(function (e) { say(e.message, true); showGate(); });
    });
  }

  // the cost page carries a signed-in box of its own, so its marker is read first
  if ($('cost-app')) initCost();
  else if ($('cp-app')) initPanel();
})();
