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
   sign-in service (symphony-app/signin): it turns GitHub's one-time code
   into a token, renews it, revokes it when asked, and keeps nothing.
   "Sign in with GitHub" is the way in, one press for a person who has
   allowed the App once; a fine-grained token pasted into the page is the
   fallback, folded under it. Until SIGNIN_SERVICE and CLIENT_ID name the
   service, the button stands where it belongs, unpressable, with a line
   saying why, and the token box is open beneath it. The sign-in uses
   PKCE: the page keeps a secret for each sign-in and sends GitHub its
   hash, so only this page can turn the code GitHub returns into a token.

   What it never does: it never stores anything but the GitHub token (and
   the refresh token that came with it) and the names of the repositories
   you listed, and never sends anything anywhere but GitHub and, for the
   sign-in, that service. The one Claude token it touches is one pasted
   into the Tokens tab's "Add or renew a slot", which it seals in this
   browser for GitHub's public key and sends to GitHub as that sealed box
   alone, never stored, logged or shown (the owner, 2026-10-18).

   Every state on the page is written in words and every action is a
   button or a link with a name, so a person and a browsing agent read
   and drive it alike. /symphony/control/?repo=OWNER/NAME lands on one
   repository.
   ============================================================ */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  // The stateless sign-in service and SymphonyBoard's client id, neither a secret. With both set,
  // "Sign in with GitHub" can be pressed; emptying either one turns the button off again.
  var SIGNIN_SERVICE = 'https://symphony-signin.openspineconsortium.workers.dev';
  var CLIENT_ID = 'Iv23liTkIRov2FYN83wD';
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
  // a signal that ends a request nobody answers once the time given is up: AbortSignal.timeout where
  // the browser has it, else a controller and a timer, so an older browser waits no longer
  function within(ms) {
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
      if (typeof AbortController !== 'undefined') {
        var c = new AbortController();
        setTimeout(function () { c.abort(); }, ms);
        return c.signal;
      }
    } catch (e) { /* no way to end it: the request waits as long as the browser lets it */ }
    return undefined;
  }

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
  // This tab's sign-in lives in one storage: the tab's own sessionStorage when that holds one (signed
  // in for this tab only), else localStorage (kept on this browser). The token and the sign-in record
  // are read from that one storage and a renewal is written back to it, so a sign-in kept by another
  // tab never moves a tab-only one into localStorage, where it would outlive the tab.
  function signinStore() {
    try {
      if (sessionStorage.getItem(KEY_TOKEN) || sessionStorage.getItem(KEY_OAUTH)) return sessionStorage;
      if (localStorage.getItem(KEY_TOKEN) || localStorage.getItem(KEY_OAUTH)) return localStorage;
    } catch (e) { /* storage refused: nothing is kept */ }
    return null;
  }
  function readSignin(key) {
    var store = signinStore();
    try { return store ? store.getItem(key) || '' : ''; } catch (e) { return ''; }
  }
  function keepSignedIn() {
    try { return signinStore() === localStorage; } catch (e) { return false; }
  }
  function recordIn(store) {
    try { return JSON.parse(store.getItem(KEY_OAUTH) || 'null'); } catch (e) { return null; }
  }

  var token = '';
  // whether this tab's token is the one storage holds: when storage holds none any more, another tab
  // has forgotten it, and this tab is signed out too
  var tokenStored = false;
  // a sign-in for this tab alone keeps its refresh token here, in the open page, and never in storage,
  // which a browser brings back with a closed or restored tab; it belongs to one token, and a reload
  // loses it, so that sign-in ends with its eight-hour token
  var heldRefresh = { access: '', refresh: '' };
  // this tab's sign-in ended (it was forgotten here, ran out, or GitHub refused it): nothing stored
  // is taken up in its place, a sign-in another tab keeps on this browser included, until the
  // person signs in, pastes a token or reloads, so no call goes out for an account the page is no
  // longer showing
  var ended = false;
  // the account the page names and the token GitHub named it for. A token taken up since then
  // (this tab's own renewal, or a token another tab kept) goes out only once GitHub has said whose
  // it is, and a write goes out only for the account the page named when it was asked for.
  var shownLogin = '';
  var shownToken = '';
  // the one question "whose is this token?" on its way, which every call that needs the answer shares
  var naming = null;
  // the tokens this tab took itself: the one it opened with or the one the person gave it here, and
  // its renewals. While GitHub has named no account for the page, these go out unnamed, and any
  // other token, taken up from another tab, goes out once GitHub has said whose it is.
  var own = [];
  // this tab's own sign-ins and pastes, counted, and its sign-outs: each sign-out says why, so a
  // call begun before one says nothing more when it fails
  var choices = 0;
  var ends = 0;
  function oauthRecord() {
    try { return JSON.parse(readSignin(KEY_OAUTH) || 'null'); } catch (e) { return null; }
  }
  function storedToken() {
    var o = oauthRecord();
    return readSignin(KEY_TOKEN) || (o && o.access_token) || '';
  }
  function loadToken() {
    token = storedToken();
    tokenStored = !!token;
    own = token ? [token] : [];
    return token;
  }
  function refreshOf(o) {
    return o.refresh_token || (heldRefresh.access && heldRefresh.access === o.access_token ? heldRefresh.refresh : '');
  }
  // this tab's sign-in is over; what is still being read with its token is dropped when it comes,
  // not shown or said
  function endHere() {
    token = '';
    tokenStored = false;
    heldRefresh = { access: '', refresh: '' };
    own = [];
    ended = true;
    ends++;
    state = emptyState(state.repo);
  }
  function forgetToken() {
    endHere();
    dropKey(KEY_TOKEN);
    dropKey(KEY_OAUTH);
  }
  // a sign-in that ran out leaves only the storage it was read from, so a tab's own dead sign-in
  // never takes with it the one another tab keeps on this browser
  function dropSignin(store) {
    endHere();
    try { if (store) { store.removeItem(KEY_TOKEN); store.removeItem(KEY_OAUTH); } } catch (e) { /* nothing to drop */ }
  }
  // the sign-in was forgotten, or dropped, while this tab waited on its renewal: nothing more is
  // renewed for it, and the page is signed out
  function signedOutMeanwhile() {
    token = '';
    tokenStored = false;
    heldRefresh = { access: '', refresh: '' };
    return '';
  }
  // the tokens of "Sign in with GitHub" this tab can reach, its own and the one kept on this browser
  function signinTokens() {
    var found = [];
    [function () { return sessionStorage; }, function () { return localStorage; }].forEach(function (storage) {
      try {
        var o = recordIn(storage());
        if (o && o.access_token && found.indexOf(o.access_token) < 0) found.push(o.access_token);
      } catch (e) { /* nothing readable there */ }
    });
    return found;
  }
  // A new sign-in or pasted token of this tab, which the page uses from now on. Kept on the browser, it
  // replaces what the browser kept and this tab's own; for this tab alone, it stands in front of what
  // the browser keeps for its other tabs and leaves that be. A sign-in token it replaces is nobody's
  // any more, so GitHub is asked to revoke it.
  function storeSignin(key, value, keep, chosen) {
    var replaced = [];
    try {
      (keep ? [localStorage, sessionStorage] : [sessionStorage]).forEach(function (store) {
        var o = recordIn(store);
        if (o && o.access_token) replaced.push(o.access_token);
        store.removeItem(KEY_TOKEN);
        store.removeItem(KEY_OAUTH);
      });
      (keep ? localStorage : sessionStorage).setItem(key, value);
      tokenStored = true;
    } catch (e) { tokenStored = false; /* storage refused: the token lives for this page only */ }
    ended = false;
    token = chosen;
    own = [chosen];
    choices++;
    // the person chose this one in this tab, so GitHub's first answer about it names it afresh, and a
    // question still out about the token before it is not the one to wait on
    shownLogin = '';
    shownToken = '';
    naming = null;
    if (signinAvailable()) replaced.forEach(function (t) { exchange('/revoke', { access_token: t }).catch(function () { /* it runs out in eight hours */ }); });
  }
  // the token came from "Sign in with GitHub", so it can do what SymphonyBoard's permissions allow
  // and no more, whatever the person may do; a pasted token can do what it was made for
  function signedInByApp() { return !readSignin(KEY_TOKEN) && !!oauthRecord(); }

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
  // the token box, folded under the sign-in, opens where the sign-in cannot be used or did not work
  function offerToken() {
    var way = $('cp-token-way');
    if (way) way.open = true;
  }
  // GitHub's return lands on the bare page, which is the App's callback URL, so the page's own query
  // from before the sign-in (?repo=OWNER/NAME) travels with the sign-in's secret and is put back
  var SIGNIN_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri'];
  function withoutSigninParams(search) {
    var q = new URLSearchParams(search);
    SIGNIN_PARAMS.forEach(function (k) { q.delete(k); });
    return q.toString();
  }
  function restoreQuery(back) {
    if (typeof back !== 'string' || back.length > 2048 || location.search) return;
    var rest = withoutSigninParams(back);
    if (!rest) return;
    try { history.replaceState(null, '', location.pathname + '?' + rest + location.hash); } catch (e) { /* the address stays */ }
  }
  // PKCE: a secret for this one sign-in stays in this tab, GitHub gets its hash, and only the holder
  // of the secret can turn the code GitHub sends back into a token. The "keep me signed in" tick
  // travels with it, since the page that comes back from GitHub is a fresh load.
  function startOauth() {
    if (!window.crypto || !crypto.subtle || !crypto.getRandomValues) { say('This browser cannot make the sign-in\'s secret (no Web Crypto); use a token instead.', true); offerToken(); return; }
    var state = randomHex(16);
    var verifier = randomHex(32);
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      var challenge = base64url(new Uint8Array(hash));
      var keep = $('cp-keep') ? $('cp-keep').checked : false;
      try {
        sessionStorage.setItem(KEY_STATE, JSON.stringify({ state: state, verifier: verifier, keep: keep, back: location.search }));
      } catch (e) { say('This browser refuses session storage, which the sign-in needs to come back; use a token instead.', true); offerToken(); return; }
      location.href = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent(pageAddress()) + '&state=' + encodeURIComponent(state)
        + '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
    }).catch(function (e) { say('The sign-in could not start: ' + e.message, true); offerToken(); });
  }
  // GitHub's own word for a refresh token it will not renew any more (run out, revoked or spent);
  // every other failure, of the service or of GitHub, is of the moment and leaves the sign-in be
  var DEAD_REFRESH = 'bad_refresh_token';
  function exchange(route, body) {
    // a service that never answers must not hold the renewal, and the other tabs waiting on it, for good
    var ask = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: within(20000) };
    function unreachable() { throw new Error('The sign-in service could not be reached.'); }
    return fetch(SIGNIN_SERVICE + route, ask).catch(unreachable).then(function (r) {
      return r.text().catch(unreachable).then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!data || typeof data !== 'object') throw new Error('The sign-in service answered ' + r.status + ' with nothing readable; the address the page holds for it may be wrong.');
        if (!r.ok || data.error) {
          var err = new Error('The sign-in service answered ' + r.status + (data.error ? ': ' + data.error : '') + (data.error_description ? ' (' + data.error_description + ')' : '') + '.');
          err.code = String(data.error || '');
          throw err;
        }
        return data;
      });
    });
  }
  function recordOf(answer) {
    var now = Date.now();
    return {
      access_token: answer.access_token,
      refresh_token: answer.refresh_token || '',
      expires_at: answer.expires_in ? now + Number(answer.expires_in) * 1000 : 0,
      refresh_expires_at: answer.refresh_token_expires_in ? now + Number(answer.refresh_token_expires_in) * 1000 : 0
    };
  }
  // a sign-in for this tab alone keeps its refresh token in the page, the rest in the tab's storage
  function holdRefresh(record, keep) {
    heldRefresh = keep ? { access: '', refresh: '' } : { access: record.access_token, refresh: record.refresh_token };
    if (!keep) record.refresh_token = '';
    return record;
  }
  function keepOauth(answer, keep) {
    var record = holdRefresh(recordOf(answer), keep);
    storeSignin(KEY_OAUTH, JSON.stringify(record), keep, record.access_token);
  }
  // a renewal goes back to the storage the renewed record came from and touches nothing else
  function renewOauth(answer, store) {
    var kept = false;
    try { kept = store === localStorage; } catch (e) { kept = false; }
    var record = holdRefresh(recordOf(answer), kept);
    try { if (store) { store.setItem(KEY_OAUTH, JSON.stringify(record)); tokenStored = true; } } catch (e) { /* the token lives for this page only */ }
    token = record.access_token;
    own.push(token);
  }
  function finishOauth() {
    var q = new URLSearchParams(location.search);
    var code = q.get('code'), state = q.get('state'), error = q.get('error'), description = q.get('error_description') || '';
    if (!code && !error) return Promise.resolve(false);
    var kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(KEY_STATE) || 'null'); sessionStorage.removeItem(KEY_STATE); } catch (e) { kept = null; }
    // the code and GitHub's words leave the address before anything else, so neither stays in the history
    var rest = withoutSigninParams(location.search);
    try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e2) { /* the address stays */ }
    if (kept) restoreQuery(kept.back);
    if (!signinAvailable()) return Promise.resolve(false);
    if (!kept || !state || kept.state !== state || !kept.verifier) {
      // said only for a sign-in this tab started and that came back with another state; a return
      // with nothing pending is Back after a sign-in, or a crafted link, and is cleaned from the
      // address and otherwise ignored, GitHub's words with it
      if (kept && !error) { say('The sign-in did not come back the way it left (its state differs); press Sign in with GitHub to start it again.', true); offerToken(); }
      return Promise.resolve(false);
    }
    if (error) { say('GitHub did not sign you in (' + error.slice(0, 64) + (description ? ': ' + description.slice(0, 200) : '') + '). Press Sign in with GitHub to try again, or use a token.', true); offerToken(); return Promise.resolve(false); }
    return exchange('/exchange', { code: code, code_verifier: kept.verifier, redirect_uri: pageAddress() }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      keepOauth(answer, !!kept.keep);
      return true;
    }).catch(function (e) { say(e.message + ' Press Sign in with GitHub to try again, or use a token.', true); offerToken(); return false; });
  }
  // one renewal at a time: GitHub's refresh tokens are single use, so two renewals at once would
  // spend the same one twice and leave the page signed out
  var refreshing = null;
  function expired(message, store) {
    dropSignin(store);
    showGate();
    say(message, true);
    return new Error(message);
  }
  // the tabs of this browser renew in turn where it can hold a lock for that, so a second tab finds
  // the first one's renewal stored instead of spending the same refresh token again
  function inTurn(work) {
    var ran = false;
    function run() { ran = true; return work(true); }
    try {
      if (navigator.locks && navigator.locks.request) {
        return navigator.locks.request('symphony-panel-renewal', run).catch(function (e) { if (ran) throw e; return work(false); });
      }
    } catch (e) { /* no lock: renew() looks longer for another tab's renewal after a refusal */ }
    return work(false);
  }
  // the token stored since this tab began renewing the one it holds: a token pasted meanwhile, or
  // the record of another tab's renewal or sign-in; empty when nothing changed
  function storedSince(old) {
    var now = storedToken();
    if (!now || now === old) return '';
    token = now;
    tokenStored = true;
    return token;
  }
  // looks in storage every half second, until the time given, for what another tab stored
  function lookAgain(old, until) {
    var found = storedSince(old);
    if (found || !storedToken() || Date.now() >= until) return Promise.resolve(found);
    return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(function () { return lookAgain(old, until); });
  }
  function ensureToken() {
    if (ended) return Promise.resolve(signedOutMeanwhile());
    var pasted = readSignin(KEY_TOKEN);
    var o = pasted ? null : oauthRecord();
    // another tab may have renewed the sign-in, pasted a token or forgotten it since this one read
    // it: what is stored is the truth, and a token renewed elsewhere is the only one GitHub still takes
    if (pasted) { token = pasted; tokenStored = true; }
    else if (o && o.access_token) { token = o.access_token; tokenStored = true; }
    else if (tokenStored) { token = ''; tokenStored = false; }
    if (!o || !o.expires_at || Date.now() < o.expires_at - 60000 || !signinAvailable()) return Promise.resolve(token);
    if (refreshing) return refreshing;
    var store = signinStore();
    var tabOnly = false;
    try { tabOnly = store === sessionStorage; } catch (e) { tabOnly = false; }
    var refresh = refreshOf(o);
    // a sign-in for this tab alone whose refresh token went with an earlier page ends with its token
    if (!refresh) return Date.now() < o.expires_at ? Promise.resolve(token) : Promise.reject(expired('Your sign-in for this tab ran out after its eight hours; press Sign in with GitHub again.', store));
    if (o.refresh_expires_at && Date.now() >= o.refresh_expires_at) return Promise.reject(expired('Your sign-in expired (its six months are over); press Sign in with GitHub again.', store));
    var old = o.access_token;
    refreshing = inTurn(function (locked) {
      // the tab that held the turn before this one may have renewed the sign-in already, or the
      // sign-in may have been forgotten meanwhile, here or in another tab
      var renewed = storedSince(old);
      if (renewed) return renewed;
      if (!storedToken()) return signedOutMeanwhile();
      // a sign-in for this tab alone holds its refresh token in this page only, so no other tab can
      // have renewed it, whether or not the tabs take turns
      return renew(refresh, old, store, locked || tabOnly);
    }).then(function (t) { refreshing = null; return t; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  function renew(refresh, old, store, alone) {
    return exchange('/refresh', { refresh_token: refresh }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      // written back only over the record it renews, in the storage it came from: a sign-in
      // forgotten or replaced meanwhile stays so, and the renewed token, then nobody's, is revoked
      // at once; a token pasted for this tab alone meanwhile replaces nothing kept for the others
      var now = recordIn(store);
      if (!now || now.access_token !== old) {
        exchange('/revoke', { access_token: answer.access_token }).catch(function () { /* it runs out in eight hours */ });
        token = storedToken();
        tokenStored = !!token;
        return token;
      }
      renewOauth(answer, store);
      // such a paste stays in front of the renewed sign-in for this tab
      token = storedToken() || token;
      return token;
    }).catch(function (e) {
      var taken = storedSince(old);
      if (taken) return taken;
      if (!storedToken()) return signedOutMeanwhile();
      if (e.code !== DEAD_REFRESH) {
        var failure = new Error('The token could not be renewed: ' + e.message + ' Try again in a moment.');
        say(failure.message, true);
        throw failure;
      }
      // GitHub will not renew it. Where the tabs take turns, or the sign-in is this tab's alone, no
      // other tab spent it first; otherwise another may have, and its new record comes with the
      // service's answer, within twenty seconds, so the page looks for it that long before it signs out
      return lookAgain(old, Date.now() + (alone ? 0 : 22000)).then(function (later) {
        if (later) return later;
        if (!storedToken()) return signedOutMeanwhile();
        throw expired('Your sign-in expired or was revoked; press Sign in with GitHub again.', store);
      });
    });
  }

  /* ---------- the GitHub client ---------- */
  function explain(status, data, path, byApp) {
    var m = data && data.message ? String(data.message) : '';
    if (status === 401) return byApp
      ? 'GitHub refused the sign-in\'s token (401): it was revoked or has run out. Press Sign in with GitHub again.'
      : 'GitHub refused the token (401). Paste one that is still valid' + (signinAvailable() ? ', or press Sign in with GitHub.' : '.');
    if (status === 429 || (status === 403 && /rate limit|secondary/i.test(m))) return 'GitHub\'s rate limit for this token is reached (' + status + '). Wait a minute, then press Refresh.';
    if (status === 403) return byApp
      ? 'The sign-in may not do this (403' + (m ? ': ' + m : '') + '): it acts within SymphonyBoard\'s permissions and your own access, on the repositories the App is installed on.'
      : 'The token may not do this (403' + (m ? ': ' + m : '') + '). A fine-grained token needs the permission the sign-in box names for it.';
    if (status === 404) return 'GitHub has nothing at ' + path + ' (404): the repository, the branch or the file is not there, or ' + (byApp ? 'the sign-in does not reach it (SymphonyBoard is not installed there).' : 'the token does not reach it.');
    if (status === 422) return 'GitHub refused the request (422' + (m ? ': ' + m : '') + ').';
    return 'GitHub answered ' + status + (m ? ': ' + m : '') + '.';
  }
  // GitHub refused the token itself (401). When another tab has stored a newer one meanwhile, the
  // answer is true and the call is made again with it. Otherwise nothing more works with this token,
  // and the sign-in box comes back with the reason: a sign-in's token is dead (revoked, or run out)
  // and is dropped; a pasted token is the person's to replace, so it stays stored, this tab stops
  // using it, and the token box opens beneath.
  function refusedToken(sent, byApp) {
    // a tab already signed out has said why
    if (ended) return false;
    var store = signinStore();
    var stored = storedToken();
    if (stored && stored !== sent) return true;
    if (byApp) dropSignin(store);
    else { endHere(); offerToken(); }
    showGate();
    say(explain(401, null, '', byApp), true);
    return false;
  }
  // GitHub stops taking a sign-in's token once its refresh token is spent, so a call that went out
  // with it while this tab or another renewed the sign-in comes back refused. Such a refusal is
  // judged once the renewal under way has ended and stored its token: this tab's own, then any
  // other tab's, which holds the browser's lock while it renews, or with no lock is looked for as
  // a refused renewal looks for it. A sign-in for this tab alone has no other tab to wait for, and
  // another tab renews one kept on the browser only in its token's last minute, storing the new
  // record within twenty seconds, so further from its end than two minutes there is none to wait for.
  function refused(sent, byApp) {
    if (!byApp) return Promise.resolve(refusedToken(sent, byApp));
    var tabOnly = false;
    try { tabOnly = signinStore() === sessionStorage; } catch (e) { tabOnly = false; }
    function judged() { /* by what is stored, below */ }
    return (refreshing || Promise.resolve()).then(judged, judged).then(function () {
      var o = oauthRecord();
      var due = !!(o && o.expires_at && Date.now() >= o.expires_at - 120000);
      return inTurn(function (locked) { return locked || tabOnly || ended || !due ? '' : lookAgain(sent, Date.now() + 22000); });
    }).then(function () { return refusedToken(sent, byApp); });
  }
  // a token no request can carry: an earlier version of this page stored a paste unchecked
  function unusable() {
    var e = new Error('The token kept here holds a character no GitHub token has (a space, or one outside plain ASCII that a copy brought along), so no request can carry it; paste the token again, copied afresh from GitHub.');
    e.unusable = true;
    return e;
  }
  // The token a call may go out with. Every call is made signed in, and none once the token was
  // forgotten, here or in another tab, or this tab's sign-in ended. A call goes out with a token
  // GitHub has named for the page, and asks whose it is first where it has not; only while GitHub
  // has named nobody for the page do the tab's own tokens go out unnamed. A write goes out only for
  // the account the page named when it was asked for, or, asked for while the page named nobody,
  // only with a token of the tab's own.
  function ready(method, path, account) {
    return ensureToken().then(function () {
      // a sign-in that ended while this call waited on its renewal takes nothing stored in its place
      if (ended) signedOutMeanwhile();
      if (!token) { showGate(); throw new Error('This page is signed out now: the token was forgotten, or GitHub refused it, here or in another tab. Sign in again to go on.'); }
      if (!/^[\x21-\x7e]+$/.test(token)) throw unusable();
      var write = method !== 'GET' && !!account;
      var mine = own.indexOf(token) >= 0;
      if (path !== '/user' && token !== shownToken && (shownToken || write || !mine)) return named().then(function () { return ready(method, path, account); });
      if (method !== 'GET' && account !== shownLogin && (write || !mine)) throw new Error('The sign-in changed while this was on its way, so nothing was done: the page acts as ' + shownLogin + ' now' + (account ? ', not ' + account : '') + '. Press again to do it as ' + shownLogin + '.');
      return token;
    });
  }
  function failure(status, data, path, byApp) {
    var err = new Error(explain(status, data, path, byApp));
    err.status = status;
    err.data = data;
    return err;
  }
  // a call for the account the page names now, unless a chain of calls of one action names the
  // account the action was asked for
  function gh(method, path, body, headers, raw, account) {
    return call(method, path, body, headers, raw, account === undefined ? shownLogin : account, false);
  }
  function call(method, path, body, headers, raw, account, again) {
    var sent = '', byApp = false, era = ends;
    return ready(method, path, account).then(function () {
      sent = token;
      byApp = signedInByApp();
      var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      h['Authorization'] = 'Bearer ' + token;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      var k;
      for (k in (headers || {})) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      var ask = { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) };
      // the calls that wait to know whose the token is all wait on this one question, so GitHub not
      // answering it must not hold them for good
      if (path === '/user') ask.signal = within(20000);
      return fetch(API + path, ask);
    }).then(function (r) {
      // a 304, the answer to a read made conditional on an ETag (the assistant's), has no body either
      if (r.status === 204 || r.status === 205 || r.status === 304) return { status: r.status, data: null, headers: r.headers, sent: sent };
      return r.text().then(function (t) {
        if (raw && r.ok) return { status: r.status, data: t, headers: r.headers, sent: sent };
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        // GitHub turned the request away unread, so it is made once more with a token stored
        // meanwhile, where there is one; a write, only for the account it was asked for
        if (r.status === 401) return refused(sent, byApp).then(function (retry) {
          if (retry && !again) return call(method, path, body, headers, raw, account, true);
          throw failure(r.status, data, path, byApp);
        });
        if (!r.ok) throw failure(r.status, data, path, byApp);
        return { status: r.status, data: data, headers: r.headers, sent: sent };
      });
    }).catch(function (e) {
      // the tab signed out since this call began and has said why, so this failure goes unsaid
      if (ends !== era) return new Promise(function () { /* left unanswered */ });
      if (path === '/user' && e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('GitHub did not say within 20 seconds whose the token is; try again in a moment.');
      throw e;
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
  // "Sign in with GitHub" comes first; until the service is deployed it cannot be pressed, a line
  // says why, and the token box beneath it stands open
  function wireGate(onSignedIn) {
    var gate = $('cp-gate');
    if (!gate) return;
    var signin = $('cp-signin');
    if (signin && signinAvailable()) signin.addEventListener('click', startOauth);
    else if (signin) {
      signin.disabled = true;
      if ($('cp-signin-off')) $('cp-signin-off').classList.remove('hidden');
      offerToken();
    }
    $('cp-open').addEventListener('click', function () {
      var t = ($('cp-token').value || '').trim();
      if (!t) { say('Paste a token first.', true); return; }
      // a GitHub token is plain ASCII with no space in it; a character the copy brought along (a
      // space inside it, a zero-width or curly character) would make every request fail unsent
      if (!/^[\x21-\x7e]+$/.test(t)) { say('The pasted text holds a character no GitHub token has (a space, or one outside plain ASCII that the copy brought along); copy the token again from GitHub.', true); return; }
      var keep = $('cp-keep').checked;
      var open = $('cp-open');
      open.disabled = true;
      say('Asking GitHub about the token...');
      checkToken(t).then(function (ok) {
        open.disabled = false;
        if (!ok) return;
        heldRefresh = { access: '', refresh: '' };
        // a panel the kept sign-in opened while GitHub was asked about the paste closes, with what it
        // read and the name it showed, until GitHub names the token pasted
        showGate();
        state = emptyState(state.repo);
        storeSignin(KEY_TOKEN, t, keep, t);
        $('cp-token').value = '';
        say('');
        onSignedIn();
      });
    });
    $('cp-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('cp-open').click(); });
  }
  // GitHub is asked about a pasted token before it takes the place of anything, so a token GitHub
  // refuses, or a moment GitHub cannot be reached, leaves this tab's sign-in and the one the browser
  // keeps for its other tabs as they were
  function checkToken(t) {
    // a GitHub that never answers must not hold the box's button for good
    var ask = { headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Authorization': 'Bearer ' + t }, signal: within(20000) };
    return fetch(API + '/user', ask).then(function (r) {
      if (r.ok) return true;
      say(r.status === 401
        ? explain(401, null, '', false)
        : 'GitHub answered ' + r.status + ' when asked about the token, so nothing was changed; try again in a moment.', true);
      return false;
    }, function () {
      say('GitHub could not be reached to check the token, so nothing was changed; try again in a moment.', true);
      return false;
    });
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
  // Asks GitHub whose the token is and names that account on the page. The calls that need the
  // answer at one moment share one question; an answer about a token the page no longer holds names
  // nobody, and the question is asked again about the one it holds.
  function whoAmI() {
    if (naming && naming.token === token) return naming.promise;
    var mine = { token: token, promise: null };
    function done() { if (naming === mine) naming = null; }
    mine.promise = gh('GET', '/user').then(function (r) {
      done();
      var login = r.data && r.data.login ? r.data.login : '';
      // the token may have been forgotten while GitHub answered: then nobody is signed in to name
      if (!token) return '';
      if (r.sent !== token) return token === shownToken ? shownLogin : whoAmI();
      shownLogin = login;
      shownToken = token;
      if ($('cp-who')) $('cp-who').textContent = login ? 'Signed in as ' + login + (signedInByApp() ? ' through GitHub' : ' with a token') + (keepSignedIn() ? ', kept on this browser.' : ', for this tab.') : '';
      return login;
    }, function (e) { done(); throw e; });
    naming = mine;
    return mine.promise;
  }
  // asks whose the token is, and says so when it is another account than the one the page named:
  // only another tab can have put it there, unless this tab signed in or took a paste since the
  // question was asked, which names it afresh
  function named() {
    var before = shownLogin, era = choices;
    return whoAmI().then(function (login) {
      if (login && before && login !== before && era === choices) say('Now signed in as ' + login + ', not ' + before + ': another tab of this browser kept that account\'s token in place of the one this page had.', true);
      return login;
    });
  }
  // A page opens signed in once GitHub has said who the token is. A token GitHub refused, one no
  // request can carry, or none left, keeps the sign-in box; any other failure is of the moment (no
  // network yet, GitHub or the service down), so the page opens with the token it holds, where
  // Refresh tries again and Forget the token stays within reach. Only the latest opening counts, so
  // a token pasted while the stored one was still being asked about opens the page once, as itself.
  var entering = 0;
  function enter(begin) {
    var mine = ++entering;
    return whoAmI().then(function () {
      if (mine !== entering) return;
      // another tab may have forgotten the token while GitHub was answering
      if (!token) { showGate(); return; }
      showApp();
      begin();
    }, function (e) {
      if (mine !== entering) return;
      say(e.message, true);
      // a token no request can carry is of no use to any tab, so the browser keeps it no longer
      if (e.unusable) dropSignin(signinStore());
      if (e.status === 401 || e.unusable || !token) { showGate(); if (e.unusable) offerToken(); }
      else { showApp(); begin(); }
    });
  }
  // Where this tab's token was the one the browser kept, another tab that forgets it, or finds it
  // refused, signs this one out at once, and another tab that keeps a token in its place makes this
  // one ask GitHub whose the new token is, so the page never acts for an account it does not name.
  // The look waits a moment, so that a token another tab is putting in place of the old one is not
  // taken for none. A page the browser brings back from its back-forward cache missed every storage
  // event meanwhile, so it looks at once.
  function watchOtherTabs() {
    window.addEventListener('storage', function (e) {
      if (e.key !== null && e.key !== KEY_TOKEN && e.key !== KEY_OAUTH) return;
      setTimeout(lookAtStorage, 300);
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) lookAtStorage(); });
  }
  function lookAtStorage() {
    if (!token || !tokenStored) return;
    var now = storedToken();
    // a call of this tab may have taken up a token another tab stored before the page named it
    if (now === token && now === shownToken) return;
    if (now) { followToken(now); return; }
    endHere();
    showGate();
    say('Signed out: the token this browser kept was forgotten in another tab, or GitHub refused it there. Sign in again to go on.');
  }
  // another tab's renewal names the same account again; a token another tab kept in its place may
  // be another account's, and the page says so. Where GitHub cannot be asked, the page names nobody
  // until it can, and asks again before its next call. A page that named nobody and holds the token
  // it had has nothing to say when GitHub still cannot be asked.
  function followToken(now) {
    var known = !!shownToken;
    var changed = now !== token;
    token = now;
    named().catch(function (e) {
      if (e.status === 401 || !token) return;
      if ($('cp-who')) $('cp-who').textContent = '';
      if (!known && !changed) return;
      say('Another tab of this browser kept a new token in place of the one this page had, and GitHub could not be asked whose it is (' + e.message + ').' + (known ? ' The page asks again before its next call.' : ''), true);
    });
  }
  // the tokens pasted here, this tab's own and the one the browser kept; where storage is refused, a
  // pasted token lives in this page alone
  function pastedTokens() {
    var found = [];
    [function () { return sessionStorage; }, function () { return localStorage; }].forEach(function (storage) {
      try {
        var t = storage().getItem(KEY_TOKEN);
        if (t && found.indexOf(t) < 0) found.push(t);
      } catch (e) { /* nothing readable there */ }
    });
    if (!found.length && token && !tokenStored && /^(ghp_|github_pat_)/.test(token)) found.push(token);
    return found;
  }
  // "Forget the token" forgets this tab's token and the one kept on this browser, and asks GitHub,
  // through the service, to revoke each token of "Sign in with GitHub" among them; a pasted token is
  // the person's own, which only GitHub's settings revoke, and a token another tab holds for itself
  // alone is out of this tab's reach
  function signOut() {
    var pasted = pastedTokens();
    var dead = signinTokens();
    var listed = repos().length ? ' The repositories you listed stay.' : '';
    forgetToken();
    showGate();
    var era = choices;
    var where = 'The token is forgotten in this tab and on this browser';
    var others = ' Another tab signed in for that tab alone keeps its sign-in until you forget it there or close it.';
    // a classic token is deleted on another page of GitHub's settings than a fine-grained one
    var pages = [];
    if (pasted.some(function (t) { return /^ghp_/.test(t); })) pages.push('github.com/settings/tokens');
    if (pasted.some(function (t) { return !/^ghp_/.test(t); })) pages.push('github.com/settings/personal-access-tokens');
    var pat = !pasted.length ? '' : pasted.length === 1
      ? ' The personal access token itself stays valid at GitHub until it runs out or you delete it at ' + pages[0] + '.'
      : ' The personal access tokens themselves stay valid at GitHub until they run out or you delete them at ' + pages.join(' and ') + '.';
    if (dead.length && signinAvailable()) {
      say(where + '; asking GitHub to revoke the sign-in\'s token...');
      // a sign-in or paste made before GitHub answers has the page's words by then
      Promise.all(dead.map(function (t) { return exchange('/revoke', { access_token: t }); })).then(function () {
        if (era === choices) say(where + ', and the sign-in\'s token is revoked at GitHub.' + others + pat + listed);
      }).catch(function (e) {
        if (era === choices) say(where + ', but GitHub could not be asked to revoke the sign-in\'s token (' + e.message + '). It runs out within eight hours; Revoke beside SymphonyBoard at github.com/settings/apps/authorizations ends it now.' + others + pat + listed, true);
      });
      return;
    }
    say(where + '.' + others + pat + listed);
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
      // the assistant issues are the page's own, one a person (the Assistant section), not tasks;
      // a task someone labelled assistant by hand stays a task, grouped by its other labels
      if (l.indexOf(ASSISTANT_LABEL) >= 0 && /^Assistant: /.test(String(it.title || ''))) return;
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
    // the number and the labels, readable from the row, for the assistant's focus and filter
    tr.setAttribute('data-number', String(it.number));
    tr.setAttribute('data-labels', l.join('\n'));
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
    // both writes are for the account the page named when Give was pressed
    var account = shownLogin;
    say('Giving #' + issue.number + ' to ' + name + '...');
    gh('GET', '/repos/' + s.repo + '/labels/' + encodeURIComponent(label)).catch(function (e) {
      if (e.status !== 404) throw e;
      return gh('POST', '/repos/' + s.repo + '/labels', { name: label, color: LABEL_COLOR, description: 'Held or given to the worker ' + name }, undefined, false, account);
    }).then(function () {
      return gh('POST', '/repos/' + s.repo + '/issues/' + issue.number + '/labels', { labels: [label] }, undefined, false, account);
    }).then(function () {
      if (stale(s)) return;
      say('#' + issue.number + ' is given to ' + name + '; a worker in Actions wakes on the label.');
      return loadIssues(s);
    }).catch(function (e) { say(e.message, true); });
  }
  function askButton(it) {
    return btn('Ask Claude on it', true, function () {
      $('cp-prompt-target').value = String(it.number);
      revealTab($('cp-prompt'));
      $('cp-prompt').focus({ preventScroll: true });
      scrollInDeck($('cp-prompt'));
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
      assistantRedraw();
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
        note.textContent = (signedInByApp() ? 'The sign-in' : 'The token') + ' cannot list Actions runs (' + e.status + '); showing the check runs on the default branch instead. ' + (signedInByApp() ? 'The sign-in lists them once SymphonyBoard holds Actions: read; a fine-grained token with it lists them now.' : 'A fine-grained token with Actions: read lists the runs.');
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
      say(e.message + (e.status === 403 ? ' Merging needs Contents: read and write' + (signedInByApp() ? ', for you on this repository as for the App' : ' on the token') + ', and Workflows: read and write when the pull request changes a file under .github/workflows.' : (e.status === 405 ? ' GitHub does not allow this merge yet: a required check or review is missing.' : '')), true);
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
    assistantRepo(s);
    if (consoleTab === 'tokens' && consoleOnOpen.tokens) consoleOnOpen.tokens();
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
    }).catch(function (e) {
      if (e.status !== 404 || !signedInByApp()) { say(e.message, true); return; }
      // the sign-in reaches only the repositories SymphonyBoard is installed on, so a private one
      // without the App reads as missing; the way on is the App's install page, with the name carried
      say('');
      add(box, el('p', '', 'The sign-in sees nothing at ' + name + '. It reaches only the repositories SymphonyBoard is installed on, so a private repository without the App reads as missing. On GitHub:'));
      var ol = el('ol');
      add(ol, add(el('li'), link(installLink({ full_name: name }), 'Install SymphonyBoard on ' + name), ' (pick the account, then the repository; GitHub sends you on to Symphony Setup\'s install page, then to the form).'));
      add(ol, add(el('li'), 'If Symphony is not set up on it yet, press Create on ', link(FORM_URL, 'the form'), '. Then come back here and press Add again.'));
      add(box, ol);
    });
  }
  function discover() {
    say('Looking for repositories with the topic symphony among those ' + (signedInByApp() ? 'the sign-in' : 'this token') + ' reaches...');
    ghList('/user/repos?per_page=100&sort=pushed', 3).then(function (list) {
      var found = list.filter(function (r) { return r.topics && r.topics.indexOf(TOPIC) >= 0; }).map(function (r) { return r.full_name; });
      if (!found.length) { say('None found' + (list.more ? ' among the 300 most recently pushed' : '') + '. ' + (signedInByApp() ? 'The sign-in lists only the repositories SymphonyBoard is installed on' : 'A fine-grained token lists only the repositories it was made for') + '; add one by name below.'); return; }
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
    }).catch(function (e) { say(e.message + (e.status === 403 ? ' Starting a workflow needs Actions: read and write' + (signedInByApp() ? ', which the sign-in has once SymphonyBoard holds it; a fine-grained token with it starts one now.' : ' on the token.') : ''), true); });
  }

  /* ---------- the console: its height, its tabs, its readouts ---------- */
  // The control panel is one screen under the site's header and strip: a bar, a rail of tabs and one
  // tab at a time, each scrolling inside itself. The tab is kept in the address (#board, #tokens),
  // so a link or a reload opens it again, and nothing about it is stored. Anything the page points
  // at, a row the assistant centres or the box "Ask Claude on it" fills, opens its tab first.
  var consoleTab = '';
  var consoleOnOpen = {};
  var CONSOLE_TASK_TABLES = ['cp-queue', 'cp-given', 'cp-claimed', 'cp-review', 'cp-blocked', 'cp-epics'];
  function consoleTabs() { return Array.prototype.slice.call(document.querySelectorAll('.console__rail [data-tab]')); }
  function showTab(name) {
    var tabs = consoleTabs();
    if (!tabs.length) return;
    if (!tabs.some(function (t) { return t.getAttribute('data-tab') === name; })) name = tabs[0].getAttribute('data-tab');
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab-panel]'), function (p) { p.hidden = p.getAttribute('data-tab-panel') !== name; });
    var changed = consoleTab !== name;
    consoleTab = name;
    if (location.hash !== '#' + name) {
      try { history.replaceState(null, '', location.pathname + location.search + '#' + name); } catch (e) { /* the address stays */ }
    }
    if (changed && consoleOnOpen[name]) consoleOnOpen[name]();
  }
  function revealTab(node) {
    var panel = node && node.closest ? node.closest('[data-tab-panel]') : null;
    if (panel && panel.hidden) showTab(panel.getAttribute('data-tab-panel'));
  }
  // scrollIntoView moves every box around the node, the window too, which would carry the bar and
  // the strip out of sight; while the deck holds the window, the window is put back where it was
  function scrollInDeck(node, how) {
    var x = window.pageXOffset || 0, y = window.pageYOffset || 0;
    node.scrollIntoView(how);
    var c = $('console');
    if (c && getComputedStyle(c).overflow === 'hidden') window.scrollTo(x, y);
  }
  // the deck takes the height the window has left below the header and the strip
  function fitConsole() {
    var c = $('console');
    if (!c) return;
    var top = c.getBoundingClientRect().top + (window.pageYOffset || 0);
    c.style.setProperty('--console-h', Math.max(Math.floor(window.innerHeight - top), 0) + 'px');
    var rail = c.querySelector('.console__rail');
    if (rail) rail.setAttribute('aria-orientation', getComputedStyle(rail).flexDirection === 'row' ? 'horizontal' : 'vertical');
  }
  // the rows of a list, a line that says the list is empty or still reading counting for none
  function consoleRows(id) {
    var t = $(id);
    if (!t) return 0;
    return Array.prototype.filter.call(t.querySelectorAll('tbody tr'), function (tr) { return !tr.querySelector('.admin__none'); }).length;
  }
  function countConsole() {
    Array.prototype.forEach.call(document.querySelectorAll('#console [data-count]'), function (span) {
      var key = span.getAttribute('data-count');
      var n = key === 'tasks' ? CONSOLE_TASK_TABLES.reduce(function (sum, id) { return sum + consoleRows(id); }, 0) : consoleRows(key);
      var text = state && state.ready ? String(n) : '';
      if (span.classList.contains('readout__n')) text = text || '\u2013';
      if (span.textContent !== text) span.textContent = text;
      var readout = span.closest ? span.closest('.readout') : null;
      if (readout) readout.classList.toggle('readout--on', n > 0);
    });
  }
  // a list's heading at the top of the tab that holds it
  function jumpTo(id) {
    var table = $(id);
    if (!table) return;
    revealTab(table);
    var wrap = table.closest('.table-scroll') || table;
    var head = wrap.previousElementSibling && /^H[1-6]$/.test(wrap.previousElementSibling.tagName) ? wrap.previousElementSibling : wrap;
    var box = wrap.closest('.console__scroll');
    if (box) box.scrollTop = head.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  }
  function initConsole() {
    var c = $('console');
    if (!c) return;
    fitConsole();
    window.addEventListener('resize', fitConsole);
    window.addEventListener('load', fitConsole);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitConsole);
    showTab(location.hash.slice(1));
    window.addEventListener('hashchange', function () {
      var name = location.hash.slice(1);
      if (consoleTabs().some(function (t) { return t.getAttribute('data-tab') === name; })) showTab(name);
    });
    consoleTabs().forEach(function (t, i, all) {
      t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
        var next = e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : step ? all[(i + step + all.length) % all.length] : null;
        if (!next) return;
        e.preventDefault();
        showTab(next.getAttribute('data-tab'));
        next.focus();
      });
    });
    // the readouts, the launch buttons that open a tab, and the chips that press a button elsewhere
    c.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-goto],[data-jump],[data-press]') : null;
      if (!b || b.getAttribute('role') === 'tab') return;
      if (b.hasAttribute('data-press')) {
        var target = $(b.getAttribute('data-press'));
        if (target && !target.disabled) target.click();
        return;
      }
      if (b.hasAttribute('data-goto')) showTab(b.getAttribute('data-goto'));
      if (b.hasAttribute('data-jump')) jumpTo(b.getAttribute('data-jump'));
      var f = b.getAttribute('data-focus');
      if (f && $(f)) $(f).focus();
    });
    var pending = 0;
    function later() { if (!pending) pending = setTimeout(function () { pending = 0; countConsole(); }, 60); }
    if (window.MutationObserver && $('cp-app')) new MutationObserver(later).observe($('cp-app'), { childList: true, subtree: true });
    var summaryNode = $('cp-summary');
    if (window.MutationObserver && summaryNode) new MutationObserver(later).observe(summaryNode, { characterData: true, childList: true, subtree: true });
  }

  function initPanel() {
    wireGate(function () { enter(start); });
    watchOtherTabs();
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
      if (next) loadRepo(next); else { state = emptyState(''); fillRepoSelect($('cp-repo'), ''); $('cp-summary').textContent = 'No repository listed. Add one on the Repositories tab.'; }
    });
    $('cp-task-queue').addEventListener('click', queueTask);
    $('cp-w-add').addEventListener('click', addWorker);
    $('cp-prompt-ask').addEventListener('click', function () { askClaude(false); });
    $('cp-prompt-task').addEventListener('click', function () { askClaude(true); });
    $('cp-run-workers').addEventListener('click', function () { dispatch('workers.yml', 'the workers'); });
    $('cp-run-board').addEventListener('click', function () { dispatch('board.yml', 'the board'); });
    $('cp-run-ci').addEventListener('click', function () { dispatch('ci.yml', 'the checks'); });
    $('cp-run-metrics').addEventListener('click', function () { dispatch('metrics.yml', 'the metrics'); });
    initAssistant();

    function start() {
      // a sign-in, perhaps as someone else, reads the Tokens tab again rather than show the last one's
      tokensFor = null;
      var name = chosenRepo();
      fillRepoSelect($('cp-repo'), name);
      if (name) loadRepo(name); else $('cp-summary').textContent = 'No repository listed yet. Find them, or add one by name, on the Repositories tab.';
    }
    finishOauth().then(function () {
      if (!loadToken()) { showGate(); return; }
      enter(start);
    });
  }

  /* ---------- the assistant: a question on an issue labelled assistant, answered by the Claude workflow ---------- */
  // The page asks the repository's own Claude through GitHub and nothing else. Once per repository
  // and person it opens an issue "Assistant: <login>" labelled assistant; each question is a comment
  // on it that mentions @claude and ends with the page's state in a fenced block, and the
  // repository's claude.yml answers on the repository's Claude token, reading only, in a comment the
  // page watches for (symphony-template, docs/setup/claude-action.md, "The assistant issue"; the
  // vocabulary is .github/symphony/assistant.md there). The action posts a progress comment first,
  // edits it as it works, and when the run ends writes a header in front of whatever the comment
  // holds, so the page compares bodies, never counts comments, and reads a body as the answer only
  // once that header opens it. The page executes only the few lines of the fenced block the answer
  // may end with, each of them a read of what the page already shows: nothing here writes to the
  // repository but the label, the issue and the comments, each on a press.
  var ASSISTANT_LABEL = 'assistant';
  // the file the repository's workflow appends to the assistant's system prompt: a repository
  // without it on its default branch has no assistant, and a question there would run as an
  // ordinary mention, with fifty turns and the tools that write
  var ASSISTANT_FILE = '.github/symphony/assistant.md';
  // the logins the action answers as: claude[bot] where the Claude GitHub App is installed,
  // github-actions[bot] where the workflow gives it its own token; a comment by any author of type
  // Bot after the question counts too, so a repository set up another way is not left waiting
  var ASSISTANT_BOTS = ['claude[bot]', 'github-actions[bot]'];
  // the header the action writes in front of its comment when the run ends, whatever Claude left
  // in it (claude-code-action, src/github/operations/comment-logic.ts). Before it the comment is
  // the run's progress: first "Claude Code is working..." and then the checklist Claude keeps in
  // its place, which says no such phrase, so the phrase's absence is no sign of the answer; and an
  // answer may well say "working" itself. A run the runner stops at the workflow's timeout writes
  // no header, and the watch ends by its own limit.
  var ASSISTANT_FINAL = /^\s*\*\*Claude (finished|encountered an error)\b/;
  var ASSISTANT_FAILED = /^\s*\*\*Claude encountered an error\b/;
  // GitHub takes a comment body of at most this many characters
  var ASSISTANT_COMMENT_MAX = 65536;
  // how often the issue is read: every 5 seconds for ten minutes, then every 30 seconds, for 45
  // minutes at most (the workflow's own timeout), and for a minute and a half after the answer, for
  // a late edit; each read is conditional on the last ETag, so one GitHub answers 304 to costs
  // nothing against the rate limit. Each line is one constant, so a check can shorten it.
  var ASSISTANT_POLL_MS = 5000;
  var ASSISTANT_SLOW_MS = 30000;
  var ASSISTANT_SLOW_AFTER_MS = 600000;
  var ASSISTANT_GIVE_UP_MS = 2700000;
  var ASSISTANT_AFTER_MS = 90000;
  var ASSISTANT_FAILURES = 3;
  var ASSISTANT_SECTIONS = { queue: 'Queue', blockers: 'Blockers', overlaps: 'Overlaps', given: 'Given to workers', dependencies: 'Dependencies' };
  var ASSISTANT_TABLES = { 'cp-queue': 'Queue', 'cp-given': 'Given to workers', 'cp-claimed': 'Claimed', 'cp-review': 'In review', 'cp-blocked': 'Blocked, and blockers', 'cp-epics': 'Epics' };
  var ASSISTANT_UNLABELLED = 'is open but carries no label assistant';
  var KEY_ASSISTANT = 'symphony_panel_assistant';

  // one assistant per repository and person: the issue, the question on its way, the ETag of the
  // last read, the answer, and the focus, filter and section the page sends with the next question
  function assistantEmpty() {
    return { s: null, repo: '', login: '', issue: null, posting: false, question: null, etag: '', timer: 0, progress: '', answer: null, failed: false, finalAt: 0, failures: 0, focus: 0, filter: 'none', section: '', last: '', watching: false };
  }
  var assistant = assistantEmpty();
  // the assistant issues the page uses, one number a repository, one it opened or found, kept as
  // the other preferences are
  function assistantIssues() {
    try {
      var o = JSON.parse(readKey(KEY_ASSISTANT) || '{}');
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (e) { return {}; }
  }
  function rememberAssistantIssue(repo, number) {
    var o = assistantIssues();
    if (number) o[repo] = number; else delete o[repo];
    writeKey(KEY_ASSISTANT, JSON.stringify(o), true);
  }
  function assistantTitle() { return 'Assistant: ' + assistant.login; }
  function assistantIssueOf(it) {
    return !!it && !it.pull_request && it.state === 'open' && it.title === assistantTitle() && labelsOf(it).indexOf(ASSISTANT_LABEL) >= 0;
  }
  // why an issue the page kept is no longer the assistant's, in words, or nothing while it still is
  function assistantIssueGone(it) {
    if (assistantIssueOf(it)) return '';
    if (!it || it.state !== 'open') return 'is closed';
    if (it.pull_request || it.title !== assistantTitle()) return 'is open but no longer titled "' + assistantTitle() + '"';
    return ASSISTANT_UNLABELLED;
  }
  // an open issue titled for this person that has lost its label is kept and said, never replaced:
  // another opened in its place would lose the label the same way where the token may not label
  function assistantUnlabelledWords(n) {
    return '#' + n + ' ' + ASSISTANT_UNLABELLED + ', so the Claude workflow would not answer on it as the assistant: add the label on GitHub (the token may not label issues), or close it, then ask.';
  }
  function assistantLink() {
    var it = assistant.issue;
    return it ? link(it.html_url || ('https://github.com/' + assistant.repo + '/issues/' + it.number), '#' + it.number) : null;
  }
  // the state line, in words, with the issue as a link where there is one
  function assistantWords(parts, warn) {
    var p = $('cp-as-state');
    if (!p) return;
    clear(p);
    parts.forEach(function (x) { if (x) add(p, x); });
    p.className = warn ? 'admin__lead admin__warn' : 'admin__lead';
  }
  function assistantButtons(box, stop, again) {
    $('cp-as-box').classList[box ? 'remove' : 'add']('hidden');
    $('cp-as-stop').classList[stop ? 'remove' : 'add']('hidden');
    $('cp-as-again').classList[again ? 'remove' : 'add']('hidden');
    // one question at a time: while an answer is awaited, the next waits for Stop watching
    $('cp-as-ask').disabled = !!stop;
  }
  // a span in words: seconds unless it is whole minutes, so that 90 seconds never reads "2 minutes"
  function assistantSeconds(ms) { return ms < 60000 || ms % 60000 ? plural(Math.round(ms / 1000), 'second') : plural(ms / 60000, 'minute'); }

  // Called as the page starts reading a repository, before anything of it is known, so a poll under
  // way is rebound at once. The assistant keeps its watch, its focus and its filter across a
  // Refresh of the same repository for the same person, and starts over for another: it asks GitHub
  // whether the person may write, since the workflow answers nobody else, then whether the
  // repository's workflow has the assistant, then looks for the issue.
  function assistantRepo(s) {
    var a = assistant;
    if (a.repo === s.repo && a.login && a.login === shownLogin) {
      a.s = s;
      // a press or a read that was on its way when the tab signed out never settles (the client
      // leaves such a call unanswered), so the press is over and a watch left with no timer, which
      // only a settled read schedules, is read on; a read that does settle later schedules nothing
      // twice, since a new timer takes the place of the one before it
      a.posting = false;
      if (!a.watching) $('cp-as-ask').disabled = false;
      if (a.watching && !a.timer) assistantSchedule();
      return;
    }
    assistantStop('');
    a = assistant = assistantEmpty();
    a.s = s;
    a.repo = s.repo;
    a.login = shownLogin;
    clear($('cp-as-answer'));
    $('cp-as-actions').textContent = '';
    assistantRedraw();
    assistantButtons(false, false, false);
    if (!s.repo) { assistantWords(['No repository is chosen.']); return; }
    if (!shownLogin) { assistantWords(['The page has not learned from GitHub who is signed in, so it cannot tell whether you may ask; press Refresh once GitHub answers.'], true); return; }
    assistantWords(['Reading whether you may ask in ' + s.repo + '...']);
    gh('GET', '/repos/' + s.repo + '/collaborators/' + encodeURIComponent(shownLogin) + '/permission').then(function (r) {
      if (a !== assistant || stale(s)) return;
      var perm = r.data && r.data.permission ? String(r.data.permission) : 'none';
      // GitHub's permission field says write for the maintain role too, and read for triage
      if (perm !== 'admin' && perm !== 'write') { assistantWords(['The assistant answers only people with write access to ' + s.repo + ', and GitHub says yours is ' + perm + '.']); return; }
      return assistantHasFile(s).then(function (has) {
        if (a !== assistant || stale(s)) return;
        if (!has) { assistantWords(['This repository\'s Claude workflow has no assistant yet: ' + ASSISTANT_FILE + ' is not on its default branch, so a question here would run as an ordinary @claude mention, with the tools that write. Bring in the template release that carries it first.']); return; }
        return assistantFind(s).then(function (words) {
          if (a !== assistant || stale(s)) return;
          assistantWords(words);
          assistantButtons(true, false, false);
        }, function (e) {
          if (a !== assistant || stale(s)) return;
          assistantWords(['The page could not look for the assistant issue in ' + s.repo + ' (' + e.message + '); the first question looks again.'], true);
          assistantButtons(true, false, false);
        });
      }, function (e) {
        if (a !== assistant || stale(s)) return;
        assistantWords(['GitHub would not say whether ' + s.repo + ' has the assistant (' + e.message + '); press Refresh to ask again.'], true);
      });
    }, function (e) {
      if (a !== assistant || stale(s)) return;
      assistantWords(['GitHub would not say whether you may write to ' + s.repo + ' (' + e.message + '), and the assistant answers only people with write access.'], true);
    });
  }
  // whether the assistant's file is on the default branch, which the contents API reads with no ref
  function assistantHasFile(s) {
    return gh('GET', '/repos/' + s.repo + '/contents/' + ASSISTANT_FILE).then(function () { return true; }, function (e) {
      if (e.status === 404) return false;
      throw e;
    });
  }
  // the issue the page remembered for this repository, where it is still open and still the
  // assistant's, else the newest open issue labelled assistant titled for this person, else none;
  // a remembered issue that is closed, gone or retitled is forgotten, so the first question opens
  // another, and one that has lost its label is kept and said (assistantUnlabelledWords)
  function assistantFind(s) {
    var kept = assistantIssues()[s.repo];
    var remembered = /^[0-9]{1,9}$/.test(String(kept || '')) ? gh('GET', '/repos/' + s.repo + '/issues/' + kept).then(function (r) {
      return { it: r.data, why: assistantIssueGone(r.data) };
    }, function (e) {
      if (e.status === 404 || e.status === 410) return { it: null, why: 'is gone' };
      throw e;
    }) : Promise.resolve({ it: null, why: '' });
    return remembered.then(function (got) {
      if ((got.it && !got.why) || got.why === ASSISTANT_UNLABELLED) return got;
      return gh('GET', '/repos/' + s.repo + '/issues?state=open&labels=' + ASSISTANT_LABEL + '&per_page=100').then(function (r) {
        var list = Array.isArray(r.data) ? r.data.filter(assistantIssueOf) : [];
        list.sort(function (x, y) { return y.number - x.number; });
        return { it: list[0] || null, why: got.why };
      });
    }).then(function (got) {
      if (got.why === ASSISTANT_UNLABELLED) {
        assistant.issue = got.it;
        return [assistantUnlabelledWords(got.it.number)];
      }
      if (got.it) {
        assistant.issue = got.it;
        rememberAssistantIssue(s.repo, got.it.number);
        return ['The assistant issue is ', assistantLink(), ' (' + got.it.title + '); each question is a comment on it, and each answer one run of the Claude workflow.'];
      }
      if (got.why) rememberAssistantIssue(s.repo, 0);
      assistant.issue = null;
      return ['No assistant issue yet in ' + s.repo + (got.why ? ' (the one the page remembered, #' + kept + ', ' + got.why + ')' : '') + ': the first question opens one, "' + assistantTitle() + '", labelled assistant, and asks on it.'];
    });
  }
  // three short lines: what the issue is, how a question and its answer go, and that closing it
  // makes the page open another; no "@claude", which would start a run as the issue opens
  function assistantIssueBody() {
    return 'This issue is the control panel\'s assistant for ' + assistant.login + ' (https://openspineconsortium.com/symphony/control/).\n\n'
      + 'Each question is a comment from the page, with the page\'s state in a fenced block; the repository\'s Claude workflow answers it here, reading only (.github/symphony/assistant.md).\n\n'
      + 'The page reads this issue\'s comments for the answer. Close it and the page opens another.\n';
  }
  // The cached issue is read again before each question, one read a question, since a person
  // retires one by closing it between two questions and GitHub takes comments on a closed issue:
  // one that is closed, gone or retitled is forgotten and another opened, one that has lost its
  // label is said. Then the label, where the repository lacks it (template-init makes only the
  // protocol's six), then the issue, only where none is there; its body names no @claude, since
  // claude.yml runs on an issue opened with that word in its body or title. Every write is for the
  // account the page named when Ask was pressed.
  function assistantEnsureIssue(s, account) {
    var had = assistant.issue;
    var note = '';
    var again = had ? gh('GET', '/repos/' + s.repo + '/issues/' + had.number).then(function (r) {
      var why = assistantIssueGone(r.data);
      if (!why) return r.data;
      if (why === ASSISTANT_UNLABELLED) throw new Error(assistantUnlabelledWords(had.number));
      note = assistantForget(s, had.number, why);
      return null;
    }, function (e) {
      if (e.status === 404 || e.status === 410) { note = assistantForget(s, had.number, 'is gone'); return null; }
      throw e;
    }) : Promise.resolve(null);
    return again.then(function (it) {
      if (it) return it;
      assistantWords([note + 'Opening the assistant issue in ' + s.repo + '...']);
      return gh('GET', '/repos/' + s.repo + '/labels/' + ASSISTANT_LABEL).catch(function (e) {
        if (e.status !== 404) throw e;
        return gh('POST', '/repos/' + s.repo + '/labels', { name: ASSISTANT_LABEL, color: LABEL_COLOR, description: 'The control panel\'s assistant: a question a comment, answered by the Claude workflow' }, undefined, false, account);
      }).then(function () {
        return gh('POST', '/repos/' + s.repo + '/issues', { title: assistantTitle(), body: assistantIssueBody(), labels: [ASSISTANT_LABEL] }, undefined, false, account);
      }).then(function (r) {
        var it = r.data || {};
        assistant.issue = it;
        // GitHub drops a label from a new issue, with no error, when the token may not label
        // issues; the issue is kept for this page, so the next question reads it again and goes
        // once the label is on it, and remembered only then, so no other page opens a second one
        if (labelsOf(it).indexOf(ASSISTANT_LABEL) < 0) throw new Error('GitHub opened #' + it.number + ' but did not set the label assistant on it, so the Claude workflow would not read it as the assistant\'s: the token may not label issues. Add the label on GitHub, then ask again.');
        rememberAssistantIssue(s.repo, it.number);
        return it;
      });
    });
  }
  function assistantForget(s, number, why) {
    assistant.issue = null;
    rememberAssistantIssue(s.repo, 0);
    return '#' + number + ' ' + why + ', so the question opens another. ';
  }
  function assistantStateBlock() {
    var a = assistant;
    return '```symphony-state\nrepository: ' + a.repo + '\nfocus: ' + (a.focus ? '#' + a.focus : 'none') + '\nfilter: ' + a.filter + '\nsection: ' + (a.section || 'none') + '\n```\n';
  }
  function assistantAsk() {
    var s = state, a = assistant;
    var text = ($('cp-as-q').value || '').trim().replace(/^@claude\s*/i, '');
    if (!s.repo || a.s !== s || !a.login) { assistantWords(['The assistant is not ready for this repository yet; press Refresh.'], true); return; }
    // the page writes as whoever GitHub named last, which another tab's token can change under
    // it, while the issue and the permission were read for the person named before
    if (a.login !== shownLogin) { assistantWords(['The sign-in changed to ' + shownLogin + ' since the assistant was read for ' + a.login + '; press Refresh, and the assistant starts over for ' + shownLogin + '.'], true); return; }
    if (!text) { assistantWords(['Write the question first.'], true); return; }
    // one press at a time: the label, the issue and the question are three writes, and a second
    // press while they are on their way would make a second issue or a second question
    if (a.posting) { assistantWords(['The question is on its way; the page says when it is posted.'], true); return; }
    if (a.watching) { assistantWords(['One question at a time: the page is still waiting for the answer to the last one on ', assistantLink(), '. Press Stop watching to drop it first.'], true); return; }
    var body = '@claude ' + text + '\n\n' + assistantStateBlock();
    if (body.length > ASSISTANT_COMMENT_MAX) { assistantWords(['GitHub takes a comment of at most ' + ASSISTANT_COMMENT_MAX + ' characters, and this question with the page\'s state is ' + body.length + ': shorten it by ' + (body.length - ASSISTANT_COMMENT_MAX) + '.'], true); return; }
    a.last = text;
    a.posting = true;
    $('cp-as-ask').disabled = true;
    var account = shownLogin;
    assistantEnsureIssue(s, account).then(function (issue) {
      if (a !== assistant || stale(s)) return;
      assistantWords(['Posting the question on ', assistantLink(), '...']);
      return gh('POST', '/repos/' + s.repo + '/issues/' + issue.number + '/comments', { body: body }, undefined, false, account).then(function (r) {
        if (a !== assistant || stale(s)) return;
        $('cp-as-q').value = '';
        assistantWatch(r.data || {});
      });
    }).then(function () { assistantPosted(a, s); }, function (e) {
      assistantPosted(a, s);
      if (a !== assistant || stale(s)) return;
      assistantWords([e.message], true);
      assistantButtons(true, false, false);
    });
  }
  // the press is over, whatever came of it: Ask is given back unless an answer is now awaited
  function assistantPosted(a, s) {
    a.posting = false;
    if (a === assistant && !stale(s) && !a.watching) $('cp-as-ask').disabled = false;
  }
  function assistantWatch(c) {
    var a = assistant;
    a.question = { id: c.id, at: c.created_at || new Date().toISOString(), asked: Date.now() };
    a.etag = '';
    a.progress = '';
    a.answer = null;
    a.failed = false;
    a.finalAt = 0;
    a.failures = 0;
    a.watching = true;
    clear($('cp-as-answer'));
    $('cp-as-actions').textContent = '';
    assistantButtons(true, true, false);
    assistantWaitingWords();
    assistantSchedule();
  }
  function assistantWaitingWords() {
    var a = assistant;
    assistantWords(['Waiting for the answer on ', assistantLink(), ': asked ' + ago(new Date(a.question.asked).toISOString()) + '. '
      + (a.progress || 'A run of the Claude workflow answers in tens of seconds to a few minutes, first with a progress comment, then with the answer in its place; ')
      + 'the page reads the issue every ' + assistantSeconds(ASSISTANT_POLL_MS) + ' for ' + assistantSeconds(ASSISTANT_SLOW_AFTER_MS) + ', then every ' + assistantSeconds(ASSISTANT_SLOW_MS) + ', and stops after ' + assistantSeconds(ASSISTANT_GIVE_UP_MS) + ' or when you press Stop watching.']);
  }
  // the answer is in, or the run ended in an error, which its header says: the one state a person
  // most needs told apart from an answer
  function assistantAnsweredWords() {
    var a = assistant;
    var more = a.watching ? '; the page watches ' + assistantSeconds(ASSISTANT_AFTER_MS) + ' more for a late edit.' : '. Watching stopped.';
    if (a.failed) assistantWords(['The run failed on ', assistantLink(), ', ' + ago(a.answer.at) + ' (Claude encountered an error): its log is behind View job in the comment below, and Ask again sends the question once more' + more], true);
    else assistantWords(['The assistant answered on ', assistantLink(), ', ' + ago(a.answer.at) + more]);
    assistantButtons(true, a.watching, true);
  }
  // the next read, by a timer and never chained on the last read's promise, which never settles
  // once the tab signed out meanwhile
  function assistantSchedule() {
    var a = assistant;
    if (a.timer) clearTimeout(a.timer);
    var wait = Date.now() - a.question.asked < ASSISTANT_SLOW_AFTER_MS ? ASSISTANT_POLL_MS : ASSISTANT_SLOW_MS;
    a.timer = setTimeout(function () { a.timer = 0; assistantPoll(); }, wait);
  }
  // one read of the issue's comments since the question (GitHub filters them by their last edit,
  // so the action's edits of its one comment come back), conditional on the ETag of the last read
  function assistantPoll() {
    var a = assistant, s = a.s, q = a.question;
    if (!a.watching || !q) return;
    if (stale(s) || !s.repo) { assistantStop('left'); return; }
    var now = Date.now();
    if (a.finalAt && now - a.finalAt >= ASSISTANT_AFTER_MS) { assistantStop('done'); return; }
    if (!a.finalAt && now - q.asked >= ASSISTANT_GIVE_UP_MS) { assistantStop('gave-up'); return; }
    var path = '/repos/' + s.repo + '/issues/' + a.issue.number + '/comments?since=' + encodeURIComponent(q.at) + '&per_page=100';
    gh('GET', path, undefined, a.etag ? { 'If-None-Match': a.etag } : undefined).then(function (r) {
      if (a !== assistant || a.question !== q || !a.watching) return;
      a.failures = 0;
      if (r.status === 304) { if (!a.answer) assistantWaitingWords(); }
      else {
        a.etag = (r.headers && r.headers.get && r.headers.get('ETag')) || '';
        assistantRead(Array.isArray(r.data) ? r.data : []);
      }
      if (a.watching) assistantSchedule();
    }, function (e) {
      if (a !== assistant || a.question !== q || !a.watching) return;
      a.failures++;
      if (a.failures >= ASSISTANT_FAILURES || e.status === 401 || e.status === 403 || e.status === 429) { assistantStop('error', e); return; }
      assistantWords(['GitHub could not be read (' + e.message + '); the page tries again. The question is on ', assistantLink(), '.'], true);
      assistantSchedule();
    });
  }
  // the answer is the newest comment by the action's identity that came after the question (a
  // person's comment, or a bot's from before the question that an edit brought back, is neither),
  // and it is final once the action's header opens it; until then it is the run's progress
  function assistantRead(list) {
    var a = assistant, q = a.question;
    var after = new Date(q.at).getTime();
    var found = null;
    list.forEach(function (c) {
      if (!c || c.id === q.id) return;
      var login = c.user && c.user.login ? String(c.user.login) : '';
      if (ASSISTANT_BOTS.indexOf(login) < 0 && !(c.user && c.user.type === 'Bot')) return;
      var at = new Date(c.created_at).getTime();
      if (isNaN(at) || at < after) return;
      if (!found || at >= new Date(found.created_at).getTime()) found = c;
    });
    if (!found) { if (!a.answer) assistantWaitingWords(); return; }
    var body = String(found.body || '');
    if (!ASSISTANT_FINAL.test(body)) {
      if (!a.answer) { a.progress = 'The run is at work: its progress comment is on the issue, and the answer takes its place; '; assistantWaitingWords(); }
      return;
    }
    if (a.answer && a.answer.id === found.id && a.answer.body === body) return;
    if (!a.answer) a.finalAt = Date.now();
    a.failed = ASSISTANT_FAILED.test(body);
    a.answer = { id: found.id, body: body, at: found.updated_at || found.created_at };
    assistantShow(body);
    // a failed run's comment holds what Claude left, not an answer, so no line of it is acted on
    if (a.failed) clear($('cp-as-actions')); else assistantRun(body);
    assistantAnsweredWords();
  }
  // the answer through the board's renderer, which admits no tag, script, handler or image: the
  // action's spinner image, which the renderer would show as words, is dropped first, and a link
  // that leads off github.com, which anyone commenting on a public issue could put in the run's
  // context, is shown as words beside the page's own Open #N links rather than as a link
  function assistantShow(body) {
    var box = $('cp-as-answer');
    box.innerHTML = markdown(body.replace(/<img\b[^>]*>/gi, ''));
    var links = box.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var host = '';
      try { host = new URL(links[i].href).host; } catch (e) { host = ''; }
      if (host === 'github.com') continue;
      links[i].parentNode.replaceChild(document.createTextNode(links[i].textContent + ' (' + links[i].getAttribute('href') + ')'), links[i]);
    }
  }
  // stops the watch: the answer is in and its grace is over, Stop watching was pressed, the page
  // left the repository or signed out, GitHub refused the reads, or the time ran out with no answer
  function assistantStop(reason, e) {
    var a = assistant;
    if (a.timer) { clearTimeout(a.timer); a.timer = 0; }
    a.watching = false;
    if (!reason) return;
    if (reason === 'done') { assistantAnsweredWords(); return; }
    var where = a.answer ? ['. The question and the answer are on ', assistantLink(), '.'] : ['. The question is on ', assistantLink(), ', where the answer comes when the run ends.'];
    if (reason === 'pressed') assistantWords(['Watching stopped'].concat(where));
    else if (reason === 'left') assistantWords(['Watching stopped: the page left the repository or signed out'].concat(where));
    else if (reason === 'gave-up') assistantWords(['No final answer after ' + assistantSeconds(ASSISTANT_GIVE_UP_MS) + '; watching stopped. The run is on the Actions tab of ' + a.repo].concat(where), true);
    else assistantWords(['GitHub could not be read (' + (e && e.message ? e.message : 'no answer') + '); watching stopped'].concat(where), true);
    assistantButtons(true, false, !!a.last);
  }

  // The lines of the answer's fenced block whose info string is symphony, read from the raw comment,
  // since the renderer drops the fence with its info string. Only the five forms are acted on, each
  // of them a read of what the page already shows; any other line is shown as written.
  function assistantBlock(body) {
    var m = /(^|\n)```symphony[ \t]*\n([\s\S]*?)\n[ \t]*```/.exec(String(body).replace(/\r/g, ''));
    return m ? m[2].split('\n').map(function (l) { return l.trim(); }).filter(Boolean) : [];
  }
  function assistantRun(body) {
    var box = $('cp-as-actions');
    clear(box);
    var lines = assistantBlock(body);
    if (!lines.length) return;
    lines.forEach(function (line, i) {
      var m, said;
      if ((m = /^focus\s+#([0-9]{1,9})$/i.exec(line))) said = assistantFocus(Number(m[1]));
      else if ((m = /^open\s+#([0-9]{1,9})$/i.exec(line))) said = assistantOpen(Number(m[1]));
      else if ((m = /^filter\s+(blocked|todo|mine|none)$/i.exec(line))) said = assistantFilter(m[1].toLowerCase());
      else if ((m = /^show\s+(queue|blockers|overlaps|given|dependencies)$/i.exec(line))) said = assistantShowSection(m[1].toLowerCase());
      else said = 'Not acted on, shown as written: ' + line;
      if (i) add(box, ' ');
      add(box, said);
    });
  }
  // a link the person presses, since a page may not open a tab by itself from a read; GitHub takes
  // an issue's address to the pull request where the number is one
  function assistantOpen(n) {
    var span = el('span');
    add(span, link('https://github.com/' + assistant.repo + '/issues/' + n, 'Open #' + n), ' (on GitHub, in a new tab).');
    return span;
  }
  // the focus is marked whatever the filter does, and said as hidden where the filter hides its
  // row, since the vocabulary fixes no order and "filter blocked" may come before "focus #N"
  function assistantFocus(n) {
    assistant.focus = n;
    var row = assistantRedraw().row;
    if (!row) return '#' + n + ' is the focus, but it is not in the task tables (closed, a pull request, or without the protocol\'s labels).';
    if (row.classList.contains('control__off')) return '#' + n + ' is the focus, but the filter (' + assistantFilterWords() + ') hides its row; Show all tasks, above the tables, shows it.';
    revealTab(row);
    scrollInDeck(row, { block: 'center' });
    var table = row.closest ? row.closest('table') : null;
    return 'Focused #' + n + (table && ASSISTANT_TABLES[table.id] ? ' (under ' + ASSISTANT_TABLES[table.id] + ')' : '') + '.';
  }
  function assistantMatches(labels) {
    var f = assistant.filter;
    if (f === 'blocked') return labels.indexOf('blocked') >= 0 || labels.indexOf('blocker') >= 0;
    if (f === 'todo') return labels.indexOf('todo') >= 0;
    if (f === 'mine') return !!assistant.login && ['worker:', 'account:', 'agent:'].some(function (p) { return labels.indexOf(p + assistant.login) >= 0; });
    return true;
  }
  function assistantFilterWords() {
    var f = assistant.filter;
    return f === 'blocked' ? 'the tasks labelled blocked or blocker' : f === 'todo' ? 'the tasks labelled todo' : f === 'mine' ? 'the tasks held by or given to you (worker:' + assistant.login + ')' : 'every task';
  }
  // marks the focused row and hides the rows the filter leaves out, in every task table, and says
  // so above the tables; called again whenever the tables are rendered afresh
  function assistantRedraw() {
    var rows = document.querySelectorAll('#cp-app table.admin__stack tbody tr[data-number]');
    var out = { row: null, shown: 0, total: rows.length };
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var labels = tr.getAttribute('data-labels') ? tr.getAttribute('data-labels').split('\n') : [];
      if (assistantMatches(labels)) { out.shown++; tr.classList.remove('control__off'); } else tr.classList.add('control__off');
      if (assistant.focus && tr.getAttribute('data-number') === String(assistant.focus)) { out.row = tr; tr.classList.add('control__focus'); } else tr.classList.remove('control__focus');
    }
    var p = $('cp-as-filter');
    if (p) {
      clear(p);
      if (assistant.filter !== 'none') add(p, 'Showing only ' + assistantFilterWords() + ', as the assistant asked: ' + out.shown + ' of ' + out.total + ' tasks. ', btn('Show all tasks', true, function () { assistantFilter('none'); }));
    }
    return out;
  }
  function assistantFilter(kind) {
    assistant.filter = kind;
    var r = assistantRedraw();
    if (kind !== 'none') revealTab($('cp-queue'));
    return kind === 'none' ? 'Showing every task again.' : 'Filtered the task tables to ' + assistantFilterWords() + ': ' + r.shown + ' of ' + r.total + '; Show all tasks, above the tables, clears it.';
  }
  function assistantShowSection(key) {
    var name = ASSISTANT_SECTIONS[key];
    var hs = $('cp-board').querySelectorAll('h2,h3,h4,h5,h6');
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].textContent.trim().toLowerCase().indexOf(name.toLowerCase()) === 0) {
        assistant.section = name;
        revealTab(hs[i]);
        scrollInDeck(hs[i], { block: 'start' });
        return 'Showing the board\'s ' + name + ' section.';
      }
    }
    return 'The board has no ' + name + ' section yet' + (key === 'dependencies' ? ' (the board draws one once dependencies are recorded)' : '') + '.';
  }
  function initAssistant() {
    $('cp-as-ask').addEventListener('click', assistantAsk);
    $('cp-as-stop').addEventListener('click', function () { assistantStop('pressed'); });
    $('cp-as-again').addEventListener('click', function () { if (assistant.last) { $('cp-as-q').value = assistant.last; assistantAsk(); } });
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
  // only the latest choice of repository is shown, so a slow answer about an earlier one is dropped
  var measuring = 0;
  function measured() {
    var asked = ++measuring;
    var repo = $('cost-repo').value;
    var box = $('cost-measured');
    clear(box);
    if (!repo) { none(box, 'Choose a repository in the bar above first.'); return; }
    writeKey(KEY_REPO, repo, true);
    none(box, 'Reading the branch metrics of ' + repo + '...');
    var metaRead = gh('GET', '/repos/' + repo).then(function (r) { return r.data; }).catch(function () { return null; });
    Promise.all([file(repo, 'METRICS.json', 'metrics'), metaRead]).then(function (both) {
      if (asked !== measuring) return;
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
      if (asked !== measuring) return;
      clear(box);
      if (e.status === 404) none(box, repo + ' has no branch metrics yet: the metrics workflow writes it daily at 03:43 UTC, or now from the control panel\'s "Run the metrics now".');
      else none(box, e.message);
    });
  }
  function initCost() {
    wireGate(function () { enter(startCost); });
    watchOtherTabs();
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
      enter(startCost);
    });
  }


  /* ============================================================
     The Tokens page
     ============================================================ */
  // The Claude slots a repository's workers run on, read from its branch pool, which tools/pool.py
  // of the Symphony template writes: one file per slot and kind of reading (a run's, a probe's from
  // the workflow Pool, cswap's from the owner's machine), each with the five-hour and seven-day
  // windows' use and resets and the per-model weekly limits, such as Fable's, which only cswap
  // reads. No reading holds a token, and the page never sees one: GitHub never gives a secret back.
  // The rules below are pool.py's: the newest reading of each window counts, a window past its
  // reset counts as empty, and a slot with a window at 90 percent or more is held until it resets,
  // or for five hours from its reading when no reset is known.
  var POOL_BRANCH = 'pool';
  var POOL_FILE = /^slot-(main|[1-8])\.(run|probe|cswap)\.json$/;
  var POOL_THRESHOLD = 0.9;
  var POOL_UNKNOWN_HOLD_MS = 5 * 3600 * 1000;
  var POOL_WINDOWS = [['five_hour', '5 hours'], ['seven_day', '7 days']];
  var ASSIGNMENTS_PATH = '.github/symphony/accounts.json';
  var CHOICES = ['main', 'auto', '1', '2', '3', '4', '5', '6', '7', '8'];
  var SLOT_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', 'main'];
  var reading = 0;

  function moment(v) {
    if (typeof v === 'number') return v * 1000;
    var t = typeof v === 'string' ? new Date(v).getTime() : NaN;
    return isNaN(t) ? null : t;
  }
  function used(v) { return typeof v === 'number' && v === v ? Math.max(0, Math.min(v, 10)) : null; }
  function slotWindows(records, now) {
    var windows = {}, scoped = [];
    records.slice().sort(function (a, b) { return moment(a.at) - moment(b.at); }).forEach(function (r) {
      var w = r.windows || {};
      POOL_WINDOWS.forEach(function (pair) {
        var each = w[pair[0]];
        if (each && used(each.utilization) != null) windows[pair[0]] = { utilization: each.utilization, resetsAt: each.resetsAt, at: r.at, source: r.source };
      });
      if (Array.isArray(r.scoped) && r.scoped.length) scoped = r.scoped.filter(function (s) { return s && typeof s.name === 'string'; }).map(function (s) {
        return { name: s.name, utilization: s.utilization, resetsAt: s.resetsAt, at: r.at, source: r.source };
      });
    });
    Object.keys(windows).map(function (k) { return windows[k]; }).concat(scoped).forEach(function (each) {
      var resets = moment(each.resetsAt);
      if (resets != null && resets <= now) { each.utilization = 0; each.reset = true; }
    });
    return { windows: windows, scoped: scoped };
  }
  function heldUntil(found, now) {
    var until = null;
    Object.keys(found.windows).map(function (k) { return found.windows[k]; }).concat(found.scoped).forEach(function (each) {
      var u = used(each.utilization);
      if (u == null || u < POOL_THRESHOLD) return;
      var resets = moment(each.resetsAt);
      if (resets == null) resets = (moment(each.at) || now) + POOL_UNKNOWN_HOLD_MS;
      if (resets > now && (until == null || resets > until)) until = resets;
    });
    return until;
  }
  // the slot auto would take now, as pool.py's pick does: the most room in five hours, then seven
  // days, a slot no reading names after every one a reading does, the list's order last
  function autoPick(rows) {
    var free = rows.filter(function (r) { return r.slot !== 'main' && !r.until; });
    if (!free.length) return null;
    free.sort(function (a, b) {
      var ka = [a.empty ? 1 : 0].concat(POOL_WINDOWS.map(function (p) { return a.found.windows[p[0]] ? used(a.found.windows[p[0]].utilization) : 0; }));
      var kb = [b.empty ? 1 : 0].concat(POOL_WINDOWS.map(function (p) { return b.found.windows[p[0]] ? used(b.found.windows[p[0]].utilization) : 0; }));
      for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot);
    });
    return free[0].slot;
  }
  function percent(v) { return v == null ? 'n/a' : Math.round(v * 100) + '%'; }
  function windowText(each) {
    if (!each) return 'not read yet';
    var text = percent(used(each.utilization)) + ' used';
    if (each.reset) return '0% used (reset at ' + stamp(new Date(moment(each.resetsAt)).toISOString()) + ')';
    if (each.resetsAt) text += ', resets ' + stamp(new Date(moment(each.resetsAt)).toISOString());
    return text;
  }
  function sourceWord(s) { return s === 'cswap' ? 'cswap on your machine' : s === 'probe' ? 'a Refresh probe' : 'a worker\'s run'; }

  function readPool(repo) {
    return gh('GET', '/repos/' + repo + '/contents/?ref=' + POOL_BRANCH).then(function (r) {
      var names = (Array.isArray(r.data) ? r.data : []).filter(function (f) { return f.type === 'file' && POOL_FILE.test(f.name); }).map(function (f) { return f.name; });
      return Promise.all(names.map(function (name) {
        return file(repo, name, POOL_BRANCH).then(function (text) {
          var m = POOL_FILE.exec(name), rec = null;
          try { rec = JSON.parse(text); } catch (e) { rec = null; }
          // a reading of another slot or kind than its name says is left out, as pool.py leaves it
          return rec && rec.version === 1 && rec.slot === m[1] && rec.source === m[2] && moment(rec.at) != null ? rec : null;
        }).catch(function () { return null; });
      }));
    }).then(function (records) {
      var by = {};
      records.forEach(function (r) { if (r) (by[r.slot] = by[r.slot] || []).push(r); });
      return by;
    });
  }
  function readAssignments(repo) {
    return file(repo, ASSIGNMENTS_PATH).then(function (text) {
      var data = JSON.parse(text);
      return { exists: true, default: CHOICES.indexOf(data['default']) >= 0 ? data['default'] : 'main', workers: data.workers && typeof data.workers === 'object' ? data.workers : {} };
    }).catch(function (e) {
      if (e && e.status === 404) return { exists: false, default: 'main', workers: {} };
      if (e instanceof SyntaxError) return { exists: true, broken: true, default: 'main', workers: {} };
      throw e;
    });
  }
  function readActionWorkers(repo) {
    return gh('GET', '/repos/' + repo + '/contents/.github/symphony/workers').then(function (r) {
      var files = (Array.isArray(r.data) ? r.data : []).filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name); });
      return Promise.all(files.map(function (f) {
        return file(repo, '.github/symphony/workers/' + f.name).then(function (text) {
          try { return JSON.parse(text); } catch (e) { return null; }
        }).catch(function () { return null; });
      }));
    }).then(function (all) {
      return all.filter(function (w) { return w && w.runs === 'actions' && WORKER_NAME.test(w.name || ''); }).map(function (w) { return w.name; });
    }).catch(function (e) { if (e.status === 404) return []; throw e; });
  }

  function showSlots(repo, by) {
    var body = $('tk-slots').querySelector('tbody');
    clear(body);
    var now = Date.now();
    var rows = SLOT_ORDER.filter(function (slot) { return by[slot]; }).map(function (slot) {
      var found = slotWindows(by[slot], now);
      return { slot: slot, found: found, until: heldUntil(found, now), empty: !Object.keys(found.windows).length,
               at: by[slot].map(function (r) { return r.at; }).sort().pop(), sources: by[slot].map(function (r) { return r.source; }) };
    });
    if (!rows.length) {
      var tr = el('tr');
      add(tr, el('td', 'admin__none', 'No reading yet on ' + repo + '\'s branch pool. Press "Read every slot now", or run python3 scripts/tokens.py usage on your machine for cswap\'s, Fable\'s included.')).firstChild.colSpan = 6;
      body.appendChild(tr);
    }
    rows.forEach(function (r) {
      var tr = el('tr');
      add(tr, el('th', '', r.slot === 'main' ? 'main (CLAUDE_CODE_OAUTH_TOKEN)' : 'slot ' + r.slot + ' (SYMPHONY_CLAUDE_' + r.slot + ')'));
      POOL_WINDOWS.forEach(function (p) { add(tr, el('td', '', windowText(r.found.windows[p[0]]))); });
      add(tr, el('td', '', r.found.scoped.length ? r.found.scoped.map(function (s) { return s.name + ': ' + windowText(s); }).join('; ') : 'none read (only cswap reads them)'));
      add(tr, el('td', r.until ? 'admin__warn' : '', r.until ? 'held until ' + stamp(new Date(r.until).toISOString()) : 'free'));
      var last = add(el('td'), timeEl(r.at), ' from ' + r.sources.filter(function (s, i, a) { return a.indexOf(s) === i; }).map(sourceWord).join(', '));
      add(tr, last);
      body.appendChild(tr);
    });
    var pick = autoPick(rows);
    var held = rows.filter(function (r) { return r.slot !== 'main' && r.until; });
    $('tk-auto').textContent = pick
      ? 'Auto would take slot ' + pick + ' now, the read slot with the most room. A slot with no reading comes after every read one, and a held slot is passed over until it resets.'
      : held.length ? 'Every read slot is held; the first is free at ' + stamp(new Date(Math.min.apply(null, held.map(function (r) { return r.until; }))).toISOString()) + '. A worker on auto waits until then.'
      : 'No slot is read yet, so auto takes the first slot of SYMPHONY_CLAUDE_ACCOUNTS.';
  }

  function choiceSelect(id, value) {
    var s = el('select');
    s.id = id;
    CHOICES.forEach(function (c) {
      var o = el('option', '', c === 'main' ? 'main (CLAUDE_CODE_OAUTH_TOKEN)' : c === 'auto' ? 'auto (the pool)' : 'slot ' + c);
      o.value = c;
      if (c === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }
  function showAssignments(a, workers) {
    var box = $('tk-assign');
    clear(box);
    if (a.broken) none(box, ASSIGNMENTS_PATH + ' is there but does not parse as JSON; saving here replaces it.');
    add(box, add(el('div', 'admin__row'), add(el('div'), add(el('label', '', 'Every worker not named below'), ''), choiceSelect('tk-default', a['default']))));
    box.querySelector('label').htmlFor = 'tk-default';
    var names = workers.slice();
    Object.keys(a.workers).forEach(function (n) { if (names.indexOf(n) < 0 && WORKER_NAME.test(n)) names.push(n); });
    if (!names.length) none(box, 'No worker in Actions is registered yet: the control panel\'s "Add a worker" makes one.');
    names.forEach(function (n, i) {
      var row = el('div', 'admin__row'), cell = el('div'), label = el('label', '', n + (workers.indexOf(n) < 0 ? ' (no longer registered)' : ''));
      var choice = a.workers[n] && CHOICES.indexOf(a.workers[n]) >= 0 ? a.workers[n] : 'default';
      var s = choiceSelect('tk-w-' + i, choice);
      var o = el('option', '', 'the default above');
      o.value = 'default';
      s.insertBefore(o, s.firstChild);
      if (choice === 'default') o.selected = true;
      s.setAttribute('data-worker', n);
      label.htmlFor = s.id;
      add(box, add(row, add(cell, label, s)));
    });
    add(box, add(el('p', 'admin__bar'), btn('Propose these assignments as a pull request', false, saveAssignments)));
  }
  function chosenAssignments() {
    var out = { 'default': $('tk-default').value, workers: {} };
    Array.prototype.forEach.call(document.querySelectorAll('#tk-assign select[data-worker]'), function (s) {
      if (s.value !== 'default') out.workers[s.getAttribute('data-worker')] = s.value;
    });
    return out;
  }
  // main takes only pull requests, so the change is a branch of its own and a pull request, which the
  // repository's check and its owner then take as any other
  function saveAssignments() {
    var repo = tokensRepo();
    if (!repo) return;
    var text = JSON.stringify(chosenAssignments(), null, 2) + '\n';
    var branch = 'symphony/accounts-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    var base = 'main', existing = null;
    say('Opening a pull request that sets ' + ASSIGNMENTS_PATH + '...');
    gh('GET', '/repos/' + repo).then(function (r) {
      base = r.data.default_branch || 'main';
      return gh('GET', '/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(base));
    }).then(function (r) {
      return gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: r.data.object.sha });
    }).then(function () {
      return gh('GET', '/repos/' + repo + '/contents/' + ASSIGNMENTS_PATH + '?ref=' + encodeURIComponent(branch)).then(function (r) { existing = r.data && r.data.sha; }).catch(function (e) { if (e.status !== 404) throw e; });
    }).then(function () {
      var body = { message: 'Which Claude account each worker in Actions runs on', content: btoa(text), branch: branch };
      if (existing) body.sha = existing;
      return gh('PUT', '/repos/' + repo + '/contents/' + ASSIGNMENTS_PATH, body);
    }).then(function () {
      return gh('POST', '/repos/' + repo + '/pulls', { title: 'Which Claude account each worker in Actions runs on', head: branch, base: base,
        body: 'Sets ' + ASSIGNMENTS_PATH + ' from the control panel\'s Tokens tab: main is CLAUDE_CODE_OAUTH_TOKEN, a number is that slot\'s SYMPHONY_CLAUDE_<slot>, and auto takes the slot of SYMPHONY_CLAUDE_ACCOUNTS with the most room at the start of each run (docs/setup/claude-tokens.md).' });
    }).then(function (r) {
      clear($('msg'));
      add($('msg'), 'Opened ', link(r.data.html_url, 'pull request #' + r.data.number), '; the assignments take effect once it merges.');
      $('msg').className = 'admin__box';
    }).catch(function (e) { say(e.message + (e.status === 403 || e.status === 404 ? ' Proposing the change needs Contents and Pull requests: read and write on the repository.' : ''), true); });
  }

  function loadTokens() {
    var asked = ++reading;
    var repo = tokensRepo();
    var slots = $('tk-slots').querySelector('tbody');
    clear(slots);
    clear($('tk-assign'));
    $('tk-auto').textContent = '';
    tokensFor = repo;
    if (!repo) { say('Choose a repository in the bar above first.', true); return; }
    writeKey(KEY_REPO, repo, true);
    var tr = el('tr');
    add(tr, el('td', 'admin__none', 'Reading the branch pool of ' + repo + '...')).firstChild.colSpan = 6;
    slots.appendChild(tr);
    readPool(repo).catch(function (e) { if (e.status === 404) return {}; throw e; }).then(function (by) {
      if (asked === reading) showSlots(repo, by);
    }).catch(function (e) { if (asked === reading) { clear(slots); say(e.message, true); } });
    showAddSlot(repo, asked);
    Promise.all([readAssignments(repo), readActionWorkers(repo)]).then(function (both) {
      if (asked === reading) showAssignments(both[0], both[1]);
    }).catch(function (e) { if (asked === reading) none($('tk-assign'), 'The assignments could not be read: ' + e.message); });
  }
  // one word from each slot of SYMPHONY_CLAUDE_ACCOUNTS through the workflow Pool, which spends that
  // word of each slot's window, so it runs only on this press (the owner's choice, 2026-10-17)
  function probeSlots() {
    var repo = tokensRepo();
    if (!repo) return;
    say('Starting the workflow Pool...');
    gh('GET', '/repos/' + repo).then(function (r) {
      return gh('POST', '/repos/' + repo + '/actions/workflows/pool.yml/dispatches', { ref: r.data.default_branch || 'main' });
    }).then(function () {
      say('Pool is queued: it asks each slot for one word, which spends that word of the slot\'s window, and writes the readings to the branch pool in a minute or two. Press "Read the pool again" then.');
    }).catch(function (e) { say(e.message + (e.status === 404 ? ' The repository has no workflow Pool yet (.github/workflows/pool.yml).' : e.status === 403 ? ' Starting a workflow needs Actions: read and write.' : ''), true); });
  }
  /* ---------- adding a slot: a Claude token sealed in this browser for GitHub ---------- */
  // GitHub takes a secret only as a sealed box for the owner's public key, so the token is sealed
  // here (assets/js/vendor/sealedbox.js, tweetnacl and blake2b) and only the box leaves the page:
  // GitHub, which alone holds the private key, is the one place that can open it, and the page
  // never stores, logs or shows the token. Writing an organization secret needs an owner of the
  // organization and, signed in with GitHub, the SymphonyBoard App's organization permissions
  // Secrets and Variables: read and write. The same steps as scripts/tokens.py add.
  var SLOT_PREFIX = 'SYMPHONY_CLAUDE_';
  var ACCOUNTS_VARIABLE = SLOT_PREFIX + 'ACCOUNTS';
  var MAIN_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';
  var CROWD_VARIABLE = 'CLAUDE_CROWD';
  var SEALEDBOX_JS = '/assets/js/vendor/sealedbox.js';
  // built from pieces, as tools/check_docs.py's shapes are, so this file never looks like a secret
  var SECRET_HEAD = 'sk-' + 'ant-';
  var CLAUDE_TOKEN = new RegExp('^' + SECRET_HEAD + 'oat[0-9]{2}-[A-Za-z0-9_-]{20,}$');
  var API_KEY = new RegExp(SECRET_HEAD + 'api');
  // the wizard's label shape (scripts/tokens.py LABEL_SHAPE): a word, never an e-mail address
  var SLOT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
  var SECRETS_NEEDED = ' Writing a slot needs you to be an owner of the organization and, signed in with GitHub, the SymphonyBoard App\'s organization permissions Secrets and Variables: read and write, accepted on its installation; a fine-grained token needs the same two organization permissions (for a personal account\'s repository, the repository permissions Secrets and Variables).';
  var sealer = null;

  function slotSecret(slot) { return slot === 'main' ? MAIN_SECRET : SLOT_PREFIX + slot; }
  function loadSealer() {
    if (sealer) return sealer;
    sealer = new Promise(function (resolve, reject) {
      if (window.sealedBox) { resolve(window.sealedBox); return; }
      var s = document.createElement('script');
      s.src = SEALEDBOX_JS;
      s.onload = function () { window.sealedBox ? resolve(window.sealedBox) : reject(new Error('The sealing script loaded without its function.')); };
      s.onerror = function () { sealer = null; reject(new Error('The sealing script could not be loaded; try again.')); };
      document.head.appendChild(s);
    });
    return sealer;
  }
  function fromBase64(text) {
    var bin = atob(text), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function slotWords(text) { return String(text || '').split(/[,\s]+/).filter(function (w) { return /^[1-8]$/.test(w); }); }

  // where a repository's slots live: its organization's secrets, or for a personal account's
  // repository, the repository's own
  function slotPlace(repo) {
    return gh('GET', '/repos/' + repo).then(function (r) {
      var org = r.data.owner && r.data.owner.type === 'Organization';
      var owner = r.data.owner.login;
      return { org: org, owner: owner, ownerId: r.data.owner.id, id: r.data.id, base: org ? '/orgs/' + owner + '/actions' : '/repos/' + repo + '/actions' };
    });
  }
  // GitHub lists secrets, variables and a secret's repositories as an object holding the array
  function listed(path, key) {
    var out = [];
    function step(page) {
      return gh('GET', path + (path.indexOf('?') < 0 ? '?' : '&') + 'per_page=100&page=' + page).then(function (r) {
        var got = (r.data && Array.isArray(r.data[key])) ? r.data[key] : [];
        out = out.concat(got);
        if (got.length < 100) return out;
        if (page >= 50) throw new Error('GitHub listed more than 5,000 entries at ' + path + ', more than the page reads; nothing was changed.');
        return step(page + 1);
      });
    }
    return step(1);
  }
  function readSecrets(place) {
    return listed(place.base + '/secrets', 'secrets').then(function (list) {
      var by = {};
      list.forEach(function (s) { if (s && s.name) by[s.name] = s; });
      return by;
    });
  }

  function showAddSlot(repo, asked) {
    var box = $('tk-add');
    clear(box);
    none(box, 'Reading which slots ' + repo + ' has...');
    var place = null;
    slotPlace(repo).then(function (p) {
      place = p;
      return readSecrets(p).catch(function (e) { return { unread: e }; });
    }).then(function (secrets) {
      if (asked !== reading) return;
      clear(box);
      drawAddSlot(box, repo, place, secrets);
    }).catch(function (e) { if (asked === reading) { clear(box); none(box, 'The slots could not be read: ' + e.message); } });
  }
  function drawAddSlot(box, repo, place, secrets) {
    var unread = secrets.unread;
    var setList = add(el('ul', 'admin__lead'));
    ['main', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(function (slot) {
      var s = !unread && secrets[slotSecret(slot)];
      if (s) add(setList, add(el('li'), (slot === 'main' ? 'main' : 'slot ' + slot) + ' (' + slotSecret(slot) + '): set, updated ', timeEl(s.updated_at)));
    });
    // claude setup-token on a GitHub Actions runner, its token sealed there for GitHub (addByActions)
    var one = btn('Add a Claude account', false, function (ev) { addByActions(repo, place, ev.currentTarget); });
    one.id = 'tk-one';
    add(box, add(el('p', 'admin__bar'), one));
    add(box, el('p', 'admin__lead', 'A GitHub Actions run makes the token: in about a minute this page shows a claude.ai sign-in button and a box for the code claude.ai gives. The next free slot is saved, and ' + MAIN_SECRET + ' too while it is not set.'));
    var app = add(el('p', 'admin__lead'), 'The Claude GitHub App, which @claude and the workers need: ', link(claudeAppLink(place), 'install it on ' + repo), ' (GitHub says so if it is installed already).');
    add(box, app);
    claudeAppSeen(place).then(function (seen) { if (seen && app.parentNode) app.parentNode.removeChild(app); });
    if (unread) none(box, 'GitHub would not list the secrets (' + unread.message + '), so which slots are set is not known here.');
    else if (!setList.firstChild) none(box, 'No slot is set on ' + (place.org ? 'the organization ' + place.owner : repo) + ' yet.');
    else add(box, setList);

    // choosing the slot, a label or renewing one stays a pasted token, folded away under the button
    var more = el('details', 'control__token');
    add(more, el('summary', '', 'Paste a token instead: choose the slot, add a label, or renew one'));
    add(more, add(el('p', 'admin__lead'), 'Run ', el('code', '', 'claude setup-token'), ' signed in to the account and paste what it prints. The page seals it in this browser and sends GitHub only the sealed box; it never stores or shows it. Or ',
      link('https://codespaces.new/' + repo, 'open a Codespace on ' + repo), ' for the whole setup, the repository\'s settings included.'));
    add(box, more);
    box = more;
    var free = ['1', '2', '3', '4', '5', '6', '7', '8'].filter(function (n) { return unread || !secrets[slotSecret(n)]; });
    var pick = el('select');
    pick.id = 'tk-add-slot';
    ['main', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(function (slot) {
      var o = el('option', '', (slot === 'main' ? 'main (' + MAIN_SECRET + ')' : 'slot ' + slot + ' (' + slotSecret(slot) + ')') + (!unread && secrets[slotSecret(slot)] ? ', renew' : ''));
      o.value = slot;
      if (slot === (free[0] || '1')) o.selected = true;
      pick.appendChild(o);
    });
    var label = el('input');
    label.id = 'tk-add-label';
    label.type = 'text';
    label.maxLength = 40;
    label.autocomplete = 'off';
    label.placeholder = 'runners';
    var token = el('input');
    token.id = 'tk-add-token';
    token.type = 'password';
    token.autocomplete = 'off';
    token.spellcheck = false;
    token.placeholder = SECRET_HEAD + 'oat01-...';
    function field(input, text) {
      var l = el('label', '', text);
      l.htmlFor = input.id;
      return add(el('div'), l, input);
    }
    add(box, add(el('div', 'admin__row'), field(pick, 'Slot'), field(label, 'Label (a word, optional)')));
    add(box, add(el('div', 'admin__row'), field(token, 'The token claude setup-token printed')));
    var reach = el('div', 'admin__checks');
    reach.id = 'tk-add-reach';
    if (place.org) {
      add(reach, el('p', 'admin__lead', 'Repositories that see the secret (the ones it already reaches keep it):'));
      var mine = repos().filter(function (r) { return r.split('/')[0].toLowerCase() === place.owner.toLowerCase(); });
      if (mine.indexOf(repo) < 0) mine.unshift(repo);
      mine.forEach(function (name) {
        var c = el('input');
        c.type = 'checkbox';
        c.value = name;
        // the repository chosen and the bench, which reads the slots, are ticked; the rest are offered
        c.checked = name === repo || /\/coordbench$/i.test(name);
        add(reach, add(el('label'), c, ' ' + name));
      });
    } else add(reach, el('p', 'admin__lead', repo + ' belongs to a personal account, so the slot is a secret of that repository alone.'));
    add(box, reach);
    add(box, add(el('p', 'admin__bar'), btn('Seal and save the slot', false, function (ev) { saveSlot(repo, place, ev.currentTarget); })));
  }

  function reachIds(place, repo) {
    if (!place.org) return Promise.resolve([]);
    var names = Array.prototype.filter.call(document.querySelectorAll('#tk-add-reach input[type=checkbox]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
    if (!names.length) return Promise.reject(new Error('Tick at least one repository to see the secret.'));
    return Promise.all(names.map(function (name) {
      return gh('GET', '/repos/' + name).then(function (r) { return { name: name, id: r.data.id }; });
    }));
  }
  // a repository in crowd mode holds no Claude token (docs/setup/crowdsourcing.md), as the wizard refuses
  function refuseCrowd(names, place) {
    var orgWide = place.org ? gh('GET', place.base + '/variables/' + CROWD_VARIABLE).then(function (r) {
      if (String((r.data && r.data.value) || '').trim().toLowerCase() === 'true') throw new Error('The organization ' + place.owner + ' is in crowd mode (its variable ' + CROWD_VARIABLE + ' is true): its repositories hold no Claude token, so nothing was saved.');
    }, function (e) { if (e.status !== 404) throw e; }) : Promise.resolve();
    return orgWide.then(function () { return Promise.all(names.map(function (name) {
      return gh('GET', '/repos/' + name + '/actions/variables/' + CROWD_VARIABLE).then(function (r) {
        if (String((r.data && r.data.value) || '').trim().toLowerCase() === 'true') throw new Error(name + ' is in crowd mode (its variable ' + CROWD_VARIABLE + ' is true): it holds no Claude token, so nothing was saved.');
      }, function (e) { if (e.status !== 404 && e.status !== 403) throw e; });
    })); });
  }
  // the repositories a selected organization secret or variable reaches already, so a save adds to them
  // one that cannot be read stops the save, since a PUT with part of the list would take the rest away
  function reachOf(path) {
    return listed(path + '/repositories', 'repositories').then(function (list) {
      return list.map(function (r) { return r.id; });
    });
  }
  function readOne(path) {
    return gh('GET', path).then(function (r) { return r.data; }, function (e) { if (e.status === 404) return null; throw e; });
  }
  function union(a, b) {
    var out = a.slice();
    b.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  // a variable is written only when its value changed, and an organization's keeps every repository it reached
  function writeVariable(place, name, value, ids) {
    var path = place.base + '/variables/' + name;
    return readOne(path).then(function (have) {
      if (!have) {
        var body = { name: name, value: value };
        if (place.org) { body.visibility = 'selected'; body.selected_repository_ids = ids; }
        return gh('POST', place.base + '/variables', body);
      }
      var change = have.value === value ? Promise.resolve() : gh('PATCH', path, { name: name, value: value });
      if (!place.org || have.visibility !== 'selected') return change;
      return change.then(function () { return reachOf(path); }).then(function (now) {
        return Promise.all(ids.filter(function (id) { return now.indexOf(id) < 0; }).map(function (id) { return gh('PUT', path + '/repositories/' + id); }));
      });
    });
  }

  // a repository's own secret or variable of the same name outranks the organization's, as
  // scripts/tokens.py warns, so the save says when the chosen repository holds one
  function shadowed(place, repo, name, slot) {
    if (!place.org) return Promise.resolve('');
    function own(kind, n) { return readOne('/repos/' + repo + '/actions/' + kind + '/' + n).catch(function () { return null; }); }
    return Promise.all([own('secrets', name), slot === 'main' ? null : own('variables', ACCOUNTS_VARIABLE)]).then(function (have) {
      var out = '';
      if (have[0]) out += ' But ' + repo + ' holds its own secret ' + name + ', which its workflows take in place of the organization\'s: delete it under the repository\'s Settings, Secrets and variables, Actions, or the new token goes unused there.';
      if (have[1]) out += ' ' + repo + ' also holds its own ' + ACCOUNTS_VARIABLE + ' (' + have[1].value + '), which outranks the organization\'s list.';
      return out;
    });
  }
  /* ---------- one press: a GitHub Actions run mints the next slot's token ---------- */
  // The page opens an issue on the repository and starts the workflow Token there
  // (.github/workflows/token.yml, tools/token_run.py) with the issue's number and the public key
  // GitHub's secrets API gives for where the slots live. The run posts claude setup-token's sign-in
  // link on the issue, this page shows it as a button and posts back, as the person, the code
  // claude.ai shows after the sign-in, and the run posts the token only as a sealed box for that key,
  // which the page stores as the next free slot: the token is never on the page, in the issue or in
  // the log. A runner starts in seconds, where the Codespace this replaced took minutes.
  var TOKEN_WORKFLOW = 'token.yml';
  var TOKEN_MARK = {
    link: '<!-- symphony-token: sign-in -->',
    code: '<!-- symphony-token: code -->',
    sealed: '<!-- symphony-token: sealed -->',
    failed: '<!-- symphony-token: failed -->'
  };
  var RUN_BOT = 'github-actions[bot]';
  var RUN_POLL_MS = 3000;
  var RUN_FOR_MS = 15 * 60 * 1000;
  // what claude.ai shows after the sign-in, as tools/token_run.py's CODE_SHAPE takes it
  var SIGN_IN_CODE = /^[A-Za-z0-9_.~#-]{8,512}$/;
  var ACTIONS_NEEDED = ' Starting the workflow needs the SymphonyBoard App\'s repository permission Actions: read and write, and opening the issue Issues: read and write.';

  function addByActions(repo, place, button) {
    if (button.disabled) return;
    var issue = 0, slot = '', ids = [], key = null, mainMissing = false, step = 'secrets';
    button.disabled = true;
    say('Starting the workflow Token on ' + repo + '...');
    reachIds(place, repo).then(function (found) {
      ids = found.map(function (f) { return f.id; });
      return refuseCrowd(place.org ? found.map(function (f) { return f.name; }) : [repo], place);
    }).then(function () {
      return readSecrets(place);
    }).then(function (by) {
      slot = ['1', '2', '3', '4', '5', '6', '7', '8'].filter(function (n) { return !by[slotSecret(n)]; })[0] || '';
      if (!slot) throw new Error('All eight slots are set; renew one under "Paste a token instead".');
      mainMissing = !by[MAIN_SECRET];
      return gh('GET', place.base + '/secrets/public-key');
    }).then(function (r) {
      key = r.data;
      step = 'issue';
      return gh('POST', '/repos/' + repo + '/issues', { title: 'Add a Claude account as slot ' + slot,
        body: 'The control panel\'s Tokens page opened this issue for one sign-in through the workflow Token (.github/workflows/token.yml). The run posts the sign-in link here and the token only as a sealed box GitHub alone can open; the page closes the issue when the slot is saved.' });
    }).then(function (r) {
      issue = r.data.number;
      step = 'dispatch';
      return gh('GET', '/repos/' + repo);
    }).then(function (r) {
      return gh('POST', '/repos/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW + '/dispatches',
        { ref: r.data.default_branch || 'main', inputs: { issue: String(issue), key: key.key, key_id: key.key_id } });
    }).then(function () {
      step = 'run';
      say('The run is starting on GitHub Actions; the sign-in button appears here in about a minute.');
      return followRun(repo, issue, key.key_id);
    }).then(function (sealed) {
      step = 'secrets';
      say('Saving ' + slotSecret(slot) + '...');
      return storeSealed(place, repo, slot, sealed, key.key_id, ids, '').then(function () {
        if (mainMissing) return putSecret(place, place.base + '/secrets/' + MAIN_SECRET, sealed, key.key_id, ids).then(function () { return true; });
        return false;
      });
    }).then(function (alsoMain) {
      closeRunIssue(repo, issue);
      button.disabled = false;
      say(slotSecret(slot) + ' is saved and listed in ' + ACCOUNTS_VARIABLE + ' for auto and the bench' + (alsoMain ? ', and as ' + MAIN_SECRET + ', which @claude and the workers read and which was not set yet' : '') + '. Press "Read every slot now" to take its first reading.');
      showAddSlot(repo, reading);
    }).catch(function (e) {
      if (issue) closeRunIssue(repo, issue, true);
      button.disabled = false;
      var hint = '';
      if (step === 'dispatch' && e.status === 404) hint = ' ' + repo + ' has no workflow Token yet (.github/workflows/token.yml): pick symphony-template in the Repository box.';
      else if ((step === 'dispatch' || step === 'issue') && e.status === 403) hint = ACTIONS_NEEDED;
      else if (step === 'secrets' && (e.status === 403 || e.status === 404)) hint = SECRETS_NEEDED;
      say(e.message + hint, true);
    });
  }
  // the issue's comments from the run, read every three seconds: the link shows the sign-in box, the
  // sealed box ends the wait, and a failure says what the run said
  function followRun(repo, issue, keyId) {
    var until = Date.now() + RUN_FOR_MS, shown = false;
    return new Promise(function (resolve, reject) {
      function look() {
        gh('GET', '/repos/' + repo + '/issues/' + issue + '/comments?per_page=100').then(function (r) {
          var said = (r.data || []).filter(function (c) { return c && c.user && c.user.login === RUN_BOT; });
          for (var i = 0; i < said.length; i++) {
            var lines = String(said[i].body || '').trim().split('\n');
            if (lines[0] === TOKEN_MARK.failed) { reject(new Error('The run stopped: ' + lines.slice(1).join(' '))); return; }
            if (lines[0] === TOKEN_MARK.sealed) {
              if (lines[1] !== keyId || !/^[A-Za-z0-9+\/=]{40,}$/.test(lines[2] || '')) { reject(new Error('The run posted a sealed token for another key; nothing was saved. Press Add a Claude account again.')); return; }
              resolve(lines[2]);
              return;
            }
            if (lines[0] === TOKEN_MARK.link && !shown && /^https:\/\/claude\.(ai|com)\//.test(lines[1] || '')) {
              shown = true;
              drawSignIn(repo, issue, lines[1]);
            }
          }
          if (Date.now() > until) { reject(new Error('The run gave no token within 15 minutes; see its log under the repository\'s Actions, workflow Token.')); return; }
          setTimeout(look, RUN_POLL_MS);
        }, reject);
      }
      setTimeout(look, RUN_POLL_MS);
    });
  }
  function drawSignIn(repo, issue, url) {
    var m = $('msg');
    clear(m);
    m.className = 'admin__box';
    var open = btn('Sign in to claude.ai', false, function () { window.open(url, '_blank', 'noopener'); });
    var code = el('input');
    code.id = 'tk-code';
    code.type = 'text';
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.placeholder = 'the code claude.ai shows';
    var send = btn('Send the code', false, function () {
      var text = code.value.replace(/\s+/g, '');
      if (!SIGN_IN_CODE.test(text)) { code.focus(); return; }
      send.disabled = true;
      code.disabled = true;
      gh('POST', '/repos/' + repo + '/issues/' + issue + '/comments', { body: TOKEN_MARK.code + '\n' + text }).then(function () {
        add(m, el('p', 'admin__lead', 'Code sent; the run is making the token and this page saves it in a few seconds.'));
      }, function (e) { send.disabled = false; code.disabled = false; add(m, el('p', 'admin__warn', 'The code could not be sent: ' + e.message)); });
    });
    add(m, el('p', 'admin__lead', '1. Sign in as the Claude account to add and press Authorize. 2. Copy the code claude.ai shows. 3. Paste it here and send it.'));
    add(m, add(el('p', 'admin__bar'), open, ' ', code, ' ', send));
  }
  function closeRunIssue(repo, issue, failed) {
    return gh('PATCH', '/repos/' + repo + '/issues/' + issue, { state: 'closed', state_reason: failed ? 'not_planned' : 'completed' }).catch(function () { return null; });
  }
  // a secret written with a sealed box: an organization's keeps the repositories it reached and adds ids
  function putSecret(place, secretPath, sealed, keyId, ids) {
    var body = { encrypted_value: sealed, key_id: keyId };
    if (!place.org) return gh('PUT', secretPath, body);
    return readOne(secretPath).then(function (have) {
      if (have && have.visibility && have.visibility !== 'selected') { body.visibility = have.visibility; return gh('PUT', secretPath, body); }
      return (have ? reachOf(secretPath) : Promise.resolve([])).then(function (now) {
        body.visibility = 'selected';
        body.selected_repository_ids = union(now, ids);
        return gh('PUT', secretPath, body);
      });
    });
  }
  // the slot's secret, then its label, then its place in SYMPHONY_CLAUDE_ACCOUNTS; err.stored says
  // whether the secret went in before a later step failed
  function storeSealed(place, repo, slot, sealed, keyId, ids, labelText) {
    var stored = false;
    return putSecret(place, place.base + '/secrets/' + slotSecret(slot), sealed, keyId, ids).then(function () {
      stored = true;
      if (labelText && slot !== 'main') return writeVariable(place, SLOT_PREFIX + slot + '_LABEL', labelText, ids);
    }).then(function () {
      if (slot === 'main') return;
      return readOne(place.base + '/variables/' + ACCOUNTS_VARIABLE).then(function (have) {
        var words = slotWords(have && have.value);
        if (words.indexOf(slot) < 0) words.push(slot);
        return writeVariable(place, ACCOUNTS_VARIABLE, words.join(','), ids);
      });
    }).catch(function (e) { e.stored = stored; throw e; });
  }
  // The Claude GitHub App, which @claude and the workers need on the repository, installed from
  // GitHub's own page opened for this one repository; the page offers it unless it can see the App on
  // the repository's organization already
  function claudeAppLink(place) {
    return 'https://github.com/apps/claude/installations/new/permissions?target_id=' + place.ownerId + '&repository_ids[]=' + place.id;
  }
  function claudeAppSeen(place) {
    if (!place.org) return Promise.resolve(false);
    return gh('GET', '/orgs/' + place.owner + '/installations?per_page=100').then(function (r) {
      return ((r.data && r.data.installations) || []).some(function (i) { return i.app_slug === 'claude' && i.repository_selection === 'all'; });
    }, function () { return false; });
  }

  function saveSlot(repo, place, button) {
    if (button.disabled) return;
    var slot = $('tk-add-slot').value;
    var labelText = $('tk-add-label').value.trim();
    var input = $('tk-add-token');
    // the token leaves the box at once, so a second press finds nothing to seal
    var text = input.value.trim();
    input.value = '';
    if (API_KEY.test(text)) { say('That is an Anthropic API key, which Symphony never uses: paste the token claude setup-token prints, which starts ' + SECRET_HEAD + 'oat.', true); return; }
    if (!CLAUDE_TOKEN.test(text)) { say('That is not the shape of the token claude setup-token prints (' + SECRET_HEAD + 'oat and two digits, then a long run of letters); nothing was saved. Paste it again.', true); return; }
    if (labelText && !SLOT_LABEL.test(labelText)) { text = ''; say('A label is one word or a few, of letters, digits, blanks, dots, dashes and underscores, at most 40, never an e-mail address. Paste the token again with it.', true); return; }
    button.disabled = true;
    var name = slotSecret(slot), secretPath = place.base + '/secrets/' + name, ids = [], sealed = '', keyId = '', stored = false;
    say('Sealing the token in this browser and saving ' + name + '...');
    reachIds(place, repo).then(function (found) {
      ids = found.map(function (f) { return f.id; });
      return refuseCrowd(place.org ? found.map(function (f) { return f.name; }) : [repo], place);
    }).then(function () {
      return Promise.all([loadSealer(), gh('GET', place.base + '/secrets/public-key')]);
    }).then(function (both) {
      keyId = both[1].data.key_id;
      sealed = toBase64(both[0](new TextEncoder().encode(text), fromBase64(both[1].data.key)));
      // from here only the sealed box is held; the box empties so a second press seals nothing
      text = '';
    }).then(function () {
      return storeSealed(place, repo, slot, sealed, keyId, ids, labelText).catch(function (e) { stored = !!e.stored; throw e; });
    }).then(function () {
      sealed = '';
      return Promise.all([readOne(secretPath), shadowed(place, repo, name, slot)]);
    }).then(function (both) {
      var now = both[0];
      button.disabled = false;
      say(name + ' is saved' + (now && now.updated_at ? ', updated ' + stamp(now.updated_at) : '') + (slot === 'main' ? '.' : ', and ' + ACCOUNTS_VARIABLE + ' lists slot ' + slot + '. Press "Read every slot now" to take its first reading.') + both[1], !!both[1]);
      showAddSlot(repo, reading);
    }).catch(function (e) {
      button.disabled = false;
      text = '';
      sealed = '';
      // once the secret is in, a failed label or list leaves the token saved, so it is not asked for again
      if (stored) say(name + ' is saved, but its label or ' + ACCOUNTS_VARIABLE + ' could not be written: ' + e.message + (e.status === 403 || e.status === 404 ? SECRETS_NEEDED : '') + ' Add the slot to ' + ACCOUNTS_VARIABLE + ' on GitHub\'s variables page, or save the slot again.', true);
      else say(e.message + (e.status === 403 || e.status === 404 ? SECRETS_NEEDED : '') + ' Paste the token again to retry.', true);
    });
  }

  // The Tokens tab of the console: the repository is the one the console shows, and the slots are
  // read when the tab opens, or when the console moves to another repository while it is open, so a
  // person who never opens the tab sends none of its reads.
  var tokensFor = null;
  function tokensRepo() { return state && state.repo ? state.repo : ''; }
  function initTokensTab() {
    $('tk-reload').addEventListener('click', loadTokens);
    $('tk-probe').addEventListener('click', probeSlots);
    // the button at the top presses the Add box's own, within the same click, so its new tab may open
    $('tk-add-top').addEventListener('click', function () {
      var one = $('tk-one');
      if (one) one.click();
      else say('The slots are still being read; press again in a moment.');
    });
    consoleOnOpen.tokens = function () { if (tokensFor !== tokensRepo()) loadTokens(); };
  }

  // the cost page carries a signed-in box of its own, so its marker is read first
  // tokens.html was a page of its own until the console took it in as a tab: it sends a visitor there
  if ($('tokens-moved')) location.replace('/symphony/control/' + location.search + '#tokens');
  else if ($('cost-app')) initCost();
  else if ($('cp-app')) { initConsole(); initPanel(); if ($('tk-slots')) initTokensTab(); }
})();
