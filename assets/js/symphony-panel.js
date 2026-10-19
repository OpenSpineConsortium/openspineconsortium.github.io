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
   the refresh token that came with it), the names of the repositories
   you listed and the sizes and text size you set, and never sends anything anywhere but GitHub and, for the
   sign-in, that service, save what the Folders tab sends for a drive the
   person connects there: Microsoft's consent, Microsoft Graph and the
   same service's drive routes. The one Claude token it touches is one pasted
   into the Tokens tab's + Add Token, which it seals in this
   browser for GitHub's public key and sends to GitHub as that sealed box
   alone, never stored, logged or shown (the owner, 2026-10-18). The one
   other token it touches is a drive's, on the Folders tab: Microsoft's
   tokens for the person's OneDrive, held in the page's memory alone and
   sealed the same way into the repository's secret.

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
    // a drive connected under this sign-in goes with it, whatever ended it
    dropDrive();
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
  // the calls GitHub said the token has left this hour on its latest answer to any call of the page,
  // so the Dependencies tab's reserve is held to the newest count and not to the one its draw began
  // from, which the console's other reads made in parallel may have spent since
  var rateLatest = null;
  function call(method, path, body, headers, raw, account, again) {
    var sent = '', byApp = false, era = ends;
    return ready(method, path, account).then(function () {
      sent = token;
      byApp = signedInByApp();
      var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      h['Authorization'] = 'Bearer ' + token;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      var k;
      // a header given as null is left off, for a read that must go out with no header of GitHub's own
      for (k in (headers || {})) if (Object.prototype.hasOwnProperty.call(headers, k)) { if (headers[k] === null) delete h[k]; else h[k] = headers[k]; }
      var ask = { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) };
      // the calls that wait to know whose the token is all wait on this one question, so GitHub not
      // answering it must not hold them for good
      if (path === '/user') ask.signal = within(20000);
      return fetch(API + path, ask);
    }).then(function (r) {
      var seen = rateLeft(r.headers);
      if (seen !== null) rateLatest = seen;
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
  // charts says a Mermaid block is a chart to draw: the board's own Dependencies section, which
  // loadBoard draws in place (boardCharts), so the Board tab never shows the board's chart as text;
  // anything else, an assistant's answer among them, shows such a block as text, as it shows any
  // code. A comment is taken out only within its line, as the board writes its markers: the board
  // writes a title raw, and every edge of its charts carries "-->", so a title holding "<!--"
  // would otherwise swallow every line up to the first edge.
  function markdown(src, charts) {
    var lines = escapeHtml(String(src).replace(/<!--[^\n]*?-->/g, '').replace(/\r/g, '')).split('\n');
    var out = [], i = 0, para = [], list = null, table = null, code = false, chart = [];
    // a chart's lines, escaped with the rest, sit in the attribute the drawing reads
    function chartHost() { return '<div class="control__chart" data-chart="' + chart.join('\n') + '">Drawing the chart...</div>'; }
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
        if (code === 'chart') { out.push(chartHost()); code = false; }
        else if (code) { out.push('</pre>'); code = false; }
        else if (charts && /^```mermaid\s*$/.test(line)) { chart = []; code = 'chart'; }
        else { out.push('<pre class="admin__text">'); code = true; }
        continue;
      }
      if (code === 'chart') { chart.push(line); continue; }
      if (code) { out.push(line); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      // the board writes a pipe in an epic's heading as \|, as it does in a cell, and a page shows it as the pipe
      if (h) { flushPara(); flushList(); flushTable(); var n = Math.min(h[1].length + 1, 6); out.push('<h' + n + '>' + inline(h[2].replace(/\\\|/g, '|')) + '</h' + n + '>'); continue; }
      if (/^\s*\|/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
      var li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) { flushPara(); flushTable(); (list = list || []).push(li[1]); continue; }
      if (!line.trim()) { flushPara(); flushList(); flushTable(); continue; }
      flushList(); flushTable();
      para.push(line.trim());
    }
    flushPara(); flushList(); flushTable();
    if (code === 'chart') out.push(chartHost()); else if (code) out.push('</pre>');
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
    if (select.id === 'cp-repo') showRepoName(list.indexOf(current) >= 0 ? current : list[0] || '');
  }
  // the side column's whole name, the owner on its own line, under the select laid over it
  function showRepoName(name) {
    var shown = $('cp-repo-shown');
    if (!shown) return;
    clear(shown);
    if (!name) { shown.textContent = 'No repository listed yet'; return; }
    var cut = name.indexOf('/') + 1;
    add(shown, el('span', '', name.slice(0, cut)), name.slice(cut));
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
    dropDrive();
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
  // one entry per thing that could not be read, the latest, since a loader run again in place (after
  // Give to, a merge, a question) would otherwise say the same failure twice in the summary
  function failed(s, what, e) {
    s.failed = s.failed.filter(function (f) { return f.indexOf(what + ' (') !== 0; });
    s.failed.push(what + ' (' + e.message + ')');
  }

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
      // a goal, like an epic, is taken whole by nobody: a person breaks it into epics and the
      // coordinator plans each epic, so it is listed with them
      else if (l.indexOf('epic') >= 0 || l.indexOf('goal') >= 0) g.epics.push(it);
      else if (l.indexOf('in-review') >= 0) g.review.push(it);
      else if (l.indexOf('claimed') >= 0) g.claimed.push(it);
      else if (l.indexOf('blocked') >= 0) g.blocked.push(it);
      else if (worker) g.given.push(it);
      else if (l.indexOf('todo') >= 0) g.queue.push(it);
      else g.other.push(it);
    });
    return g;
  }

  // each cell of a card's row names its part, so the console draws rows as cards (control.css)
  function cardCells(tr, parts) {
    Array.prototype.forEach.call(tr.children, function (td, i) { if (parts[i]) td.classList.add('cell--' + parts[i]); });
    return tr;
  }
  // labels as chips; the separators stay in the text, so the cell reads as it did
  function labelChips(labels) {
    var td = el('td');
    labels.forEach(function (name, i) {
      if (i) add(td, el('span', 'chip__sep', ', '));
      add(td, el('span', 'lchip' + (/^worker:|^account:|^agent:/.test(name) ? ' lchip--worker' : '') + (/^(blocker|blocked)$/.test(name) ? ' lchip--warn' : ''), name));
    });
    return td;
  }
  function issueRow(it, givable) {
    var tr = el('tr');
    var l = labelsOf(it);
    // the number and the labels, readable from the row, for the assistant's focus and filter
    tr.setAttribute('data-number', String(it.number));
    tr.setAttribute('data-labels', l.join('\n'));
    add(tr, add(el('td'), link(it.html_url, '#' + it.number)));
    add(tr, el('td', '', it.title));
    add(tr, labelChips(l));
    add(tr, el('td', '', workerOf(l) || ''));
    add(tr, add(el('td'), timeEl(it.updated_at)));
    add(tr, cardControls(tr, '#' + it.number, {
      open: function () { issueStatus(it, givable); },
      gear: function () { issueSettings(it, givable, ''); },
      x: function (b) { closeIssue(it, b); }
    }));
    return cardCells(tr, ['num', 'title', 'labels', 'worker', 'when', 'ctl']);
  }
  function issueTable(id, list, givable) {
    var body = $(id).querySelector('tbody');
    clear(body);
    if (id === 'cp-queue') body.appendChild(addTileRow('+ Add task', 'cp-task-tile', function () { openTaskDialog('', ''); }, 6));
    if (!list.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'None.')).firstChild.colSpan = 6; body.appendChild(tr); return; }
    list.forEach(function (it) { body.appendChild(issueRow(it, givable)); });
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

  /* ---------- cards: a press for where it stands, the gear for its settings, the X to remove it ---------- */
  // Every card on the console behaves as a token's tile does: a press anywhere on it but a link or
  // a button opens its status, the gear its settings, and the X removes it after one confirmation.
  // The three sit in the card's last cell, which the console draws in the card's top right corner.
  function cardControls(tr, what, acts) {
    var td = el('td', 'card__ctl');
    if (acts.gear) {
      var gear = el('button', 'card__gear', '⚙');
      gear.type = 'button';
      gear.title = 'Settings of ' + what;
      gear.setAttribute('aria-label', 'Settings of ' + what);
      gear.addEventListener('click', function (ev) { ev.stopPropagation(); acts.gear(); });
      add(td, gear);
    }
    if (acts.x) {
      var x = el('button', 'card__x', '×');
      x.type = 'button';
      x.title = 'Remove ' + what;
      x.setAttribute('aria-label', 'Remove ' + what);
      x.addEventListener('click', function (ev) { ev.stopPropagation(); acts.x(x); });
      add(td, x);
    }
    if (acts.open) {
      tr.classList.add('card--open');
      tr.tabIndex = 0;
      tr.setAttribute('aria-label', 'Where ' + what + ' stands');
      tr.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('a, button, select, input, textarea, label')) return;
        acts.open();
      });
      tr.addEventListener('keydown', function (ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === tr) { ev.preventDefault(); acts.open(); } });
    }
    return td;
  }
  // the dashed + card a list ends with (or, for the task queue, begins with)
  function addTileRow(label, id, onClick, span) {
    var tr = el('tr', 'card--add');
    var td = el('td');
    td.colSpan = span;
    var b = el('button', 'card__add', label);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', onClick);
    add(tr, add(td, b));
    return tr;
  }
  function openDialog(id) {
    var d = $(id);
    if (!d) return null;
    if (dialogOpeners[id] && !d.open) dialogOpeners[id]();
    if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    return d;
  }
  function closeDialog(id) {
    var d = $(id);
    if (d && d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } }
  }
  // the + buttons open their dialog empty; a gear or the assistant fills it after
  var dialogOpeners = {
    'dlg-worker': function () { workerDialog(null); },
    'dlg-repos': function () { pickerOpen(); },
    'dlg-share': function () { shareDialogOpen(); }
  };
  // the one dialog a card's status and settings are drawn in
  function itemDialog(title) {
    var d = $('dlg-item');
    clear(d);
    var form = el('form', 'tkdlg__form');
    form.method = 'dialog';
    var close = el('button', 'tkside__close cpdlg__close', '×');
    close.type = 'submit';
    close.setAttribute('aria-label', 'Close');
    add(form, close, el('h3', 'console__boxh cpdlg__title', title));
    add(d, form);
    if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    return form;
  }
  // a button that sends something stays pressed until GitHub answers, so a second press sends nothing twice
  function hold(id) {
    var b = $(id);
    if (b) b.disabled = true;
    return function () { if (b) b.disabled = false; };
  }
  function fact(label, value) {
    var p = el('p', 'tkdlg__fact');
    add(p, el('span', 'tkdlg__faint', label + ' '), typeof value === 'string' ? document.createTextNode(value) : value);
    return p;
  }
  function issueGroupWord(it) {
    var g = sortIssues([it]);
    return g.claimed.length ? 'Claimed, at work' : g.review.length ? 'In review' : g.epics.length ? 'An epic, which the coordinator plans'
      : g.blockers.length ? 'A blocker' : g.blocked.length ? 'Blocked' : g.given.length ? 'Given to a worker, not yet claimed' : g.queue.length ? 'In the queue, free to claim' : 'Open, with none of the protocol\'s labels';
  }
  function issueStatus(it, givable) {
    var form = itemDialog('#' + it.number + ' ' + it.title);
    var l = labelsOf(it), who = workerOf(l);
    add(form, fact('Stands:', issueGroupWord(it) + (who ? ', ' + who : '') + '.'));
    if (l.length) {
      var chips = el('div', 'cpdlg__chips');
      Array.prototype.slice.call(labelChips(l).childNodes).forEach(function (n) { chips.appendChild(n); });
      add(form, chips);
    }
    add(form, fact('Updated:', timeEl(it.updated_at)));
    if (it.user && it.user.login) add(form, fact('Opened by:', '@' + it.user.login));
    var body = el('div', 'control__answer control__assistant cpdlg__body');
    var text = String(it.body || '').trim();
    if (text) body.innerHTML = markdown(text.length > 6000 ? text.slice(0, 6000) + '\n\n...' : text);
    else add(body, el('p', 'admin__none', 'No description.'));
    add(form, body);
    var bar = el('p', 'tkdlg__bar');
    add(bar, btn('⚙ Settings', false, function () { issueSettings(it, givable, ''); }), link(it.html_url, 'Open on GitHub'));
    var held = sortIssues([it]);
    if (state && state.repo && (held.claimed.length || held.review.length)) add(bar, link('https://github.com/' + state.repo + '/tree/claude/' + it.number, 'Its claim branch'));
    add(form, bar);
  }
  // a card's settings: give it to a worker where the protocol lets a label give it, and ask Claude
  // on it; prompt fills the box when the assistant drafted the words
  function issueSettings(it, givable, prompt) {
    var form = itemDialog('Settings of #' + it.number + (it.title ? ' ' + it.title : ''));
    if (givable) {
      var names = workerNames();
      var sel = el('select');
      sel.id = 'dlg-give';
      add(sel, el('option', '', names.length ? 'Pick a worker...' : 'No worker registered')).firstChild.value = '';
      names.forEach(function (n) { var o = el('option', '', n); o.value = n; sel.appendChild(o); });
      sel.disabled = !names.length;
      var give = btn('Give it', false, function () { if (!sel.value) { say('Pick a worker first.', true); return; } closeDialog('dlg-item'); giveTo(it, sel.value); });
      give.id = 'dlg-give-go';
      add(form, add(el('div', 'tkdlg__field'), add(el('label', '', 'Give it to a worker')), add(el('div', 'cpdlg__inline'), sel, give)));
      form.lastChild.querySelector('label').htmlFor = 'dlg-give';
    } else if (it.title) {
      add(form, el('p', 'tkdlg__fact tkdlg__faint', 'No worker can be given it now: ' + issueGroupWord(it).toLowerCase() + ', and only a queued, given or blocked issue is given by its label.'));
    }
    var q = el('textarea');
    q.id = 'dlg-ask';
    q.rows = 4;
    q.value = prompt || '';
    var ask = btn('Ask @claude on #' + it.number, false, function () { askOnIssue(it.number, q.value); });
    ask.id = 'dlg-ask-go';
    ask.className = 'console__primary';
    add(form, add(el('div', 'tkdlg__field'), add(el('label', '', 'Ask Claude to do something on it')), q), add(el('p', 'tkdlg__bar'), ask));
    q.previousSibling.htmlFor = 'dlg-ask';
    add(form, el('p', 'tkdlg__note admin__lead', 'Ask comments on the issue mentioning @claude, and the repository\'s Claude workflow answers there on the repository\'s own Claude token. For a question about the board, use the Ask Claude bar at the foot.'));
    (prompt ? q : (form.querySelector('select:not(:disabled)') || q)).focus();
  }
  function askOnIssue(n, text) {
    text = String(text || '').trim();
    if (!text) { say('Write what Claude should do first.', true); return; }
    var s = state;
    say('Sending...');
    var done = hold('dlg-ask-go');
    gh('POST', '/repos/' + s.repo + '/issues/' + n + '/comments', { body: (/@claude/i.test(text) ? '' : '@claude ') + text }).then(function () {
      done();
      closeDialog('dlg-item');
      say('Commented on #' + n + '; the Claude workflow answers there on the repository\'s own Claude token.');
    }).catch(function (e) { done(); say(e.message, true); });
  }
  function closeIssue(it, button) {
    if (!window.confirm('Close #' + it.number + ' "' + it.title + '" as not planned? It leaves the board; reopen it on GitHub to bring it back.')) return;
    var s = state;
    button.disabled = true;
    say('Closing #' + it.number + '...');
    gh('PATCH', '/repos/' + s.repo + '/issues/' + it.number, { state: 'closed', state_reason: 'not_planned' }).then(function () {
      say('#' + it.number + ' is closed.');
      if (!stale(s)) return loadIssues(s);
    }).catch(function (e) { button.disabled = false; say(e.message, true); });
  }

  // A change to the repository's files from the panel is a pull request, never a push to the
  // default branch: one branch per change, moved to the default branch's head each time, each file
  // written or deleted through the contents API, and the pull request opened or found. files is a
  // list of { path, text } where text null deletes the file.
  function proposeFiles(repo, branch, title, body, files) {
    var base, head;
    // a branch that is there already is built on, never moved: a reviewer or another tab may have
    // pushed to its pull request, and the contents calls below commit on top of whatever it holds
    return gh('GET', '/repos/' + repo).then(function (r) {
      base = r.data.default_branch || 'main';
      return gh('GET', '/repos/' + repo + '/git/ref/heads/' + base.split('/').map(encodeURIComponent).join('/'));
    }).then(function (r) {
      head = r.data.object.sha;
      return gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: head }).catch(function (e) {
        if (e.status !== 422) throw e;
      });
    }).then(function () {
      return files.reduce(function (done, f) {
        return done.then(function () {
          return gh('GET', '/repos/' + repo + '/contents/' + f.path + '?ref=' + encodeURIComponent(branch)).then(function (r) { return r.data.sha; }, function (e) { if (e.status === 404) return null; throw e; });
        }).then(function (sha) {
          if (f.text == null) return sha ? gh('DELETE', '/repos/' + repo + '/contents/' + f.path, { message: title, sha: sha, branch: branch }) : null;
          var put = { message: title, content: utf8Base64(f.text), branch: branch };
          if (sha) put.sha = sha;
          return gh('PUT', '/repos/' + repo + '/contents/' + f.path, put);
        });
      }, Promise.resolve());
    }).then(function () {
      return gh('GET', '/repos/' + repo + '/pulls?state=open&head=' + encodeURIComponent(repo.split('/')[0] + ':' + branch));
    }).then(function (r) {
      if (Array.isArray(r.data) && r.data.length) return r.data[0];
      return gh('POST', '/repos/' + repo + '/pulls', { title: title, head: branch, base: base, body: body }).then(function (x) { return x.data; });
    });
  }
  function proposedWords(what, pr) {
    return what + ': pull request #' + pr.number + ' is open (' + pr.html_url + '); nothing changes until it merges.';
  }

  function loadMeta(s) {
    return gh('GET', '/repos/' + s.repo).then(function (r) {
      if (stale(s)) return r.data;
      s.meta = r.data;
      // the Share tab's role picker hangs on whether an organization owns the repository
      if (consoleTab === 'share' && consoleOnOpen.share) consoleOnOpen.share();
      return r.data;
    });
  }
  function loadIssues(s) {
    return ghList('/repos/' + s.repo + '/issues?state=open&per_page=100', 5).then(function (list) {
      if (stale(s)) return;
      s.issues = list;
      var g = sortIssues(list);
      // "Give to" is offered where the protocol lets a label give the issue: the queue, the issues
      // given and the blocked ones; a claimed issue names its holder alone, and an epic is the coordinator's
      issueTable('cp-queue', g.queue, true);
      issueTable('cp-given', g.given, true);
      issueTable('cp-claimed', g.claimed, false);
      issueTable('cp-review', g.review, false);
      issueTable('cp-blocked', g.blocked.concat(g.blockers), true);
      issueTable('cp-epics', g.epics, false);
      assistantRedraw();
      loadGraph(s);
      $('cp-other').textContent = (g.other.length ? plural(g.other.length, 'other open issue') + ' carries none of the protocol\'s labels: ' + g.other.slice(0, 8).map(function (it) { return '#' + it.number + ' ' + it.title; }).join('; ') + (g.other.length > 8 ? '; ...' : '') + '.' : '')
        + (list.more ? ' Only the first ' + list.length + ' open issues were read; the rest are on GitHub.' : '');
      // the summary is written once everything of the first load is in, and again after each change
      if (s.ready) summary();
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the issues', e);
      $('cp-other').textContent = 'The issues could not be read: ' + e.message;
      graphReset('Not drawn: the issues could not be read.', true);
      if (s.ready) summary();
    });
  }
  function loadBoard(s) {
    var box = $('cp-board');
    return file(s.repo, 'STATE.md', 'board').then(function (text) {
      if (stale(s)) return;
      box.innerHTML = markdown(text, true);
      boardCharts(s, box);
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
      if (!workers.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'None registered: people\'s sessions work under their own GitHub logins and need no file.')).firstChild.colSpan = 9; body.appendChild(tr); }
      workers.forEach(function (w) {
        if (!w.name) { var bad = el('tr'); add(bad, el('td', 'admin__none', w.about || '')).firstChild.colSpan = 9; body.appendChild(bad); return; }
        var tr = el('tr');
        add(tr, el('td', '', w.name || ''));
        add(tr, el('td', '', w.runs || ''));
        add(tr, el('td', '', w.about || ''));
        add(tr, el('td', '', Array.isArray(w.area) ? w.area.join(', ') : (w.area || 'anywhere')));
        add(tr, el('td', '', w.lands || ''));
        add(tr, el('td', '', w.model || 'default'));
        add(tr, el('td', '', w.max_turns != null ? String(w.max_turns) : ''));
        add(tr, el('td', '', w.rounds != null ? String(w.rounds) : ''));
        add(tr, cardControls(tr, w.name, {
          open: function () { workerStatus(w); },
          gear: function () { openDialog('dlg-worker'); workerDialog(w); },
          x: function (b) { removeWorker(w, b); }
        }));
        tr.setAttribute('data-runs', w.runs || '');
        body.appendChild(cardCells(tr, ['name', 'runs', 'about', 'area', 'lands', 'model', 'turns', 'rounds', 'ctl']));
      });
      body.appendChild(addTileRow('+ Add worker', 'cp-worker-tile', function () { openDialog('dlg-worker'); }, 9));
      return loadIssues(s);
    });
  }
  /* ---------- the Agents tab ---------- */
  // The agents are .github/symphony/agents.json and the files under .claude/agents/ it names
  // (symphony-template's docs/agents/AGENTS.md). Each row shows what the agent is for, the tools its
  // file lists and where it came from; the Tokens cell is the Tokens tab's own control,
  // tokenAssignBox(repo, agentName), which knows where tokens live and who may change them, so this
  // tab writes no token setting itself. Run and Import start the Agents workflow, agents.yml.
  var AGENTS_REGISTRY = '.github/symphony/agents.json';
  function frontMatter(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var found = {};
    if (lines[0] !== '---') return found;
    var key = '';
    for (var i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      var line = lines[i];
      if (/^\s/.test(line)) {
        var item = line.trim();
        if (key && item.indexOf('- ') === 0 && Array.isArray(found[key])) found[key].push(item.slice(2).trim());
        continue;
      }
      var at = line.indexOf(':');
      if (at < 0) continue;
      key = line.slice(0, at).trim();
      var value = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      found[key] = value || [];
    }
    return found;
  }
  function toolsOf(value) {
    if (Array.isArray(value)) return value;
    return String(value || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }
  function loadAgents(s) {
    var body = $('cp-agents').querySelector('tbody');
    var note = $('cp-agents-note');
    return file(s.repo, AGENTS_REGISTRY).then(function (text) {
      var registry = JSON.parse(text);
      var names = Object.keys(registry && registry.agents || {});
      return Promise.all(names.map(function (name) {
        return file(s.repo, '.claude/agents/' + name + '.md').then(frontMatter, function () { return { description: 'its file .claude/agents/' + name + '.md could not be read' }; })
          .then(function (head) { return { name: name, entry: registry.agents[name] || {}, head: head }; });
      }));
    }).catch(function (e) {
      if (e.status === 404) return null;
      if (!stale(s)) failed(s, 'the agents', e);
      return [];
    }).then(function (agents) {
      if (stale(s)) return;
      s.agents = agents || [];
      clear(body);
      note.textContent = agents === null ? 'This repository lists no agents yet: it was made before agents existed, and the template\'s next update brings the reviewer, developer and tester.' : '';
      if (agents && !agents.length) { var none = el('tr'); add(none, el('td', 'admin__none', 'No agents listed.')).firstChild.colSpan = 7; body.appendChild(none); }
      s.agents.forEach(function (a) {
        var tr = el('tr');
        add(tr, add(el('td'), link('https://github.com/' + s.repo + '/blob/' + ((s.meta && s.meta.default_branch) || 'main') + '/.claude/agents/' + a.name + '.md', a.name)));
        add(tr, el('td', '', a.entry.purpose || ''));
        add(tr, el('td', '', typeof a.head.description === 'string' ? a.head.description : ''));
        var tools = toolsOf(a.head.tools);
        var toolCell = el('td', '', tools.length ? tools.length + (tools.length === 1 ? ' tool' : ' tools') : 'every tool');
        toolCell.title = tools.join(', ');
        add(tr, toolCell);
        var runs = a.entry.runs === 'pull_request' ? 'on every pull request' : 'by hand';
        if (a.entry.workers && a.entry.workers.length) runs += '; workers ' + a.entry.workers.join(', ');
        add(tr, el('td', '', runs));
        add(tr, el('td', '', a.entry.source === 'symphony' ? 'Symphony' : a.entry.source === 'local' ? 'written here' : (a.entry.source || '')));
        add(tr, cardControls(tr, a.name, {
          open: function () { agentStatus(a); },
          gear: function () { agentSettings(a, ''); },
          x: function (b) { removeAgent(a, b); }
        }));
        tr.setAttribute('data-purpose', a.entry.purpose || 'other');
        body.appendChild(cardCells(tr, ['name', 'purpose', 'about', 'tools', 'runs', 'from', 'ctl']));
      });
      if (agents !== null) body.appendChild(addTileRow('+ Import agent', 'cp-agent-tile', function () { openDialog('dlg-import'); }, 7));
    });
  }
  function dispatchAgents(inputs, label) {
    var s = state;
    var branch = s.meta && s.meta.default_branch ? s.meta.default_branch : 'main';
    say('Starting ' + label + '...');
    return gh('POST', '/repos/' + s.repo + '/actions/workflows/agents.yml/dispatches', { ref: branch, inputs: inputs }).then(function () {
      say(label + ' is queued on ' + branch + '; the Runs tab shows it within a minute.');
      setTimeout(function () { if (!stale(s)) loadRuns(s); }, 4000);
    }).catch(function (e) {
      say(e.status === 404 ? 'This repository has no Agents workflow yet (.github/workflows/agents.yml); the template\'s next update brings it.'
        : e.message + (e.status === 403 ? ' Starting a workflow needs Actions: read and write on the sign-in or the token.' : ''), true);
    });
  }
  function runAgent(agent, target) {
    target = String(target || '').trim().replace(/^#/, '');
    if (!agent) { say('Choose an agent first.', true); return; }
    if (!/^[1-9][0-9]{0,8}$/.test(target)) { say('Give the number of the pull request or issue it works on.', true); return; }
    closeDialog('dlg-item');
    dispatchAgents({ agent: agent, target: target }, 'the agent ' + agent + ' on #' + target);
  }
  function importAgent() {
    var source = ($('cp-a-source').value || '').trim();
    var name = ($('cp-a-name').value || '').trim();
    if (!/^(https:\/\/\S+|[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/\S+\.md(@\S+)?)$/.test(source)) { say('Give OWNER/REPO/PATH.md, perhaps with @branch, or an https address.', true); return; }
    if (name && !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(name)) { say('A name is lower case letters, digits and inner dashes, up to 39.', true); return; }
    var inputs = { 'import': source };
    if (name) inputs.name = name;
    if ($('cp-a-purpose').value) inputs.purpose = $('cp-a-purpose').value;
    closeDialog('dlg-import');
    dispatchAgents(inputs, 'the import of ' + source);
  }
  function agentRunsWords(a) {
    var runs = a.entry.runs === 'pull_request' ? 'on every pull request' : 'by hand';
    if (a.entry.workers && a.entry.workers.length) runs += '; workers ' + a.entry.workers.join(', ');
    return runs;
  }
  function agentFileUrl(a) {
    return 'https://github.com/' + state.repo + '/blob/' + ((state.meta && state.meta.default_branch) || 'main') + '/.claude/agents/' + a.name + '.md';
  }
  function agentStatus(a) {
    var form = itemDialog(a.name);
    add(form, fact('For:', a.entry.purpose || 'other'));
    if (typeof a.head.description === 'string' && a.head.description) add(form, el('p', 'tkdlg__fact', a.head.description));
    var tools = toolsOf(a.head.tools);
    add(form, fact('Tools:', tools.length ? tools.join(', ') : 'every tool'));
    if (a.head.model) add(form, fact('Model:', String(a.head.model)));
    add(form, fact('Runs:', agentRunsWords(a)));
    add(form, fact('From:', a.entry.source === 'symphony' ? 'Symphony' : a.entry.source === 'local' ? 'written here' : (a.entry.source || 'not recorded')));
    add(form, add(el('p', 'tkdlg__bar'), btn('⚙ Settings', false, function () { agentSettings(a, ''); }), link(agentFileUrl(a), 'Its file on GitHub')));
  }
  // an agent's settings: run it on a pull request or issue, and the tokens it runs on, which is the
  // Tokens tab's own control (tokenAssignBox), so this dialog writes no token setting itself
  function agentSettings(a, target) {
    var form = itemDialog('Settings of ' + a.name);
    var n = el('input');
    n.id = 'dlg-run-target';
    n.inputMode = 'numeric';
    n.maxLength = 10;
    n.placeholder = '12';
    n.value = target || '';
    var go = btn('Run it', false, function () { runAgent(a.name, n.value); });
    go.id = 'dlg-run-go';
    go.className = 'console__primary';
    n.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    var lab = el('label', '', 'Run it in GitHub Actions on pull request or issue number');
    lab.htmlFor = n.id;
    add(form, add(el('div', 'tkdlg__field'), lab, add(el('div', 'cpdlg__inline'), n, go)));
    var tokens = el('div', 'tkdlg__reach');
    add(tokens, el('p', 'tkdlg__fact', 'The tokens it runs on'));
    if (typeof window.tokenAssignBox === 'function') {
      try { var box = window.tokenAssignBox(state.repo, a.name); if (box) tokens.appendChild(box); } catch (e) { add(tokens, el('p', 'admin__none', 'The token box failed: ' + e.message)); }
    } else add(tokens, el('p', 'admin__none', 'The main token, until the Tokens tab gives it others.'));
    add(form, tokens);
    n.focus();
  }
  // the X: a pull request that deletes the agent's file and takes its entry off agents.json
  function removeAgent(a, button) {
    if (!window.confirm('Remove the agent ' + a.name + '? This opens a pull request that deletes .claude/agents/' + a.name + '.md and its entry in ' + AGENTS_REGISTRY + '; it is gone once that merges.')) return;
    var s = state;
    button.disabled = true;
    say('Opening the pull request that removes ' + a.name + '...');
    var branch = 'symphony/remove-agent-' + a.name;
    gh('GET', '/repos/' + s.repo).then(function (r) {
      return file(s.repo, AGENTS_REGISTRY, r.data.default_branch || 'main');
    }).then(function (text) {
      var registry = JSON.parse(text);
      if (registry && registry.agents) delete registry.agents[a.name];
      return proposeFiles(s.repo, branch, 'Remove the agent ' + a.name, 'The control panel\'s Agents tab: removes the agent ' + a.name + ' (.claude/agents/' + a.name + '.md and its entry in ' + AGENTS_REGISTRY + ').',
        [{ path: AGENTS_REGISTRY, text: JSON.stringify(registry, null, 2) + '\n' }, { path: '.claude/agents/' + a.name + '.md', text: null }]);
    }).then(function (pr) { say(proposedWords('Removing ' + a.name, pr)); button.disabled = false; })
      .catch(function (e) { button.disabled = false; say('The removal of ' + a.name + ' stopped: ' + e.message, true); });
  }

  function conclusionWord(run) {
    if (run.status !== 'completed') return run.status.replace(/_/g, ' ');
    return run.conclusion ? run.conclusion.replace(/_/g, ' ') : 'completed';
  }
  // a run's outcome as one of three the cards colour: passed, failed, or anything else
  function outcomeOf(word) {
    if (word === 'success') return 'ok';
    if (/^(failure|timed out|startup failure|action required)$/.test(word)) return 'bad';
    return /^(in progress|queued|waiting|pending|requested)$/.test(word) ? 'running' : 'other';
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
        tr.setAttribute('data-outcome', outcomeOf(w));
        body.appendChild(cardCells(tr, ['name', 'event', 'branch', 'outcome', 'who', 'when']));
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
        tr2.setAttribute('data-outcome', outcomeOf(run.status === 'completed' ? (run.conclusion || 'completed') : run.status));
        body.appendChild(cardCells(tr2, ['name', 'event', 'branch', 'outcome', 'who', 'when']));
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
      cell.className = 'cell--checks ' + (bad ? 'admin__tag admin__tag--wait' : (wait || unread ? 'admin__tag admin__tag--mid' : 'admin__tag admin__tag--ok'));
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
  function pullStatus(pr, checks) {
    var form = itemDialog('#' + pr.number + ' ' + pr.title);
    add(form, fact('Stands:', (pr.draft ? 'A draft' : 'Ready for review') + ', from ' + pr.head.ref + ' into ' + pr.base.ref + '.'));
    add(form, fact('Checks:', checks.textContent || 'not read yet'));
    if (pr.user && pr.user.login) add(form, fact('Opened by:', '@' + pr.user.login));
    add(form, fact('Updated:', timeEl(pr.updated_at)));
    var body = el('div', 'control__answer control__assistant cpdlg__body');
    var text = String(pr.body || '').trim();
    if (text) body.innerHTML = markdown(text.length > 6000 ? text.slice(0, 6000) + '\n\n...' : text);
    else add(body, el('p', 'admin__none', 'No description.'));
    add(form, body, add(el('p', 'tkdlg__bar'), link(pr.html_url, 'Open on GitHub'), link(pr.html_url + '/files', 'Its changes')));
  }
  function closePull(pr, button) {
    if (!window.confirm('Close pull request #' + pr.number + ' "' + pr.title + '" without merging? Its branch stays; reopen it on GitHub to bring it back.')) return;
    var s = state;
    button.disabled = true;
    say('Closing #' + pr.number + '...');
    gh('PATCH', '/repos/' + s.repo + '/pulls/' + pr.number, { state: 'closed' }).then(function () {
      say('#' + pr.number + ' is closed without merging.');
      if (!stale(s)) return loadPulls(s);
    }).catch(function (e) { button.disabled = false; say(e.message, true); });
  }
  // the read is kept on the state, so the Dependencies tab, drawn from the issues read beside
  // it, can wait for the claim branches the pull requests show (graphClaimed)
  function loadPulls(s) {
    var body = $('cp-pulls').querySelector('tbody');
    var read = ghList('/repos/' + s.repo + '/pulls?state=open&per_page=100', 2).then(function (pulls) {
      if (stale(s)) return;
      s.pulls = pulls;
      clear(body);
      if (!pulls.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'No open pull request.')).firstChild.colSpan = 8; body.appendChild(tr); }
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
        add(tr, cardControls(tr, '#' + pr.number, {
          open: function () { pullStatus(pr, checks); },
          x: function (b) { closePull(pr, b); }
        }));
        tr.setAttribute('data-draft', pr.draft ? 'true' : 'false');
        // the Ask Claude bar finds a pull request's Merge button by its number; data-pull keeps
        // these cards out of the task filters, which read tr[data-number] as tasks
        tr.setAttribute('data-number', String(pr.number));
        tr.setAttribute('data-pull', String(pr.number));
        body.appendChild(cardCells(tr, ['num', 'title', 'branch', 'state', 'checks', 'when', 'act', 'ctl']));
        checksOf(s, pr, checks, m);
      });
      if (pulls.more) { var more = el('tr'); add(more, el('td', 'admin__none', 'Only the first ' + pulls.length + ' open pull requests were read; the rest are on GitHub.')).firstChild.colSpan = 8; body.appendChild(more); }
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the pull requests', e);
      clear(body);
      var tr = el('tr'); add(tr, el('td', 'admin__none', 'The pull requests could not be read: ' + e.message)).firstChild.colSpan = 8; body.appendChild(tr);
    });
    s.pullsRead = read;
    return read;
  }

  function summary() {
    var p = $('cp-summary');
    if (!p) return;
    var s = state;
    if (!s.meta) {
      p.textContent = s.failed.length ? 'Could not read ' + s.repo + ': ' + s.failed.join('; ') + '.' : 'Reading ' + s.repo + '...';
      summaryWarn(s.failed.length ? p.textContent : '');
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
      'Queue: ' + atLeast + plural(g.queue.length, 'unclaimed issue') + '; given to workers: ' + g.given.length + '; claimed: ' + g.claimed.length + (claimedBy.length ? ' (' + claimedBy.join(', ') + ')' : '') + '; in review: ' + g.review.length + '; blocked: ' + g.blocked.length + '; blockers: ' + g.blockers.length + '; epics and goals: ' + g.epics.length + '.',
      'Open pull requests: ' + (s.pulls.more ? 'at least ' : '') + s.pulls.length + (s.pulls.length ? ' (' + s.pulls.filter(function (x) { return x.draft; }).length + ' drafts)' : '') + '.',
      'Workers in Actions: ' + (inActions.length ? inActions.join(', ') : 'none') + '; routines: ' + (routines.length ? routines.join(', ') : 'none') + '.',
      last ? 'Last run: ' + (last.name || 'run') + ', ' + conclusionWord(last) + ', ' + ago(last.run_started_at || last.created_at) + '.' : 'Runs: none listed.',
      s.failed.length ? 'Not read: ' + s.failed.join('; ') + '.' : ''
    ];
    p.textContent = parts.filter(Boolean).join(' ');
    summaryWarn(s.failed.length ? 'Not read: ' + s.failed.join('; ') + '.' : '');
  }
  // the summary itself is for a screen reader and a browsing agent; what could not be read shows
  function summaryWarn(text) {
    var w = $('cp-summary-warn');
    if (!w) return;
    w.textContent = text;
    w.hidden = !text;
  }

  function loadRepo(name) {
    var s = state = emptyState(name);
    showRepoName(name);
    $('cp-on-github').href = 'https://github.com/' + name;
    $('cp-board-link').href = 'https://github.com/' + name + '/blob/board/STATE.md';
    $('cp-actions-link').href = 'https://github.com/' + name + '/actions';
    $('cp-issues-link').href = 'https://github.com/' + name + '/issues';
    $('cp-worker-form-link').href = 'https://github.com/' + name + '/issues/new?template=worker.yml';
    $('cp-task-form-link').href = 'https://github.com/' + name + '/issues/new?template=task.yml';
    $('cp-summary').textContent = 'Reading ' + name + '...';
    graphReset('Reading the issues of ' + name + '...');
    try { history.replaceState(null, '', location.pathname + '?repo=' + encodeURIComponent(name) + location.hash); } catch (e) { /* the address stays */ }
    rememberRepo(name);
    fillRepoSelect($('cp-repo'), name);
    assistantRepo(s);
    if (consoleTab === 'tokens' && consoleOnOpen.tokens) consoleOnOpen.tokens();
    if (consoleTab === 'leaders' && consoleOnOpen.leaders) consoleOnOpen.leaders();
    foldersFor = null;
    if (consoleTab === 'folders' && consoleOnOpen.folders) consoleOnOpen.folders();
    if (consoleTab === 'share' && consoleOnOpen.share) consoleOnOpen.share();
    exploreForget();
    if (consoleTab === 'explore' && consoleOnOpen.explore) consoleOnOpen.explore();
    return loadMeta(s).then(function () {
      if (stale(s)) return;
      // the saved catalog read needs the repository's meta (private, and no drive connected), which
      // the folders tab's earlier open could not see; now that meta is in, draw it if the tab is open
      if (consoleTab === 'folders' && !drive) maybeCatalog();
      return Promise.all([loadBoard(s), loadWorkers(s), loadAgents(s), loadRuns(s), loadPulls(s)]);
    }).then(function () {
      if (stale(s)) return;
      s.ready = true;
      summary();
    }).catch(function (e) {
      if (stale(s)) return;
      failed(s, 'the repository', e);
      s.ready = true;
      say(e.message, true);
      graphReset('Not drawn: the repository could not be read.', true);
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
        closeDialog('dlg-repos');
        say(meta.full_name + ' is adopted already (it carries the topic symphony); it is on your list now.');
        loadRepo(meta.full_name);
        return;
      }
      add(box, el('p', '', meta.full_name + ' does not carry the topic symphony, so Symphony is not set up on it yet. Two steps, on GitHub:'));
      var ol = el('ol');
      add(ol, add(el('li'), link(installLink(meta), 'Install SymphonyBoard on ' + meta.full_name), ' (the page comes with this one repository selected; it sends you on to Symphony Setup\'s install page, then to the form).'));
      add(ol, add(el('li'), 'On ', link(FORM_URL, 'the form'), ', press Create: the pull request lands within about two minutes and merges unless you asked to review it. Then come back here and press Add again.'));
      add(box, ol);
      add(box, btn('Add it to the list anyway', true, function () { clear(box); closeDialog('dlg-repos'); loadRepo(meta.full_name); }));
    }).catch(function (e) {
      if (e.status !== 404 || !signedInByApp()) { say(e.message, true); add(box, el('p', 'admin__warn', e.message)); return; }
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
  /* ---------- the repository picker: every repository the App or the token reaches ---------- */
  // Signed in through GitHub, the page lists each installation of SymphonyBoard the person can see
  // and the repositories it is installed on, grouped by account, as GitHub's own App pages do; with
  // a pasted token it lists what the token reaches. Nothing is typed unless the person wants to:
  // the search narrows the list, and a whole OWNER/NAME opens a repository the list does not hold.
  var picker = { token: null, groups: null, reading: null };
  function ghListOf(path, key, pages) {
    var out = [];
    function step(p, left) {
      return gh('GET', p).then(function (r) {
        var items = r.data && Array.isArray(r.data[key]) ? r.data[key] : [];
        out = out.concat(items);
        var n = nextPage(r.headers);
        if (n && left <= 1) { out.more = true; return out; }
        return n ? step(n, left - 1) : out;
      });
    }
    return step(path, pages || 3);
  }
  function pickerGroups() {
    if (!signedInByApp()) {
      return ghList('/user/repos?per_page=100&sort=pushed', 3).then(function (list) {
        return [{ account: 'Repositories this token reaches', kind: '', settings: '', repos: list, more: !!list.more }];
      });
    }
    return ghListOf('/user/installations?per_page=100', 'installations', 2).then(function (installs) {
      return Promise.all(installs.map(function (inst) {
        return ghListOf('/user/installations/' + inst.id + '/repositories?per_page=100', 'repositories', 3).then(function (list) {
          var account = inst.account || {};
          return { account: account.login || 'An account', kind: account.type === 'Organization' ? 'Organization' : 'Personal account', settings: inst.html_url || '', repos: list, more: !!list.more };
        });
      }));
    });
  }
  // every open reads the list again, since the person may have installed the App on more since;
  // the list kept from the last read is drawn meanwhile
  function pickerRead() {
    if (picker.token === token && picker.reading) return picker.reading;
    var mine = token;
    if (picker.token !== mine) picker = { token: mine, groups: null, reading: null };
    picker.reading = pickerGroups().then(function (groups) {
      if (picker.token !== mine) return null;
      groups.forEach(function (g) { g.repos.sort(function (a, b) { return String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')); }); });
      picker.groups = groups;
      picker.reading = null;
      return groups;
    }, function (e) { if (picker.token === mine) picker.reading = null; throw e; });
    return picker.reading;
  }
  function pickerOpen() {
    $('cp-add-name').value = '';
    clear($('cp-add-answer'));
    $('rp-state').textContent = 'Reading the repositories ' + (signedInByApp() ? 'SymphonyBoard is installed on' : 'this token reaches') + '...';
    pickerDraw();
    pickerRead().then(function (groups) {
      if (!groups) { $('rp-state').textContent = 'The sign-in changed while GitHub answered; close this and press + Add repository again.'; return; }
      var count = groups.reduce(function (n, g) { return n + g.repos.length; }, 0);
      $('rp-state').textContent = count
        ? plural(count, 'repository', 'repositories') + (signedInByApp() ? ' SymphonyBoard is installed on, ' + plural(groups.length, 'account') : ' this token reaches') + '. Press one to open it.'
        : (signedInByApp() ? 'SymphonyBoard is installed on no repository you can see yet: install it with the button below.' : 'This token reaches no repository; a fine-grained token lists only the repositories it was made for.');
      pickerDraw();
    }).catch(function (e) { $('rp-state').textContent = 'GitHub did not list them: ' + e.message + ' Type OWNER/NAME above to open one by name.'; });
    setTimeout(function () { $('cp-add-name').focus(); }, 0);
  }
  function pickerMatches(repo, q) {
    if (!q) return true;
    return (repo.full_name + ' ' + (repo.description || '')).toLowerCase().indexOf(q) >= 0;
  }
  function pickerDraw() {
    var box = $('rp-list');
    clear(box);
    var q = ($('cp-add-name').value || '').trim().toLowerCase();
    var listed = repos();
    var shownAny = false;
    // what is on this browser's list comes first, so the usual ones are a press away even before GitHub answers
    var seen = {};
    (picker.groups || []).forEach(function (g) { g.repos.forEach(function (r) { seen[r.full_name] = r; }); });
    var mine = listed.filter(function (n) { return pickerMatches(seen[n] || { full_name: n }, q); });
    if (mine.length) {
      shownAny = true;
      add(box, el('h4', 'repos__h', 'On your list'));
      var ul = el('div', 'repos__list');
      mine.forEach(function (n) { add(ul, pickerCard(seen[n] || { full_name: n }, true)); });
      add(box, ul);
    }
    (picker.groups || []).forEach(function (g) {
      var rest = g.repos.filter(function (r) { return listed.indexOf(r.full_name) < 0 && pickerMatches(r, q); });
      if (!rest.length && q) return;
      shownAny = true;
      var h = add(el('h4', 'repos__h'), g.account, g.kind ? el('span', 'repos__kind', g.kind) : null);
      if (g.settings) add(h, link(g.settings, 'Choose which repositories'));
      add(box, h);
      var list = el('div', 'repos__list');
      rest.forEach(function (r) { add(list, pickerCard(r, false)); });
      if (!rest.length) add(list, el('p', 'admin__none', 'Every repository here is on your list already.'));
      add(box, list);
      if (g.more) add(box, el('p', 'admin__none', (signedInByApp() ? 'Only the first 300 GitHub lists are here' : 'Only the 300 most recently pushed are here') + '; type OWNER/NAME for another.'));
    });
    if (!shownAny && q) add(box, el('p', 'admin__none', REPOSITORY.test(q) ? 'Not in the list: press Open to read ' + q + ' by name.' : 'Nothing matches "' + q + '".'));
  }
  function pickerCard(r, listed) {
    var adopted = !!(r.topics && r.topics.indexOf(TOPIC) >= 0);
    var card = el('div', 'repos__card' + (r.full_name === state.repo ? ' repos__card--on' : ''));
    card.setAttribute('data-repo', r.full_name);
    var cut = r.full_name.indexOf('/') + 1;
    var name = add(el('button', 'repos__name'), el('span', 'repos__owner', r.full_name.slice(0, cut)), el('b', '', r.full_name.slice(cut)));
    name.type = 'button';
    name.setAttribute('aria-label', 'Open ' + r.full_name);
    var tags = el('p', 'repos__tags');
    if (r.topics) add(tags, el('span', 'repos__tag' + (adopted ? ' repos__tag--on' : ''), adopted ? 'Symphony set up' : 'Not set up yet'));
    if (r.private != null) add(tags, el('span', 'repos__tag', r.private ? 'Private' : 'Public'));
    if (r.full_name === state.repo) add(tags, el('span', 'repos__tag repos__tag--now', 'Showing'));
    if (r.pushed_at) add(tags, add(el('span', 'repos__when'), 'pushed ', timeEl(r.pushed_at)));
    add(card, name, tags);
    if (r.description) add(card, el('p', 'repos__about', r.description));
    if (listed) {
      var x = el('button', 'card__x repos__x', '×');
      x.type = 'button';
      x.title = 'Take ' + r.full_name + ' off your list';
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', function (ev) { ev.stopPropagation(); forgetRepo(r.full_name); pickerDraw(); });
      add(card, x);
    }
    function choose() {
      if (adopted || listed || !r.topics) { closeDialog('dlg-repos'); if (r.full_name !== state.repo) loadRepo(r.full_name); return; }
      addRepository(r.full_name);
    }
    card.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('a, button') && !ev.target.closest('.repos__name')) return; choose(); });
    return card;
  }
  // Open, or Enter in the search: a whole name is read by name; otherwise the first card shown opens
  function pickerOpenTyped() {
    var typed = ($('cp-add-name').value || '').trim();
    var cards = Array.prototype.slice.call($('rp-list').querySelectorAll('.repos__card'));
    var exact = cards.filter(function (c) { return typed && c.getAttribute('data-repo').toLowerCase() === typed.toLowerCase(); })[0];
    if (exact) { exact.click(); return; }
    if (REPOSITORY.test(typed)) { addRepository(typed); return; }
    if (cards.length) { cards[0].click(); return; }
    say(typed ? 'Nothing matches "' + typed + '"; type the whole OWNER/NAME to open it by name.' : 'Type a name, or press a repository.', true);
  }
  function forgetRepo(name) {
    saveRepos(repos().filter(function (n) { return n !== name; }));
    if (readKey(KEY_REPO) === name) dropKey(KEY_REPO);
    say(name + ' is off your list.');
    if (state.repo !== name) { fillRepoSelect($('cp-repo'), state.repo); return; }
    var next = repos()[0];
    if (next) loadRepo(next);
    else { state = emptyState(''); fillRepoSelect($('cp-repo'), ''); $('cp-summary').textContent = 'No repository listed. Press + Add repository in the side column to pick one.'; graphReset(GRAPH_NO_REPOSITORY); }
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
  // the task dialog, empty from + Add task, or filled with the words the assistant drafted
  function openTaskDialog(title, goal) {
    if (title || goal) {
      $('cp-task-title').value = title || '';
      $('cp-task-goal').value = goal || '';
    }
    // the task lands in the Tasks tab, so the dialog opens over it
    showTab('tasks');
    openDialog('dlg-task');
    (title ? $('cp-task-goal') : $('cp-task-title')).focus();
  }
  function taskFields() {
    var title = ($('cp-task-title').value || '').trim();
    var goal = ($('cp-task-goal').value || '').trim();
    return {
      title: title || goal.split('\n')[0].slice(0, 100),
      goal: goal,
      acceptance: ($('cp-task-acceptance').value || '').trim() || 'The goal above holds and bash scripts/check.sh passes.',
      files: ($('cp-task-files').value || '').trim()
    };
  }
  function clearTask() {
    ['cp-task-title', 'cp-task-goal', 'cp-task-acceptance', 'cp-task-files'].forEach(function (id) { $(id).value = ''; });
    closeDialog('dlg-task');
  }
  function queueTask() {
    var t = taskFields();
    if (!t.title || !t.goal) { say('A task needs a title and what is true when it is done.', true); return; }
    var s = state;
    say('Queueing the task...');
    var done = hold('cp-task-queue');
    gh('POST', '/repos/' + s.repo + '/issues', {
      title: /^Task: /.test(t.title) ? t.title : 'Task: ' + t.title,
      body: formBody([['Goal', t.goal], ['Acceptance', t.acceptance], ['Files likely touched', t.files]]),
      labels: ['todo']
    }).then(function (r) {
      done();
      say(queuedWords(r.data));
      clearTask();
      if (!stale(s)) return loadIssues(s);
    }).catch(function (e) { done(); say(e.message, true); });
  }
  // the same words as an issue that mentions @claude, which the repository's Claude workflow
  // answers at once on the repository's own token, in place of waiting for a worker
  function askTask() {
    var t = taskFields();
    if (!t.goal && !t.title) { say('Write what Claude should do first.', true); return; }
    var text = t.goal || t.title;
    var extra = ($('cp-task-acceptance').value || '').trim() ? '\n\nDone when: ' + t.acceptance : '';
    if (t.files) extra += '\n\nFiles likely touched:\n' + t.files;
    var s = state;
    say('Sending...');
    var done = hold('cp-task-ask');
    gh('POST', '/repos/' + s.repo + '/issues', { title: t.title.replace(/^@claude\s*/i, '') || 'From the control panel', body: (/@claude/i.test(text) ? '' : '@claude ') + text + extra }).then(function (r) {
      done();
      say('Opened #' + r.data.number + '; the Claude workflow answers there on the repository\'s own Claude token.');
      clearTask();
      if (!stale(s)) return loadIssues(s);
    }).catch(function (e) { done(); say(e.message, true); });
  }

  /* ---------- workers: add by the "Add a worker" issue, change or remove by pull request ---------- */
  var WORKER_RUNS = ['actions', 'routine', 'session'];
  var WORKER_LANDS = ['owner', 'auto-merge'];
  var workerEditing = null;
  // the dialog empty for + Add worker, or filled with a worker's settings for its gear
  function workerDialog(w) {
    workerEditing = w;
    var set = function (id, v) { $(id).value = v == null ? '' : String(v); };
    $('dlg-worker-h').textContent = w ? 'Change ' + w.name : 'Add a worker';
    $('cp-w-add').textContent = w ? 'Propose the change' : '+ Add the worker';
    $('cp-w-name').readOnly = !!w;
    set('cp-w-name', w ? w.name : '');
    set('cp-w-about', w ? w.about : '');
    set('cp-w-model', w ? w.model : '');
    set('cp-w-turns', w && w.max_turns != null ? w.max_turns : '');
    set('cp-w-rounds', w && w.rounds != null ? w.rounds : '');
    set('cp-w-area', w ? (Array.isArray(w.area) ? w.area.join('\n') : w.area || '') : '');
    set('cp-w-account', w ? w.account : '');
    $('cp-w-runs').selectedIndex = Math.max(0, WORKER_RUNS.indexOf(w ? w.runs : 'actions'));
    $('cp-w-lands').selectedIndex = Math.max(0, WORKER_LANDS.indexOf(w ? w.lands : 'owner'));
    ['cp-w-runs', 'cp-w-lands'].forEach(function (id) { $(id).dispatchEvent(new Event('change', { bubbles: true })); });
    // a change shows every setting; a new worker keeps the rarer ones folded
    $('dlg-worker').querySelector('details').open = !!w;
    (w ? $('cp-w-about') : $('cp-w-name')).focus();
  }
  function addWorker() {
    if (workerEditing) { changeWorker(workerEditing); return; }
    var name = ($('cp-w-name').value || '').trim();
    if (!WORKER_NAME.test(name)) { say('A worker\'s name is lower-case letters, digits and inner dashes, up to 39.', true); return; }
    var runs = $('cp-w-runs').value;
    var lands = $('cp-w-lands').value;
    say('Opening the "Add a worker" issue...');
    var done = hold('cp-w-add');
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
      done();
      $('cp-w-name').value = '';
      closeDialog('dlg-worker');
    }).catch(function (e) { done(); say(e.message, true); });
  }
  // the worker's file as the registry writes it (sdlc_protocol.workers.Worker.to_json): every
  // field, in its order, two spaces of indent; the pull request's required check reads it again
  function workerFileText(w) {
    var number = function (id, fallback) { var v = ($(id).value || '').trim(); return v === '' ? fallback : Number(v); };
    var data = {
      name: w.name,
      runs: WORKER_RUNS[$('cp-w-runs').selectedIndex] || w.runs,
      about: ($('cp-w-about').value || '').trim(),
      area: ($('cp-w-area').value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean),
      lands: WORKER_LANDS[$('cp-w-lands').selectedIndex] || w.lands,
      model: ($('cp-w-model').value || '').trim(),
      max_turns: number('cp-w-turns', 80),
      rounds: number('cp-w-rounds', 6),
      account: ($('cp-w-account').value || '').trim()
    };
    if (!(data.max_turns >= 1 && data.max_turns <= 500 && data.max_turns % 1 === 0)) throw new Error('Turns a run is a whole number from 1 to 500.');
    if (!(data.rounds >= 1 && data.rounds <= 50 && data.rounds % 1 === 0)) throw new Error('Rounds is a whole number from 1 to 50.');
    return JSON.stringify(data, null, 2) + '\n';
  }
  function workerPath(w) { return '.github/symphony/workers/' + w.name + '.json'; }
  function changeWorker(w) {
    var text;
    try { text = workerFileText(w); } catch (e) { say(e.message, true); return; }
    var s = state;
    say('Opening the pull request that changes ' + w.name + '...');
    var done = hold('cp-w-add');
    proposeFiles(s.repo, 'symphony/worker-' + w.name, 'Change the worker ' + w.name, 'The control panel\'s Workers tab: new settings for the worker ' + w.name + ' (' + workerPath(w) + '). The required check reads the file again before it can merge.', [{ path: workerPath(w), text: text }])
      .then(function (pr) { done(); closeDialog('dlg-worker'); say(proposedWords('Changing ' + w.name, pr)); })
      .catch(function (e) { done(); say('The change to ' + w.name + ' stopped: ' + e.message, true); });
  }
  function removeWorker(w, button) {
    if (!window.confirm('Remove the worker ' + w.name + '? This opens a pull request that deletes ' + workerPath(w) + '; it stops taking work once that merges. Issues given to it keep their label until you give them to another.')) return;
    var s = state;
    button.disabled = true;
    say('Opening the pull request that removes ' + w.name + '...');
    proposeFiles(s.repo, 'symphony/remove-worker-' + w.name, 'Remove the worker ' + w.name, 'The control panel\'s Workers tab: removes the worker ' + w.name + ' (' + workerPath(w) + ').', [{ path: workerPath(w), text: null }])
      .then(function (pr) { button.disabled = false; say(proposedWords('Removing ' + w.name, pr)); })
      .catch(function (e) { button.disabled = false; say('The removal of ' + w.name + ' stopped: ' + e.message, true); });
  }
  function workerStatus(w) {
    var form = itemDialog(w.name);
    var where = { actions: 'In GitHub Actions, on this repository\'s Claude token', routine: 'A routine on someone\'s Claude account', session: 'A person\'s own sessions' }[w.runs] || (w.runs || 'not set');
    add(form, fact('Runs:', where + '.'));
    if (w.about) add(form, fact('For:', w.about));
    add(form, fact('Area:', Array.isArray(w.area) && w.area.length ? w.area.join(', ') : 'anywhere'));
    add(form, fact('Lands:', w.lands === 'auto-merge' ? 'GitHub merges each pull request once the check is green.' : 'The owner merges each pull request.'));
    if (w.runs === 'actions') add(form, fact('Each run:', 'model ' + (w.model || 'the default') + ', ' + (w.max_turns != null ? w.max_turns : 80) + ' turns, ' + (w.rounds != null ? w.rounds : 6) + ' rounds in a row.'));
    var held = (state.issues || []).filter(function (it) { return !it.pull_request && workerOf(labelsOf(it)) === w.name; });
    var list = el('ul', 'cpdlg__list');
    held.forEach(function (it) { add(list, add(el('li'), link(it.html_url, '#' + it.number), ' ' + it.title + ' (' + issueGroupWord(it).toLowerCase() + ')')); });
    add(form, fact('Its issues:', held.length ? plural(held.length, 'open issue') : 'none open.'));
    if (held.length) add(form, list);
    var bar = el('p', 'tkdlg__bar');
    add(bar, btn('⚙ Settings', false, function () { closeDialog('dlg-item'); openDialog('dlg-worker'); workerDialog(w); }),
      link('https://github.com/' + state.repo + '/blob/' + ((state.meta && state.meta.default_branch) || 'main') + '/' + workerPath(w), 'Its file on GitHub'));
    add(form, bar);
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
  // scrollIntoView moves every box around the node, the window too, which would carry the header and
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
    return Array.prototype.filter.call(t.querySelectorAll('tbody tr:not(.card--add)'), function (tr) { return !tr.querySelector(':scope > td.admin__none'); }).length;
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
    if (!box) return;
    // the task board lays its lists side by side, so the jump is sideways there
    if (box.classList.contains('console__kanban') && getComputedStyle(box).display === 'grid') {
      box.scrollLeft = head.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
      head.classList.remove('console__flash');
      void head.offsetWidth;
      head.classList.add('console__flash');
    } else box.scrollTop = head.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  }
  // a message that arrives, or changes, flashes the line at the deck's foot; emptying it does not.
  // say() replaces className, so the flash class is put back after it rather than kept
  function initFlash() {
    var m = $('msg');
    if (!m || !window.MutationObserver) return;
    var last = '';
    new MutationObserver(function () {
      var text = m.textContent;
      if (!text || text === last) { last = text; return; }
      last = text;
      m.classList.remove('console__flash');
      void m.offsetWidth;
      m.classList.add('console__flash');
    }).observe(m, { childList: true, characterData: true, subtree: true });
    m.addEventListener('animationend', function () { m.classList.remove('console__flash'); });
  }
  // full screen is the browser's own (F11, or the Fullscreen API from the button): the site's bar
  // is hidden while it holds, and the deck measured again
  function inFullScreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    // F11 makes the browser full screen without the API; Chrome and Firefox say so through display-mode
    return !!(window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
  }
  function syncFullScreen() {
    var on = inFullScreen();
    document.body.classList.toggle('console-full', on);
    if ($('cp-full')) {
      $('cp-full').setAttribute('aria-pressed', on ? 'true' : 'false');
      $('cp-full').querySelector('.console__fullword').textContent = on ? 'Leave' : 'Full screen';
    }
    fitConsole();
  }
  function initFullScreen() {
    var b = $('cp-full');
    if (b) b.addEventListener('click', function () {
      var root = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (inFullScreen()) {
        say('The browser itself is full screen: press F11 (on a Mac, Control-Command-F) to leave it.');
      } else if (root.requestFullscreen || root.webkitRequestFullscreen) {
        var asked = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        if (asked && asked.catch) asked.catch(function () { say('The browser would not go full screen here; press F11 instead.', true); });
      } else {
        say('This browser has no full screen for a page; press F11 instead.', true);
      }
    });
    document.addEventListener('fullscreenchange', syncFullScreen);
    document.addEventListener('webkitfullscreenchange', syncFullScreen);
    window.addEventListener('resize', syncFullScreen);
    syncFullScreen();
  }
  // the worker's tiles set the select each group names; a select set any other way lights its tile
  function initTiles() {
    Array.prototype.forEach.call(document.querySelectorAll('.wtiles[data-for]'), function (group) {
      var select = $(group.getAttribute('data-for'));
      if (!select) return;
      var tiles = group.querySelectorAll('.wtile');
      function light() {
        Array.prototype.forEach.call(tiles, function (t) { t.setAttribute('aria-pressed', Number(t.getAttribute('data-index')) === select.selectedIndex ? 'true' : 'false'); });
      }
      Array.prototype.forEach.call(tiles, function (t) {
        t.addEventListener('click', function () { select.selectedIndex = Number(t.getAttribute('data-index')); select.dispatchEvent(new Event('change', { bubbles: true })); });
      });
      select.addEventListener('change', light);
      light();
    });
  }
  /* ---------- the layout the person sets: sizes and the text size, kept in this browser ---------- */
  // Each grip (an element with data-split) sizes one part of the console as the person drags it, and
  // A- and A+ scale the console's text with its buttons and boxes, through CSS zoom, so the whole
  // deck grows or shrinks as one. The numbers are kept in this browser's localStorage under one key,
  // read once when the page opens; a double-click on a grip, or 100%, puts that part back. Nothing
  // but these numbers is kept, and nothing is sent anywhere.
  var KEY_LAYOUT = 'symphony_panel_layout';
  // prop: the custom property on #console that CSS sizes the part by; sign: whether dragging right
  // (or down) grows the part (+1) or shrinks it (-1); measure: the part's size now, in CSS pixels
  var LAYOUT_PARTS = {
    side: { prop: '--side-w', min: 150, max: 520, axis: 'x', sign: 1, measure: function () { return $('console').querySelector('.console__side').offsetWidth; } },
    col: { prop: '--col-w', min: 170, max: 720, axis: 'x', sign: 1, measure: function (grip) { return grip.closest('h3').offsetWidth; } },
    tkside: { prop: '--tkside-w', min: 220, max: 760, axis: 'x', sign: -1, measure: function () { return $('tk-side').offsetWidth; } },
    drawer: { prop: '--drawer-h', min: 120, max: 1600, axis: 'y', sign: -1, measure: function () { return $('cp-as-drawer').offsetHeight; } }
  };
  var ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7];
  var layout = {};
  function readLayout() {
    var kept = {};
    try { kept = JSON.parse(localStorage.getItem(KEY_LAYOUT) || '{}'); } catch (e) { kept = {}; }
    var clean = {};
    if (!kept || typeof kept !== 'object') return clean;
    Object.keys(LAYOUT_PARTS).forEach(function (k) {
      var v = kept[k], p = LAYOUT_PARTS[k];
      if (typeof v === 'number' && v >= p.min && v <= p.max) clean[k] = Math.round(v);
    });
    if (ZOOM_STEPS.indexOf(kept.zoom) >= 0) clean.zoom = kept.zoom;
    return clean;
  }
  function saveLayout() {
    try {
      if (Object.keys(layout).length) localStorage.setItem(KEY_LAYOUT, JSON.stringify(layout));
      else localStorage.removeItem(KEY_LAYOUT);
    } catch (e) { /* storage refused: the sizes last while the page is open */ }
  }
  function zoomOf() { return layout.zoom || 1; }
  function applyLayout() {
    var c = $('console');
    if (!c) return;
    Object.keys(LAYOUT_PARTS).forEach(function (k) {
      if (layout[k] != null) c.style.setProperty(LAYOUT_PARTS[k].prop, layout[k] + 'px');
      else c.style.removeProperty(LAYOUT_PARTS[k].prop);
    });
    // the answer keeps its usual cap until the person sizes it, and may then take the stage
    if (layout.drawer != null) c.style.setProperty('--drawer-max', 'calc(100% - 16px)');
    else c.style.removeProperty('--drawer-max');
    c.style.setProperty('--console-zoom', String(zoomOf()));
    if ($('cp-zoom-reset')) $('cp-zoom-reset').textContent = Math.round(zoomOf() * 100) + '%';
  }
  // a grip made by the script, for a part the script draws (a token's panel, Claude's answer)
  function splitGrip(part, what) {
    var g = el('div', 'console__split console__split--edge console__split--' + part);
    g.setAttribute('data-split', part);
    g.setAttribute('role', 'separator');
    g.setAttribute('aria-orientation', LAYOUT_PARTS[part].axis === 'x' ? 'vertical' : 'horizontal');
    g.setAttribute('aria-label', 'Drag to size ' + what + '; double-click to reset');
    g.tabIndex = 0;
    return g;
  }
  function setPart(part, px) {
    var p = LAYOUT_PARTS[part];
    layout[part] = Math.round(Math.min(p.max, Math.max(p.min, px)));
    applyLayout();
  }
  function stepZoom(step) {
    var at = ZOOM_STEPS.indexOf(zoomOf());
    var next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (at < 0 ? 3 : at) + step))];
    if (next === 1) delete layout.zoom; else layout.zoom = next;
    applyLayout();
    saveLayout();
    fitConsole();
  }
  function initLayout() {
    var c = $('console');
    layout = readLayout();
    applyLayout();
    if ($('cp-zoom-down')) $('cp-zoom-down').addEventListener('click', function () { stepZoom(-1); });
    if ($('cp-zoom-up')) $('cp-zoom-up').addEventListener('click', function () { stepZoom(1); });
    if ($('cp-zoom-reset')) $('cp-zoom-reset').addEventListener('click', function () { stepZoom(0 - ZOOM_STEPS.indexOf(zoomOf()) + 3); });
    // one listener on the console serves every grip, those the script draws later among them
    c.addEventListener('pointerdown', function (e) {
      var grip = e.target && e.target.closest ? e.target.closest('[data-split]') : null;
      if (!grip || e.button !== 0) return;
      var part = grip.getAttribute('data-split'), p = LAYOUT_PARTS[part];
      if (!p) return;
      e.preventDefault();
      var start = p.measure(grip), from = p.axis === 'x' ? e.clientX : e.clientY;
      // the pointer moves in the window's pixels; the part is sized in the zoomed console's
      var scale = zoomOf();
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('console-dragging', 'console-dragging--' + p.axis);
      function move(ev) { setPart(part, start + p.sign * ((p.axis === 'x' ? ev.clientX : ev.clientY) - from) / scale); }
      // the grip may be drawn again mid-drag (the Tokens tab redraws its panel as readings land), so
      // a lost capture ends the drag as a release does
      var done = false;
      function up() {
        if (done) return;
        done = true;
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.removeEventListener('lostpointercapture', up);
        document.body.classList.remove('console-dragging', 'console-dragging--' + p.axis);
        saveLayout();
      }
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
      grip.addEventListener('lostpointercapture', up);
    });
    c.addEventListener('dblclick', function (e) {
      var grip = e.target && e.target.closest ? e.target.closest('[data-split]') : null;
      if (!grip || !LAYOUT_PARTS[grip.getAttribute('data-split')]) return;
      delete layout[grip.getAttribute('data-split')];
      applyLayout();
      saveLayout();
    });
    // the arrow keys move a focused grip, so the sizes are set without a mouse too
    c.addEventListener('keydown', function (e) {
      var grip = e.target && e.target.getAttribute ? e.target : null;
      var part = grip && grip.getAttribute('data-split'), p = part && LAYOUT_PARTS[part];
      if (!p) return;
      var keys = p.axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      setPart(part, p.measure(grip) + p.sign * keys[e.key] * 16);
      saveLayout();
    });
  }

  function initConsole() {
    var c = $('console');
    if (!c) return;
    initFlash();
    initFullScreen();
    initTiles();
    initLayout();
    // the deck's foot holds the page's message; Clear empties it
    // Clear leaves a step the person is in the middle of (the code box of Add a Claude account)
    if ($('cp-msg-close')) $('cp-msg-close').addEventListener('click', function () {
      if ($('msg').querySelector('input:not(:disabled)')) return;
      clear($('msg'));
      $('msg').className = 'admin__box';
    });
    fitConsole();
    window.addEventListener('resize', fitConsole);
    window.addEventListener('load', fitConsole);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitConsole);
    showTab(location.hash.slice(1));
    window.addEventListener('hashchange', function () {
      var name = location.hash.slice(1);
      // #repos was the Repositories tab before the picker took its place
      if (name === 'repos') { if (!$('cp-app').classList.contains('hidden')) openDialog('dlg-repos'); return; }
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
      var b = e.target && e.target.closest ? e.target.closest('[data-goto],[data-jump],[data-press],[data-open],[data-focus]') : null;
      if (!b || b.getAttribute('role') === 'tab') return;
      if (b.hasAttribute('data-press')) {
        var target = $(b.getAttribute('data-press'));
        if (target && !target.disabled) target.click();
        return;
      }
      if (b.hasAttribute('data-goto')) showTab(b.getAttribute('data-goto'));
      if (b.hasAttribute('data-jump')) jumpTo(b.getAttribute('data-jump'));
      if (b.hasAttribute('data-open')) openDialog(b.getAttribute('data-open'));
      var f = b.getAttribute('data-focus');
      // the bar is hidden in a repository without the assistant: then a task asks @claude instead
      if (f === 'cp-as-q' && $('cp-as-box') && $('cp-as-box').classList.contains('hidden')) { openTaskDialog(); $('cp-task-ask').focus(); say('This repository has no assistant yet, so Claude is asked by an issue: write what it should do and press Ask @claude now.'); return; }
      if (f && $(f)) $(f).focus();
    });
    var pending = 0;
    function later() { if (!pending) pending = setTimeout(function () { pending = 0; countConsole(); }, 60); }
    if (window.MutationObserver && $('cp-app')) new MutationObserver(later).observe($('cp-app'), { childList: true, subtree: true });
    var summaryNode = $('cp-summary');
    if (window.MutationObserver && summaryNode) new MutationObserver(later).observe(summaryNode, { characterData: true, childList: true, subtree: true });
  }

  // Enter in a dialog's one-line box presses the dialog's own primary button: the form's implicit
  // submission would otherwise press Cancel, its only submit button, and close it with nothing sent
  function wireDialogEnter() {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || ev.defaultPrevented || ev.isComposing) return;
      var t = ev.target;
      if (!t || t.tagName !== 'INPUT' || !t.closest) return;
      var d = t.closest('dialog.cpdlg');
      if (!d) return;
      ev.preventDefault();
      var go = d.querySelector('button.console__primary:not([disabled])');
      if (go) go.click();
    });
  }
  function initPanel() {
    wireDialogEnter();
    wireGate(function () { enter(start); });
    watchOtherTabs();
    $('cp-signout').addEventListener('click', signOut);
    $('cp-refresh').addEventListener('click', function () { if (state.repo) loadRepo(state.repo); });
    $('cp-repo').addEventListener('change', function () { if ($('cp-repo').value) loadRepo($('cp-repo').value); });
    $('cp-add').addEventListener('click', pickerOpenTyped);
    $('cp-add-name').addEventListener('input', pickerDraw);
    $('cp-add-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pickerOpenTyped(); } });
    $('cp-task-queue').addEventListener('click', queueTask);
    $('cp-task-ask').addEventListener('click', askTask);
    $('cp-w-add').addEventListener('click', addWorker);
    $('cp-a-import').addEventListener('click', importAgent);
    $('cp-run-workers').addEventListener('click', function () { dispatch('workers.yml', 'the workers'); });
    $('cp-run-board').addEventListener('click', function () { dispatch('board.yml', 'the board'); });
    $('cp-run-ci').addEventListener('click', function () { dispatch('ci.yml', 'the checks'); });
    $('cp-run-metrics').addEventListener('click', function () { dispatch('metrics.yml', 'the metrics'); });
    initAssistant();
    initGraph();

    function start() {
      // a sign-in, perhaps as someone else, reads the Tokens tab again rather than show the last one's
      tokensFor = null;
      foldersFor = null;
      // a drive connected under another account than the one GitHub names now is dropped here,
      // and one connected before any was named is bound to this one
      heldDrive();
      var name = chosenRepo();
      fillRepoSelect($('cp-repo'), name);
      // the picker opens by itself where nothing is listed, but not over the Folders tab, which needs no repository
      if (location.hash === '#repos' || (!name && consoleTab !== 'folders')) setTimeout(function () { openDialog('dlg-repos'); }, 0);
      if (name) loadRepo(name);
      else {
        $('cp-summary').textContent = 'No repository listed yet. Press + Add repository in the side column to pick one.';
        graphReset(GRAPH_NO_REPOSITORY);
        // the Folders tab needs no repository to connect a drive or make one
        if (consoleTab === 'folders' && consoleOnOpen.folders) consoleOnOpen.folders();
      }
    }
    // A drive's return comes back to this page as GitHub's does, so it is read first, and in order:
    // the drive's code is exchanged at the sign-in service, which needs no GitHub token; then the
    // GitHub sign-in is restored from storage, finishOauth finding no code left; then the console
    // opens for the account GitHub names, or the sign-in box stands where none is restored; and
    // last the Folders tab opens, whatever came of the drive's return, so it reads the repository
    // the bar has chosen with the sign-in in place and says what is next.
    var fromDrive = false;
    ($('fd-connect') ? driveReturn() : Promise.resolve(false)).then(function (back) { fromDrive = back; return finishOauth(); }).then(function () {
      if (!loadToken()) { showGate(); if (fromDrive) showTab('folders'); return; }
      return enter(start).then(function () { if (fromDrive) showTab('folders'); });
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
  // once that header opens it. The page executes by itself only the lines of the fenced block the
  // answer may end with that read what the page already shows; a line that would change something
  // is offered as a button that presses the panel's own button for it, as the person, so nothing
  // here writes to the repository but the label, the issue and the comments, each on a press, and
  // what the person presses. The assistant is the Ask Claude bar at the console's foot, on every
  // tab, and its answer opens in a drawer above the bar.
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
  var ASSISTANT_TABLES = { 'cp-queue': 'Queue', 'cp-given': 'Given to workers', 'cp-claimed': 'Claimed', 'cp-review': 'In review', 'cp-blocked': 'Blocked, and blockers', 'cp-epics': 'Epics and goals' };
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
    assistantDrawer(false);
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
    assistantDrawer(false);
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
    // the symphony block is the page's to act on, shown as the actions above the answer, not as code
    // the same block assistantBlock reads, so what is hidden is exactly what is acted on
    box.innerHTML = markdown(body.replace(/\r/g, '').replace(/<img\b[^>]*>/gi, '').replace(ASSISTANT_BLOCK, '$1'));
    assistantDrawer(true);
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
  var ASSISTANT_BLOCK = /(^|\n)```symphony[ \t]*\n([\s\S]*?)\n[ \t]*```/;
  function assistantBlock(body) {
    var m = ASSISTANT_BLOCK.exec(String(body).replace(/\r/g, ''));
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
      else if ((m = /^tab\s+([a-z]{1,20})$/i.exec(line))) said = assistantTab(m[1].toLowerCase());
      else if ((m = /^run\s+(workers|board|checks|metrics)$/i.exec(line))) said = assistantRunOffer(m[1].toLowerCase());
      else if ((m = /^give\s+#([0-9]{1,9})\s+to\s+([a-z0-9-]{1,39})$/i.exec(line))) said = assistantGiveOffer(Number(m[1]), m[2].toLowerCase());
      else if ((m = /^merge\s+#([0-9]{1,9})$/i.exec(line))) said = assistantMergeOffer(Number(m[1]));
      else if ((m = /^task:?\s+(.{1,200})$/i.exec(line))) said = assistantTaskOffer(m[1].trim());
      else if ((m = /^ask(?:\s+#([0-9]{1,9}))?\s*:?\s+(.{1,2000})$/i.exec(line))) said = assistantAskOffer(m[1] || '', m[2].trim());
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
    // the task tables alone: the Pull requests tab's rows carry data-number too, for "merge #N"
    var rows = document.querySelectorAll(CONSOLE_TASK_TABLES.map(function (id) { return '#' + id + ' tbody tr[data-number]'; }).join(','));
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
  // the Dependencies tab is the page's own, drawn from GitHub as the person, and opens at its first
  // chart; the other sections are the board's, in the Board tab
  function assistantShowSection(key) {
    var name = ASSISTANT_SECTIONS[key];
    if (key === 'dependencies') {
      var heading = $('h-dependencies'), charts = $('cp-graph').closest('.console__scroll');
      assistant.section = name;
      revealTab(heading);
      graphShowFirst();
      scrollInDeck(heading, { block: 'start' });
      if (charts) charts.scrollTop = 0;
      return 'Showing the Dependencies tab, which this page draws.';
    }
    var hs = $('cp-board').querySelectorAll('h2,h3,h4,h5,h6');
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].textContent.trim().toLowerCase().indexOf(name.toLowerCase()) === 0) {
        assistant.section = name;
        revealTab(hs[i]);
        scrollInDeck(hs[i], { block: 'start' });
        return 'Showing the board\'s ' + name + ' section.';
      }
    }
    return 'The board has no ' + name + ' section yet.';
  }
  // A tab the answer names opens, as a rail button would; only the rail's own tabs
  function assistantTab(name) {
    // a repository's assistant prompt from before the + style still names the two tabs it replaced
    if (name === 'repos') { openDialog('dlg-repos'); return 'Opened the repositories.'; }
    if (name === 'ask') { openTaskDialog(); return 'Opened Add a task, where Ask @claude now asks Claude.'; }
    var tab = consoleTabs().filter(function (t) { return t.getAttribute('data-tab') === name; })[0];
    if (!tab) return 'Not acted on: the panel has no tab "' + name + '".';
    showTab(name);
    return 'Opened the ' + tab.textContent.replace(/[0-9]+$/, '').replace(/^\W+/, '').trim() + ' tab.';
  }

  // The lines that would change the repository or fill a form are offered, never run: each is a
  // button that says what it does and, on a press, runs the panel's own handler for the same thing,
  // as the person signed in, once. Claude's answer can be steered by any text it read (an issue
  // anyone may open on a public repository), so a press is the person's word for each change, and
  // a press made after the page moved to another repository or another sign-in does nothing. A
  // Refresh of the same repository keeps the buttons; each reads what it acts on when pressed. A
  // run that refuses (returns false) gives the button back, so a press made too early is not lost.
  function assistantOffer(label, words, run) {
    var a = assistant, repo = a.repo, login = a.login;
    var row = el('div', 'console__askact');
    var b = btn(label, false, function () {
      if (a !== assistant || repo !== state.repo || login !== shownLogin) { say('That button belonged to an answer for ' + repo + ' as ' + login + ', and the page has moved on; ask again.', true); return; }
      b.disabled = true;
      if (run() === false) b.disabled = false;
    });
    add(row, b, ' ', words);
    return row;
  }
  var ASSISTANT_RUNS = { workers: 'cp-run-workers', board: 'cp-run-board', checks: 'cp-run-ci', metrics: 'cp-run-metrics' };
  function assistantRunOffer(key) {
    var target = $(ASSISTANT_RUNS[key]);
    var name = target ? target.querySelector('.launch__name').textContent : key;
    return assistantOffer(name, 'Starts that workflow on the default branch, as you, as the Command tab\'s button does.', function () { $(ASSISTANT_RUNS[key]).click(); });
  }
  function assistantGiveOffer(n, name) {
    var g = sortIssues(state.issues);
    var it = g.queue.concat(g.given, g.blocked, g.blockers).filter(function (x) { return x.number === n; })[0];
    if (!it) return 'Not offered: #' + n + ' is not an issue the page can give, one in the Queue, Given to workers, Blocked or Blockers.';
    if (workerNames().indexOf(name) < 0) return 'Not offered: no worker named ' + name + ' is registered.';
    return assistantOffer('Give #' + n + ' to ' + name, '"' + it.title + '": puts the label worker:' + name + ' on it, as Give it in the issue\'s settings (its gear) does.', function () {
      var g2 = sortIssues(state.issues);
      var now = g2.queue.concat(g2.given, g2.blocked, g2.blockers).filter(function (x) { return x.number === n; })[0];
      if (!now) { say('#' + n + ' can no longer be given: it is claimed, in review or closed since the answer came.', true); return false; }
      giveTo(now, name);
    });
  }
  function assistantMergeOffer(n) {
    var pr = state.pulls.filter(function (x) { return x.number === n; })[0];
    if (!pr) return 'Not offered: #' + n + ' is not an open pull request the page lists.';
    return assistantOffer('Merge #' + n + '...', '"' + pr.title + '" into ' + pr.base.ref + ': opens the Pull requests tab and presses its Merge, and you confirm there.', function () {
      var row = assistantPullRow(n);
      var m = row ? Array.prototype.filter.call(row.querySelectorAll('button'), function (x) { return /^(Merge|Confirm: merge)\b/.test(x.textContent); })[0] : null;
      if (!m) { say('#' + n + ' is no longer on the Pull requests tab; press Refresh.', true); return false; }
      assistantDrawer(false);
      revealTab(row);
      scrollInDeck(row, { block: 'center' });
      var cur = state.pulls.filter(function (x) { return x.number === n; })[0] || pr;
      if (m.disabled) { say('#' + n + ' cannot be merged from here yet: ' + (cur.draft ? 'it is a draft.' : 'its checks have not all passed, or are still being read.'), true); return false; }
      if (!m.getAttribute('data-armed')) m.click();
      say('Press "' + m.textContent + '" beside #' + n + ' to merge it, or Cancel.');
    });
  }
  // the pull request's element on the Pull requests tab, by its data-number, or else the row whose
  // first link is its number, as the table drew it before the tab's pictures
  function assistantPullRow(n) {
    var tab = $('tab-pulls');
    if (!tab) return null;
    var el1 = tab.querySelector('[data-number="' + n + '"]');
    if (el1) return el1;
    return Array.prototype.filter.call(tab.querySelectorAll('tr'), function (tr) {
      var a = tr.querySelector('a');
      return !!a && a.textContent === '#' + n;
    })[0] || null;
  }
  function assistantTaskOffer(title) {
    return assistantOffer('Draft the task', '"' + title + '": fills + Add task with this title; you write what is true when it is done and press Queue.', function () {
      assistantDrawer(false);
      openTaskDialog(title, '');
    });
  }
  function assistantAskOffer(target, text) {
    return assistantOffer(target ? 'Draft @claude on #' + target : 'Draft @claude on a new issue', '"' + text + '": fills the words for @claude in the issue\'s settings; Claude works on it with the tools that write only once you press Ask there.', function () {
      assistantDrawer(false);
      if (!target) { openTaskDialog(text.split('\n')[0].slice(0, 100), text); $('cp-task-ask').focus(); return; }
      var n = Number(target);
      var it = (state.issues || []).filter(function (x) { return x.number === n; })[0];
      var g = sortIssues(it ? [it] : []);
      issueSettings(it || { number: n, title: '' }, !!it && g.queue.concat(g.given, g.blocked, g.blockers).length > 0, text);
    });
  }

  // the drawer above the bar holds the answer; Answer opens it again once closed
  function assistantDrawer(open) {
    var d = $('cp-as-drawer'), t = $('cp-as-toggle');
    if (!d) return;
    var has = !!$('cp-as-answer').firstChild;
    d.hidden = !(open && has);
    t.classList[has ? 'remove' : 'add']('hidden');
    t.setAttribute('aria-expanded', d.hidden ? 'false' : 'true');
    t.textContent = d.hidden ? 'Answer' : 'Hide answer';
  }
  // the box grows with the question, up to the few lines the bar allows, and Enter sends it
  function assistantFit() {
    var q = $('cp-as-q');
    q.style.height = 'auto';
    q.style.height = q.scrollHeight + 2 + 'px';
  }
  // The bar and its drawer are made here, into the frame's empty #cp-askbar (which the frame hides
  // while it is empty) and over the foot of the stage, since the bar scrolls inside itself and would
  // clip a drawer it held
  function assistantBuildBar() {
    var bar = $('cp-askbar'), stage = document.querySelector('#console .console__stage');
    if (!bar || !stage || $('cp-as-q')) return;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Ask Claude');
    var row = el('div', 'console__askrow');
    add(row, el('span', 'console__askname', '❖ Ask Claude'));
    var box = el('div', 'console__askbox hidden');
    box.id = 'cp-as-box';
    var q = el('textarea');
    q.id = 'cp-as-q';
    q.rows = 1;
    q.setAttribute('aria-label', 'The question');
    q.placeholder = 'Ask, or tell Claude what to do here (Enter sends)';
    var ask = el('button', 'console__primary', 'Ask');
    ask.id = 'cp-as-ask';
    var stop = el('button', 'quiet hidden', 'Stop watching');
    stop.id = 'cp-as-stop';
    var again = el('button', 'quiet hidden', 'Ask again');
    again.id = 'cp-as-again';
    [ask, stop, again].forEach(function (b) { b.type = 'button'; });
    add(box, q, ask, stop, again);
    var st = el('p', 'admin__lead', 'Reading...');
    st.id = 'cp-as-state';
    var toggle = el('button', 'quiet hidden', 'Answer');
    toggle.id = 'cp-as-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'cp-as-drawer');
    toggle.setAttribute('aria-expanded', 'false');
    var own = el('button', 'quiet', 'Ask in claude.ai');
    own.id = 'cp-as-own';
    own.type = 'button';
    own.title = 'Opens claude.ai in a new tab, on your own account, with the question and what this page shows';
    own.setAttribute('aria-label', 'Ask in claude.ai, in a new tab');
    add(row, box, st, own, toggle);
    bar.appendChild(row);
    var drawer = el('div', 'console__askdrawer');
    drawer.id = 'cp-as-drawer';
    drawer.hidden = true;
    drawer.setAttribute('role', 'region');
    drawer.setAttribute('aria-label', 'Claude’s answer');
    var head = el('div', 'console__askhead');
    var close = el('button', 'quiet', 'Close');
    close.id = 'cp-as-close';
    close.type = 'button';
    add(head, el('strong', '', 'Claude’s answer'), close);
    var body = el('div', 'console__askbody');
    var answer = el('div', 'control__answer control__assistant');
    answer.id = 'cp-as-answer';
    var acts = el('div', 'console__askactions');
    acts.id = 'cp-as-actions';
    add(body, acts, answer);
    add(drawer, splitGrip('drawer', 'the answer'), head, body);
    stage.appendChild(drawer);
  }
  // "Ask in claude.ai" opens the question on the person's own claude.ai account, in a new tab, with a
  // line or two naming what the page shows, so that Claude there, with whatever the person connected
  // to that account (their OneDrive among them), starts where the person is. It needs no write access
  // and no assistant file, since the repository's workflow is not asked: the page sends nothing and
  // writes nothing for it, the words travel in the new tab's address alone, which is why the whole is
  // cut to what an address carries.
  var OWN_CLAUDE = 'https://claude.ai/new?q=';
  var OWN_CLAUDE_MAX = 2000;
  // the encoded form is what the address carries, and a character outside ASCII encodes to nine
  var OWN_CLAUDE_ENCODED_MAX = 6000;
  // the tabs that show the task the assistant centres; on the others the focus is not on screen
  var OWN_CLAUDE_TASK_TABS = ['command', 'board', 'tasks', 'dependencies'];
  // a foreign string (a title, a folder's or a file's name) goes in quotes on one line, so that one
  // holding a line break cannot pose as a line of the page's own
  function ownQuote(text) { return JSON.stringify(String(text || '').replace(/\s+/g, ' ').trim()); }
  function askInClaudeContext() {
    var s = state, a = assistant, lines = [];
    var tab = consoleTab || 'command';
    var rail = document.querySelector('.console__rail [data-tab="' + tab + '"] .rail__name');
    var name = rail ? (rail.textContent || '').trim() : tab;
    lines.push('I am looking at the Symphony control panel' + (s.repo ? ' for ' + s.repo + ' (https://github.com/' + s.repo + ')' : '') + ', on its ' + name + ' tab.');
    if (tab === 'explore') {
      var here = exCurrent();
      if (here && explore.path.length > 1) lines.push('I am at ' + explore.path.slice(1).map(function (n) { return ownQuote(n.title); }).join(' > ') + (here.url ? ' (' + here.url + ')' : '') + '.');
    } else if (tab === 'folders') {
      var last = crumbs[crumbs.length - 1];
      var it = explorer.items.filter(function (x) { return String(x.id) === explorer.selected; })[0];
      if (last) lines.push('The OneDrive folder open is ' + ownQuote(crumbs.map(function (c) { return c.name; }).join('/')) + (last.url ? ' (' + last.url + ')' : '') + '.');
      if (it) lines.push('The item chosen is ' + ownQuote(it.name) + (httpsOnly(it.webUrl) ? ' (' + httpsOnly(it.webUrl) + ')' : '') + '.');
    } else if (OWN_CLAUDE_TASK_TABS.indexOf(tab) >= 0 && a.s === s && a.focus) {
      lines.push('The task I am on is #' + a.focus + ' (https://github.com/' + s.repo + '/issues/' + a.focus + ').');
    }
    return lines.join('\n');
  }
  // cut by code points, so that no surrogate pair is split: a lone surrogate makes encodeURIComponent throw
  function ownCut(text, max) { return Array.from(text).slice(0, max).join(''); }
  function askInClaude() {
    var text = ($('cp-as-q').value || '').trim();
    var context = askInClaudeContext();
    var whole, dropped = '';
    // the question stays whole up to the bound and the page's lines give way, since the person
    // can see what the page shows and cannot see what the cut took from their words
    if (Array.from(text).length > OWN_CLAUDE_MAX) {
      whole = ownCut(text, OWN_CLAUDE_MAX);
      dropped = 'the question goes in cut to its first ' + OWN_CLAUDE_MAX + ', and what the page shows is left out';
    } else {
      var room = OWN_CLAUDE_MAX - Array.from(text).length - (text ? 2 : 0);
      whole = text + (text && room > 0 ? '\n\n' : '') + (room > 0 ? ownCut(context, room) : '');
      if (room < Array.from(context).length) dropped = 'what the page shows goes in shortened';
    }
    var cps = Array.from(whole);
    while (encodeURIComponent(cps.join('')).length > OWN_CLAUDE_ENCODED_MAX) { cps.pop(); dropped = dropped || 'the words go in cut to fit'; }
    whole = cps.join('');
    if (dropped) say('The claude.ai tab takes at most ' + OWN_CLAUDE_MAX + ' characters: ' + dropped + '.', true);
    window.open(OWN_CLAUDE + encodeURIComponent(whole), '_blank', 'noopener,noreferrer');
  }
  function initAssistant() {
    assistantBuildBar();
    $('cp-as-ask').addEventListener('click', assistantAsk);
    $('cp-as-own').addEventListener('click', askInClaude);
    $('cp-as-stop').addEventListener('click', function () { assistantStop('pressed'); });
    $('cp-as-again').addEventListener('click', function () { if (assistant.last) { $('cp-as-q').value = assistant.last; assistantAsk(); } });
    $('cp-as-q').addEventListener('input', assistantFit);
    $('cp-as-q').addEventListener('keydown', function (e) {
      // 229 is the key a browser reports while an input method composes, Safari's last Enter included
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!$('cp-as-ask').disabled) assistantAsk();
    });
    $('cp-as-toggle').addEventListener('click', function () { assistantDrawer($('cp-as-drawer').hidden); });
    $('cp-as-close').addEventListener('click', function () { assistantDrawer(false); $('cp-as-toggle').focus(); });
    // Escape shuts the drawer from inside it or from the bar
    [$('cp-as-drawer'), $('cp-askbar')].forEach(function (n) {
      n.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('cp-as-drawer').hidden) { assistantDrawer(false); $('cp-as-toggle').focus(); } });
    });
    if ($('cp-as-goto')) $('cp-as-goto').addEventListener('click', function () { $('cp-as-q').focus(); });
  }

  /* ============================================================
     The Dependencies tab: each open epic's tasks and what blocks them
     ============================================================ */
  // The same charts the protocol's board writes into STATE.md where it carries the section
  // (symphony-protocol, sdlc_protocol/board.py, the dependencies), built here from GitHub's REST
  // objects to the same bytes, so a person reads one picture whichever drew it: a flowchart per
  // open epic of its sub-issues and the issues blocking them, and one of the goals above their
  // epics. Mermaid draws them, 12.2.0 (MIT; assets/js/vendor/mermaid.min.js, the npm package's own
  // build unchanged, its licence in mermaid.LICENSE beside it), loaded from the site only when there
  // is a chart to draw, as the sealing script is, and told to draw at its strict level. A title is
  // untrusted: it is folded, cut and written as entities as the board writes it (graphLabel), and
  // never raw, so what reaches the drawing is text, and the tables under the charts show it as text
  // too. The board's own text, which anyone who may push the branch board writes, is drawn in the
  // Board tab only where every line is one the board writes (boardChartLines). The tab reads and
  // never writes. It draws whenever the task tables are rendered, whether or not it is open, as the
  // review of the section settled: its reads are capped and keep a reserve, and a failed read is
  // said in the Command tab's summary, which a draw made only once the tab is opened would leave
  // unsaid.
  var MERMAID_JS = '/assets/js/vendor/mermaid.min.js';
  // the most reads of GitHub one draw makes, each page of a list one read; a draw that would need
  // more says so and draws nothing, since a tab half drawn would mislead (one line, so a check
  // can lower it)
  var GRAPH_READS_MAX = 60;
  // the calls of the token's hour a draw leaves for the rest of the page, its tables, its writes and
  // the assistant's waiting, as the board keeps a reserve of its own: a draw whose read finds fewer
  // left stops there and says so
  var GRAPH_RESERVE = 100;
  // a node's label is cut to this many characters, as the board cuts it
  var GRAPH_LABEL_WIDTH = 40;
  // the tab's words while no repository is chosen, the same the page is served with
  var GRAPH_NO_REPOSITORY = 'Nothing to draw yet: no repository is chosen.';
  // how a person starts, said wherever there is nothing to draw
  var GRAPH_START = 'To start, label an issue epic, open it on GitHub and add its tasks under Sub-issues (Create sub-issue, or Add existing issue); on a task, add what must close first under Relationships (Blocked by); then press Refresh.';
  // the five classes every chart ends with, a node's shade being its state (board.NODE_CLASSES)
  var GRAPH_CLASSES = [
    'classDef todo fill:#ffffff,stroke:#0e8a16,color:#000000',
    'classDef claimed fill:#fff8d6,stroke:#fbca04,color:#000000',
    'classDef review fill:#e3f0ff,stroke:#1d76db,color:#000000',
    'classDef blocked fill:#ffe7e7,stroke:#e99695,color:#000000',
    'classDef closed fill:#eeeeee,stroke:#999999,color:#666666'
  ];
  // the state each class stands for, in words, for the table under a chart
  var GRAPH_STATES = { closed: 'closed', review: 'in review', claimed: 'claimed', blocked: 'blocked', todo: 'todo, unclaimed', '': 'open' };
  // the whitespace Python's str.split() and rstrip() take, which the board collapses and trims by
  var GRAPH_SPACE = /[ \t\n\v\f\r\x1c-\x1f]+/;
  var GRAPH_SPACE_END = /[ \t\n\v\f\r\x1c-\x1f]+$/;
  var GRAPH_SPACE_START = /^[ \t\n\v\f\r\x1c-\x1f]+/;
  var mermaidLoad = null;
  var graphRenders = 0;

  function isPlain(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  // a count as GitHub's summaries give it, or 0 where it is not a whole number of zero or more
  function wholeCount(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 ? v : 0; }
  function endsWith(text, tail) { return text.length >= tail.length && text.slice(text.length - tail.length) === tail; }
  // the fields of an issue a chart reads, as the board's Issue record holds them: its state, its
  // labels, how many issues GitHub's dependencies say block it, open and in all, and the count of
  // its sub-issues closed and in all, from the two summaries GitHub carries on every issue it lists
  function graphIssue(it) {
    var deps = isPlain(it.issue_dependencies_summary) ? it.issue_dependencies_summary : {};
    var subs = isPlain(it.sub_issues_summary) ? it.sub_issues_summary : {};
    var total = wholeCount(subs.total);
    return {
      number: Number(it.number), title: String(it.title || ''), labels: labelsOf(it), html_url: String(it.html_url || ''),
      closed: it.state === 'closed',
      blockedByOpen: wholeCount(deps.blocked_by), blockedByTotal: wholeCount(deps.total_blocked_by),
      progress: total ? [wholeCount(subs.completed), total] : null
    };
  }
  function graphPlanned(issue) { return issue.labels.indexOf('epic') >= 0 || issue.labels.indexOf('goal') >= 0; }
  // whether a planned issue's own summary says it has no sub-issue, so its read would answer nothing;
  // an issue whose summary says no whole number is read, as one that carries none is
  function owesNoRead(it) { var s = it.sub_issues_summary; return isPlain(s) && typeof s.total === 'number' && s.total === 0; }
  // whether an issue GitHub lists under another is this repository's: a sub-issue or a blocker may
  // live elsewhere, where its number means nothing here, so such an item is left out of the chart
  function inRepository(it, repo) {
    var url = it.repository_url;
    return typeof url !== 'string' || endsWith(url.toLowerCase(), ('/repos/' + repo).toLowerCase());
  }
  // text folded to ASCII as the board folds it: accented letters to their plain ones, the rest dropped
  function graphFold(text) { return String(text).normalize('NFKD').replace(/[^\x00-\x7f]/g, ''); }
  // a node's text, byte for byte the board's (symphony-protocol's node_label, on its branch
  // claude/dependencies, held for its next release): the number, the title folded, one-spaced and
  // cut, the characters that could end the label as entities ("#" first, since the entities carry
  // one), and the sub-issues' progress where there is any. "%" and "$" are written as entities too,
  // after the fold, which turns the small and the fullwidth signs into them, as the board writes
  // them: Mermaid scans the whole text for a directive, %%{ ... }%%, before it reads the entities,
  // so a raw "%" would let a title break or edit the chart, and it typesets $$...$$ as math with
  // KaTeX, which stops the whole chart from drawing on a formula it cannot parse. Mermaid still
  // reads a label further, harmlessly at its strict level, and the board's text alike: an HTML
  // entity a title holds (&lt;b&gt;) shows decoded, fa:fa-<name> becomes an empty icon, a title of
  // the form "style x:#f;" loses its last semicolon, and NUL and DEL are dropped; the table under
  // the chart shows the title as it is.
  function graphLabel(issue) {
    var title = graphFold(issue.title).split(GRAPH_SPACE).filter(Boolean).join(' ');
    if (title.length > GRAPH_LABEL_WIDTH) title = title.slice(0, GRAPH_LABEL_WIDTH - 3).replace(GRAPH_SPACE_END, '') + '...';
    [['#', '#35;'], ['%', '#37;'], ['$', '#36;'], ['"', '#quot;'], ['|', '#124;'], ['<', '#lt;'], ['>', '#gt;']].forEach(function (pair) { title = title.split(pair[0]).join(pair[1]); });
    var label = '#' + issue.number + (title ? ' ' + title : '');
    if (issue.progress && issue.progress[1] > 0) label += ' (' + issue.progress[0] + '/' + issue.progress[1] + ')';
    return label;
  }
  // a node's state as its class: closed first, then in review, then claimed (the label, or a claim
  // branch the open pull requests show, graphClaimed), then labelled blocked, then todo; "" for an
  // issue in none of them, drawn plain
  function graphClass(issue, claimed) {
    var l = issue.labels;
    if (issue.closed) return 'closed';
    if (l.indexOf('in-review') >= 0) return 'review';
    if (l.indexOf('claimed') >= 0 || claimed[issue.number]) return 'claimed';
    if (l.indexOf('blocked') >= 0) return 'blocked';
    return l.indexOf('todo') >= 0 ? 'todo' : '';
  }
  // the claims the open pull requests show, by issue number: the board also counts an unreleased
  // claude/<issue> branch as claimed, and every claim opens its draft at once (the protocol, Work in
  // the open), so the branch of each open pull request from this repository, never a fork's, stands
  // in for the branches the page does not read; a claim with no draft yet, or one released and not
  // yet renamed, is drawn by its labels alone, the one difference left from the board
  function graphClaimed(pulls, repo) {
    var claimed = {};
    (pulls || []).forEach(function (pr) {
      var head = pr && isPlain(pr.head) ? pr.head : {};
      var m = /^claude\/([1-9][0-9]{0,8})$/.exec(String(head.ref || ''));
      var own = isPlain(head.repo) && typeof head.repo.full_name === 'string' && head.repo.full_name.toLowerCase() === repo.toLowerCase();
      if (m && own) claimed[Number(m[1])] = true;
    });
    return claimed;
  }
  function graphNodeLine(draw, issue) {
    var c = graphClass(issue, draw.claimed);
    return 'i' + issue.number + '["' + graphLabel(issue) + '"]' + (c ? ':::' + c : '');
  }
  // one flowchart's text: the nodes in number order, the edges each once and sorted as strings, the
  // five classes; the bytes between the fences of the board's block
  function graphChart(draw, nodes, edges) {
    var seen = {}, once = [];
    edges.forEach(function (e) { if (!seen[e]) { seen[e] = true; once.push(e); } });
    once.sort();
    var lines = ['flowchart TD'];
    nodes.slice().sort(function (a, b) { return a.number - b.number; }).forEach(function (n) { lines.push('  ' + graphNodeLine(draw, n)); });
    once.forEach(function (e) { lines.push('  ' + e); });
    GRAPH_CLASSES.forEach(function (c) { lines.push('  ' + c); });
    return lines.join('\n');
  }
  // an epic's heading as the board writes it, the title folded and trimmed of the characters the
  // board strips; a pipe needs no escape on a page
  function graphHeading(epic) {
    var title = graphFold(epic.title.replace(/[\r\n]/g, ' ')).replace(GRAPH_SPACE_START, '').replace(GRAPH_SPACE_END, '');
    return 'Epic #' + epic.number + (title ? ': ' + title : '') + (epic.progress && epic.progress[1] > 0 ? ' (' + epic.progress[0] + '/' + epic.progress[1] + ')' : '');
  }

  /* ---------- the reads ---------- */
  // one draw per render of the task tables, numbered on the state, so a draw begun before the
  // tables were rendered again drops its answer, as a loader whose state is no longer the page's does
  function graphLive(draw) { return !stale(draw.s) && draw.s.graphDraw === draw.n; }
  function graphWords(text, warn) {
    var p = $('cp-graph-state');
    p.textContent = text;
    p.className = warn ? 'admin__lead admin__warn' : 'admin__lead';
  }
  function graphReset(words, warn) {
    clear($('cp-graph'));
    graphStripClear();
    $('cp-graph-said').textContent = '';
    graphWords(words, warn);
  }
  // The focus strip that lets a person see one epic's chart at a time, or a zoomed-out goals chart,
  // instead of scrolling every chart at once, the next step of the owner's 2026-10-17 ask ("if there
  // are multiple epics per repo the board should allow focusing on one epic ... or a more zoomed out
  // view where epics are shown connected to each other to reach product goals",
  // docs/research/control-board-graph.md). The charts are the same, drawn the same, from the same
  // reads; the strip only shows one of their sections at a time, with an All chip that shows every
  // one, as the tab did before. It appears only where there are two charts or more, so a repository
  // with one epic reads as it did; it keeps the console's own chip look (control.css), and which chip
  // a person last chose is kept per repository in this browser, as the panel's sizes are. It writes
  // nothing of the repository and asks nothing of anyone.
  var KEY_GRAPH_FOCUS = 'symphony_panel_graph_focus';
  function graphFocusGet(repo) {
    try { var m = JSON.parse(localStorage.getItem(KEY_GRAPH_FOCUS) || '{}'); return m && typeof m === 'object' ? (m[String(repo).toLowerCase()] || '') : ''; } catch (e) { return ''; }
  }
  function graphFocusSet(repo, key) {
    try {
      var m = JSON.parse(localStorage.getItem(KEY_GRAPH_FOCUS) || '{}');
      if (!m || typeof m !== 'object') m = {};
      if (key) m[String(repo).toLowerCase()] = key; else delete m[String(repo).toLowerCase()];
      localStorage.setItem(KEY_GRAPH_FOCUS, JSON.stringify(m));
    } catch (e) { /* storage refused: the choice lasts while the page is open */ }
  }
  function graphStripClear() {
    var strip = $('cp-graph-focus');
    if (strip) { clear(strip); strip.hidden = true; }
  }
  // show the chart a chip names, or every chart for All, and press that chip; the sections are the
  // page's own and read by their data-focus, so the assistant's "show dependencies" can reset to the
  // first without the draw's own list
  function graphSelect(key, repo) {
    var strip = $('cp-graph-focus');
    if (!strip) return;
    Array.prototype.forEach.call(strip.querySelectorAll('.graph__chip'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-focus') === key ? 'true' : 'false');
    });
    Array.prototype.forEach.call($('cp-graph').querySelectorAll('.graph__section'), function (sec) {
      sec.hidden = !(key === 'all' || sec.getAttribute('data-focus') === key);
    });
    if (repo) {
      graphFocusSet(repo, key);
      // a person's press shows the chosen chart from its top, not where the last one was scrolled to
      var box = $('cp-graph').closest('.console__scroll');
      if (box) box.scrollTop = 0;
    }
  }
  // the chips for a draw's charts: All, then one per chart, the last chosen one pressed or, where none
  // was or it is gone, the first chart; a chart is a section the strip shows and hides by its key
  function graphStrip(draw, charts) {
    var strip = $('cp-graph-focus');
    if (!strip) return;
    clear(strip);
    if (charts.length < 2) { strip.hidden = true; return; }
    strip.hidden = false;
    var keys = charts.map(function (c) { return c.key; });
    var saved = graphFocusGet(draw.repo);
    var selected = saved === 'all' || keys.indexOf(saved) >= 0 ? saved : charts[0].key;
    function chip(key, label, title) {
      var b = el('button', 'graph__chip', label);
      b.type = 'button';
      b.setAttribute('data-focus', key);
      b.setAttribute('aria-pressed', 'false');
      if (title) b.title = title;
      b.addEventListener('click', function () { graphSelect(key, draw.repo); });
      add(strip, b);
    }
    chip('all', 'All', 'Show every chart');
    charts.forEach(function (c) { chip(c.key, c.label, c.heading); });
    graphSelect(selected, '');
  }
  // the assistant's "show dependencies ... at its first chart": the first section shown, so its
  // heading is the one in view, without changing the chip a person chose for next time
  function graphShowFirst() {
    var strip = $('cp-graph-focus');
    if (!strip || strip.hidden) return;
    var first = $('cp-graph').querySelector('.graph__section');
    if (first) graphSelect(first.getAttribute('data-focus'), '');
  }
  // the issue a number names: the open list first, then what the reads brought (a closed sub-issue,
  // a blocker from outside the epic), else a bare one, so a node is drawn for every number an edge names
  function graphIssueOf(draw, n) {
    return draw.listed[n] || draw.others[n] || { number: n, title: '', labels: [], html_url: '', closed: false, blockedByOpen: 0, blockedByTotal: 0, progress: null };
  }
  function graphRemember(draw, it) {
    var n = Number(it.number);
    if (!draw.listed[n]) draw.others[n] = graphIssue(it);
  }
  // the pages of a list, every one of them, each counted against the cap before it is read; GitHub
  // saying there is nothing there (404, 410) is an empty list, as the board reads it
  function graphList(draw, path) {
    var out = [];
    function step(p) {
      if (!graphLive(draw)) return Promise.resolve(out);
      if (draw.reads >= GRAPH_READS_MAX) { var e = new Error('more than ' + GRAPH_READS_MAX + ' reads'); e.cap = true; return Promise.reject(e); }
      if (rateLatest !== null && (draw.left === null || rateLatest < draw.left)) draw.left = rateLatest;
      if (draw.left !== null && draw.left < GRAPH_RESERVE) { var low = new Error('fewer than ' + GRAPH_RESERVE + ' calls left on the token'); low.reserve = true; return Promise.reject(low); }
      draw.reads++;
      return gh('GET', p).then(function (r) {
        var left = rateLeft(r.headers);
        if (left !== null) draw.left = left;
        if (Array.isArray(r.data)) out = out.concat(r.data);
        var n = nextPage(r.headers);
        return n ? step(n) : out;
      });
    }
    return step(path).catch(function (e) {
      if (e.status === 404 || e.status === 410) return out;
      throw e;
    });
  }
  // the calls GitHub says the token has left this hour, or null where its answer does not say
  function rateLeft(headers) {
    var v = headers && headers.get ? headers.get('X-RateLimit-Remaining') : null;
    return typeof v === 'string' && /^[0-9]{1,9}$/.test(v) ? Number(v) : null;
  }
  // a planned issue's sub-issues, pull requests and another repository's issues left out, and, for
  // an epic's, the issues blocking each; a goal's sub-issues are epics, whose chart draws no
  // relation of the epic's own, so their blockers are not read
  function graphReadParent(draw, parent) {
    var number = parent.number, isEpic = parent.labels.indexOf('epic') >= 0;
    draw.reading = 'the sub-issues of #' + number;
    return graphList(draw, '/repos/' + draw.repo + '/issues/' + number + '/sub_issues?per_page=100').then(function (list) {
      var children = list.filter(function (c) { return isPlain(c) && !('pull_request' in c) && inRepository(c, draw.repo); });
      if (children.length) draw.subIssues[number] = children.map(function (c) { return Number(c.number); });
      children.forEach(function (c) { graphRemember(draw, c); });
      if (!isEpic) return;
      return children.reduce(function (p, child) { return p.then(function () { return graphReadBlockers(draw, child); }); }, Promise.resolve());
    });
  }
  // the issues blocking a sub-issue, where its summary counts one and no earlier epic's read brought them
  function graphReadBlockers(draw, child) {
    var rec = graphIssue(child), number = rec.number;
    if (rec.blockedByTotal === 0 || Object.prototype.hasOwnProperty.call(draw.blockedBy, number)) return Promise.resolve();
    draw.reading = 'the issues blocking #' + number;
    return graphList(draw, '/repos/' + draw.repo + '/issues/' + number + '/dependencies/blocked_by?per_page=100').then(function (list) {
      var blockers = list.filter(function (b) { return isPlain(b) && inRepository(b, draw.repo); });
      draw.blockedBy[number] = blockers.map(function (b) { return Number(b.number); }).sort(function (a, b) { return a - b; });
      blockers.forEach(function (b) { graphRemember(draw, b); });
    });
  }
  // the whole draw: from the open issues the page holds, the sub-issues of each open issue labelled
  // epic or goal whose summary does not say it has none, by number, then the charts and their tables;
  // called whenever the task tables are rendered afresh and never on a timer of its own. The
  // repository is named as GitHub names it (the record loadMeta read): a name the person typed or
  // the page remembered may be an old one GitHub still answers to, while every issue it lists
  // carries the new one.
  function loadGraph(s) {
    var repo = s.meta && typeof s.meta.full_name === 'string' && s.meta.full_name ? s.meta.full_name : s.repo;
    // the draw starts from the calls GitHub said were left on its newest answer, the open issues'
    // that come just before it among them, so once the token is under the reserve no draw reads, a
    // draw that follows a Refresh included
    var left = rateLatest;
    // a draw started afresh says nothing yet, so an earlier draw's failure leaves the summary
    s.failed = s.failed.filter(function (f) { return f.indexOf('the dependencies (') !== 0; });
    if (s.ready) summary();
    var draw = { s: s, n: s.graphDraw = (s.graphDraw || 0) + 1, repo: repo, claimed: {}, reads: 0, left: left, reading: '', subIssues: {}, blockedBy: {}, others: {}, listed: {} };
    var open = s.issues.filter(function (it) { return !it.pull_request; });
    open.forEach(function (it) { draw.listed[Number(it.number)] = graphIssue(it); });
    var planned = open.filter(function (it) { return graphPlanned(draw.listed[Number(it.number)]) && !owesNoRead(it); })
      .map(function (it) { return draw.listed[Number(it.number)]; }).sort(function (a, b) { return a.number - b.number; });
    if (!planned.length) {
      graphReset('Nothing to draw yet: no open issue labelled epic or goal has sub-issues. ' + GRAPH_START + graphCut(draw));
      s.graphLast = draw;
      exploreAfterDraw();
      return Promise.resolve();
    }
    graphReset('Reading the sub-issues of ' + plural(planned.length, 'epic or goal', 'epics and goals') + '...');
    return planned.reduce(function (p, parent) { return p.then(function () { return graphReadParent(draw, parent); }); }, Promise.resolve()).then(function () {
      draw.reading = '';
      // the pull requests are read beside the issues, and say which tasks a claim branch holds
      return s.pullsRead;
    }).then(function () {
      if (!graphLive(draw)) return;
      draw.claimed = graphClaimed(s.pulls, repo);
      graphRender(draw);
      // Explore builds its tree from the latest draw, and redraws while it is open
      s.graphLast = draw;
      s.graphFailed = '';
      exploreAfterDraw();
    }).catch(function (e) {
      if (!graphLive(draw)) return;
      clear($('cp-graph'));
      if (e.cap) graphWords('Not drawn: it would take more than ' + GRAPH_READS_MAX + ' reads of GitHub, the most this page makes for one draw; stopped at ' + draw.reading + '. Closing the epics that are done makes it fewer.', true);
      else if (e.reserve) graphWords('Not drawn: GitHub says this token has ' + draw.left + ' calls left this hour, and the page keeps the last ' + GRAPH_RESERVE + ' for the rest of the console; stopped at ' + draw.reading + '. Press Refresh once GitHub\'s hourly limit has reset.', true);
      else if (draw.reading) graphWords('Not drawn: reading ' + draw.reading + ' failed. ' + e.message, true);
      // the reads ended, so what failed is the page's own laying out of them
      else graphWords('Not drawn: ' + e.message, true);
      failed(s, 'the dependencies', e);
      s.graphFailed = e.message || 'the reads stopped';
      exploreAfterDraw();
      if (s.ready) summary();
    });
  }
  // what the state says where the open list was cut, since an epic or goal beyond the cut is not drawn
  function graphCut(draw) {
    return draw.s.issues.more ? ' Only the first ' + draw.s.issues.length + ' open issues were read, so an epic or goal beyond them is not drawn.' : '';
  }

  /* ---------- the charts and their tables ---------- */
  // the open issues carrying a label that the reads found sub-issues for, in number order
  function graphWithSubIssues(draw, label) {
    return Object.keys(draw.listed).map(function (k) { return draw.listed[k]; })
      .filter(function (it) { return it.labels.indexOf(label) >= 0 && (draw.subIssues[it.number] || []).length; })
      .sort(function (a, b) { return a.number - b.number; });
  }
  function graphNumbers(numbers) { return Object.keys(numbers).map(Number).sort(function (a, b) { return a - b; }); }
  // an epic's chart: its sub-issues and the issues outside the epic that block one of them, with
  // every blocked-by relation among them as an edge, dotted once the blocker is closed; the epic
  // itself is no node, and a blocker's own blockers are not followed
  function graphEpic(draw, epicNumber) {
    var numbers = {}, edges = [];
    (draw.subIssues[epicNumber] || []).forEach(function (n) { numbers[n] = true; });
    graphNumbers(numbers).forEach(function (blocked) {
      (draw.blockedBy[blocked] || []).forEach(function (blocker) {
        numbers[blocker] = true;
        edges.push('i' + blocker + (graphIssueOf(draw, blocker).closed ? ' -.-> ' : ' --> ') + 'i' + blocked);
      });
    });
    return { nodes: graphNumbers(numbers).map(function (n) { return graphIssueOf(draw, n); }), edges: edges };
  }
  // the goals above their epics, joined by thick arrows and no blocked-by edge, since an epic's own chart draws those
  function graphGoals(draw, goals) {
    var numbers = {}, edges = [];
    goals.forEach(function (goal) {
      numbers[goal.number] = true;
      (draw.subIssues[goal.number] || []).forEach(function (epic) { numbers[epic] = true; edges.push('i' + goal.number + ' ==> i' + epic); });
    });
    return { nodes: graphNumbers(numbers).map(function (n) { return graphIssueOf(draw, n); }), edges: edges };
  }
  function graphIssueLink(draw, n) {
    var it = graphIssueOf(draw, n);
    return link(it.html_url || 'https://github.com/' + draw.repo + '/issues/' + n, '#' + n);
  }
  // what blocks a task, in words: the blockers the reads brought, a closed one said so, else the
  // count GitHub's summary gives where no read was made for it
  function graphBlockedBy(draw, it) {
    var cell = el('td');
    if (Object.prototype.hasOwnProperty.call(draw.blockedBy, it.number)) {
      draw.blockedBy[it.number].forEach(function (b, i) { add(cell, i ? ', ' : '', graphIssueLink(draw, b), graphIssueOf(draw, b).closed ? ' (closed)' : ''); });
    } else if (it.blockedByOpen > 0) add(cell, plural(it.blockedByOpen, 'open issue') + (it.blockedByTotal > it.blockedByOpen ? ' and ' + plural(it.blockedByTotal - it.blockedByOpen, 'closed one') : ''));
    return cell;
  }
  // a goal's epics, on the goal's row alone: an epic drawn under it has tasks, which its own chart shows
  function graphEpicsOf(draw, goal) {
    var cell = el('td');
    if (goal.labels.indexOf('goal') < 0) return cell;
    (draw.subIssues[goal.number] || []).forEach(function (n, i) { add(cell, i ? ', ' : '', graphIssueLink(draw, n)); });
    return cell;
  }
  // one chart's heading, its picture (empty until Mermaid draws it) and its table, which says the
  // same in words and stands alone when the picture cannot be drawn
  // a chip's short label for an epic: its number, a few words of its title and its progress, so the
  // strip reads at a glance where the heading says it in full
  function graphChipLabel(epic) {
    var t = graphFold(epic.title).split(GRAPH_SPACE).filter(Boolean).join(' ');
    if (t.length > 22) t = t.slice(0, 19).replace(GRAPH_SPACE_END, '') + '...';
    var p = epic.progress && epic.progress[1] > 0 ? ' ' + epic.progress[0] + '/' + epic.progress[1] : '';
    return '#' + epic.number + (t ? ' ' + t : '') + p;
  }
  function graphSection(draw, box, heading, chart, relation, relationCell, key, label) {
    var sec = el('section', 'graph__section');
    sec.setAttribute('data-focus', key);
    add(sec, el('h3', '', heading));
    var host = el('div', 'control__chart');
    add(sec, host);
    var table = el('table', 'control__tasks'), head = el('tr');
    ['Issue', 'Title', 'State', relation, 'Worker'].forEach(function (c) { add(head, el('th', '', c)); });
    add(head, add(el('th'), el('span', 'admin__sr', 'Actions')));
    add(table, add(el('thead'), head));
    var body = el('tbody');
    chart.nodes.forEach(function (it) {
      var tr = el('tr');
      add(tr, add(el('td'), graphIssueLink(draw, it.number)));
      add(tr, el('td', '', it.title));
      add(tr, el('td', '', GRAPH_STATES[graphClass(it, draw.claimed)]));
      add(tr, relationCell(draw, it));
      add(tr, el('td', '', workerOf(it.labels)));
      add(tr, add(el('td', 'admin__act'), btn('Centre its row', true, function () { graphFocus(it.number); })));
      body.appendChild(tr);
    });
    add(table, body);
    add(sec, add(el('div', 'table-scroll'), table));
    add(box, sec);
    return { host: host, heading: heading, text: graphChart(draw, chart.nodes, chart.edges), key: key, label: label };
  }
  function graphRender(draw) {
    var box = $('cp-graph');
    var goals = graphWithSubIssues(draw, 'goal'), epics = graphWithSubIssues(draw, 'epic');
    clear(box);
    graphStripClear();
    if (!goals.length && !epics.length) {
      graphWords('Nothing to draw yet: ' + plural(draw.reads, 'read') + ' of GitHub found no sub-issue of an open epic or goal in this repository. ' + GRAPH_START + graphCut(draw));
      return;
    }
    var charts = [];
    if (goals.length) charts.push(graphSection(draw, box, 'Goals', graphGoals(draw, goals), 'Its epics', graphEpicsOf, 'goals', 'Goals'));
    epics.forEach(function (epic) { charts.push(graphSection(draw, box, graphHeading(epic), graphEpic(draw, epic.number), 'Blocked by', graphBlockedBy, 'epic-' + epic.number, graphChipLabel(epic))); });
    graphStrip(draw, charts);
    var drew = (goals.length ? [plural(goals.length, 'goal')] : []).concat(epics.length ? [plural(epics.length, 'epic')] : []);
    var drawn = 'from ' + plural(draw.reads, 'read') + ' of GitHub: ' + drew.join(' and ') + ' with sub-issues';
    graphWords('Drawing ' + drawn + '...');
    // each chart is drawn on its own, so one Mermaid cannot draw leaves the others drawn and is
    // named, its table standing in for it
    loadMermaid().then(function (m) {
      var undrawn = [];
      return charts.reduce(function (p, chart) {
        return p.then(function () {
          if (!graphLive(draw)) return;
          return graphDraw(m, chart).catch(function (e) { undrawn.push(chart.heading + ': ' + e.message); });
        });
      }, Promise.resolve()).then(function () { return undrawn; });
    }).then(function (undrawn) {
      if (!graphLive(draw)) return;
      if (!undrawn.length) graphWords('Drawn ' + drawn + '. A node\'s shade is its state; click one to centre its row in the Tasks tab.' + graphCut(draw));
      else graphWords('Drawn ' + (charts.length - undrawn.length) + ' of ' + plural(charts.length, 'chart') + ' ' + drawn + '; ' + plural(undrawn.length, 'chart') + ' could not be drawn (' + undrawn.join('; ') + '), and the table under ' + (undrawn.length === 1 ? 'it' : 'each') + ' says the same.' + graphCut(draw), true);
    }, function (e) {
      if (graphLive(draw)) graphWords('The charts could not be drawn (' + e.message + '); the tables say the same ' + drawn + '.', true);
    });
  }
  function loadMermaid() {
    if (mermaidLoad) return mermaidLoad;
    mermaidLoad = new Promise(function (resolve, reject) {
      if (window.mermaid) { resolve(window.mermaid); return; }
      var s = document.createElement('script');
      s.src = MERMAID_JS;
      s.onload = function () { window.mermaid ? resolve(window.mermaid) : reject(new Error('the drawing script loaded without its function')); };
      s.onerror = function () { reject(new Error('the drawing script could not be loaded; press Refresh to try again')); };
      document.head.appendChild(s);
    }).then(function (m) {
      // nothing is drawn on load, no HTML of a label is trusted, and a failed drawing leaves no picture
      // of its own on the page; beside Mermaid's own secure keys, no directive may change the label
      // sanitizer's settings, the styles or the fonts, which could fetch from elsewhere. No directive
      // reaches it from the page (graphLabel, boardChartLines); this holds should one ever do.
      m.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
          'dompurifyConfig', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily'] });
      return m;
    }).catch(function (e) {
      // whatever failed, the next draw tries the load again, as the words tell the person Refresh does
      mermaidLoad = null;
      throw e;
    });
    return mermaidLoad;
  }
  // one chart drawn under an id of its own, since Mermaid takes any element already carrying the id
  // it draws under off the page; the picture is put where the tab keeps it, at its own width,
  // so a wide one scrolls sideways instead of shrinking
  function graphDraw(m, chart) {
    var id = 'cp-graph-' + (++graphRenders);
    return m.render(id, chart.text).then(function (r) {
      chart.host.innerHTML = r.svg;
      var svg = chart.host.querySelector('svg');
      var width = svg && svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0;
      if (svg && width > 0) svg.style.minWidth = Math.ceil(width) + 'px';
    }, function (e) {
      // what a failed drawing may leave on the page: the library's own picture of the error, under an id of its own
      var left = document.getElementById('d' + id);
      if (left && left.parentNode) left.parentNode.removeChild(left);
      throw e;
    });
  }
  // a node pressed, or Centre its row: the task's row is centred and marked in the Tasks tab, which
  // opens, as the assistant's focus opens it, where the task tables hold the task, and nothing else
  // happens; no window or page opens. The words go to the message line under the deck too, on every
  // press, whichever tab it leaves shown, so that line never keeps an earlier press's focus.
  function graphFocus(n) {
    $('cp-graph-said').textContent = assistantFocus(n);
    say($('cp-graph-said').textContent);
  }
  // The lines of a chart as the board's mermaid_block writes them, and only those: the header; a
  // node whose label starts with its own number and whose title holds only the characters
  // node_label leaves raw, every printable ASCII character but the quote, "$", "%", "<", ">" and
  // "|", which it writes as entities, and "#", which it writes only as the first of one of those
  // entities; an edge of the three kinds; and the five classes. Anyone who may push the branch board
  // writes its text, and Mermaid at its strict level still draws the HTML
  // a label holds (an image, a form, a field with an id the page's own forms answer to, a link) and
  // obeys a directive, so a block of any other line is never handed to it. This follows node_label's
  // escapes: a change to the labels in the library changes it in the same step, and the panel's
  // checks (symphony-app, signin/panel-checks/e2e2/graph.test.mjs, R2 and R3) hand this tab the
  // library's own lines for titles of every printable ASCII character, so a step missed fails them.
  var BOARD_NODE_LINE = /^  i([1-9][0-9]{0,8})\["#\1(?: (?:[ !&-;=?-{}~]|#(?:35|36|37|124|quot|lt|gt);)*)?"\](?::::(?:todo|claimed|review|blocked|closed))?$/;
  var BOARD_EDGE_LINE = /^  i[1-9][0-9]{0,8} (?:-->|-\.->|==>) i[1-9][0-9]{0,8}$/;
  function boardChartLines(text) {
    var lines = String(text).split('\n');
    return lines[0] === 'flowchart TD' && lines.slice(1).every(function (line) {
      return BOARD_NODE_LINE.test(line) || BOARD_EDGE_LINE.test(line) || GRAPH_CLASSES.some(function (c) { return line === '  ' + c; });
    });
  }
  // a block that is no chart the board writes, shown as the text it is, and never drawn; the host
  // gives up the chart's class, whose light ground and dark ink are for a drawing, so its words and
  // its text read in the Board tab's own colours, as any other block of code on the board does
  function boardNotChart(host) {
    var text = host.getAttribute('data-chart');
    host.removeAttribute('data-chart');
    host.removeAttribute('class');
    clear(host);
    add(host, el('p', 'admin__lead', 'Not drawn: this block is not a chart as the board writes it, so it is shown here as text.'));
    add(host, el('pre', 'admin__text', text));
  }
  // the charts the board's own text holds, its Dependencies section, drawn in place in the Board tab
  // where the renderer put them (markdown), each on its own, so the board never shows its chart as
  // text; Mermaid is loaded only where a block is a chart the board writes
  function boardCharts(s, box) {
    var hosts = Array.prototype.slice.call(box.querySelectorAll('.control__chart[data-chart]')).filter(function (host) {
      if (boardChartLines(host.getAttribute('data-chart'))) return true;
      boardNotChart(host);
      return false;
    });
    if (!hosts.length) return;
    // a chart that could not be drawn keeps its text under the words, as the Dependencies tab keeps
    // its table, so the board still says what it holds
    function undrawn(host, e) {
      var text = host.getAttribute('data-chart');
      host.removeAttribute('class');
      clear(host);
      add(host, el('p', 'admin__lead', 'This chart could not be drawn (' + e.message + '); it is shown here as text.'));
      add(host, el('pre', 'admin__text', text));
    }
    loadMermaid().then(function (m) {
      return hosts.reduce(function (p, host) {
        return p.then(function () {
          if (stale(s)) return;
          return graphDraw(m, { host: host, text: host.getAttribute('data-chart') }).catch(function (e) { undrawn(host, e); });
        });
      }, Promise.resolve());
    }).catch(function (e) { if (!stale(s)) hosts.forEach(function (host) { undrawn(host, e); }); });
  }
  // a node pressed, in the tab's own charts or in the board's
  function initGraph() {
    ['cp-graph', 'cp-board'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var node = e.target && e.target.closest ? e.target.closest('g.node') : null;
        var m = node ? /-flowchart-i([0-9]{1,9})-[0-9]+$/.exec(node.id || '') : null;
        if (m) graphFocus(Number(m[1]));
      });
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
  // only the latest choice of repository is shown, so a slow answer about an earlier one is dropped
  var measuring = 0;
  function measured() {
    var asked = ++measuring;
    var repo = $('cost-repo').value;
    var box = $('cost-measured');
    clear(box);
    if (!repo) { none(box, 'Choose a repository in the side column first.'); return; }
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
  var POOL_FILE = /^slot-(main|[1-9]|[12][0-9]|3[0-2])\.(run|probe|cswap)\.json$/;
  var POOL_THRESHOLD = 0.9;
  var POOL_UNKNOWN_HOLD_MS = 5 * 3600 * 1000;
  var POOL_WINDOWS = [['five_hour', '5 hours'], ['seven_day', '7 days']];
  var ASSIGNMENTS_PATH = '.github/symphony/accounts.json';
  // an organization's pool holds every member's tokens, so it has room for 32, as tools/pool.py's SLOTS
  var POOL_SLOTS = Array.apply(null, Array(32)).map(function (x, i) { return String(i + 1); });
  var CHOICES = ['main', 'auto'].concat(POOL_SLOTS);
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

  function loadTokens() {
    var asked = ++reading;
    var repo = tokensRepo();
    tokensFor = repo;
    if (!repo) { say('Choose a repository in the side column first.', true); return; }
    writeKey(KEY_REPO, repo, true);
    readPool(repo).catch(function (e) { if (e.status === 404) return {}; throw e; }).then(function (by) {
      if (asked === reading) { tk.pool = by; drawTiles(); }
    }).catch(function (e) { if (asked === reading) say(e.message, true); });
    readTokenPlace(repo, asked);
  }
  // one word from each slot of SYMPHONY_CLAUDE_ACCOUNTS through the workflow Pool, which spends that
  // word of each slot's window, so it runs only on this press (the owner's choice, 2026-10-17)
  var PROBE_SETTLE_MS = 100 * 1000;
  function probeSlots() {
    var repo = tokensRepo();
    if (!repo) return;
    say('Starting the workflow Pool...');
    gh('GET', '/repos/' + repo).then(function (r) {
      return gh('POST', '/repos/' + repo + '/actions/workflows/pool.yml/dispatches', { ref: r.data.default_branch || 'main' });
    }).then(function () {
      say('Reading every token: each spends one word of its window, and the tiles show the new use in a minute or two.');
      var repoNow = repo;
      setTimeout(function () { if (tokensRepo() === repoNow) loadTokens(); }, PROBE_SETTLE_MS);
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
  // the wizard's label shape (scripts/tokens.py LABEL_SHAPE): a word, never an e-mail address
  var SLOT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
  // what a 403 or 404 on a slot's secret or variable means, for where the slots live: an organization's
  // pool, or a personal account's repository, which takes the App's repository permissions instead
  function secretsNeeded(place) {
    if (place && !place.org) return ' Writing a slot on a personal account\'s repository needs the SymphonyBoard App\'s repository permissions Secrets and Variables: read and write, accepted on its installation (github.com/settings/installations, Configure beside SymphonyBoard, then accept the new permissions); until Variables is accepted the repository takes one token, its main one. A fine-grained token needs the same two repository permissions.';
    return ' Writing a slot needs you to be an owner of the organization and, signed in with GitHub, the SymphonyBoard App\'s organization permissions Secrets and Variables: read and write, accepted on its installation; a fine-grained token needs the same two organization permissions.';
  }

  function slotSecret(slot) { return slot === 'main' ? MAIN_SECRET : SLOT_PREFIX + slot; }
  function slotWords(text) { return String(text || '').split(/[,\s]+/).filter(function (w) { return POOL_SLOTS.indexOf(w) >= 0; }); }

  // where a repository's slots live: its organization's secrets, or for a personal account's
  // repository, the repository's own
  function slotPlace(repo) {
    return gh('GET', '/repos/' + repo).then(function (r) {
      var org = r.data.owner && r.data.owner.type === 'Organization';
      var owner = r.data.owner.login;
      // GitHub says whether the signed-in person administers the repository; a secret needs that,
      // or for an organization's pool, an owner of the organization
      var admin = r.data.permissions ? !!r.data.permissions.admin : null;
      // and whether they may write to it, which lets the Token run store their token in the pool
      var push = r.data.permissions ? !!r.data.permissions.push : null;
      return { org: org, owner: owner, ownerId: r.data.owner.id, id: r.data.id, admin: admin, push: push, base: org ? '/orgs/' + owner + '/actions' : '/repos/' + repo + '/actions' };
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

  // An organization's owners hold every token in its pool; anyone else only the ones they added
  // (the owner, 2026-10-18). GitHub says who is an owner; a personal account is its own.
  function ownsPlace(place) {
    if (!shownLogin) return Promise.resolve(false);
    if (!place.org) return Promise.resolve(place.owner.toLowerCase() === shownLogin.toLowerCase());
    return gh('GET', '/orgs/' + place.owner + '/memberships/' + shownLogin).then(function (r) {
      return !!(r.data && r.data.role === 'admin' && r.data.state === 'active');
    // unknown, not "no": an owner whose membership GitHub would not show keeps the owner's path
    }, function () { return null; });
  }

  // where the tokens live, which are set and their names and settings, read when the tab opens
  function readTokenPlace(repo, asked) {
    var place = null, secrets = null;
    if (tk.repo !== repo) { tk = { repo: repo, place: null, secrets: null, settings: {}, labels: {}, pool: null, admin: false, side: '' }; drawTiles(); }
    slotPlace(repo).then(function (p) {
      place = p;
      return readSecrets(p).catch(function (e) { return { unread: e }; });
    }).then(function (found) {
      secrets = found;
      return Promise.all([readTileVariables(place), ownsPlace(place)]);
    }).then(function (both) {
      var vars = both[0];
      if (asked !== reading) return;
      tk.admin = both[1];
      tk.place = place;
      tk.secrets = secrets;
      tk.settings = vars[0];
      tk.labels = vars[1];
      drawTiles();
    }).catch(function (e) { if (asked === reading) say('The tokens could not be read: ' + e.message, true); });
  }

  // a repository in crowd mode holds no Claude token (docs/setup/crowdsourcing.md), as the wizard refuses
  function refuseCrowd(names, place) {
    var orgWide = place.org ? gh('GET', place.base + '/variables/' + CROWD_VARIABLE).then(function (r) {
      if (String((r.data && r.data.value) || '').trim().toLowerCase() === 'true') throw new Error('The organization ' + place.owner + ' is in crowd mode (its variable ' + CROWD_VARIABLE + ' is true): its repositories hold no Claude token, so nothing was saved.');
    // someone who is not an owner may not read it, and the Token run reads it then (vars.CLAUDE_CROWD)
    }, function (e) { if (e.status !== 404 && e.status !== 403) throw e; }) : Promise.resolve();
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
    stored: '<!-- symphony-token: stored -->',
    failed: '<!-- symphony-token: failed -->'
  };
  var RUN_BOT = 'github-actions[bot]';
  var RUN_POLL_MS = 3000;
  var RUN_FOR_MS = 15 * 60 * 1000;
  // what claude.ai shows after the sign-in, as tools/token_run.py's CODE_SHAPE takes it
  var SIGN_IN_CODE = /^[A-Za-z0-9_.~#-]{8,512}$/;
  var ACTIONS_NEEDED = ' Starting the workflow needs the SymphonyBoard App\'s repository permission Actions: read and write, and opening the issue Issues: read and write.';
  var ADOPT_BRANCH = 'symphony/adopt';
  var STOPPED = 'Stopped; nothing was saved. Press Add Token to start again.';
  // the sign-in under way, one at a time since each opens an issue and starts a run: its dialog,
  // shown again when Add Token is pressed after the dialog was closed, and how to stop it
  var tokenRun = null;

  // the sign-in in the token's dialog: a line that says where the run is, and the step it needs from
  // the person, the claude.ai button and the code's box, under it
  function signInView(title) {
    var d = $('tk-dialog');
    var box = el('div', 'tkdlg__form');
    var line = el('p', 'admin__lead tkdlg__line');
    line.id = 'tk-line';
    var step = el('div', 'tkdlg__step');
    var note = el('p', 'admin__warn tkdlg__line');
    note.hidden = true;
    // Close only hides the dialog: the run goes on, and Add Token shows it again
    var close = btn('Close', true, function () { d.close(); });
    var stop = btn('Stop this sign-in', true, function () { if (tokenRun && tokenRun.view.stop === stop) tokenRun.stop(); });
    stop.id = 'tk-stop';
    add(box, el('h3', 'console__boxh', title), note, line, step, add(el('p', 'admin__bar tkdlg__bar'), close, ' ', stop));
    // shown again with a note when Add Token or Renew asked for something else meanwhile
    function show(why) {
      note.hidden = !why;
      note.textContent = why || '';
      if (box.parentNode !== d) { clear(d); add(d, box); }
      if (!d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
    }
    show();
    return {
      tell: function (text, warn) { line.textContent = text; line.className = 'tkdlg__line ' + (warn ? 'admin__warn' : 'admin__lead'); },
      step: step,
      close: close,
      stop: stop,
      show: show
    };
  }
  // the hint for a repository without the workflow Token: one not adopted yet, or whose adoption pull
  // request is still open, as a repository named before its merge is
  function noTokenWorkflow(repo, view) {
    var hint = ' ' + repo + ' has no workflow Token yet (.github/workflows/token.yml), which comes with Symphony\'s adoption.';
    var reach = gh('GET', '/repos/' + repo).then(function () { return true; }, function (e) { return e.status !== 404; });
    return reach.then(function (reached) {
      if (!reached) return ' The sign-in does not reach ' + repo + ': SymphonyBoard is not installed on it.';
      return adoptionHint(repo, view, hint);
    });
  }
  function adoptionHint(repo, view, hint) {
    return gh('GET', '/repos/' + repo + '/pulls?state=open&per_page=1&head=' + encodeURIComponent(repo.split('/')[0] + ':' + ADOPT_BRANCH)).then(function (r) {
      var pr = (r.data || [])[0];
      if (!pr || !/^https:\/\/github\.com\//.test(pr.html_url || '')) throw new Error('none open');
      add(view.step, add(el('p', 'admin__bar'), link(pr.html_url, 'Open the adoption pull request #' + pr.number)));
      return hint + ' Merge its adoption pull request first, then press Add Token again.';
    }).catch(function () {
      return hint + ' Merge its adoption pull request first, or adopt it if it never was, then press Add Token again.';
    });
  }

  function addByActions(repo, place, button, wanted) {
    // a sign-in begun before the page signed out waits on calls that never answer, so it is let go
    if (tokenRun && tokenRun.era !== ends) tokenRun = null;
    if (tokenRun) {
      tokenRun.view.show(tokenRun.repo !== repo || (wanted && wanted !== tokenRun.wanted) ? 'Another sign-in is under way; finish it or stop it first.' : '');
      return;
    }
    var issue = 0, slot = '', ids = place.org ? [place.id] : [], key = null, mainMissing = false, step = 'secrets', stopped = false;
    var renewing = wanted && tk.secrets && tk.secrets[slotSecret(wanted)];
    var pooled = intoPool(place);
    var view = signInView((renewing ? 'Renew ' + tileName(wanted) : pooled ? 'Add your token to ' + place.owner + '\'s pool' : 'Add a token') + ' on ' + repo);
    // a stop frees Add Token at once, whatever call is on its way; the chain ends quietly when it answers
    var run = tokenRun = { view: view, repo: repo, wanted: wanted || '', era: ends, stop: function () {
      stopped = true;
      if (issue) closeRunIssue(repo, issue, true);
      over();
      clear(view.step);
      view.tell(STOPPED);
    } };
    function unlessStopped(value) {
      if (stopped) { var e = new Error(STOPPED); e.stopped = true; throw e; }
      return value;
    }
    function over() {
      if (tokenRun === run) { tokenRun = null; drawTiles(); }
      view.stop.hidden = true;
    }
    drawTiles();
    view.tell('Starting the sign-in on GitHub Actions...');
    refuseCrowd([repo], place).then(function () {
      if (pooled && wanted) throw new Error('Renewing a token in ' + place.owner + '\'s pool is for an owner of ' + place.owner + '; add a new one with Add Token, and ask an owner to remove the old one.');
      // the run itself finds the free slot, since only an owner may read the pool's secrets
      return pooled ? {} : readSecrets(place);
    }).then(unlessStopped).then(function (by) {
      if (pooled) { step = 'workflow'; return gh('GET', '/repos/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW); }
      slot = wanted || POOL_SLOTS.filter(function (n) { return !by[slotSecret(n)]; })[0] || '';
      if (!slot) throw new Error('All 32 slots are set; remove one with its X, or renew one from its tile.');
      mainMissing = slot !== 'main' && !by[MAIN_SECRET];
      step = 'workflow';
      // read before the issue is opened, so a repository without the workflow gets no issue
      return gh('GET', '/repos/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW);
    }).then(unlessStopped).then(function (r) {
      var state = r.data && r.data.state;
      if (state && state !== 'active') {
        var off = new Error(repo + '\'s workflow Token is turned off (' + state + '): open it, press Enable workflow, then press Add Token again.');
        off.page = 'https://github.com/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW;
        throw off;
      }
      step = 'secrets';
      return pooled ? { data: null } : gh('GET', place.base + '/secrets/public-key');
    }).then(unlessStopped).then(function (r) {
      key = r.data;
      step = 'issue';
      return gh('POST', '/repos/' + repo + '/issues', { title: pooled ? 'Add a Claude account to ' + place.owner + '\'s pool' : 'Add a Claude account as ' + (slot === 'main' ? 'main' : 'slot ' + slot),
        body: 'The control panel\'s Tokens page opened this issue for one sign-in through the workflow Token (.github/workflows/token.yml). The run posts the sign-in link here and the token only as a sealed box GitHub alone can open; the page closes the issue when the slot is saved.' });
    }).then(function (r) {
      issue = r.data.number;
      step = 'dispatch';
      return gh('GET', '/repos/' + repo);
    }).then(unlessStopped).then(function (r) {
      return gh('POST', '/repos/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW + '/dispatches',
        { ref: r.data.default_branch || 'main', inputs: pooled ? { issue: String(issue), store: 'pool' } : { issue: String(issue), key: key.key, key_id: key.key_id } });
    }).then(function () {
      step = 'run';
      view.tell('The sign-in is starting; its button appears here in about a minute.');
      return followRun(repo, issue, pooled ? null : key.key_id, view, function () { return stopped; });
    }).then(unlessStopped).then(function (sealed) {
      if (pooled) return { pooled: sealed.stored };
      // the token is sealed and on its way into the secret, which a stop now would only cut short
      view.stop.hidden = true;
      step = 'secrets';
      clear(view.step);
      view.tell('Saving the token...');
      return storeSealed(place, repo, slot, sealed, key.key_id, ids, '').then(function () {
        if (mainMissing) return putSecret(place, place.base + '/secrets/' + MAIN_SECRET, sealed, key.key_id, ids).then(function () { return true; });
        return false;
      });
    }).then(function (alsoMain) {
      closeRunIssue(repo, issue);
      over();
      if (alsoMain && alsoMain.pooled) {
        view.tell('Your token is saved in slot ' + alsoMain.pooled + ' of ' + place.owner + '\'s pool, marked as yours. An owner of ' + place.owner + ' sets its model and the repositories it runs on.');
        view.close.textContent = 'Done';
        readTokenPlace(repo, reading);
        return;
      }
      view.tell(tileName(slot) + ' is saved' + (alsoMain ? ', and as main too, which @claude and the workers read and which was not set yet' : '') + '. Its use shows on its tile after its first run, or press its tile and Read use now.');
      view.close.textContent = 'Done';
      readTokenPlace(repo, reading);
    }).catch(function (e) {
      // a stop has closed the issue and said so already
      if (e.stopped || stopped) return;
      if (issue) closeRunIssue(repo, issue, true);
      over();
      clear(view.step);
      if (e.page) add(view.step, add(el('p', 'admin__bar'), link(e.page, 'Open the workflow Token')));
      var hint = Promise.resolve('');
      if ((step === 'workflow' || step === 'dispatch') && e.status === 404) hint = noTokenWorkflow(repo, view);
      else if ((step === 'workflow' || step === 'dispatch' || step === 'issue') && e.status === 403) hint = Promise.resolve(ACTIONS_NEEDED);
      else if (step === 'secrets' && (e.status === 403 || e.status === 404)) hint = Promise.resolve(secretsNeeded(place));
      hint.then(function (text) { view.tell(e.message + text, true); });
    });
  }
  // the issue's comments from the run, read every three seconds: the link shows the sign-in box, the
  // sealed box ends the wait, and a failure says what the run said
  // GitHub lets a browser keep an issue's comments for 60 seconds (Cache-Control: private,
  // max-age=60), so each read asks at an address of its own, or the sign-in link waits that long
  function followRun(repo, issue, keyId, view, stopped) {
    var until = Date.now() + RUN_FOR_MS, shown = false;
    return new Promise(function (resolve, reject) {
      function look() {
        if (stopped()) { var e = new Error(STOPPED); e.stopped = true; reject(e); return; }
        gh('GET', '/repos/' + repo + '/issues/' + issue + '/comments?per_page=100&at=' + Date.now()).then(function (r) {
          if (stopped()) { var gone = new Error(STOPPED); gone.stopped = true; reject(gone); return; }
          var said = (r.data || []).filter(function (c) { return c && c.user && c.user.login === RUN_BOT; });
          for (var i = 0; i < said.length; i++) {
            var lines = String(said[i].body || '').trim().split('\n');
            if (lines[0] === TOKEN_MARK.failed) { reject(new Error('The run stopped: ' + lines.slice(1).join(' '))); return; }
            if (lines[0] === TOKEN_MARK.stored && !keyId) {
              if (!/^([1-9]|[12][0-9]|3[0-2])$/.test(lines[1] || '')) { reject(new Error('The run said it stored the token, but not in which slot; see the issue, and ask an owner to look at the pool.')); return; }
              resolve({ stored: lines[1] });
              return;
            }
            if (lines[0] === TOKEN_MARK.sealed) {
              if (!keyId || lines[1] !== keyId || !/^[A-Za-z0-9+\/=]{40,}$/.test(lines[2] || '')) { reject(new Error('The run posted a sealed token for another key; nothing was saved. Press Add a Claude account again.')); return; }
              resolve(lines[2]);
              return;
            }
            if (lines[0] === TOKEN_MARK.link && !shown && /^https:\/\/claude\.(ai|com)\//.test(lines[1] || '')) {
              shown = true;
              drawSignIn(repo, issue, lines[1], view);
            }
          }
          if (Date.now() > until) { reject(new Error('The run gave no token within 15 minutes; see its log under the repository\'s Actions, workflow Token.')); return; }
          setTimeout(look, RUN_POLL_MS);
        }, reject);
      }
      setTimeout(look, RUN_POLL_MS);
    });
  }
  function drawSignIn(repo, issue, url, view) {
    var m = view.step;
    clear(m);
    view.tell('Sign in as the Claude account this token is for.');
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
        view.tell('Code sent; the run is making the token, and it is saved here in a few seconds.');
      }, function (e) { send.disabled = false; code.disabled = false; add(m, el('p', 'admin__warn', 'The code could not be sent: ' + e.message)); });
    });
    add(m, el('p', 'admin__lead', '1. Press Sign in to claude.ai, sign in as the account and press Authorize. 2. Copy the code claude.ai shows. 3. Paste it below and send it.'));
    add(m, add(el('p', 'admin__bar'), open), add(el('p', 'admin__bar tkdlg__code'), code, ' ', send));
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
  /* ---------- the tokens as tiles: settings on a click, an X to remove, + Add Token last ---------- */
  // Each token set on the repository's place is a square tile, main first and then the slots, and the
  // dashed + Add Token tile comes last, so tokens fill a row from the left and go on at the next.
  // A tile's settings live in the variable SYMPHONY_CLAUDE_SETTINGS, JSON by slot, which tools/pool.py
  // checks and the workers in Actions follow (docs/setup/claude-tokens.md, "Each token's settings"):
  // the model, the effort, a lesser model for when the model's own weekly limit is spent, and whether
  // the token comes back by itself once its limit resets. The X deletes the token's secret, its label
  // and its settings, and takes it off SYMPHONY_CLAUDE_ACCOUNTS.
  var SETTINGS_VARIABLE = SLOT_PREFIX + 'SETTINGS';
  var TILE_SLOTS = ['main'].concat(POOL_SLOTS);
  // not MODELS, which the cost page's prices hold in the same scope
  var TILE_MODELS = [['', 'The worker\'s own model'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'],
                ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
  var EFFORTS = [['', 'The model\'s default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  // tools/pool.py takes only these models (KNOWN_MODELS), so the page never writes one it would leave out
  function knownModel(m) { return TILE_MODELS.some(function (t) { return t[0] && t[0] === m; }); }
  var tk = { repo: '', place: null, secrets: null, settings: {}, labels: {}, pool: null, admin: false, side: '' };

  // why the signed-in person can add no token where the repository's slots live, said before the
  // press, since GitHub would refuse the first write with a bare 403
  function cannotAdd() {
    var place = tk.place;
    if (!place) return '';
    if (place.org) {
      if (tk.admin || place.push !== false) return '';
      return 'Adding a token to ' + place.owner + '\'s pool takes write access to this repository, which you do not have. Ask an owner of ' + place.owner + ' to share it with you, or pick a repository of your own in the Repository box.';
    }
    if (place.admin !== false) return '';
    return 'Only ' + place.owner + ', who owns this repository, can add its tokens. Pick a repository of your own in the Repository box.';
  }
  // someone who may write to an organization's repository but is not an owner of the organization,
  // whom GitHub lets write none of its secrets: the Token run stores their token in a free slot of the
  // pool itself, with the App's key, marked as theirs (the owner's choice of 2026-10-18)
  function intoPool(place) { return !!place && place.org && tk.admin === false; }
  function ownerOf(slot) { return (tk.settings[slot] || {}).owner || ''; }
  function canChange(slot) {
    return tk.admin || (!!shownLogin && ownerOf(slot).toLowerCase() === shownLogin.toLowerCase());
  }
  // eight hex digits, as tools/pool.py's TOKEN_ID, made once per token and kept while it is renewed
  function newTokenId() {
    var bytes = new Uint8Array(4);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  function tileName(slot) { return tk.labels[slot] || (slot === 'main' ? 'Main' : 'Slot ' + slot); }
  function modelWord(model) {
    for (var i = 0; i < TILE_MODELS.length; i++) if (TILE_MODELS[i][0] === (model || '')) return i ? TILE_MODELS[i][1] : 'Worker\'s model';
    return model;
  }
  function familyOf(model) {
    var m = /(fable|opus|sonnet|haiku)/.exec(model || '');
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null;
  }
  // whether a reading after resumedAt saw the token at its limit, for one that does not resume by itself
  function tripped(records, since) {
    var from = since ? moment(since) : null;
    return (records || []).some(function (r) {
      if (from != null && moment(r.at) < from) return false;
      var seen = Object.keys(r.windows || {}).map(function (k) { return r.windows[k]; }).concat(Array.isArray(r.scoped) ? r.scoped : []);
      return seen.some(function (each) { return each && (used(each.utilization) || 0) >= POOL_THRESHOLD; });
    });
  }
  // the tile's state as tools/pool.py's slot_state reads it: paused, waiting for Resume, held, on its
  // fallback, free, or not read yet
  function tileState(slot) {
    var s = tk.settings[slot] || {};
    if (s.paused) return { text: 'Paused', cls: 'tok__state--warn' };
    var records = tk.pool && tk.pool[slot];
    if (s.resume === false && tripped(records, s.resumedAt)) return { text: 'Waiting for Resume', cls: 'tok__state--warn' };
    if (!records) return { text: tk.pool ? 'Not read yet' : '', cls: '' };
    var now = Date.now(), found = slotWindows(records, now);
    var general = heldUntil({ windows: found.windows, scoped: [] }, now);
    if (general) return { text: 'Held until ' + stamp(new Date(general).toISOString()), cls: 'tok__state--warn' };
    var fam = familyOf(s.model);
    var own = heldUntil({ windows: {}, scoped: found.scoped.filter(function (x) { return !fam || x.name === fam; }) }, now);
    if (!own) return { text: 'Free', cls: 'tok__state--go' };
    if (s.fallback && s.fallback !== s.model) return { text: 'On ' + modelWord(s.fallback), cls: 'tok__state--go' };
    return { text: 'Model held until ' + stamp(new Date(own).toISOString()), cls: 'tok__state--warn' };
  }

  function readTileVariables(place) {
    var settings = readOne(place.base + '/variables/' + SETTINGS_VARIABLE).then(function (v) {
      try {
        var data = v ? JSON.parse(v.value) : {};
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch (e) { return {}; }
    });
    var labels = listed(place.base + '/variables', 'variables').then(function (list) {
      var out = {};
      list.forEach(function (v) {
        var m = /^SYMPHONY_CLAUDE_([1-9]|[12][0-9]|3[0-2])_LABEL$/.exec(v.name || '');
        if (m && SLOT_LABEL.test(v.value || '')) out[m[1]] = v.value;
      });
      return out;
    });
    return Promise.all([settings.catch(function () { return {}; }), labels.catch(function () { return {}; })]);
  }

  function drawTiles() {
    var box = $('tk-tiles');
    if (!box) return;
    clear(box);
    if (!tk.place) { none(box, 'Reading the tokens...'); return; }
    var unread = !tk.secrets || tk.secrets.unread;
    if (!unread) TILE_SLOTS.filter(function (slot) { return tk.secrets[slotSecret(slot)]; }).forEach(function (slot) { add(box, tileOf(slot)); });
    var plus = el('button', 'tok__open tok--add');
    plus.type = 'button';
    plus.id = 'tk-tile-add';
    var waiting = tokenRun && tokenRun.era === ends;
    add(plus, el('span', 'tok__plus', waiting ? '\u2026' : '+'), el('span', 'tok__name', waiting ? 'Sign-in waiting' : 'Add Token'));
    plus.addEventListener('click', function () { if (tokenRun && tokenRun.era === ends) tokenRun.view.show(''); else openTokenDialog('', true); });
    add(box, add(el('div', 'tok'), plus));
    if (unread && intoPool(tk.place)) add(box, el('p', 'admin__none toks__note', 'Only an owner of ' + tk.place.owner + ' sees the tokens in its pool; Add Token puts yours in a free slot, marked as yours.'));
    else if (unread) add(box, el('p', 'admin__none toks__note', 'GitHub would not list the secrets' + (tk.secrets && tk.secrets.unread ? ' (' + tk.secrets.unread.message + ')' : '') + ', so the tokens set are not shown.'));
    drawSide();
  }

  // The side panel: one token's use, each window's reset, the per-model limits, where it is on and
  // who it belongs to, kept open while the tiles are read again
  function openTokenSide(slot) {
    tk.side = tk.side === slot ? '' : slot;
    drawTiles();
  }
  function drawSide() {
    var side = $('tk-side');
    if (!side) return;
    var slot = tk.side;
    if (!slot || !tk.secrets || tk.secrets.unread || !tk.secrets[slotSecret(slot)]) { tk.side = ''; side.hidden = true; clear(side); return; }
    clear(side);
    side.hidden = false;
    add(side, splitGrip('tkside', 'this panel'));
    var s = tk.settings[slot] || {}, state = tileState(slot);
    var close = el('button', 'tkside__close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { openTokenSide(slot); });
    add(side, close, el('h3', 'console__boxh', tileName(slot)), el('p', 'tok__owner', s.owner ? '@' + s.owner : 'no owner yet'));
    if (state.text) add(side, el('p', 'tok__state ' + state.cls, state.text));
    var records = tk.pool && tk.pool[slot];
    if (records) {
      var found = slotWindows(records, Date.now());
      POOL_WINDOWS.forEach(function (p) { add(side, sideMeter(p[1], found.windows[p[0]])); });
      found.scoped.forEach(function (x) { add(side, sideMeter(x.name + ' weekly', x)); });
      var last = records.map(function (r) { return r.at; }).sort().pop();
      add(side, add(el('p', 'tkdlg__fact tkdlg__faint'), 'Read ', timeEl(last), ' from ' + records.map(function (r) { return sourceWord(r.source); }).filter(function (w, i, a) { return a.indexOf(w) === i; }).join(', ')));
    } else add(side, el('p', 'admin__none', 'No reading yet: its first run, or Read use now, takes one.'));
    add(side, el('p', 'tkdlg__fact', 'Runs on ' + modelWord(s.model) + (s.effort ? ', thinking ' + s.effort : '') + (s.fallback ? '; then ' + modelWord(s.fallback) + ' when its model\'s weekly limit runs out' : '') + '.'));
    add(side, el('p', 'tkdlg__fact', s.paused ? 'Paused.' : s.resume === false ? 'Waits for Resume once at its limit.' : 'Resumes by itself when its limit resets.'));
    add(side, el('p', 'tkdlg__fact tkdlg__faint', slotSecret(slot) + (tk.secrets[slotSecret(slot)].updated_at ? ', set ' + stamp(tk.secrets[slotSecret(slot)].updated_at) : '')));
    var probe = btn('Read use now', true, probeSlots);
    probe.id = 'tk-probe';
    probe.title = 'Asks every token for one word on Haiku, which spends that word of each one\'s window';
    add(side, add(el('p', 'admin__bar'), probe));
  }
  function sideMeter(name, each) {
    var u = each ? used(each.utilization) : null;
    var box = el('div', 'tkside__meter');
    var bar = el('span', 'tok__bar' + (u != null && u >= POOL_THRESHOLD ? ' tok__bar--full' : ''));
    var fill = el('span', 'tok__fill');
    fill.style.width = (u == null ? 0 : Math.round(Math.min(u, 1) * 100)) + '%';
    add(bar, fill);
    var resets = each && each.resetsAt ? (each.reset ? 'reset ' : 'resets ') + stamp(new Date(moment(each.resetsAt)).toISOString()) : (each ? 'reset not known' : 'not read yet');
    add(box, add(el('p', 'tkside__line'), el('span', '', name), el('span', 'tkside__pct', u == null ? '' : percent(u))), bar, el('p', 'tkside__reset', resets));
    return box;
  }
  function tileOf(slot) {
    var s = tk.settings[slot] || {}, state = tileState(slot);
    var wrap = el('div', 'tok');
    var open = el('button', 'tok__open');
    open.type = 'button';
    open.id = 'tk-tile-' + slot;
    open.title = 'The use of ' + tileName(slot) + ' (' + slotSecret(slot) + ')';
    if (tk.side === slot) wrap.className += ' tok--on';
    add(open, el('span', 'tok__icon', slot === 'main' ? 'M' : slot), el('span', 'tok__name', tileName(slot)),
        el('span', 'tok__owner', s.owner ? '@' + s.owner : 'no owner yet'),
        el('span', 'tok__meta', modelWord(s.model) + (s.effort ? ', ' + s.effort : '')),
        useBars(slot), state.text ? el('span', 'tok__state ' + state.cls, state.text) : null);
    open.addEventListener('click', function () { openTokenSide(slot); });
    if (!canChange(slot)) return add(wrap, open);
    var gear = el('button', 'tok__gear', '\u2699');
    gear.type = 'button';
    gear.id = 'tk-gear-' + slot;
    gear.title = 'Settings of ' + tileName(slot);
    gear.setAttribute('aria-label', 'Settings of ' + tileName(slot));
    gear.addEventListener('click', function (ev) { ev.stopPropagation(); openTokenDialog(slot, false); });
    var x = el('button', 'tok__x', '\u00d7');
    x.type = 'button';
    x.id = 'tk-remove-' + slot;
    x.title = 'Remove ' + tileName(slot);
    x.setAttribute('aria-label', 'Remove ' + tileName(slot));
    x.addEventListener('click', function (ev) { ev.stopPropagation(); removeToken(slot, x); });
    return add(wrap, open, gear, x);
  }

  function useBars(slot) {
    var records = tk.pool && tk.pool[slot];
    if (!records) return null;
    var found = slotWindows(records, Date.now());
    var box = el('span', 'tok__use');
    POOL_WINDOWS.forEach(function (p) {
      var each = found.windows[p[0]], u = each ? used(each.utilization) : null;
      var bar = el('span', 'tok__bar' + (u != null && u >= POOL_THRESHOLD ? ' tok__bar--full' : ''));
      bar.title = p[1] + ': ' + windowText(each);
      var fill = el('span', 'tok__fill');
      fill.style.width = (u == null ? 0 : Math.round(Math.min(u, 1) * 100)) + '%';
      add(box, add(el('span', 'tok__window'), el('span', 'tok__wname', p[0] === 'five_hour' ? '5h' : '7d'), add(bar, fill)));
    });
    return box;
  }
  function selectOf(id, options, value) {
    var s = el('select');
    s.id = id;
    options.forEach(function (o) {
      var opt = el('option', '', o[1]);
      opt.value = o[0];
      if (o[0] === (value || '')) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }
  function labelled(input, text) {
    var l = el('label', '', text);
    l.htmlFor = input.id;
    return add(el('div', 'tkdlg__field'), l, input);
  }
  function tickOf(id, checked, text) {
    var c = el('input');
    c.type = 'checkbox';
    c.id = id;
    c.checked = !!checked;
    var l = add(el('label', 'tkdlg__tick'), c, ' ' + text);
    return l;
  }
  // one dialog for a tile's settings and for adding a token, which saves the settings first and then
  // starts the sign-in for that slot
  function openTokenDialog(slot, adding) {
    var d = $('tk-dialog');
    if (!d || !tk.place) { say('The tokens are still being read; press again in a moment.'); return; }
    clear(d);
    var s = tk.settings[slot] || {};
    var form = el('form', 'tkdlg__form');
    form.method = 'dialog';
    add(form, el('h3', 'console__boxh', adding ? 'Add a token' : tileName(slot)));
    if (adding && intoPool(tk.place)) { drawPoolAdd(d, form); return; }
    var free = TILE_SLOTS.filter(function (n) { return !tk.secrets || tk.secrets.unread || !tk.secrets[slotSecret(n)]; });
    if (adding) {
      // a personal repository's first token is its main one, which @claude and the workers read and
      // which needs no variable; elsewhere main stays for last
      var mainFree = free.indexOf('main') >= 0;
      slot = (!tk.place.org && mainFree) ? 'main' : (free.filter(function (n) { return n !== 'main'; })[0] || free[0] || '');
      if (!slot) add(form, el('p', 'admin__lead', 'All 32 slots and main are set: remove one with its \u00d7, or renew one from its tile.'));
    } else if (!canChange(slot)) { drawSomeoneElses(d, form, slot); return; }
    var label = el('input');
    label.id = 'tk-d-label';
    label.type = 'text';
    label.maxLength = 40;
    label.autocomplete = 'off';
    label.placeholder = 'a word of your own, never an e-mail address';
    label.value = tk.labels[slot] || '';
    var labelField = labelled(label, 'Name');
    add(form, labelField);
    var model = selectOf('tk-d-model', TILE_MODELS, s.model);
    var effort = selectOf('tk-d-effort', EFFORTS, s.effort);
    var fallback = selectOf('tk-d-fallback', [['', 'Don\'t switch']].concat(TILE_MODELS.slice(1)), s.fallback);
    add(form, add(el('div', 'tkdlg__row'), labelled(model, 'Model'), labelled(effort, 'Thinking strength')));
    add(form, labelled(fallback, 'When its model\'s weekly limit runs out, switch to'));
    add(form, tickOf('tk-d-resume', s.resume !== false, 'Resume by itself when its limit resets'));
    add(form, tickOf('tk-d-paused', s.paused, 'Pause: auto passes this token over'));
    labelField.hidden = slot === 'main';
    var owner = null;
    if (tk.admin) {
      owner = el('input');
      owner.id = 'tk-d-owner';
      owner.type = 'text';
      owner.maxLength = 39;
      owner.autocomplete = 'off';
      owner.value = s.owner || (adding ? shownLogin : '');
      add(form, labelled(owner, 'Belongs to (a GitHub login)'));
    } else add(form, el('p', 'admin__lead tkdlg__faint', adding ? 'It will be yours: only you and an owner of ' + tk.place.owner + ' can change or remove it.' : 'Yours: only you and an owner of ' + tk.place.owner + ' can change or remove it.'));
    add(form, el('p', 'admin__lead tkdlg__note', 'Runs on this token follow these from their next start.'));
    var problem = el('p', 'admin__warn tkdlg__problem');
    problem.hidden = true;
    add(form, problem);
    function chosen() {
      var out = {};
      if (model.value) out.model = model.value;
      if (effort.value) out.effort = effort.value;
      if (fallback.value && fallback.value !== model.value) out.fallback = fallback.value;
      var resume = $('tk-d-resume').checked;
      if (!resume) {
        out.resume = false;
        // turning resume off starts the count afresh, so a reading taken before it holds nothing
        out.resumedAt = s.resume === false && s.resumedAt ? s.resumedAt : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      }
      if ($('tk-d-paused').checked) out.paused = true;
      out.id = s.id || newTokenId();
      var who = owner ? owner.value.trim() : (s.owner || (adding ? shownLogin : ''));
      if (who) out.owner = who;
      return out;
    }
    function check() {
      var text = label.value.trim();
      if (text && !SLOT_LABEL.test(text)) return 'A name is a word or a few, of letters, digits, blanks, dots, dashes and underscores, at most 40, never an e-mail address.';
      if (owner && owner.value.trim() && !LOGIN.test(owner.value.trim())) return 'Belongs to takes a GitHub login, such as ' + (shownLogin || 'octocat') + '.';
      return '';
    }
    function fail(e) { problem.hidden = false; problem.textContent = e.message + (e.status === 403 || e.status === 404 ? secretsNeeded(tk.place) : ''); }
    var bar = el('p', 'admin__bar tkdlg__bar');
    var cancel = btn('Cancel', true, function () { d.close(); });
    var save = el('button', 'console__primary', adding ? 'Save and sign in' : 'Save');
    save.type = 'button';
    save.id = adding ? 'tk-start' : 'tk-save';
    if (adding && !slot) save.disabled = true;
    var barred = adding && cannotAdd();
    if (barred) { save.disabled = true; problem.hidden = false; problem.textContent = barred; }
    save.addEventListener('click', function () {
      var why = check();
      if (why) { problem.hidden = false; problem.textContent = why; return; }
      save.disabled = true;
      var wanted = slot, labelText = wanted === 'main' ? '' : label.value.trim();
      saveTokenSettings(wanted, chosen(), labelText).then(function () {
        drawTiles();
        if (adding) { addByActions(tk.repo, tk.place, $('tk-tile-add') || save, wanted); return; }
        d.close();
        say('Saved the settings of ' + tileName(wanted) + '; its runs follow them from their next start.');
      }, function (e) { save.disabled = false; fail(e); });
    });
    add(bar, cancel, ' ', save);
    if (!adding && tk.place.org) add(form, reachBox(slot));
    if (!adding) {
      if (s.resume === false) {
        var resume = btn('Resume now', true, function () {
          resume.disabled = true;
          var next = chosen();
          next.resumedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          delete next.paused;
          saveTokenSettings(slot, next, tk.labels[slot] || '').then(function () { d.close(); drawTiles(); say(tileName(slot) + ' is back in the pool from the workers\' next run.'); },
            function (e) { resume.disabled = false; fail(e); });
        });
        resume.id = 'tk-resume';
        add(bar, ' ', resume);
      }
      var renew = btn('Sign in again to renew', true, function () { addByActions(tk.repo, tk.place, renew, slot); });
      renew.id = 'tk-renew';
      add(bar, ' ', renew);
    }
    add(form, bar);
    add(d, form);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    model.focus();
  }

  // Add Token for someone who is not an owner of the organization: no settings to save, since only an
  // owner may write them; the run picks the free slot and marks it as theirs
  function drawPoolAdd(d, form) {
    var problem = el('p', 'admin__warn tkdlg__problem');
    var barred = cannotAdd();
    problem.hidden = !barred;
    problem.textContent = barred;
    add(form, el('p', 'admin__lead', 'Your Claude token goes into the next free slot of ' + tk.place.owner + '\'s pool, marked as yours. The sign-in runs on GitHub Actions in ' + tk.repo + ', and the token is never shown on this page, in the issue or in the log.'));
    add(form, el('p', 'admin__lead tkdlg__faint', 'An owner of ' + tk.place.owner + ' sets its model and the repositories it runs on, and can remove it.'));
    add(form, problem);
    var save = el('button', 'console__primary', 'Sign in');
    save.type = 'button';
    save.id = 'tk-start';
    save.disabled = !!barred;
    save.addEventListener('click', function () { save.disabled = true; addByActions(tk.repo, tk.place, $('tk-tile-add') || save, ''); });
    add(form, add(el('p', 'admin__bar tkdlg__bar'), btn('Cancel', true, function () { d.close(); }), ' ', save));
    add(d, form);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function drawSomeoneElses(d, form, slot) {
    var s = tk.settings[slot] || {};
    add(form, el('p', 'tkdlg__fact', 'Model: ' + modelWord(s.model) + (s.effort ? ', thinking ' + s.effort : '') + (s.fallback ? '; switches to ' + modelWord(s.fallback) + ' when its model\'s weekly limit runs out' : '')));
    add(form, el('p', 'tkdlg__fact', s.paused ? 'Paused.' : s.resume === false ? 'Waits for Resume once at its limit.' : 'Resumes by itself when its limit resets.'));
    add(form, el('p', 'admin__lead tkdlg__faint', (s.owner ? 'This token belongs to @' + s.owner : 'This token has no owner yet') + '; only ' + (s.owner ? 'they' : 'the person who adds it') + ' and an owner of ' + tk.place.owner + ' can change or remove it.'));
    add(form, add(el('p', 'admin__bar tkdlg__bar'), btn('Close', true, function () { d.close(); })));
    add(d, form);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  // The repositories a token is on: an organization secret's own list of repositories, which GitHub
  // keeps, so switching one is a single call and takes effect at the next run there.
  function reachBox(slot) {
    var box = el('div', 'tkdlg__reach');
    add(box, el('p', 'tkdlg__fact', 'On in these repositories'));
    var list = el('div', 'tkdlg__repos');
    add(box, list);
    none(list, 'Reading...');
    var path = tk.place.base + '/secrets/' + slotSecret(slot);
    readOne(path).then(function (have) {
      if (!have) throw new Error('GitHub does not list this token\'s secret');
      if (have.visibility !== 'selected') {
        clear(list);
        none(list, have.visibility === 'all' ? 'On in every repository of ' + tk.place.owner + '.' : 'On in every private repository of ' + tk.place.owner + '.');
        return null;
      }
      return listed(path + '/repositories', 'repositories');
    }).then(function (on) {
      if (!on) return;
      clear(list);
      var mine = repos().filter(function (r) { return r.split('/')[0].toLowerCase() === tk.place.owner.toLowerCase(); });
      var rows = on.map(function (r) { return { name: r.full_name, id: r.id, on: true }; });
      mine.forEach(function (name) { if (!rows.some(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })) rows.push({ name: name, id: null, on: false }); });
      rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
      rows.forEach(function (r, i) { add(list, reachTick(path, r, i)); });
    }).catch(function (e) { clear(list); none(list, 'Could not read where it is on: ' + e.message); });
    return box;
  }
  function reachTick(path, r, i) {
    var label = tickOf('tk-d-repo-' + i, r.on, r.name);
    var tick = label.querySelector('input');
    tick.addEventListener('change', function () {
      tick.disabled = true;
      var id = r.id ? Promise.resolve(r.id) : gh('GET', '/repos/' + r.name).then(function (x) { return (r.id = x.data.id); });
      id.then(function (n) {
        return gh(tick.checked ? 'PUT' : 'DELETE', path + '/repositories/' + n);
      }).then(function () {
        tick.disabled = false;
        say(r.name + (tick.checked ? ' can use this token from its next run.' : ' no longer sees this token.'));
      }, function (e) {
        tick.disabled = false;
        tick.checked = !tick.checked;
        say('Could not switch it on ' + r.name + ': ' + e.message + (e.status === 403 || e.status === 404 ? secretsNeeded(tk.place) : ''), true);
      });
    });
    return label;
  }

  /* ---------- which tokens an agent takes in one repository ---------- */
  // The Agents tab gives each agent (a worker by name in accounts.json) a share of the repository's
  // tokens: its line becomes a list of slots, which tools/pool.py picks over as auto picks over the
  // pool, main only where the list names it. The list belongs to the repository, so anyone who may
  // write to it may change it, through a pull request as every change under .github/ is made; who
  // may switch a token on for the repository at all stays its owner's (reachBox).
  var ASSIGN_BRANCH = 'symphony/tokens-';
  var AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  function assignedSlots(choice, pooled) {
    if (Array.isArray(choice)) return choice.filter(function (s) { return TILE_SLOTS.indexOf(s) >= 0; });
    if (choice === 'auto') return pooled.slice();
    return TILE_SLOTS.indexOf(choice) >= 0 ? [choice] : ['main'];
  }
  // the tokens the repository can use, by name: the Tokens tab's own reading where it is of this
  // repository, else the organization's lists, else the ones GitHub shows the repository
  function usableTokens(repo) {
    if (tk.repo === repo && tk.secrets && !tk.secrets.unread) {
      return readAccounts(tk.place, repo).then(function (pooled) {
        return { pooled: pooled, slots: TILE_SLOTS.filter(function (s) { return tk.secrets[slotSecret(s)]; }), labels: tk.labels };
      });
    }
    var place;
    return slotPlace(repo).then(function (p) {
      place = p;
      return readSecrets(place).catch(function () {
        return Promise.all([
          place.org ? listed('/repos/' + repo + '/actions/organization-secrets', 'secrets') : Promise.resolve([]),
          listed('/repos/' + repo + '/actions/secrets', 'secrets').catch(function () { return []; })
        ]).then(function (both) {
          var by = {};
          both[0].concat(both[1]).forEach(function (s) { if (s && s.name) by[s.name] = s; });
          return by;
        });
      });
    }).then(function (secrets) {
      return Promise.all([readTileVariables(place), readAccounts(place, repo)]).then(function (both) {
        return { pooled: both[1], slots: TILE_SLOTS.filter(function (s) { return secrets[slotSecret(s)]; }), labels: both[0][1] };
      });
    });
  }
  function readAccounts(place, repo) {
    return readOne(place.base + '/variables/' + ACCOUNTS_VARIABLE).catch(function () {
      return listed('/repos/' + repo + '/actions/organization-variables', 'variables').then(function (list) {
        return list.filter(function (v) { return v.name === ACCOUNTS_VARIABLE; })[0] || null;
      }, function () { return null; });
    }).then(function (v) { return slotWords(v ? v.value : ''); });
  }
  function assignLabel(slot, labels) {
    return labels[slot] || (slot === 'main' ? 'Main' : 'Slot ' + slot);
  }
  function tokenAssignBox(repo, agentName) {
    var box = el('div', 'tkassign');
    if (!repo || !AGENT_NAME.test(agentName || '') || agentName.indexOf('..') >= 0 || /\.lock$/i.test(agentName)) { none(box, 'No such agent.'); return box; }
    none(box, 'Reading the tokens...');
    Promise.all([usableTokens(repo), readAssignments(repo)]).then(function (both) {
      var found = both[0], plan = both[1];
      clear(box);
      if (plan.broken) { none(box, ASSIGNMENTS_PATH + ' is not JSON, so it is left as it is.'); return; }
      var choice = Object.prototype.hasOwnProperty.call(plan.workers, agentName) ? plan.workers[agentName] : plan['default'];
      var have = assignedSlots(choice, found.pooled);
      if (!found.slots.length) { none(box, 'Runs on the main token: this repository sees no token yet.'); return; }
      var ticks = found.slots.map(function (slot) {
        var label = tickOf('tka-' + agentName + '-' + slot, have.indexOf(slot) >= 0, assignLabel(slot, found.labels));
        if (slot !== 'main' && found.pooled.indexOf(slot) < 0) label.title = 'Not in ' + ACCOUNTS_VARIABLE + ', so no run takes it until it is';
        return { slot: slot, input: label.querySelector('input'), label: label };
      });
      var save = btn('Save', false, function () {
        var list = ticks.filter(function (t) { return t.input.checked; }).map(function (t) { return t.slot; });
        save.disabled = true;
        say('Proposing the tokens of ' + agentName + '...');
        proposeAssignment(repo, agentName, list).then(function (url) {
          clear(note);
          add(note, 'Proposed in ', link(url, 'a pull request'), '; ' + agentName + ' takes them once it merges.');
          say('The tokens of ' + agentName + ' are proposed in a pull request; its runs take them once it merges.');
        }, function (e) {
          save.disabled = false;
          say('Could not propose the tokens of ' + agentName + ': ' + e.message + (e.status === 403 || e.status === 404 ? ' It needs Contents and Pull requests: read and write on ' + repo + '.' : ''), true);
        });
      });
      save.id = 'tka-save-' + agentName;
      save.disabled = true;
      ticks.forEach(function (t) {
        t.input.addEventListener('change', function () { save.disabled = !ticks.some(function (x) { return x.input.checked; }); });
        add(box, t.label);
      });
      var note = el('p', 'tkdlg__fact tkdlg__faint', Array.isArray(choice) ? '' : choice === 'auto' ? 'Now: any token of the pool.' : 'Now: ' + assignLabel(have[0], found.labels) + '.');
      add(box, add(el('p', 'admin__bar'), save), note);
    }).catch(function (e) { clear(box); none(box, 'Could not read the tokens: ' + e.message); });
    return box;
  }
  function utf8Base64(text) { return btoa(unescape(encodeURIComponent(text))); }
  // accounts.json read again on the default branch just before the change, so the change carries
  // whatever merged meanwhile; one branch per agent, moved to the default branch's head each time
  function proposeAssignment(repo, agent, list) {
    var base, head, branch = ASSIGN_BRANCH + agent.toLowerCase();
    return gh('GET', '/repos/' + repo).then(function (r) {
      base = r.data.default_branch || 'main';
      return gh('GET', '/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(base));
    }).then(function (r) {
      head = r.data.object.sha;
      // a pool.py older than the lists would refuse the whole file and stop every worker's run
      return file(repo, 'tools/pool.py', base).catch(function (e) { if (e.status === 404) return ''; throw e; });
    }).then(function (code) {
      if (code.indexOf('def is_choice(') < 0) throw new Error('this repository\'s tools/pool.py does not take a list of tokens yet; bring the template\'s newer tools/pool.py in first');
      return file(repo, ASSIGNMENTS_PATH, base).catch(function (e) { if (e.status === 404) return '{}'; throw e; });
    }).then(function (text) {
      var data = JSON.parse(text || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(ASSIGNMENTS_PATH + ' is not an object');
      data.workers = data.workers && typeof data.workers === 'object' ? data.workers : {};
      data.workers[agent] = list;
      var body = JSON.stringify(data, null, 2) + '\n';
      return gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: head }).catch(function (e) {
        if (e.status !== 422) throw e;
        return gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + branch, { sha: head, force: true });
      }).then(function () {
        return gh('GET', '/repos/' + repo + '/contents/' + ASSIGNMENTS_PATH + '?ref=' + encodeURIComponent(branch)).then(function (r) { return r.data.sha; }, function (e) { if (e.status === 404) return null; throw e; });
      }).then(function (sha) {
        var put = { message: 'Give ' + agent + ' the tokens ' + list.join(', '), content: utf8Base64(body), branch: branch };
        if (sha) put.sha = sha;
        return gh('PUT', '/repos/' + repo + '/contents/' + ASSIGNMENTS_PATH, put);
      });
    }).then(function () {
      return gh('GET', '/repos/' + repo + '/pulls?state=open&head=' + encodeURIComponent(repo.split('/')[0] + ':' + branch));
    }).then(function (r) {
      if (Array.isArray(r.data) && r.data.length) return r.data[0];
      return gh('POST', '/repos/' + repo + '/pulls', { title: 'Give ' + agent + ' its tokens', head: branch, base: base,
        body: 'The control panel\'s Agents tab: ' + agent + ' takes the tokens ' + list.join(', ') + ' in this repository (' + ASSIGNMENTS_PATH + ', a list tools/pool.py picks over as auto picks over the pool).' }).then(function (x) { return x.data; });
    }).then(function (pr) {
      // GitHub merges it once its checks pass where the repository allows auto-merge; else it waits for a press
      return gh('POST', '/graphql', { query: 'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){clientMutationId}}', variables: { id: pr.node_id } })
        .then(function () { return pr.html_url; }, function () { return pr.html_url; });
    });
  }

  // the settings are read again just before the write, so a change another page made meanwhile stays
  function saveTokenSettings(slot, setting, labelText) {
    var place = tk.place, ids = [place.id], path = place.base + '/variables/' + SETTINGS_VARIABLE;
    if ([setting.model, setting.fallback].some(function (m) { return m && !knownModel(m); })) return Promise.reject(new Error('That is not a model the tiles offer.'));
    return readOne(path).then(function (have) {
      var all = {};
      try { all = have ? JSON.parse(have.value) : {}; } catch (e) { all = {}; }
      if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
      if (Object.keys(setting).length) all[slot] = setting; else delete all[slot];
      tk.settings = all;
      return writeVariable(place, SETTINGS_VARIABLE, JSON.stringify(all), ids);
    }).catch(function (e) {
      // a personal repository whose App installation lacks the repository permission Variables
      // still takes its main token, which needs no variable; its settings wait for the permission
      if (!place.org && slot === 'main' && e.status === 403) { tk.noVariables = true; return 'skip'; }
      throw e;
    }).then(function (skipped) {
      if (slot === 'main' || skipped === 'skip') return;
      var name = SLOT_PREFIX + slot + '_LABEL';
      if (labelText) return writeVariable(place, name, labelText, ids).then(function () { tk.labels[slot] = labelText; });
      if (!tk.labels[slot]) return;
      return gh('DELETE', place.base + '/variables/' + name).catch(function (e) { if (e.status !== 404) throw e; }).then(function () { delete tk.labels[slot]; });
    });
  }

  // the X: the secret first, since that is what stops the token being used, then its label, its place
  // in SYMPHONY_CLAUDE_ACCOUNTS and its settings
  function removeToken(slot, button) {
    var place = tk.place, name = slotSecret(slot);
    var where = place.org ? 'the organization ' + place.owner + ', for every repository that sees it' : tk.repo;
    var warn = slot === 'main' ? ' @claude, the workers in Actions and the coordinator workflow stop until ' + MAIN_SECRET + ' is set again.' : '';
    if (!window.confirm('Remove ' + tileName(slot) + '? This deletes the secret ' + name + ' from ' + where + '.' + warn + ' The token itself stays good until it expires; revoke it on claude.ai if it should stop everywhere.')) return;
    button.disabled = true;
    say('Removing ' + name + '...');
    gh('DELETE', place.base + '/secrets/' + name).catch(function (e) { if (e.status !== 404) throw e; }).then(function () {
      if (slot === 'main') return;
      return gh('DELETE', place.base + '/variables/' + SLOT_PREFIX + slot + '_LABEL').catch(function (e) { if (e.status !== 404) throw e; }).then(function () {
        return readOne(place.base + '/variables/' + ACCOUNTS_VARIABLE);
      }).then(function (have) {
        if (!have) return;
        var words = slotWords(have.value).filter(function (w) { return w !== slot; });
        if (!words.length) return gh('DELETE', place.base + '/variables/' + ACCOUNTS_VARIABLE);
        return writeVariable(place, ACCOUNTS_VARIABLE, words.join(','), [place.id]);
      });
    }).then(function () {
      return readOne(place.base + '/variables/' + SETTINGS_VARIABLE);
    }).then(function (have) {
      var all = {};
      try { all = have ? JSON.parse(have.value) : {}; } catch (e) { all = {}; }
      if (!all || typeof all !== 'object' || !(slot in all)) return;
      delete all[slot];
      tk.settings = all;
      return writeVariable(place, SETTINGS_VARIABLE, JSON.stringify(all), [place.id]);
    }).then(function () {
      say(name + ' is removed' + (slot === 'main' ? '.' : ' and off ' + ACCOUNTS_VARIABLE + '.'));
      readTokenPlace(tk.repo, reading);
    }).catch(function (e) {
      button.disabled = false;
      say('Removing ' + name + ' stopped: ' + e.message + (e.status === 403 || e.status === 404 ? secretsNeeded(tk.place) : ''), true);
    });
  }

  // The Tokens tab of the console: the repository is the one the console shows, and the slots are
  // read when the tab opens, or when the console moves to another repository while it is open, so a
  // person who never opens the tab sends none of its reads.
  var tokensFor = null;
  function tokensRepo() { return state && state.repo ? state.repo : ''; }
  function initTokensTab() {
    consoleOnOpen.tokens = function () { if (tokensFor !== tokensRepo()) loadTokens(); };
    if ($('lb-people')) consoleOnOpen.leaders = function () { if (leadersFor !== tokensRepo()) loadLeaders(); };
  }

  /* ---------- the leaderboard: the issues each token worked, by the label token:<id> ---------- */
  // A worker's run labels the issue it worked token:<id> (symphony-template's workers.yml), and the
  // token's settings name its owner, so GitHub's issue search over the organization, or the personal
  // account, counts what each token and each person's tokens worked and closed as done.
  var LEADER_PAGES = 10;
  var leadersFor = null;
  function issuesOf(scope, id) {
    var q = scope + ' label:"token:' + id + '" is:issue';
    var worked = 0, closed = 0;
    function step(page) {
      return gh('GET', '/search/issues?q=' + encodeURIComponent(q) + '&per_page=100&page=' + page).then(function (r) {
        var items = (r.data && r.data.items) || [];
        worked += items.length;
        closed += items.filter(function (i) { return i.state === 'closed' && i.state_reason === 'completed'; }).length;
        if (items.length < 100 || page >= LEADER_PAGES) return { worked: worked, closed: closed };
        return step(page + 1);
      });
    }
    return step(1);
  }
  function rankRows(body, rows, cells) {
    clear(body);
    rows.sort(function (a, b) { return b.closed - a.closed || b.worked - a.worked || a.key.localeCompare(b.key); });
    var top = rows.length ? rows[0].closed : 0;
    rows.forEach(function (r, i) {
      var tr = el('tr');
      add(tr, el('td', '', String(i + 1)));
      cells(r).forEach(function (c) { add(tr, el('td', '', c)); });
      var bar = el('span', 'lb__bar');
      bar.style.width = (top ? Math.round(r.closed / top * 100) : 0) + '%';
      add(tr, add(el('td', 'lb__closed'), add(el('span', 'lb__track'), bar), el('span', 'lb__n', String(r.closed))), el('td', '', String(r.worked)));
      body.appendChild(tr);
    });
  }
  function loadLeaders() {
    var repo = tokensRepo();
    leadersFor = repo;
    var people = $('lb-people').querySelector('tbody'), toks = $('lb-tokens').querySelector('tbody');
    clear(people);
    clear(toks);
    if (!repo) { $('lb-lead').textContent = 'Choose a repository in the side column first.'; return; }
    $('lb-lead').textContent = 'Counting the issues each token worked...';
    var place = null, settings = {}, labels = {};
    slotPlace(repo).then(function (p) {
      place = p;
      return readTileVariables(p);
    }).then(function (vars) {
      settings = vars[0];
      labels = vars[1];
      var slots = Object.keys(settings).filter(function (slot) { return settings[slot] && /^[0-9a-f]{8}$/.test(settings[slot].id || ''); });
      var scope = (place.org ? 'org:' : 'user:') + place.owner;
      // one token at a time, since GitHub's search takes 30 questions a minute
      var out = [];
      return slots.reduce(function (chain, slot) {
        return chain.then(function () {
          return issuesOf(scope, settings[slot].id).then(function (n) { out.push({ slot: slot, worked: n.worked, closed: n.closed }); });
        });
      }, Promise.resolve()).then(function () { return out; });
    }).then(function (counts) {
      if (leadersFor !== repo) return;
      var tokenRows = counts.map(function (c) {
        var s = settings[c.slot];
        return { key: c.slot, name: labels[c.slot] || (c.slot === 'main' ? 'Main' : 'Slot ' + c.slot), owner: s.owner || '', worked: c.worked, closed: c.closed };
      });
      var by = {};
      tokenRows.forEach(function (t) {
        var who = t.owner || '';
        var row = by[who] || (by[who] = { key: who, tokens: 0, worked: 0, closed: 0 });
        row.tokens += 1;
        row.worked += t.worked;
        row.closed += t.closed;
      });
      rankRows(people, Object.keys(by).map(function (k) { return by[k]; }), function (r) { return [r.key ? '@' + r.key : 'no owner yet', String(r.tokens)]; });
      rankRows(toks, tokenRows, function (r) { return [r.name, r.owner ? '@' + r.owner : 'no owner yet']; });
      $('lb-lead').textContent = tokenRows.length
        ? 'Issues the tokens of ' + place.owner + ' worked, by the label token:<id> a worker\'s run puts on them; closed counts those closed as done.'
        : 'No token of ' + place.owner + ' has an id yet: a token gets one when it is added, or when its settings are saved on the Tokens tab.';
    }).catch(function (e) { if (leadersFor === repo) $('lb-lead').textContent = 'The leaderboard could not be read: ' + e.message; });
  }

  /* ============================================================
     The Folders tab (/symphony/control/#folders): a repository that
     tracks files and folders of the person's OneDrive
     ============================================================ */
  // The repository side is the template's tools/drive_sync.py and drive-sync.yml, which read
  // .github/symphony/drive.json and the secret SYMPHONY_DRIVE_REFRESH; this tab writes the two, as
  // the person, for the repository the bar has chosen, and starts the first sync. The drive's
  // consent comes back to the console's own address, the page GitHub's sign-in returns to, with
  // ?code and ?state, so the two returns are told apart by which pending state the returned one
  // matches: the drive's, kept in the tab's storage under a key of its own with its PKCE verifier,
  // or GitHub's. A drive's code never reaches the GitHub sign-in's handler, and GitHub's never
  // reaches the drive's. The drive's tokens live in this page's memory alone: never in the
  // browser's storage, the address or a log, and Track and Forget the token drop them. OneDrive is
  // the one provider for now: Google's Picker takes a browser API key, which the owner declined
  // (2026-10-18), so Google Drive waits for a way that needs none. The tab draws the drive's list
  // itself from Microsoft Graph, since Files.ReadWrite reaches every file and OneDrive's File
  // Picker would need a SharePoint-resource token, an iframe message protocol and a
  // tenant-specific address, and would differ between a personal and a work account. Like the
  // Tokens tab it reads nothing until it is opened, so a person who never opens it sends nothing
  // to the sign-in service's drive routes or about the drive files.
  var KEY_DRIVE = 'symphony_panel_drive_state';
  var DRIVE_FILE = '.github/symphony/drive.json';
  var DRIVE_SECRET = 'SYMPHONY_DRIVE_REFRESH';
  var DRIVE_WORKFLOW = 'drive-sync.yml';
  var DRIVE_BRANCH = 'symphony/drive';
  // the drive organizer's catalog: catalog.json on the branch drive-catalog, a flat list of the
  // drive's folders and files whose paths start with this root; read when no drive is connected
  var CATALOG_FILE = 'catalog.json';
  var CATALOG_BRANCH = 'drive-catalog';
  var CATALOG_ROOT = 'OneDrive';
  var TEMPLATE_NAME = 'OpenSpineConsortium/symphony-template';
  // the console's own address, with its trailing slash: the one redirect the sign-in service's
  // /drive/connect and the Microsoft app registration accept, the same page GitHub returns to
  var DRIVE_RETURN = '/symphony/control/';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var GRAPH_SELECT = '?$select=id,name,folder,file,size,parentReference,lastModifiedDateTime,webUrl&$top=200';
  var GRAPH_PAGES = 10;
  var MS_AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
  var MS_SCOPE = 'Files.ReadWrite offline_access';
  var MS_REFRESH_DAYS = 90;
  var DRIVE_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'session_state', 'admin_consent'];
  // the newest repositories "Find the repository I just made" looks through
  var NEWEST = 10;
  // the folder's shape as drive-sync.yml reads it, one path segment; it ends in no dot or blank,
  // which the workflow's rule admits and Windows refuses
  var FOLDER_NAME = /^[A-Za-z0-9_]([A-Za-z0-9_. -]{0,78}[A-Za-z0-9_])?$/;
  // the connection, in this page's memory alone, with the GitHub account it belongs to; the
  // provider the service listed; what is ticked, and the repository whose file ticked it
  var drive = null;
  var driveConfig = null;
  var driveAsked = false;
  var picked = Object.create(null);
  var pickedOrder = [];
  // the repository whose file put its folder's name in the box
  var prefilled = '';
  // the pull request Track made this sitting for a repository whose default branch takes only those
  var pendingPull = Object.create(null);
  var crumbs = [];
  var tracked = null;
  var folderReading = 0;
  var listing = 0;
  // the repository the tab last read, null when it is to be read again; the connection its list
  // was last drawn for
  var foldersFor = null;
  var listedFor = null;
  // the saved catalog a repository's drive-catalog branch holds, read when no drive is connected and
  // the repository is private; it feeds the same explorer, read-only, with no Track or ticking
  var catalog = null;
  var catalogFor = '';
  var catalogKids = null;
  var catalogMode = false;
  var catalogBusy = false;
  var catalogLoading = 0;
  // The drive's refresh token is sealed in this browser for the repository's public key, as GitHub's
  // own secrets page seals a secret, with the vendored sealed box (tweetnacl and blake2b); the Tokens
  // tab no longer seals anything, so the tab keeps the loader and its two base64 helpers itself
  var SEALEDBOX_JS = '/assets/js/vendor/sealedbox.js';
  var sealer = null;
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

  function driveAddress() { return location.origin + DRIVE_RETURN; }
  function foldersRepo() { return state && state.repo ? state.repo : ''; }
  function driveName(provider) { return provider === 'microsoft' ? 'OneDrive' : provider === 'google' ? 'Google Drive' : provider; }
  function dayOf(date) { return date.toISOString().slice(0, 10); }
  function daysAfter(day, days) {
    var d = new Date(day + 'T00:00:00Z');
    if (isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + days);
    return dayOf(d);
  }
  function stripDriveParams(keys) {
    var q = new URLSearchParams(location.search);
    (keys || DRIVE_PARAMS).forEach(function (k) { q.delete(k); });
    var rest = q.toString();
    try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* the address stays */ }
  }
  function syncLink(repo) { return 'https://github.com/' + repo + '/actions/workflows/' + DRIVE_WORKFLOW; }
  // a repository anyone can read: what comes down from the drive, and drive.json's names, are public there
  function isPublic(meta) { return !!meta && (meta.visibility === 'public' || meta.private === false); }
  // a refusal the page has already put in words, which the catch says as it is
  function plain(text) { var e = new Error(text); e.plain = true; return e; }
  function installationsPage(repo) {
    var org = !!(state && state.meta && state.meta.owner && state.meta.owner.type === 'Organization');
    return org ? 'https://github.com/organizations/' + repo.split('/')[0] + '/settings/installations' : 'https://github.com/settings/installations';
  }
  // GitHub's 403 on a repository's secrets: SymphonyBoard's permission where the person signed in
  // with GitHub, the token's own where they pasted one
  function secretsRefused(repo) {
    if (signedInByApp()) return 'SymphonyBoard cannot reach the secrets of ' + repo + ' (403): it needs the repository permission Secrets (read and write) accepted on its installation, at ' + installationsPage(repo) + '; a fine-grained token with Secrets: Read and write does it meanwhile.';
    return 'This token cannot reach the secrets of ' + repo + ' (403): it needs the repository permission Secrets: Read and write on ' + repo + '.';
  }
  function tabLink(repo) { return location.origin + DRIVE_RETURN + '?repo=' + encodeURIComponent(repo) + '#folders'; }
  function readJson(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function forgetDriveState() {
    try { sessionStorage.removeItem(KEY_DRIVE); } catch (e) { /* nothing kept */ }
  }

  /* ---------- the connection: Microsoft's consent, and the drive's tokens in memory ---------- */
  // The connection belongs to the GitHub account the page named when Connect OneDrive was pressed,
  // or, pressed while it named nobody, the first it names after the return; another account named
  // since, in this tab or by another tab's token, finds no drive,
  // so one person's refresh token is never sealed into another's repository
  function heldDrive() {
    if (!drive) return null;
    if (!drive.login) drive.login = shownLogin;
    else if (shownLogin && drive.login !== shownLogin) dropDrive();
    return drive;
  }
  // the drive, what was ticked in it and its list go with the sign-in they were made under
  function dropDrive() {
    drive = null;
    picked = Object.create(null);
    pickedOrder = [];
    prefilled = '';
    crumbs = [];
    resetExplorer();
    tracked = null;
    listedFor = null;
    foldersFor = null;
    pendingPull = Object.create(null);
    catalogMode = false; catalog = null; catalogFor = ''; catalogBusy = false;
    if (!$('fd-browser')) return;
    clear($('fd-tracked'));
    drawPicked();
    drawBrowser();
    showConnectState();
  }
  function readDriveConfig() {
    var ask = { signal: within(20000) };
    function unreachable() { throw new Error('The sign-in service could not be reached.'); }
    return fetch(SIGNIN_SERVICE + '/drive/config', ask).catch(unreachable).then(function (r) {
      return r.text().catch(unreachable).then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok || !data || typeof data !== 'object') throw new Error('The sign-in service answered ' + r.status + ' when asked which drives it is set up for.');
        return data;
      });
    });
  }
  function showConnectState() {
    var button = $('fd-connect'), note = $('fd-connect-note');
    // the next step's button is the one filled: Connect until a drive is held, then Track
    button.classList.toggle('console__primary', !drive);
    $('fd-track').classList.toggle('console__primary', !!drive);
    if (drive) {
      button.disabled = false;
      button.textContent = 'Connect OneDrive again';
      note.textContent = 'Connected to ' + driveName(drive.provider) + (drive.owner ? ' as ' + drive.owner : '') + ', for this page until Track, a sign-out or a reload.';
      return;
    }
    button.textContent = 'Connect OneDrive';
    if (!signinAvailable()) { button.disabled = true; note.textContent = 'Connecting a drive goes through the sign-in service, which the page does not name yet.'; return; }
    if (!driveConfig) { button.disabled = false; note.textContent = ''; return; }
    if (!driveConfig.microsoft || !driveConfig.microsoft.client_id) { button.disabled = true; note.textContent = 'The owner has not set OneDrive up on the sign-in service yet, so this button cannot be pressed.'; return; }
    button.disabled = false;
    note.textContent = '';
  }
  // asked once a load, when the tab first opens; a failed ask is asked again on the next opening
  // or by Connect OneDrive
  function wireConnect() {
    if (!signinAvailable()) { showConnectState(); return; }
    driveAsked = true;
    readDriveConfig().then(function (c) { driveConfig = c; showConnectState(); }, function (e) {
      driveConfig = null;
      driveAsked = false;
      showConnectState();
      $('fd-connect-note').textContent = 'The sign-in service could not say whether OneDrive is set up (' + e.message + '); press Connect OneDrive to ask it again.';
    });
  }
  // PKCE as the GitHub sign-in does it, with a state of the drive's own, so that the return is told
  // apart from a GitHub sign-in's; the console's own query (?repo=) travels and comes back
  function startDriveConnect() {
    if (!signinAvailable()) { say('Connecting a drive goes through the sign-in service, which the page does not name yet.', true); return; }
    if (!window.crypto || !crypto.subtle || !crypto.getRandomValues) { say('This browser cannot make the connection\'s secret (no Web Crypto).', true); return; }
    var button = $('fd-connect');
    button.disabled = true;
    (driveConfig ? Promise.resolve(driveConfig) : readDriveConfig()).then(function (c) {
      driveConfig = c;
      if (!c.microsoft || !c.microsoft.client_id) { showConnectState(); say('The owner has not set OneDrive up on the sign-in service yet.', true); return; }
      var state = randomHex(16);
      var verifier = randomHex(32);
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
        var challenge = base64url(new Uint8Array(hash));
        try {
          sessionStorage.setItem(KEY_DRIVE, JSON.stringify({ provider: 'microsoft', state: state, verifier: verifier, back: location.search, login: shownLogin }));
        } catch (e) { button.disabled = false; say('This browser refuses session storage, which the connection needs to come back.', true); return; }
        location.href = MS_AUTHORIZE + '?client_id=' + encodeURIComponent(c.microsoft.client_id)
          + '&response_type=code&response_mode=query&redirect_uri=' + encodeURIComponent(driveAddress())
          + '&scope=' + encodeURIComponent(MS_SCOPE) + '&state=' + encodeURIComponent(state)
          + '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256&prompt=select_account';
      });
    }).catch(function (e) { button.disabled = false; say('The connection could not start: ' + e.message, true); });
  }
  // The return from Microsoft, read when the console loads and before the GitHub sign-in's
  // handler, finishOauth, so that handler never sees a drive's code. Resolves true for a drive's
  // return, whatever came of it, so the console opens the Folders tab once it is ready.
  //   The state is the pending drive connection's: the drive's, exchanged at the service.
  //   A GitHub sign-in is pending: GitHub's, left whole to finishOauth, which tells its own state.
  //   Only a drive connection is pending, with another state: refused and said.
  //   Nothing is pending: Back to an old return, or a crafted link, which the page cannot tell
  //   from GitHub's own; left to finishOauth, which cleans it from the address and otherwise
  //   ignores it, with only Microsoft's own two words taken out here.
  // The code and the state leave the address before anything else, so neither stays in the
  // history, and the query the console had when Connect was pressed is put back.
  function driveReturn() {
    var q = new URLSearchParams(location.search);
    var code = q.get('code'), state = q.get('state'), error = q.get('error'), description = q.get('error_description') || '';
    if (!code && !error) return Promise.resolve(false);
    var kept = readJson(KEY_DRIVE), github = readJson(KEY_STATE);
    var ours = !!(kept && state && kept.state === state && kept.verifier);
    if (!ours && github) {
      // GitHub's own return: a drive connection still pending beside it was abandoned
      if (kept && github.state === state) forgetDriveState();
      return Promise.resolve(false);
    }
    // the drive's own return: a GitHub sign-in still pending beside it was abandoned
    if (ours && github) { try { sessionStorage.removeItem(KEY_STATE); } catch (e) { /* nothing kept */ } }
    if (!kept) { stripDriveParams(['session_state', 'admin_consent']); return Promise.resolve(false); }
    forgetDriveState();
    stripDriveParams();
    restoreQuery(kept.back);
    if (!ours) {
      say('The OneDrive connection did not come back the way it left (its state differs), so nothing was exchanged; press Connect OneDrive to start it again.', true);
      return Promise.resolve(true);
    }
    if (error) { say('Microsoft did not connect the drive (' + error.slice(0, 64) + (description ? ': ' + description.slice(0, 200) : '') + '). Press Connect OneDrive to try again.', true); return Promise.resolve(true); }
    if (!signinAvailable()) return Promise.resolve(true);
    say('Connecting OneDrive...');
    return exchange('/drive/connect', { provider: kept.provider, code: code, code_verifier: kept.verifier, redirect_uri: driveAddress() }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without the drive\'s access token.');
      if (!answer.refresh_token) throw new Error('Microsoft gave no refresh token, so the sync could not run: the consent did not include keeping access when you are away.');
      drive = { provider: kept.provider, access: answer.access_token, refresh: answer.refresh_token, expiresAt: Date.now() + (Number(answer.expires_in) || 3600) * 1000, owner: '', id: '', login: typeof kept.login === 'string' ? kept.login : '' };
      say('OneDrive is connected for this page. Tick what to track in the list.');
      return true;
    }).catch(function (e) { say(e.message + ' Press Connect OneDrive to try again.', true); return true; });
  }
  // the access token for a Graph call, renewed through the service when its hour is nearly up
  function driveAccess() {
    var d = heldDrive();
    if (!d) return Promise.reject(new Error('No drive is connected to this page: press Connect OneDrive first.'));
    if (Date.now() < d.expiresAt - 60000) return Promise.resolve(d.access);
    return exchange('/drive/token', { provider: d.provider, refresh_token: d.refresh }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without an access token.');
      if (drive !== d) throw new Error('The connection changed while its token was renewed.');
      d.access = answer.access_token;
      d.expiresAt = Date.now() + (Number(answer.expires_in) || 3600) * 1000;
      return d.access;
    });
  }
  function graph(url) {
    return driveAccess().then(function (access) {
      // a full address is Graph's next page, and the token goes to Graph alone
      var full = url.indexOf(GRAPH + '/') === 0 ? url : GRAPH + url;
      return fetch(full, { headers: { 'Authorization': 'Bearer ' + access, 'Accept': 'application/json' }, signal: within(30000) }).catch(function () { throw new Error('Microsoft Graph could not be reached.'); });
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var m = data && data.error && data.error.message ? ': ' + String(data.error.message).slice(0, 200) : '';
          if (r.status === 401) throw new Error('Microsoft refused the drive\'s token (401' + m + '); press Connect OneDrive again.');
          throw new Error('Microsoft Graph answered ' + r.status + m + '.');
        }
        return data || {};
      });
    });
  }
  // the children of a folder, page after page as Graph gives them; .cut says when more were left
  function graphChildren(url) {
    var out = [];
    function step(next, left) {
      return graph(next).then(function (page) {
        if (Array.isArray(page.value)) out = out.concat(page.value);
        var more = page['@odata.nextLink'];
        if (more && (left <= 1 || typeof more !== 'string' || more.indexOf(GRAPH + '/') !== 0)) { out.cut = true; return out; }
        return more ? step(more, left - 1) : out;
      });
    }
    return step(url, GRAPH_PAGES);
  }
  function nameDrive() {
    return graph('/me/drive?$select=id,driveType,owner').then(function (d) {
      if (!drive) return;
      var who = d.owner && d.owner.user ? d.owner.user.displayName : '';
      drive.owner = (who || '') + (d.driveType ? ' (' + d.driveType + ')' : '');
      drive.id = typeof d.id === 'string' ? d.id : '';
      drive.type = typeof d.driveType === 'string' ? d.driveType : '';
      showConnectState();
    }).catch(function () { /* the name is a nicety; the list says the rest */ });
  }

  /* ---------- the drive's list, drawn here, and what is ticked ---------- */
  function itemOf(it) {
    return { id: String(it.id || ''), name: String(it.name || ''), drive: it.parentReference && it.parentReference.driveId ? String(it.parentReference.driveId) : '' };
  }
  // an item ticked in the drive's list is the person's own; one a repository's file ticked carries
  // that repository's name, so choosing another repository lets it go
  function tick(it, on, from) {
    if (catalogMode) return;
    var item = itemOf(it);
    if (!item.id) return;
    if (on && !picked[item.id]) { item.from = from || ''; picked[item.id] = item; pickedOrder.push(item.id); }
    if (!on && picked[item.id]) { delete picked[item.id]; pickedOrder = pickedOrder.filter(function (id) { return id !== item.id; }); }
    drawPicked();
  }
  function drawPicked() {
    var list = $('fd-picked');
    clear(list);
    pickedOrder.forEach(function (id) {
      var item = picked[id];
      var li = add(el('li'), el('code', '', item.name));
      add(li, btn('Untick', true, function () { tick(item, false); }));
      list.appendChild(li);
    });
    $('fd-picked-head').textContent = pickedOrder.length ? 'Ticked, ' + plural(pickedOrder.length, 'item') + ':' : 'Nothing ticked yet.';
    // the drive's list shows what is ticked, whichever answered first, the drive's or the repository's
    Array.prototype.forEach.call(document.querySelectorAll('#fd-items input[data-id]'), function (box) { box.checked = !!picked[box.getAttribute('data-id')]; });
  }
  /* ---------- the drive's list, drawn as a file explorer ---------- */
  // The list reads as Windows' File Explorer does: a folder tree on the left, an address bar with
  // Back, Forward and Up, the folder's items in Details or Large icons, sorted by a column's
  // heading, and a status bar. A double click opens a folder, or a Word, Excel or PowerPoint file
  // in its desktop app through Office's own address scheme, where it is edited in place on the
  // drive; any other file opens on OneDrive's own page. Nothing here writes to the drive: the
  // ticks are what Track records, as before.
  var OFFICE_APPS = {
    'ms-word': ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt'],
    'ms-excel': ['xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm', 'csv', 'ods'],
    'ms-powerpoint': ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp'],
    'ms-visio': ['vsd', 'vsdx']
  };
  var FILE_KINDS = [
    ['word', 'Word document', OFFICE_APPS['ms-word']],
    ['excel', 'Excel workbook', OFFICE_APPS['ms-excel']],
    ['powerpoint', 'PowerPoint presentation', OFFICE_APPS['ms-powerpoint']],
    ['pdf', 'PDF document', ['pdf']],
    ['image', 'Image', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'svg']],
    ['video', 'Video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv']],
    ['audio', 'Audio', ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac']],
    ['archive', 'Compressed folder', ['zip', '7z', 'rar', 'tar', 'gz', 'tgz']],
    ['code', 'Source code', ['py', 'js', 'ts', 'r', 'm', 'c', 'h', 'cpp', 'java', 'cs', 'go', 'rs', 'sh', 'ipynb', 'json', 'yml', 'yaml', 'html', 'css', 'sql', 'tex', 'md']],
    ['text', 'Text document', ['txt', 'log']]
  ];
  // the colour of each kind's mark, Office's own where it has one
  var KIND_COLORS = { folder: '#E8B33D', word: '#2B5797', excel: '#1E7145', powerpoint: '#C4421A', pdf: '#C1272D', image: '#7A4FB3', video: '#B03A7A', audio: '#2E8B8B', archive: '#8A6D3B', code: '#3C6E9E', text: '#6B6B6B', file: '#6B6B6B' };
  var KIND_LETTERS = { word: 'W', excel: 'X', powerpoint: 'P', pdf: 'PDF', image: '', video: '', audio: '', archive: 'ZIP', code: '</>', text: 'TXT', file: '' };
  var explorer = { view: 'details', sort: 'name', down: false, filter: '', back: [], forward: [], items: [], selected: '', open: Object.create(null), cache: Object.create(null), cacheFor: null };

  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function kindKey(it) {
    if (it.folder) return 'folder';
    var ext = extOf(it.name);
    for (var i = 0; i < FILE_KINDS.length; i++) if (FILE_KINDS[i][2].indexOf(ext) >= 0) return FILE_KINDS[i][0];
    return 'file';
  }
  function kindName(it) {
    if (it.folder) return 'File folder';
    var key = kindKey(it);
    for (var i = 0; i < FILE_KINDS.length; i++) if (FILE_KINDS[i][0] === key) return FILE_KINDS[i][1];
    var ext = extOf(it.name);
    return ext ? ext.toUpperCase() + ' file' : 'File';
  }
  function sizeOf(it) {
    if (it.folder) return typeof it.folder.childCount === 'number' ? plural(it.folder.childCount, 'item') : '';
    if (typeof it.size !== 'number') return '';
    return it.size < 1024 ? it.size + ' B' : it.size < 1048576 ? Math.max(1, Math.round(it.size / 1024)).toLocaleString('en-US') + ' KB' : (it.size / 1048576).toFixed(1) + ' MB';
  }
  function officeApp(it) {
    if (it.folder) return '';
    var ext = extOf(it.name);
    for (var app in OFFICE_APPS) if (OFFICE_APPS[app].indexOf(ext) >= 0) return app;
    return '';
  }
  // the address an Office desktop app opens a drive's file at: a personal OneDrive's file by the
  // drive's id and the file's path under d.docs.live.net, where Word, Excel and PowerPoint open it
  // for editing and save back to it; a work or school drive's file at its own SharePoint address
  function officeAddress(it) {
    if (drive && drive.type === 'personal') {
      var ref = it.parentReference || {};
      var path = typeof ref.path === 'string' ? ref.path.replace(/^\/drive\/root:?/, '') : null;
      var id = String(ref.driveId || drive.id || '');
      if (path !== null && /^[0-9A-Za-z!]+$/.test(id)) {
        // Graph may give the path percent-encoded; each segment is read plain, then encoded once
        var parts = path.split('/').filter(Boolean).map(plainSegment).concat([String(it.name || '')]);
        return 'https://d.docs.live.net/' + id + '/' + parts.map(encodeURIComponent).join('/');
      }
    }
    return httpsOnly(it.webUrl);
  }
  function plainSegment(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function httpsOnly(url) { return typeof url === 'string' && /^https:\/\//.test(url) ? url : ''; }
  function openInBrowser(it) {
    var url = httpsOnly(it.webUrl);
    if (!url) { say('OneDrive gave no address for ' + it.name + '.', true); return; }
    window.open(url, '_blank', 'noopener');
  }
  function openInApp(it) {
    var app = officeApp(it), url = app ? officeAddress(it) : '';
    if (!url) { openInBrowser(it); return; }
    // ofe|u| is Office's "open for editing" command; the browser asks once whether to open the app
    var a = el('a');
    a.href = app + ':ofe|u|' + url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    say('Opening ' + it.name + ' in ' + appName(app) + '. If nothing opens, the app is not installed here: right-click the file and choose Open in the browser.');
  }
  function appName(app) { return { 'ms-word': 'Word', 'ms-excel': 'Excel', 'ms-powerpoint': 'PowerPoint', 'ms-visio': 'Visio' }[app] || 'its app'; }
  function openItem(it) {
    if (it.folder) { go(crumbs.concat([{ id: String(it.id), name: String(it.name || ''), url: httpsOnly(it.webUrl) }])); return; }
    if (!catalogMode && officeApp(it)) openInApp(it); else openInBrowser(it);
  }

  // a mark for an item's kind, drawn here, so no picture comes from anywhere; its letters are the
  // stylesheet's, from data-letter, so they are never part of the name's text
  var SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function kindIcon(it, size) {
    var key = kindKey(it), color = KIND_COLORS[key] || KIND_COLORS.file;
    var mark = el('span', 'fx__mark');
    mark.style.setProperty('--s', size + 'px');
    mark.setAttribute('aria-hidden', 'true');
    var s = svgEl('svg', { viewBox: '0 0 48 48', width: size, height: size, 'class': 'fx__icon' });
    mark.appendChild(s);
    if (key === 'folder') {
      s.appendChild(svgEl('path', { d: 'M4 12a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v21a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', fill: color }));
      s.appendChild(svgEl('path', { d: 'M4 18h40v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', fill: '#F4CB5E' }));
      return mark;
    }
    s.appendChild(svgEl('path', { d: 'M10 4h20l10 10v28a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', fill: '#FFFFFF', stroke: '#9AA0A6', 'stroke-width': '1.5' }));
    s.appendChild(svgEl('path', { d: 'M30 4v8a2 2 0 0 0 2 2h8', fill: 'none', stroke: '#9AA0A6', 'stroke-width': '1.5' }));
    s.appendChild(svgEl('rect', { x: '4', y: '24', width: '30', height: '14', rx: '2', fill: color }));
    var letter = KIND_LETTERS[key];
    if (letter) { mark.setAttribute('data-letter', letter); if (letter.length > 2) mark.classList.add('fx__mark--long'); }
    return mark;
  }

  // what the list holds, read once per folder per connection and kept until Refresh; the tree and
  // the list share one read of a folder, the one in flight included
  function cachedRead(id) {
    if (explorer.cacheFor !== drive) { explorer.cache = Object.create(null); explorer.open = Object.create(null); explorer.cacheFor = drive; }
    return explorer.cache[id || 'root'];
  }
  function readChildren(id) {
    if (catalogMode) return Promise.resolve(catalogChildren(id));
    var key = id || 'root', have = cachedRead(id);
    if (have) return have;
    var url = id ? '/me/drive/items/' + encodeURIComponent(id) + '/children' + GRAPH_SELECT : '/me/drive/root/children' + GRAPH_SELECT;
    var d = drive;
    var read = graphChildren(url).then(function (items) {
      var kept = items.filter(function (it) { return it && typeof it === 'object'; });
      kept.cut = !!items.cut;
      return kept;
    });
    explorer.cache[key] = read;
    read.catch(function () { if (d === drive && explorer.cache[key] === read) delete explorer.cache[key]; });
    return read;
  }
  /* ---------- the saved catalog, drawn in the same explorer when no drive is connected ---------- */
  // The drive organizer writes catalog.json to the branch drive-catalog of a private repository: a
  // flat list of the drive's folders and files, their paths starting with CATALOG_ROOT. Read with
  // the person's GitHub token, it feeds the same explorer, read-only (no Track, no ticking), so a
  // person sees the whole drive without connecting one. Connecting a drive puts the live drive back.
  // The catalog may lack a modified date or a web link for some files (treated as unknown, never an
  // error), and mime is empty, so the kind comes from the name as it does for a live drive.
  function catLast(path) { var s = String(path || '').split('/').filter(Boolean); return s.length ? s[s.length - 1] : ''; }
  function catParent(path, name) {
    var p = String(path || '');
    if (name) { var tail = '/' + name; if (p.length >= tail.length && p.slice(-tail.length) === tail) return p.slice(0, -tail.length); }
    var i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  }
  // the flat lists turned into children by folder id, the explorer root (id '') under the key ''
  function buildCatalogTree(data) {
    catalogKids = Object.create(null);
    var pathId = Object.create(null);
    pathId[CATALOG_ROOT] = '';
    var folders = Array.isArray(data.folders) ? data.folders : [];
    var files = Array.isArray(data.files) ? data.files : [];
    // each folder path takes a unique node id: its own id where that is free, else a suffixed form,
    // so two folders sharing an id in a malformed catalog never merge children or make the tree a
    // cycle (the explorer keys open state and children by this id, and ids drive recursion)
    var usedId = Object.create(null);
    folders.forEach(function (f) {
      if (!f || typeof f.path !== 'string' || f.path === CATALOG_ROOT) return;
      var base = String(f.id || f.path), fid = base, n = 0;
      while (Object.prototype.hasOwnProperty.call(usedId, fid) && usedId[fid] !== f.path) fid = base + '#' + (++n);
      usedId[fid] = f.path;
      pathId[f.path] = fid;
    });
    function kidsOf(id) { return catalogKids[id] || (catalogKids[id] = []); }
    function parentId(path, name) {
      var pp = catParent(path, name);
      if (pp === '' || pp === CATALOG_ROOT) return '';
      return Object.prototype.hasOwnProperty.call(pathId, pp) ? pathId[pp] : '';
    }
    folders.forEach(function (f) {
      if (!f || typeof f.path !== 'string' || f.path === CATALOG_ROOT) return;
      kidsOf(parentId(f.path)).push({ id: pathId[f.path], name: catLast(f.path), folder: { childCount: 0 }, lastModifiedDateTime: f.latest ? String(f.latest) : '', webUrl: typeof f.web === 'string' ? f.web : '', parentReference: { driveId: f.drive ? String(f.drive) : '' } });
    });
    files.forEach(function (fl) {
      if (!fl || typeof fl.path !== 'string') return;
      var nm = typeof fl.name === 'string' && fl.name ? fl.name : catLast(fl.path);
      kidsOf(parentId(fl.path, nm)).push({ id: String(fl.id || fl.path), name: nm, file: { mimeType: typeof fl.mime === 'string' ? fl.mime : '' }, size: typeof fl.size === 'number' ? fl.size : undefined, lastModifiedDateTime: fl.modified ? String(fl.modified) : '', webUrl: typeof fl.web === 'string' ? fl.web : '', parentReference: { driveId: fl.drive ? String(fl.drive) : '' } });
    });
    Object.keys(catalogKids).forEach(function (pid) {
      catalogKids[pid].forEach(function (it) { if (it.folder) it.folder.childCount = (catalogKids[it.id] || []).length; });
    });
  }
  function catalogChildren(id) { return ((catalogKids && catalogKids[id || '']) || []).slice(); }
  // read the catalog for the chosen repository, once per repository, and draw it
  function startCatalog(repo) {
    var asked = ++catalogLoading;
    catalogFor = repo;
    catalog = null; catalogKids = null; catalogMode = false; catalogBusy = true;
    crumbs = []; explorer.filter = ''; explorer.selected = '';
    drawBrowser();
    file(repo, CATALOG_FILE, CATALOG_BRANCH).then(function (text) {
      // a read is stale if a newer one began, or the chosen repository changed, or a drive connected
      // while it was in flight: it must not overwrite the view or mislabel another repository's
      if (asked !== catalogLoading || repo !== foldersRepo() || drive) return;
      catalogBusy = false;
      var data = null; try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { catalog = null; catalogMode = false; drawBrowser(); return; }
      catalog = data; buildCatalogTree(data); catalogMode = true;
      crumbs = []; explorer.filter = ''; explorer.selected = '';
      listFolder();
    }, function (e) {
      if (asked !== catalogLoading || repo !== foldersRepo() || drive) return;
      catalogBusy = false; catalog = null; catalogMode = false;
      drawBrowser();
    });
  }
  // when no drive is connected: show the chosen private repository's catalog if it has one, reading
  // it once per repository; a drive, a public repository or no repository shows the connect prompt
  function maybeCatalog() {
    var repo = foldersRepo();
    if (drive) { catalogMode = false; return; }
    if (!repo || !token || !state.meta || isPublic(state.meta)) { catalogMode = false; catalog = null; catalogFor = ''; drawBrowser(); return; }
    if (catalogFor === repo) { if (catalog) listFolder(); else drawBrowser(); return; }
    startCatalog(repo);
  }
  function resetExplorer() {
    explorer.back = []; explorer.forward = []; explorer.items = []; explorer.selected = ''; explorer.filter = '';
    explorer.cache = Object.create(null); explorer.open = Object.create(null); explorer.cacheFor = null;
  }
  // moving to a folder: the path walked is kept for Back, and Forward is cleared, as Explorer does
  function go(path) {
    explorer.back.push(crumbs.slice());
    explorer.forward = [];
    crumbs = path;
    explorer.selected = '';
    explorer.filter = '';
    listFolder();
  }
  function goBack() { if (!explorer.back.length) return; explorer.forward.push(crumbs.slice()); crumbs = explorer.back.pop(); explorer.selected = ''; explorer.filter = ''; listFolder(); }
  function goForward() { if (!explorer.forward.length) return; explorer.back.push(crumbs.slice()); crumbs = explorer.forward.pop(); explorer.selected = ''; explorer.filter = ''; listFolder(); }
  function goUp() { if (crumbs.length) go(crumbs.slice(0, -1)); }

  function toolButton(label, title, enabled, onClick) {
    var b = btn(label, true, onClick);
    b.className = 'fx__tool';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !enabled;
    return b;
  }
  function drawBrowser() {
    var box = $('fd-browser');
    clear(box);
    hideMenu();
    if (!drive && !catalogMode) {
      if (catalogBusy && catalogFor === foldersRepo()) { none(box, 'Reading ' + catalogFor + '’s saved catalog…'); return; }
      var hint = (state.meta && !isPublic(state.meta) && foldersRepo()) ? ' If ' + foldersRepo() + ' has a saved catalog on its ' + CATALOG_BRANCH + ' branch (the drive organizer writes one), it shows here without a drive.' : '';
      none(box, 'Connect OneDrive first: the list of your files and folders is read as you, in this browser, once the drive is connected.' + hint);
      return;
    }
    if (catalogMode) {
      var made = catalog && catalog.made ? String(catalog.made).slice(0, 10) : '';
      var prov = driveName(catalog && catalog.provider);
      add(box, el('p', 'admin__lead', 'Showing ' + (catalogFor || foldersRepo()) + '’s saved ' + prov + ' catalog' + (made ? ', read ' + made : '') + ': a read-only list from the ' + CATALOG_BRANCH + ' branch, so nothing is asked of ' + prov + '. Connect OneDrive to browse the live drive and track folders.'));
      if (catalog && catalog.complete === false) {
        var why = Array.isArray(catalog.problems) && catalog.problems.length ? ' (' + catalog.problems.slice(0, 3).map(String).join('; ').slice(0, 200) + ')' : '';
        add(box, el('p', 'admin__none', 'The catalog says it is not complete' + why + ', so some items may be missing.'));
      }
    }
    var win = el('div', 'fx');
    // the toolbar: Back, Forward, Up, Refresh, the address, the search box and the view
    var bar = el('div', 'fx__bar');
    add(bar, toolButton('←', 'Back (Alt+Left)', explorer.back.length > 0, goBack),
      toolButton('→', 'Forward (Alt+Right)', explorer.forward.length > 0, goForward),
      toolButton('↑', 'Up to the folder above (Backspace)', crumbs.length > 0, goUp),
      toolButton('↻', 'Refresh', true, function () { delete explorer.cache[crumbs.length ? crumbs[crumbs.length - 1].id : 'root']; listFolder(); }));
    var address = el('nav', 'fx__address folders__crumbs');
    address.setAttribute('aria-label', 'Where you are in the drive');
    add(address, btn('OneDrive', true, function () { if (crumbs.length) go([]); }));
    crumbs.forEach(function (c, i) {
      add(address, el('span', 'fx__sep', '›'), btn(c.name, true, function () { if (i < crumbs.length - 1) go(crumbs.slice(0, i + 1)); }));
    });
    bar.appendChild(address);
    var search = el('input', 'fx__search');
    search.type = 'search';
    search.id = 'fd-search';
    search.placeholder = 'Search ' + (crumbs.length ? crumbs[crumbs.length - 1].name : 'OneDrive');
    search.setAttribute('aria-label', search.placeholder);
    search.value = explorer.filter;
    search.addEventListener('input', function () { explorer.filter = search.value; drawItems(); });
    bar.appendChild(search);
    var views = el('div', 'fx__views');
    [['details', 'Details'], ['icons', 'Large icons']].forEach(function (v) {
      var b = toolButton(v[1], v[1] + ' view', true, function () { explorer.view = v[0]; drawBrowser(); drawItems(); });
      b.setAttribute('aria-pressed', String(explorer.view === v[0]));
      views.appendChild(b);
    });
    win.appendChild(bar);
    var body = el('div', 'fx__body');
    var tree = el('div', 'fx__tree');
    tree.id = 'fd-tree';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Folders');
    body.appendChild(tree);
    var main = el('div', 'fx__main');
    main.id = 'fd-main';
    main.tabIndex = 0;
    main.setAttribute('aria-label', 'Items in ' + (crumbs.length ? crumbs[crumbs.length - 1].name : 'OneDrive'));
    main.addEventListener('keydown', onExplorerKey);
    main.addEventListener('contextmenu', function (ev) { if (ev.target === main) ev.preventDefault(); });
    none(main, 'Reading ' + (crumbs.length ? crumbs[crumbs.length - 1].name : 'your files') + '...');
    body.appendChild(main);
    win.appendChild(body);
    // the status bar, with the two views at its right as Explorer keeps them
    var foot = el('div', 'fx__foot');
    var status = el('div', 'fx__status');
    status.id = 'fd-status';
    status.setAttribute('aria-live', 'polite');
    add(foot, status, views);
    win.appendChild(foot);
    box.appendChild(win);
    drawTree();
  }
  function listFolder() {
    var asked = ++listing;
    drawBrowser();
    if (!catalogMode && !heldDrive()) return;
    var here = crumbs.length ? crumbs[crumbs.length - 1] : null;
    readChildren(here ? here.id : '').then(function (items) {
      if (asked !== listing) return;
      explorer.items = items;
      drawItems();
    }).catch(function (e) {
      if (asked !== listing) return;
      var main = $('fd-main');
      if (main) { clear(main); none(main, 'The list could not be read: ' + e.message); }
    });
  }
  function sortedItems() {
    var q = explorer.filter.trim().toLowerCase();
    var list = explorer.items.filter(function (it) { return !q || String(it.name || '').toLowerCase().indexOf(q) >= 0; });
    var key = explorer.sort, dir = explorer.down ? -1 : 1;
    function value(it) {
      if (key === 'changed') return it.lastModifiedDateTime || '';
      if (key === 'type') return kindName(it).toLowerCase();
      if (key === 'size') return it.folder ? (it.folder.childCount || 0) : (it.size || 0);
      return String(it.name || '').toLowerCase();
    }
    return list.sort(function (a, b) {
      // folders come first whichever column sorts, as Explorer keeps them
      if (!!a.folder !== !!b.folder) return a.folder ? -1 : 1;
      var x = value(a), y = value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }
  function drawItems() {
    var main = $('fd-main');
    if (!main) return;
    clear(main);
    var list = sortedItems();
    if (explorer.view === 'icons') main.appendChild(iconGrid(list)); else main.appendChild(detailsTable(list));
    if (!explorer.items.length) none(main, 'This folder is empty.');
    else if (!list.length) none(main, 'Nothing here matches "' + explorer.filter + '".');
    if (explorer.items.cut) none(main, 'More than ' + (GRAPH_PAGES * 200) + ' items are here; only the first are listed. Tick the folder itself to track them all.');
    drawStatus(list);
    drawPicked();
  }
  function drawStatus(list) {
    var status = $('fd-status');
    if (!status) return;
    if (catalogMode) { status.textContent = plural(list.length, 'item') + '   From the saved catalog; double-click to open.'; return; }
    var ticked = list.filter(function (it) { return picked[String(it.id || '')]; }).length;
    status.textContent = plural(list.length, 'item') + (ticked ? '   ' + ticked + ' ticked' : '') + '   Double-click to open; right-click for more.';
  }
  function tickBox(it) {
    var box = el('input');
    box.type = 'checkbox';
    box.setAttribute('data-id', String(it.id || ''));
    if (catalogMode) { box.disabled = true; box.title = 'Connect OneDrive to track'; box.setAttribute('aria-label', 'Connect OneDrive to track'); return box; }
    box.checked = !!picked[String(it.id || '')];
    box.setAttribute('aria-label', 'Track ' + String(it.name || ''));
    box.addEventListener('change', function () { tick(it, box.checked); drawStatus(sortedItems()); });
    box.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    return box;
  }
  function wire(node, it) {
    node.setAttribute('data-item', String(it.id || ''));
    node.addEventListener('click', function (ev) { if (ev.target.tagName !== 'INPUT') select(it.id); });
    node.addEventListener('dblclick', function (ev) { if (ev.target.tagName !== 'INPUT') openItem(it); });
    node.addEventListener('contextmenu', function (ev) { ev.preventDefault(); select(it.id); showMenu(it, ev.clientX, ev.clientY); });
    if (explorer.selected === String(it.id)) node.classList.add('fx__selected');
    return node;
  }
  function detailsTable(list) {
    var scroll = el('div', 'table-scroll');
    var table = el('table', 'fx__details');
    table.id = 'fd-items';
    var tr = el('tr');
    add(tr, el('th', 'fx__tickh', ''));
    [['name', 'Name'], ['changed', 'Date modified'], ['type', 'Type'], ['size', 'Size']].forEach(function (h) {
      var th = el('th');
      var b = btn(h[1] + (explorer.sort === h[0] ? (explorer.down ? ' ▾' : ' ▴') : ''), true, function () {
        explorer.down = explorer.sort === h[0] ? !explorer.down : false;
        explorer.sort = h[0];
        drawItems();
      });
      b.className = 'fx__sort';
      th.setAttribute('aria-sort', explorer.sort === h[0] ? (explorer.down ? 'descending' : 'ascending') : 'none');
      add(tr, add(th, b));
    });
    add(table, add(el('thead'), tr));
    var body = el('tbody');
    list.forEach(function (it) {
      var row = el('tr');
      add(row, add(el('td'), tickBox(it)));
      add(row, add(el('td', 'fx__name'), add(el('span', 'fx__namewrap'), kindIcon(it, 18), el(it.folder ? 'strong' : 'span', '', String(it.name || '')))));
      add(row, it.lastModifiedDateTime ? add(el('td'), timeEl(it.lastModifiedDateTime)) : el('td', '', ''));
      add(row, el('td', '', kindName(it)));
      add(row, el('td', 'fx__size', sizeOf(it)));
      body.appendChild(wire(row, it));
    });
    table.appendChild(body);
    return add(scroll, table);
  }
  function iconGrid(list) {
    var grid = el('div', 'fx__grid');
    grid.id = 'fd-items';
    list.forEach(function (it) {
      var tile = el('div', 'fx__tile');
      tile.title = String(it.name || '') + '\n' + kindName(it) + (sizeOf(it) ? ', ' + sizeOf(it) : '');
      add(tile, tickBox(it), kindIcon(it, 56), el('span', 'fx__label', String(it.name || '')));
      grid.appendChild(wire(tile, it));
    });
    return grid;
  }
  function select(id) {
    explorer.selected = String(id || '');
    Array.prototype.forEach.call(document.querySelectorAll('#fd-main [data-item]'), function (n) {
      n.classList.toggle('fx__selected', n.getAttribute('data-item') === explorer.selected);
    });
  }
  function onExplorerKey(ev) {
    var list = sortedItems();
    var at = list.findIndex(function (it) { return String(it.id) === explorer.selected; });
    var step = explorer.view === 'icons' ? Math.max(1, Math.floor(($('fd-main').clientWidth || 600) / 112)) : 1;
    if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); goBack(); return; }
    if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); goForward(); return; }
    if (ev.target.tagName === 'INPUT' && ev.key !== 'Enter') return;
    var next = -1;
    if (ev.key === 'ArrowDown') next = at + step;
    else if (ev.key === 'ArrowUp') next = at < 0 ? 0 : at - step;
    else if (ev.key === 'ArrowRight' && explorer.view === 'icons') next = at + 1;
    else if (ev.key === 'ArrowLeft' && explorer.view === 'icons') next = at - 1;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = list.length - 1;
    else if (ev.key === 'Enter' && at >= 0) { ev.preventDefault(); openItem(list[at]); return; }
    else if (ev.key === ' ' && at >= 0) { ev.preventDefault(); var it = list[at]; tick(it, !picked[String(it.id)]); drawStatus(list); return; }
    else if (ev.key === 'Backspace') { ev.preventDefault(); goUp(); return; }
    else if (ev.key === 'ContextMenu' && at >= 0) { ev.preventDefault(); var n = document.querySelector('#fd-main [data-item="' + CSS.escape(explorer.selected) + '"]'); var r = n ? n.getBoundingClientRect() : { left: 0, bottom: 0 }; showMenu(list[at], r.left + 20, r.bottom); return; }
    else return;
    ev.preventDefault();
    if (!list.length) return;
    next = Math.max(0, Math.min(list.length - 1, next));
    select(list[next].id);
    var node = document.querySelector('#fd-main [data-item="' + CSS.escape(explorer.selected) + '"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  // the menu a right click opens on an item, Explorer's few verbs that fit a drive read here
  function hideMenu() { var m = $('fd-menu'); if (m) m.remove(); }
  function showMenu(it, x, y) {
    hideMenu();
    var menu = el('div', 'fx__menu');
    menu.id = 'fd-menu';
    menu.setAttribute('role', 'menu');
    function entry(label, act) {
      var b = btn(label, true, function () { hideMenu(); act(); });
      b.setAttribute('role', 'menuitem');
      menu.appendChild(b);
    }
    if (it.folder) entry('Open', function () { openItem(it); });
    var app = officeApp(it);
    if (app && !catalogMode) entry('Open in ' + appName(app), function () { openInApp(it); });
    if (!it.folder) entry('Open in the browser', function () { openInBrowser(it); });
    if (it.folder && httpsOnly(it.webUrl)) entry('Open in OneDrive', function () { openInBrowser(it); });
    if (!catalogMode) {
      var on = !!picked[String(it.id || '')];
      entry(on ? 'Untick' : 'Tick to track', function () { tick(it, !on); drawStatus(sortedItems()); });
    }
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
    var first = menu.querySelector('button');
    if (first) first.focus();
    menu.addEventListener('keydown', function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); hideMenu(); var main = $('fd-main'); if (main) main.focus(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    setTimeout(function () {
      document.addEventListener('mousedown', function away(ev) { if (!menu.contains(ev.target)) { hideMenu(); document.removeEventListener('mousedown', away); } });
    }, 0);
  }

  // the folder tree: the drive's folders, each opened a level at a time, the path shown open
  function drawTree() {
    var tree = $('fd-tree');
    if (!tree) return;
    clear(tree);
    var root = treeNode({ id: '', name: 'OneDrive' }, [], 0);
    tree.appendChild(root);
  }
  function treeNode(folder, path, depth) {
    var wrap = el('div', 'fx__branch');
    var row = el('div', 'fx__node');
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    var key = folder.id || 'root';
    var here = crumbs.length ? crumbs[crumbs.length - 1].id : '';
    var onPath = folder.id === '' || crumbs.some(function (c) { return c.id === folder.id; });
    var open = explorer.open[key] !== undefined ? explorer.open[key] : onPath;
    var twisty = btn(open ? '▾' : '▸', true, function (ev) { ev.stopPropagation(); explorer.open[key] = !open; drawTree(); });
    twisty.className = 'fx__twisty';
    twisty.setAttribute('aria-label', (open ? 'Close ' : 'Open ') + folder.name);
    var name = btn('', true, function () { if (folder.id !== here) go(path); });
    name.className = 'fx__nodename';
    add(name, kindIcon({ folder: {} }, 16), el('span', '', folder.name));
    if (folder.id === here) { row.classList.add('fx__current'); row.setAttribute('aria-current', 'true'); }
    row.setAttribute('aria-expanded', String(open));
    add(row, twisty, name);
    wrap.appendChild(row);
    if (!open) return wrap;
    var kids = el('div', 'fx__kids');
    wrap.appendChild(kids);
    function fill(items) {
      clear(kids);
      items.filter(function (it) { return it.folder; }).sort(function (a, b) { return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1; }).forEach(function (f) {
        kids.appendChild(treeNode({ id: String(f.id), name: String(f.name || '') }, path.concat([{ id: String(f.id), name: String(f.name || '') }]), depth + 1));
      });
    }
    add(kids, el('div', 'fx__node fx__wait', 'Reading...')).lastChild.style.paddingLeft = (18 + depth * 14) + 'px';
    readChildren(folder.id).then(fill, function () { clear(kids); add(kids, el('div', 'fx__node fx__wait', 'Could not be read')); });
    return wrap;
  }

  /* ---------- the repository: what it tracks, the file, the secret, the sync ---------- */
  function trackedItems(config) {
    return Array.isArray(config.items) ? config.items.filter(function (i) { return i && typeof i === 'object' && typeof i.id === 'string' && i.id; }) : [];
  }
  function drawTracked(repo, config, secret, workflow) {
    var box = $('fd-tracked');
    clear(box);
    // the workflow is there (true), missing (false), or could not be read (the error)
    if (workflow !== true) {
      none(box, repo + ' has no .github/workflows/' + DRIVE_WORKFLOW + (workflow === false ? ': it was not made from the template, or from one older than the drive sync, so there is no run to track a drive with. Make one in step 2 (GitHub\'s form for the enterprise\'s members, the front door for anyone else), or bring the workflow in.' : ' that could be read (' + workflow.message + ').'));
      if (workflow === false) { $('fd-track').disabled = true; drawPull(box, repo); return; }
    }
    // a sign-in that cannot reach the repository's secrets is told so before Connect, not after it
    var refused = !!(secret && secret.unread && secret.unread.status === 403);
    $('fd-track').disabled = refused;
    if (refused) none(box, secretsRefused(repo));
    if (!config) { none(box, repo + ' tracks no drive yet' + (refused ? '.' : ': the steps in this tab set one up.')); drawPull(box, repo); return; }
    var items = trackedItems(config);
    var p = add(el('p', 'admin__lead'), repo + ' tracks ' + plural(items.length, 'item') + ' of ' + driveName(config.provider) + ' in ', el('code', '', String(config.folder || 'papers') + '/'), ': ');
    items.forEach(function (i, n) { add(p, n ? ', ' : '', el('code', '', String(i.name || i.id))); });
    add(p, '.');
    box.appendChild(p);
    var when = typeof config.connected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.connected) ? config.connected : '';
    var lapsed = lapsedOn(config);
    var life;
    if (config.provider !== 'microsoft') life = when ? 'Connected ' + when + '; a Google refresh token lasts until it goes six months unused.' : 'A Google refresh token lasts until it goes six months unused.';
    else if (!when) life = 'A OneDrive refresh token lasts ' + MS_REFRESH_DAYS + ' days from the connection, whose date the file does not say: Connect and Track again to record it.';
    else if (lapsed) life = 'Connected ' + when + '; a OneDrive refresh token lasts ' + MS_REFRESH_DAYS + ' days, so this connection ran out on ' + lapsed + ', and every sync since stops before it reaches the drive: press Connect OneDrive, then Track, which replaces the secret and the date.';
    else {
      var due = daysAfter(when, MS_REFRESH_DAYS), left = daysBetween(dayOf(new Date()), due);
      life = 'Connected ' + when + '; a OneDrive refresh token lasts ' + MS_REFRESH_DAYS + ' days, so press Connect OneDrive again by ' + due + (left <= 14 ? ' (in ' + plural(left, 'day') + ')' : '') + ', then Track, which replaces the secret and the date.';
    }
    var kept = secret && secret.unread ? (refused ? '' : 'Whether the secret ' + DRIVE_SECRET + ' is set could not be read (' + secret.unread.message + ').')
      : secret ? 'The secret ' + DRIVE_SECRET + ' is set' + (secret.updated_at ? ', updated ' + stamp(secret.updated_at) : '') + '.'
      : 'The secret ' + DRIVE_SECRET + ' is not set, so the sync ends at once: press Connect OneDrive, then Track.';
    add(box, el('p', 'admin__lead', life + (kept ? ' ' + kept : '')));
    add(box, add(el('p', 'admin__bar'), btn('Sync now', false, function (ev) { syncNow(repo, ev.currentTarget, lapsed); }), ' ', link(syncLink(repo), 'the runs of ' + DRIVE_WORKFLOW)));
    drawPull(box, repo);
  }
  // the day a OneDrive connection the file records ran out, or '' while it still holds
  function lapsedOn(config) {
    if (!config || config.provider !== 'microsoft' || typeof config.connected !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.connected)) return '';
    var due = daysAfter(config.connected, MS_REFRESH_DAYS);
    return due && due <= dayOf(new Date()) ? due : '';
  }
  function daysBetween(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000); }
  // the pull request Track made this sitting, which the default branch's file does not show yet
  function drawPull(box, repo) {
    var url = pendingPull[repo];
    if (!url) return;
    add(box, add(el('p', 'admin__lead'), 'Track\'s ' + DRIVE_FILE + ' rides ', link(url, 'this pull request'), ': once it is merged, press Sync now. Until then the half-hourly sync runs with the new secret on the drive.json the default branch already holds, or does nothing where it holds none.'));
  }
  function readTracked(repo) {
    return file(repo, DRIVE_FILE).then(function (text) {
      try { var c = JSON.parse(text); return c && typeof c === 'object' && !Array.isArray(c) ? c : null; } catch (e) { return null; }
    }, function (e) { if (e.status === 404) return null; throw e; });
  }
  // What ticked itself from one repository's file is that repository's, so choosing another
  // repository in the bar lets it go, and the folder's name with it, before the other is read;
  // what the person ticked in the drive's list stays, to be tracked wherever they choose
  function letPrefilledGo(repo) {
    if (prefilled && prefilled !== repo) {
      var folder = $('fd-folder');
      if (tracked && folder.value === String(tracked.folder || '')) folder.value = 'papers';
      prefilled = '';
    }
    var gone = pickedOrder.filter(function (id) { return picked[id].from && picked[id].from !== repo; });
    if (!gone.length) return;
    gone.forEach(function (id) { delete picked[id]; });
    pickedOrder = pickedOrder.filter(function (id) { return !!picked[id]; });
    drawPicked();
  }
  // whether the chosen repository is public, said beside Track with a box to tick, never ticked
  // beforehand; a repository read again asks again
  function showPublic(meta) {
    var row = $('fd-public-row');
    var open = isPublic(meta);
    if (row.hidden === open) $('fd-public').checked = false;
    row.hidden = !open;
  }
  // the chosen repository's file, whether its secret is set and whether it has the workflow, read
  // for the repository the bar shows; an answer about a repository no longer chosen is dropped
  function loadFolders() {
    var asked = ++folderReading;
    var repo = foldersRepo();
    letPrefilledGo(repo);
    foldersFor = repo;
    tracked = null;
    clear($('fd-tracked'));
    $('fd-track-head').textContent = repo ? '3. Track in ' + repo : '3. Track';
    $('fd-public').checked = false;
    $('fd-public-row').hidden = true;
    if (!repo) { $('fd-track').disabled = true; none($('fd-tracked'), 'No repository is chosen: choose one in the bar, or make one in step 2.'); return; }
    if (!token) { $('fd-track').disabled = true; none($('fd-tracked'), 'Sign in to read what ' + repo + ' tracks.'); return; }
    none($('fd-tracked'), 'Reading ' + repo + '...');
    Promise.all([
      readTracked(repo),
      readOne('/repos/' + repo + '/actions/secrets/' + DRIVE_SECRET).catch(function (e) { return { unread: e }; }),
      readOne('/repos/' + repo + '/contents/.github/workflows/' + DRIVE_WORKFLOW).then(function (found) { return !!found; }, function (e) { return e; }),
      readOne('/repos/' + repo).catch(function () { return null; })
    ]).then(function (all) {
      if (asked !== folderReading) return;
      tracked = all[0];
      drawTracked(repo, tracked, all[1], all[2]);
      showPublic(all[3]);
      // what the repository tracks is ticked already, so Connect again needs no second pick
      if (tracked && !pickedOrder.length) {
        trackedItems(tracked).forEach(function (i) { tick({ id: i.id, name: i.name, parentReference: { driveId: i.drive } }, true, repo); });
        if (typeof tracked.folder === 'string' && FOLDER_NAME.test(tracked.folder)) { $('fd-folder').value = tracked.folder; prefilled = repo; }
      }
    }).catch(function (e) { if (asked === folderReading) { foldersFor = null; clear($('fd-tracked')); none($('fd-tracked'), repo + ' could not be read: ' + e.message); } });
  }
  function fromTemplate(r) {
    var t = r && r.template_repository && r.template_repository.full_name;
    return typeof t === 'string' && t.toLowerCase() === TEMPLATE_NAME.toLowerCase();
  }
  // "Find the repository I just made": the newest repositories the sign-in reaches, those not yet
  // listed asked about one by one, since GitHub's list of them leaves out which template made each;
  // every one made from the template, or carrying the topic, joins the list, and the newest is
  // chosen in the bar, which moves the whole console to it
  function findRepos() {
    var button = $('fd-reload');
    button.disabled = true;
    say('Asking GitHub for your newest repositories...');
    ghList('/user/repos?sort=created&direction=desc&per_page=' + NEWEST, 1).then(function (list) {
      var listed = repos();
      var fresh = list.filter(function (r) { return r && typeof r.full_name === 'string' && REPOSITORY.test(r.full_name) && listed.indexOf(r.full_name) < 0; });
      return Promise.all(fresh.map(function (r) {
        if (fromTemplate(r) || (Array.isArray(r.topics) && r.topics.indexOf(TOPIC) >= 0)) return r.full_name;
        return gh('GET', '/repos/' + r.full_name).then(function (one) { return fromTemplate(one.data) ? r.full_name : ''; }, function () { return ''; });
      }));
    }).then(function (names) {
      var added = names.filter(Boolean);
      button.disabled = false;
      if (!added.length) {
        say('None of the ' + NEWEST + ' newest repositories ' + (signedInByApp() ? 'the sign-in' : 'this token') + ' reaches is new to the list and made from the template. ' + (signedInByApp()
          ? 'Signed in with GitHub, the page reaches only the repositories SymphonyBoard is installed on: add the new one to its installation, at https://github.com/apps/' + APP_SLUG + '/installations/new, then press this again.'
          : 'A fine-grained token reaches only the repositories it was made for.') + ' One made on GitHub\'s form without the template, which the form gives the enterprise\'s members alone, is neither: set it up through the front door in step 2.' + (repos().length ? ' The bar keeps the one chosen.' : ''));
        return;
      }
      added.forEach(rememberRepo);
      say('Added to the list: ' + added.join(', ') + '. ' + added[0] + ' is chosen.');
      loadRepo(added[0]);
    }).catch(function (e) { button.disabled = false; say(e.message, true); });
  }
  function dispatchSync(repo, branch, account) {
    return gh('POST', '/repos/' + repo + '/actions/workflows/' + DRIVE_WORKFLOW + '/dispatches', { ref: branch }, undefined, false, account);
  }
  // short words for #msg, whose links are the tab's own, drawn in it
  function dispatchWords(repo, e) {
    if (e.status === 403) return 'The sync could not be started from here (403: no Actions permission); press "Run workflow" at the runs link in this tab.';
    if (e.status === 404) return 'The sync could not be started from here (404): ' + repo + ' has no ' + DRIVE_WORKFLOW + ' on its default branch.';
    return 'The sync could not be started from here (' + e.message + '); press "Run workflow" at the runs link in this tab.';
  }
  function syncNow(repo, button, lapsed) {
    if (button) button.disabled = true;
    say('Starting the drive sync of ' + repo + '...');
    gh('GET', '/repos/' + repo).then(function (r) { return dispatchSync(repo, r.data.default_branch || 'main'); }).then(function () {
      if (button) button.disabled = false;
      if (lapsed) say('The drive sync of ' + repo + ' is queued, but it will stop at the token trade: the OneDrive connection ran out on ' + lapsed + '. Press Connect OneDrive, then Track.', true);
      else say('The drive sync of ' + repo + ' is queued; its summary says what came down and what went up.');
    }).catch(function (e) { if (button) button.disabled = false; say(dispatchWords(repo, e), true); });
  }
  // the file on the default branch, or, where that branch takes only pull requests, on a branch of
  // its own with a pull request to merge; the sha travels with a file that is already there, and
  // every write goes out for the account Track was pressed as
  function writeDriveFile(repo, branch, config, account) {
    var path = '/repos/' + repo + '/contents/' + DRIVE_FILE;
    var content = toBase64(new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
    var message = 'Track ' + plural(trackedItems(config).length, 'item') + ' of ' + driveName(config.provider) + ' in ' + config.folder;
    function put(on) {
      return readOne(path + '?ref=' + encodeURIComponent(on)).then(function (have) {
        var body = { message: message, content: content, branch: on };
        if (have && have.sha) body.sha = have.sha;
        return gh('PUT', path, body, undefined, false, account);
      });
    }
    return put(branch).then(function () { return { branch: branch }; }, function (e) {
      if (e.status !== 403 && e.status !== 409 && e.status !== 422) throw e;
      // The default branch refused the commit: a branch of the tab's own and a pull request. The
      // branch holds the default branch's head and this one commit, so a branch of that name left
      // from an earlier Track, or pushed by anyone else, is set back to that head first, and the pull
      // request asks the person to merge nothing they did not ask for; where it cannot be set back,
      // nothing is committed on it
      var head = '';
      return gh('GET', '/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch)).then(function (r) {
        head = r.data.object.sha;
        return gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + DRIVE_BRANCH, sha: head }, undefined, false, account).catch(function (e2) {
          if (e2.status !== 422) throw e2;
          return gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + DRIVE_BRANCH, { sha: head, force: true }, undefined, false, account).catch(function (e3) {
            throw new Error('the branch ' + DRIVE_BRANCH + ' is there already and could not be set back to ' + branch + ' (' + e3.message + '); delete it on GitHub and press Track again.');
          });
        });
      }).then(function () { return put(DRIVE_BRANCH); }).then(function () {
        return ghList('/repos/' + repo + '/pulls?state=open&head=' + encodeURIComponent(repo.split('/')[0] + ':' + DRIVE_BRANCH), 1);
      }).then(function (open) {
        if (open.length) return { branch: DRIVE_BRANCH, pull: open[0].html_url };
        return gh('POST', '/repos/' + repo + '/pulls', { title: message, head: DRIVE_BRANCH, base: branch, body: 'Made from the Folders tab of the control panel: ' + DRIVE_FILE + ' says what the drive sync tracks. Merge it, then press Sync now on the tab: ' + tabLink(repo) }, undefined, false, account)
          .then(function (r) { return { branch: DRIVE_BRANCH, pull: r.data.html_url }; });
      });
    });
  }
  function track(button) {
    if (button.disabled) return;
    var repo = foldersRepo();
    var folder = ($('fd-folder').value || '').trim();
    var d = heldDrive();
    if (!repo) { say('Choose a repository in the bar first (or make one in step 2).', true); return; }
    if (!d || !d.refresh) { showConnectState(); drawBrowser(); say('Connect OneDrive first (step 1): the drive\'s refresh token is what the repository keeps.', true); return; }
    if (!pickedOrder.length) { say('Tick at least one file or folder to track, in the list of your OneDrive.', true); return; }
    if (!FOLDER_NAME.test(folder) || folder.indexOf('..') >= 0) { say('The folder is one name of up to 80 letters, digits, dots, dashes, underscores and blanks, ending in a letter or digit, as drive-sync.yml takes it; "papers" is the default.', true); return; }
    // an item ticked from what the repository tracked under another Microsoft account is out of
    // this drive's reach, and one item the sync cannot read stops every run
    var foreign = d.id ? pickedOrder.filter(function (id) { var i = picked[id]; return i.drive && i.drive.toLowerCase() !== d.id.toLowerCase(); }) : [];
    if (foreign.length) { say(plural(foreign.length, 'ticked item is', 'ticked items are') + ' from another OneDrive than the one connected now (' + foreign.map(function (id) { return picked[id].name; }).join(', ') + '): untick them, or Connect OneDrive again as the account that holds them.', true); return; }
    button.disabled = true;
    // the drive is the account's it was connected under, and every write of the chain goes out for
    // that account, so a token another tab puts in place meanwhile stops the chain
    var account = d.login || shownLogin;
    var refresh = d.refresh;
    var config = { provider: d.provider, folder: folder, items: pickedOrder.map(function (id) { var i = picked[id]; return { id: i.id, name: i.name, drive: i.drive }; }), connected: dayOf(new Date()) };
    var branch = '', wrote = null, saved = false;
    say('Sealing the drive\'s refresh token in this browser and saving ' + DRIVE_SECRET + ' on ' + repo + '...');
    gh('GET', '/repos/' + repo).then(function (r) {
      branch = r.data.default_branch || 'main';
      // what comes down from the drive is the repository's, so a public one is tracked into only
      // once the person has ticked that they know it
      if (isPublic(r.data) && !$('fd-public').checked) {
        showPublic(r.data);
        throw plain(repo + ' is public, so the files you tick, their names and the comments in them would be readable by anyone: tick the box under Track to go on, or choose a private repository in the bar.');
      }
      return readOne('/repos/' + repo + '/contents?ref=' + encodeURIComponent(branch));
    }).then(function (top) {
      // the drive's files land in this folder and merge by themselves once the check passes, so a
      // folder the repository already holds at its top, such as tools or scripts, which its checks
      // and workflows run, is never one the drive writes into; the folder it tracks already is
      var already = tracked && typeof tracked.folder === 'string' ? tracked.folder.toLowerCase() : '';
      var taken = (Array.isArray(top) ? top : []).some(function (e) { var n = String(e && e.name || '').toLowerCase(); return n === folder.toLowerCase() && n !== already; });
      if (taken) throw plain(repo + ' already has ' + folder + ' at its top, which the drive would write into and its checks may run: choose a folder name of its own, such as papers.');
      return Promise.all([loadSealer(), gh('GET', '/repos/' + repo + '/actions/secrets/public-key')]);
    }).then(function (both) {
      var sealed = toBase64(both[0](new TextEncoder().encode(refresh), fromBase64(both[1].data.key)));
      refresh = '';
      return gh('PUT', '/repos/' + repo + '/actions/secrets/' + DRIVE_SECRET, { encrypted_value: sealed, key_id: both[1].data.key_id }, undefined, false, account);
    }).then(function () {
      saved = true;
      say('The secret is saved; writing ' + DRIVE_FILE + '...');
      return writeDriveFile(repo, branch, config, account);
    }).then(function (w) {
      wrote = w;
      if (w.pull) return null;
      say('The file is written; starting the first sync...');
      return dispatchSync(repo, branch, account).then(function () { return true; }, function (e) { return e; });
    }).then(function (started) {
      // the drive's tokens are of no more use here: the repository holds the refresh token now
      if (drive === d) { drive = null; listedFor = null; }
      button.disabled = false;
      showConnectState();
      drawBrowser();
      if (wrote.pull) pendingPull[repo] = wrote.pull; else delete pendingPull[repo];
      var words = repo + ' tracks ' + plural(config.items.length, 'item') + ' of OneDrive in ' + folder + '/, and the drive\'s tokens are dropped from this page. ';
      if (wrote.pull) words += 'Its default branch takes only pull requests: merge the one linked in this tab, then press Sync now.';
      else if (started === true) words += 'The first sync is queued.';
      else words += dispatchWords(repo, started);
      say(words, started !== true && !wrote.pull);
      if (foldersRepo() === repo) loadFolders();
    }).catch(function (e) {
      refresh = '';
      button.disabled = false;
      if (e.plain) say(e.message, true);
      else if (!saved && e.status === 403) say(secretsRefused(repo), true);
      else if (!saved) say('The secret could not be saved (' + e.message + '), so nothing else was written. Press Track to try again.', true);
      else say('The secret ' + DRIVE_SECRET + ' is saved, but ' + DRIVE_FILE + ' could not be written: ' + e.message + ' Until it is, the half-hourly sync runs with the new secret on the drive.json the default branch holds, if any. Press Track to write it again.', true);
    });
  }

  // The tab opened, or the bar chose another repository while it is open: the drive's side drawn
  // from memory, the sign-in service asked once which drives it serves, and the chosen
  // repository read again unless the tab read it last
  function openFolders() {
    var d = heldDrive();
    showConnectState();
    if (!driveConfig && !driveAsked) wireConnect();
    drawPicked();
    if (d) { catalogMode = false; if (listedFor !== d) { listedFor = d; crumbs = []; resetExplorer(); nameDrive(); listFolder(); } }
    else maybeCatalog();
    if (foldersFor !== foldersRepo()) loadFolders();
  }
  // a part of the console: the sign-in, the bar and the repository are the console's, so the tab
  // wires only its own buttons, and the drive's return is read by initPanel before GitHub's
  function initFoldersTab() {
    $('fd-reload').addEventListener('click', findRepos);
    $('fd-connect').addEventListener('click', startDriveConnect);
    $('fd-track').addEventListener('click', function (ev) { track(ev.currentTarget); });
    consoleOnOpen.folders = openFolders;
  }

  // The Share tab: the person is invited as a collaborator through GitHub's API, as the signed-in
  // person, with SymphonyBoard's Administration permission, which GitHub's endpoint takes only a
  // username for; an email address is looked up in GitHub's user search, which finds only an address
  // its owner made public, and otherwise GitHub's own Add people page takes over. The mail buttons
  // compose the note in the person's own mail; nothing there is sent by the page.
  var SHARE_ROLES = { read: 'pull', triage: 'triage', write: 'push', maintain: 'maintain', admin: 'admin' };
  var SHARE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  var shareInvited = '';
  function shareRepo() { return state && state.repo ? state.repo : ''; }
  function shareWho() { return $('sh-who').value.trim(); }
  function shareIsEmail(who) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who); }
  function shareInOrg() { return !!(state && state.meta && state.meta.owner && state.meta.owner.type === 'Organization'); }
  function shareRole() { return shareInOrg() ? $('sh-role').value : 'write'; }
  function shareSay(text) { $('sh-answer').textContent = text; }
  function shareSubject() { return 'Join ' + shareRepo() + ' on GitHub'; }
  function shareNote() {
    var repo = shareRepo();
    return 'I would like you to work with me on ' + repo + ', a Symphony project on GitHub, with ' + shareRole() + ' access.\n\n' +
      (shareInvited ? 'I have invited your GitHub account (' + shareInvited + '). Accept it here, signed in to GitHub:\n'
        : 'I am inviting you on GitHub; once I have, the invitation is here, signed in to GitHub:\n') +
      'https://github.com/' + repo + '/invitations\n\n' +
      'The repository: https://github.com/' + repo + '\n' +
      'Its control panel: https://openspineconsortium.com/symphony/control/?repo=' + encodeURIComponent(repo) + '\n\n' +
      'No GitHub account yet? Make one at https://github.com/signup (Continue with Google works) and send me your username.\n';
  }
  function shareReady() {
    if (shareRepo()) return true;
    shareSay('Pick a repository first: + Add repository in the side column.');
    return false;
  }
  // window.open with noopener answers null even when the tab opens, so the opener is cut by hand
  function shareOpen(url) {
    var w = window.open(url, '_blank');
    if (!w) { shareSay('The browser blocked the new tab; allow pop-ups for this site, or use Copy the note.'); return false; }
    try { w.opener = null; } catch (e) { /* the new tab is another origin's already */ }
    return true;
  }
  function shareCopy(text, done) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) { shareSay('This browser gives the page no clipboard; select and copy by hand.'); return; }
    navigator.clipboard.writeText(text).then(function () { shareSay(done); },
      function () { shareSay('The browser refused the clipboard; select and copy by hand.'); });
  }
  // the address the mail goes to: what was typed, when it is one; else the person picks it in the mail
  function shareTo() {
    var who = shareWho();
    if (shareIsEmail(who)) return who;
    shareSay(who ? who + ' is not an email address, so pick who the note goes to in your mail.' : 'Pick who the note goes to in your mail.');
    return '';
  }
  function shareLogin(who) {
    if (!shareIsEmail(who)) return Promise.resolve(SHARE_LOGIN.test(who) ? who : '');
    return gh('GET', '/search/users?q=' + encodeURIComponent(who + ' in:email') + '&per_page=2').then(function (r) {
      var items = (r.data && r.data.items) || [];
      return items.length === 1 ? items[0].login : '';
    });
  }
  function shareInviteFailed(e) {
    var words = e.status === 403 || e.status === 404
      ? 'GitHub refused the invitation: you must administer ' + shareRepo() + ', and SymphonyBoard needs its Administration permission accepted on this installation (or a pasted token with Administration).'
      : 'GitHub refused the invitation: ' + e.message;
    shareSay(words + ' Open GitHub\'s Add people instead.');
  }
  function shareInvite() {
    if (!shareReady()) return;
    var who = shareWho();
    if (!who) { shareSay('Type their GitHub username or email first.'); return; }
    if (!shareIsEmail(who) && !SHARE_LOGIN.test(who)) { shareSay(who + ' is neither a GitHub username nor an email address.'); return; }
    var repo = shareRepo(), button = $('sh-invite');
    button.disabled = true;
    shareSay('Asking GitHub...');
    shareLogin(who).then(function (login) {
      if (!login) { shareSay('No GitHub account shows ' + who + ' publicly, so GitHub cannot be asked by address. Ask them for their username, or open GitHub\'s Add people and type the address there.'); return; }
      var body = shareInOrg() ? { permission: SHARE_ROLES[$('sh-role').value] || 'push' } : undefined;
      return gh('PUT', '/repos/' + repo + '/collaborators/' + encodeURIComponent(login), body).then(function (r) {
        shareInvited = login;
        shareSay(r.status === 201
          ? 'Invited ' + login + ' with ' + shareRole() + ' access. They accept at https://github.com/' + repo + '/invitations; now tell them below.'
          : login + ' already has access to ' + repo + '; GitHub sent no new invitation.');
        if (state.repo === repo) sharePeople();
      });
    }).catch(shareInviteFailed).then(function () { button.disabled = false; });
  }
  function shareRefresh() {
    var org = shareInOrg();
    $('sh-repo').textContent = shareRepo();
    $('sh-access-link').href = 'https://github.com/' + shareRepo() + '/settings/access';
    $('sh-role').disabled = !org;
    if (!org) $('sh-role').value = 'write';
    $('sh-role-note').textContent = org ? '' : 'A personal repository gives every collaborator write; GitHub has no other role for one.';
    shareInvited = '';
    shareSay('');
    sharePeople();
  }
  function shareDialogOpen() {
    shareInvited = '';
    shareSay('');
    $('sh-who').value = '';
    setTimeout(function () { $('sh-who').focus(); }, 0);
  }
  // who has access: a personal repository lists everyone (its owner among them); an organization's
  // lists the people added by name, since its members also reach it through the organization's base
  // role and teams, which GitHub's own page shows
  var shareFor = null;
  var SHARE_ROLE_WORDS = { admin: 'Admin', maintain: 'Maintain', write: 'Write', push: 'Write', triage: 'Triage', read: 'Read', pull: 'Read' };
  var shareSeq = 0;
  function sharePeople() {
    var repo = shareRepo();
    var body = $('sh-people').querySelector('tbody');
    var mine = ++shareSeq;
    shareFor = repo;
    clear(body);
    if (!repo) { $('sh-state').textContent = 'Pick a repository first: + Add repository in the side column.'; return; }
    // who owns it decides what is read, so the read waits for the repository's details (loadMeta calls again)
    if (!state.meta) { $('sh-state').textContent = 'Reading ' + repo + '...'; return; }
    var org = shareInOrg();
    $('sh-state').textContent = 'Reading who has access to ' + repo + '...';
    var people = ghList('/repos/' + repo + '/collaborators?affiliation=' + (org ? 'direct' : 'all') + '&per_page=100', 2);
    var waiting = ghList('/repos/' + repo + '/invitations?per_page=100', 1).catch(function () { return null; });
    Promise.all([people, waiting, whoAmI().catch(function () { return ''; })]).then(function (r) {
      if (mine !== shareSeq || state.repo !== repo) return;
      var list = r[0], invites = r[1], me = r[2];
      clear(body);
      var owner = state.meta && state.meta.owner;
      if (!org && owner && owner.login && !list.some(function (p) { return p.login === owner.login; })) list.unshift({ login: owner.login, role_name: 'admin' });
      list.forEach(function (p) { add(body, sharePersonRow(p, me, owner)); });
      (invites || []).forEach(function (inv) { add(body, shareInviteRow(inv)); });
      add(body, addTileRow('+ Add people', 'sh-tile', function () { openDialog('dlg-share'); }, 5));
      $('sh-state').textContent = plural(list.length, 'person', 'people') + ' with access' + (org ? ' by name' : '') +
        (invites ? (invites.length ? ', ' + plural(invites.length, 'invitation') + ' waiting' : ', no invitation waiting') : '; the invitations could not be read') +
        (org ? '. Members of ' + owner.login + ' may reach it through the organization too: see GitHub\'s Collaborators and teams.' : '.');
    }).catch(function (e) {
      if (mine !== shareSeq) return;
      clear(body);
      add(body, addTileRow('+ Add people', 'sh-tile', function () { openDialog('dlg-share'); }, 5));
      $('sh-state').textContent = (e.status === 403 || e.status === 404
        ? 'GitHub shows who has access to ' + repo + ' only to people who may push to it' + (signedInByApp() ? ', through an installation that may read its administration' : ', with a token that may') + '.'
        : 'Who has access could not be read: ' + e.message) + ' + Add people still works, and so does GitHub\'s own page.';
    });
  }
  function shareInitial(login) {
    var i = el('span', 'share__face', String(login || '?').charAt(0).toUpperCase());
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  function sharePersonRow(p, me, owner) {
    var tr = el('tr');
    var isOwner = !!(owner && owner.login === p.login && owner.type !== 'Organization');
    var role = isOwner ? 'Owner' : SHARE_ROLE_WORDS[p.role_name] || p.role_name || 'Access';
    var who = add(el('td', 'share__who'), link('https://github.com/' + encodeURIComponent(p.login), p.login));
    if (p.login === me) add(who, el('span', 'share__you', 'you'));
    add(tr, add(el('td', 'share__facecell'), shareInitial(p.login)), who, add(el('td'), el('span', 'share__role', role)), el('td', 'share__status', 'Has access'));
    var acts = { open: function () { shareStatus(p, role, false); } };
    if (!isOwner) acts.gear = function () { shareRoleDialog(p, role, false); };
    if (!isOwner && me && p.login !== me) acts.x = function (b) { shareRemove(p, b); };
    add(tr, cardControls(tr, p.login, acts));
    return tr;
  }
  function shareInviteRow(inv) {
    var login = inv.invitee && inv.invitee.login ? inv.invitee.login : (inv.email || 'someone');
    var tr = el('tr', 'share__pending');
    var role = SHARE_ROLE_WORDS[inv.permissions] || inv.permissions || 'Access';
    var status = add(el('td', 'share__status'), 'Invited ', timeEl(inv.created_at), ', not answered yet');
    add(tr, add(el('td', 'share__facecell'), shareInitial(login)), add(el('td', 'share__who'), inv.invitee ? link('https://github.com/' + encodeURIComponent(login), login) : el('span', '', login)), add(el('td'), el('span', 'share__role', role)), status);
    var p = { login: login, invitation: inv };
    add(tr, cardControls(tr, 'the invitation of ' + login, {
      open: function () { shareStatus(p, role, true); },
      gear: function () { shareRoleDialog(p, role, true); },
      x: function (b) { shareRemove(p, b); }
    }));
    return tr;
  }
  function shareStatus(p, role, pending) {
    var form = itemDialog(p.login);
    add(form, fact('Role:', role));
    add(form, fact('Stands:', pending ? 'Invited; they accept at https://github.com/' + shareRepo() + '/invitations, signed in to GitHub.' : 'Has access to ' + shareRepo() + '.'));
    if (pending && p.invitation.created_at) add(form, fact('Invited:', timeEl(p.invitation.created_at)));
    if (pending && p.invitation.inviter && p.invitation.inviter.login) add(form, fact('By:', p.invitation.inviter.login));
    add(form, add(el('p', 'tkdlg__bar'), link('https://github.com/' + encodeURIComponent(p.login), 'Their profile'), link('https://github.com/' + shareRepo() + '/settings/access', 'Access on GitHub')));
  }
  function shareRoleDialog(p, role, pending) {
    var form = itemDialog((pending ? 'The invitation of ' : '') + p.login);
    if (!shareInOrg()) {
      add(form, el('p', 'tkdlg__fact', 'A personal repository gives every collaborator write; GitHub has no other role to give. The × takes the access away.'));
      return;
    }
    var sel = el('select');
    sel.id = 'sh-role-change';
    var known = false;
    ['read', 'triage', 'write', 'maintain', 'admin'].forEach(function (v) { var o = el('option', '', SHARE_ROLE_WORDS[v]); o.value = v; if (SHARE_ROLE_WORDS[v] === role) { o.selected = true; known = true; } sel.appendChild(o); });
    if (!known) { var now = el('option', '', role + ' (now)'); now.value = ''; now.selected = true; now.disabled = true; sel.insertBefore(now, sel.firstChild); }
    var said = el('p', 'admin__warn');
    said.id = 'sh-role-said';
    var go = btn('Change the role', false, function () {
      if (!sel.value || SHARE_ROLE_WORDS[sel.value] === role) { said.textContent = 'Pick a role other than the one they have.'; return; }
      shareChangeRole(p, sel.value, pending, go, said);
    });
    go.id = 'sh-role-go';
    go.className = 'console__primary';
    add(form, add(el('div', 'tkdlg__field'), add(el('label', '', 'Role')), add(el('div', 'cpdlg__inline'), sel, go)));
    form.lastChild.querySelector('label').htmlFor = 'sh-role-change';
    add(form, said, el('p', 'tkdlg__note admin__lead', 'Read sees and clones; Triage also labels and closes issues; Write also pushes and merges; Maintain also manages the repository without its dangerous settings; Admin has every setting, deleting it included.'));
  }
  function shareChangeRole(p, role, pending, button, said) {
    var repo = shareRepo();
    button.disabled = true;
    say('Changing the role of ' + p.login + '...');
    var call = pending
      ? gh('PATCH', '/repos/' + repo + '/invitations/' + p.invitation.id, { permissions: role })
      : gh('PUT', '/repos/' + repo + '/collaborators/' + encodeURIComponent(p.login), { permission: SHARE_ROLES[role] || 'push' });
    call.then(function () {
      closeDialog('dlg-item');
      say(p.login + (pending ? '\'s invitation' : '') + ' now has ' + SHARE_ROLE_WORDS[role] + ' on ' + repo + '.');
      if (state.repo === repo) sharePeople();
    }).catch(function (e) {
      button.disabled = false;
      said.textContent = e.status === 403 || e.status === 404 ? 'GitHub refused: changing a role needs you to administer ' + repo + ' and SymphonyBoard\'s Administration permission accepted on its installation.' : e.message;
      say((e.status === 403 || e.status === 404 ? 'GitHub refused: changing a role needs you to administer ' + repo + ' and SymphonyBoard\'s Administration permission accepted on its installation.' : e.message), true);
    });
  }
  function shareRemove(p, button) {
    var repo = shareRepo();
    var pending = !!p.invitation;
    if (!window.confirm(pending ? 'Withdraw the invitation of ' + p.login + ' to ' + repo + '?' : 'Take ' + p.login + '\'s access to ' + repo + ' away? Their open pull requests stay; invite them again to bring them back.')) return;
    button.disabled = true;
    say(pending ? 'Withdrawing the invitation...' : 'Taking the access away...');
    var call = pending ? gh('DELETE', '/repos/' + repo + '/invitations/' + p.invitation.id) : gh('DELETE', '/repos/' + repo + '/collaborators/' + encodeURIComponent(p.login));
    call.then(function () {
      say(pending ? 'The invitation of ' + p.login + ' is withdrawn.' : p.login + ' no longer has access to ' + repo + '.');
      if (state.repo === repo) sharePeople();
    }).catch(function (e) {
      button.disabled = false;
      say((e.status === 403 || e.status === 404 ? 'GitHub refused: it needs you to administer ' + repo + ' and SymphonyBoard\'s Administration permission accepted on its installation.' : e.message), true);
    });
  }
  function initShareTab() {
    var q = function (v) { return encodeURIComponent(v); };
    $('sh-invite').addEventListener('click', shareInvite);
    $('sh-grant').addEventListener('click', function () {
      if (!shareReady()) return;
      var who = shareWho();
      // the tab opens first, so a blocked one is said and nothing tells the person to go to it
      if (!shareOpen('https://github.com/' + shareRepo() + '/settings/access')) return;
      if (who) shareCopy(who, who + ' is copied: on GitHub press Add people, paste it, pick the role and press Add.');
      else shareSay('On GitHub, press Add people and type their username or email.');
    });
    $('sh-gmail').addEventListener('click', function () {
      if (shareReady()) shareOpen('https://mail.google.com/mail/?view=cm&fs=1&to=' + q(shareTo()) + '&su=' + q(shareSubject()) + '&body=' + q(shareNote()));
    });
    $('sh-outlook').addEventListener('click', function () {
      if (shareReady()) shareOpen('https://outlook.office.com/mail/deeplink/compose?to=' + q(shareTo()) + '&subject=' + q(shareSubject()) + '&body=' + q(shareNote()));
    });
    $('sh-outlook-com').addEventListener('click', function () {
      if (shareReady()) shareOpen('https://outlook.live.com/mail/0/deeplink/compose?to=' + q(shareTo()) + '&subject=' + q(shareSubject()) + '&body=' + q(shareNote()));
    });
    $('sh-mail').addEventListener('click', function () {
      if (!shareReady()) return;
      var to = shareTo();
      location.href = 'mailto:' + q(to) + '?subject=' + q(shareSubject()) + '&body=' + q(shareNote());
      shareSay((to ? '' : 'Pick who the note goes to in your mail. ') + 'If no email app opened, use Copy the note.');
    });
    $('sh-native').addEventListener('click', function () {
      if (!shareReady()) return;
      if (!navigator.share) { shareCopy(shareNote(), 'This browser has no share sheet; the note is copied instead.'); return; }
      navigator.share({ title: shareSubject(), text: shareNote() }).catch(function () { /* the person closed the sheet */ });
    });
    $('sh-copy').addEventListener('click', function () { if (shareReady()) shareCopy(shareNote(), 'The note is copied.'); });
    consoleOnOpen.share = shareRefresh;
  }

  /* ---------- Explore: the project as a map to go into ---------- */
  // The repository at the top, then its goals and epics, each epic's tasks, a task's pull requests
  // (or its claim branch where it has none), the runs on that branch, a run's jobs, a job's steps and,
  // at the bottom, the lines of a step's log. One level is drawn at a time, its children as tiles:
  // a click, or scrolling up while pointing at a tile, goes into it; scrolling down, Backspace or a
  // crumb comes back out. The wheel scrolls a long level to its edge first and only then moves a
  // level, so a long list still scrolls. Goals, epics and tasks are what the console read already;
  // the levels below a task are read as the person, one read each, only when the person goes into
  // them, kept in the tab's memory for the repository chosen and written nowhere.
  var EXPLORE_KINDS = { repo: 'Repository', goal: 'Goal', epic: 'Epic', group: 'Group', issue: 'Task', pull: 'Pull request', branch: 'Branch', run: 'Run', job: 'Job', step: 'Step', log: 'Log' };
  var EXPLORE_LOG_LINES = 5000;
  // a wheel event this long after the one before starts a new gesture; only a gesture's first event
  // moves a level, so a trackpad's glide never carries on into the next level
  var EXPLORE_GESTURE_GAP = 250;
  var EXPLORE_LOGS_KEPT = 3;
  var explore = { s: null, issues: null, pulls: null, draw: null, failed: '', root: null, path: [], wheelLast: 0, era: 0, logs: [] };

  // the repository changed: nothing of the last one is kept, its logs included
  function exploreForget() {
    explore.era++;
    explore.s = null; explore.root = null; explore.path = []; explore.logs = [];
  }
  // a draw of the Dependencies tab ended, drawn or not; a fault here is Explore's, never the draw's
  function exploreAfterDraw() {
    if (consoleTab !== 'explore') return;
    try { openExplore(); } catch (e) { exStatus('Explore could not be drawn: ' + e.message); }
  }

  function exNode(kind, key, title, more) {
    var n = { kind: kind, key: kind + ':' + key, title: title, sub: '', state: '', url: '', claude: false, children: null, load: null, reading: null, failed: '', step: null, job: null };
    var k;
    for (k in (more || {})) if (Object.prototype.hasOwnProperty.call(more, k)) n[k] = more[k];
    return n;
  }
  function exHttps(url) { return typeof url === 'string' && /^https:\/\//.test(url) ? url : ''; }
  function exRepo(s) { return s.meta && typeof s.meta.full_name === 'string' && s.meta.full_name ? s.meta.full_name : s.repo; }
  function exAssistant(it) { return labelsOf(it).indexOf(ASSISTANT_LABEL) >= 0 && /^Assistant: /.test(String(it.title || '')); }

  // the tree down to the tasks, from the open issues and the Dependencies tab's latest draw; an
  // issue already on the path is not drawn under itself again, whatever GitHub's lists say
  function exBuild(s) {
    var repo = exRepo(s), draw = s.graphLast || null;
    // without a finished draw the epics' sub-issues are unknown, which the tab says rather than
    // calling an epic empty
    var unread = draw ? '' : (s.graphFailed ? 'Its sub-issues could not be read: ' + s.graphFailed : 'Its sub-issues are not read yet; they come with the Dependencies tab\'s next read.');
    var listed = {}, subs = draw ? draw.subIssues : {};
    var open = s.issues.filter(function (it) { return !it.pull_request && !exAssistant(it); });
    open.forEach(function (it) { listed[Number(it.number)] = graphIssue(it); });
    var claimed = graphClaimed(s.pulls || [], repo);
    function rec(n) { return listed[n] || (draw && (draw.listed[n] || draw.others[n])) || null; }
    var under = {};
    Object.keys(subs).forEach(function (k) { subs[k].forEach(function (n) { under[n] = true; }); });
    function issueNode(r, seen) {
      var goal = r.labels.indexOf('goal') >= 0, planned = graphPlanned(r);
      var n = exNode(planned ? (goal ? 'goal' : 'epic') : 'issue', r.number, '#' + r.number + ' ' + r.title, { state: graphClass(r, claimed) || 'open', url: exHttps(r.html_url), number: r.number });
      if (r.progress) n.sub = r.progress[0] + ' of ' + r.progress[1] + ' closed';
      var mine = seen.concat([r.number]);
      if (planned && unread) { n.children = []; n.unread = unread; }
      else if (planned) n.children = (subs[r.number] || []).filter(function (c) { return mine.indexOf(c) < 0; }).map(rec).filter(Boolean).map(function (c) { return issueNode(c, mine); });
      else n.load = function () { return exBranches(s, repo, r); };
      return n;
    }
    var root = exNode('repo', repo, repo, { url: exHttps(s.meta && s.meta.html_url), state: 'open' });
    root.sub = s.meta && typeof s.meta.description === 'string' ? s.meta.description : '';
    var planned = open.map(function (it) { return listed[Number(it.number)]; }).filter(graphPlanned).sort(function (a, b) { return a.number - b.number; });
    var goals = planned.filter(function (r) { return r.labels.indexOf('goal') >= 0; });
    var epics = planned.filter(function (r) { return r.labels.indexOf('goal') < 0 && !under[r.number]; });
    var loose = open.map(function (it) { return listed[Number(it.number)]; }).filter(function (r) { return !graphPlanned(r) && !under[r.number]; }).sort(function (a, b) { return a.number - b.number; });
    root.children = goals.concat(epics).map(function (r) { return issueNode(r, []); });
    if (loose.length) {
      var group = exNode('group', 'loose', unread ? 'Open tasks' : 'Not in an epic', { state: 'open', sub: plural(loose.length, 'open task') });
      group.children = loose.map(function (r) { return issueNode(r, []); });
      root.children.push(group);
    }
    root.sub = root.sub || plural(open.length, 'open issue');
    return root;
  }

  // a task's open pull requests, by its claim branch or by a body that closes it; where it has none,
  // its claim branch, whose runs may still be there
  function exBranches(s, repo, r) {
    var closes = new RegExp('\\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\\s+(' + repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')?#' + r.number + '\\b', 'i');
    var pulls = (s.pulls || []).filter(function (p) {
      var head = p && p.head ? p.head : {};
      var ours = head.repo && head.repo.full_name === repo;
      return (ours && head.ref === 'claude/' + r.number) || closes.test(String(p.body || ''));
    });
    var out = pulls.map(function (p) {
      var head = p.head || {}, ref = String(head.ref || '');
      var n = exNode('pull', p.number, '#' + p.number + ' ' + String(p.title || ''), { state: p.draft ? 'draft' : 'review', url: exHttps(p.html_url), sub: ref });
      // a fork's pull request runs here under its branch's name, so the runs are told apart by the
      // repository their head came from
      var from = head.repo && typeof head.repo.full_name === 'string' ? head.repo.full_name : '';
      n.load = function () { return exRuns(repo, ref, from); };
      return n;
    });
    if (!out.length) {
      var b = exNode('branch', r.number, 'claude/' + r.number, { state: 'open', sub: 'No open pull request; the runs on its claim branch' });
      b.load = function () { return exRuns(repo, 'claude/' + r.number, repo); };
      out.push(b);
    }
    return Promise.resolve(out);
  }

  // one read of GitHub, refused while the token is under the reserve the Dependencies tab keeps
  function exRead(path, raw, headers) {
    if (rateLatest !== null && rateLatest < GRAPH_RESERVE) return Promise.reject(new Error('GitHub says this token has ' + rateLatest + ' calls left this hour, and the page keeps the last ' + GRAPH_RESERVE + ' for the rest of the console. Try again once the hour has reset.'));
    return gh('GET', path, undefined, headers, raw);
  }
  function exOutcome(status, conclusion) {
    if (status && status !== 'completed') return 'running';
    if (conclusion === 'success') return 'done';
    if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipped';
    if (conclusion === 'cancelled') return 'cancelled';
    return conclusion ? 'failed' : 'open';
  }
  function exRuns(repo, branch, from) {
    return exRead('/repos/' + repo + '/actions/runs?branch=' + encodeURIComponent(branch) + '&per_page=20').then(function (r) {
      var runs = r.data && Array.isArray(r.data.workflow_runs) ? r.data.workflow_runs : [];
      return runs.filter(isPlain).filter(function (run) {
        var h = isPlain(run.head_repository) ? run.head_repository.full_name : '';
        return !h || !from || h === from;
      }).map(function (run) {
        var n = exNode('run', run.id, String(run.name || 'Run') + ' #' + String(run.run_number || ''), { state: exOutcome(run.status, run.conclusion), url: exHttps(run.html_url) });
        n.sub = String(run.event || '') + (run.created_at ? ', ' + ago(run.created_at) : '');
        n.load = function () { return exJobs(repo, run.id); };
        return n;
      });
    });
  }
  function exJobs(repo, id) {
    return exRead('/repos/' + repo + '/actions/runs/' + encodeURIComponent(id) + '/jobs?per_page=50').then(function (r) {
      var jobs = r.data && Array.isArray(r.data.jobs) ? r.data.jobs : [];
      var total = r.data && typeof r.data.total_count === 'number' ? r.data.total_count : jobs.length;
      var out = jobs.filter(isPlain).map(function (job) {
        var steps = Array.isArray(job.steps) ? job.steps.filter(isPlain) : [];
        var n = exNode('job', job.id, String(job.name || 'Job'), { state: exOutcome(job.status, job.conclusion), url: exHttps(job.html_url), sub: plural(steps.length, 'step') });
        n.repo = repo;
        n.children = steps.map(function (st) {
          var c = exNode('step', job.id + '.' + st.number, String(st.number) + '. ' + String(st.name || ''), { state: exOutcome(st.status, st.conclusion), url: n.url, step: st, job: n });
          c.claude = /claude/i.test(String(st.name || ''));
          if (c.claude) n.claude = true;
          return c;
        });
        n.children.push(exNode('log', job.id, 'The whole log', { state: 'open', url: n.url, job: n, sub: 'Every line of the job' }));
        return n;
      });
      if (total > out.length) out.more = 'The first ' + out.length + ' of ' + total + ' jobs; the rest are on GitHub.';
      return out;
    });
  }
  // a job's log, read once and kept with the job; GitHub answers with a redirect to its own storage,
  // which the browser follows and may refuse to read across origins
  // The read carries the token alone: the browser drops it on the redirect to another origin, and a
  // request with no header of GitHub's own needs no permission asked of the storage first. The
  // lines are kept for the last few jobs read, not every one.
  var EXPLORE_LOG_HEADERS = { 'Accept': null, 'X-GitHub-Api-Version': null };
  function exLog(job) {
    if (!job.logRead) {
      explore.logs = explore.logs.filter(function (j) { return j !== job; }).concat([job]);
      while (explore.logs.length > EXPLORE_LOGS_KEPT) explore.logs.shift().logRead = null;
    }
    if (!job.logRead) job.logRead = exRead('/repos/' + job.repo + '/actions/jobs/' + encodeURIComponent(job.key.slice(4)) + '/logs', true, EXPLORE_LOG_HEADERS).then(function (r) {
      return exLines(typeof r.data === 'string' ? r.data : '');
    }).catch(function (e) {
      job.logRead = null;
      if (e && e.name === 'TypeError') throw new Error('GitHub keeps this log where your browser may not read it from this page.');
      throw e;
    });
    return job.logRead;
  }
  // the lines of a log, each with its time, the colour codes taken out
  function exLines(text) {
    return String(text).split(/\r?\n/).map(function (line) {
      var m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z ?(.*)$/.exec(line);
      var body = (m ? m[3] : line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      return { at: m ? Date.parse(m[1] + (m[2] ? m[2].slice(0, 4) : '') + 'Z') : NaN, text: body };
    });
  }
  // a step's lines, by the times GitHub gives the steps, to the second: a skipped step printed
  // nothing, so it takes none; a line in the second a step starts stays with the step before unless
  // it opens the new step's group, since a step's last lines and the next one's first share a second;
  // a line with no time goes with the line before it, and lines before the first start with the first
  function exStepLines(lines, job, step) {
    var starts = job.children.filter(function (c) { return c.step && c.step.started_at && c.step.conclusion !== 'skipped'; })
      .map(function (c) { return { n: c.step.number, at: Math.floor(Date.parse(c.step.started_at) / 1000) }; })
      .filter(function (b) { return !isNaN(b.at); }).sort(function (a, b) { return a.at - b.at; });
    if (!starts.length) return [];
    var cur = 0, out = [];
    lines.forEach(function (l) {
      if (!isNaN(l.at)) {
        var sec = Math.floor(l.at / 1000);
        while (cur + 1 < starts.length && (sec > starts[cur + 1].at || (sec === starts[cur + 1].at && /^##\[group\]Run /.test(l.text)))) cur++;
      }
      if (starts[cur].n === step.number) out.push(l);
    });
    return out;
  }

  /* drawing */
  function exCurrent() { return explore.path[explore.path.length - 1] || null; }
  function exStatus(text) { $('ex-status').textContent = text; }
  function exKids(n) { return Array.isArray(n.children) ? n.children : []; }
  function exTile(n, i) {
    var t = el('button', 'ex__tile ex__tile--' + n.kind + ' ex__s--' + (n.state || 'open'));
    t.type = 'button';
    t.setAttribute('data-ex', String(i));
    if (exKids(n).length > 8) t.className += ' ex__tile--wide';
    var top = add(t, el('span', 'ex__kind', EXPLORE_KINDS[n.kind] || n.kind)).lastChild;
    if (n.claude) add(top, ' ', el('span', 'ex__claude', 'Claude'));
    add(t, el('span', 'ex__title', n.title));
    if (n.sub) add(t, el('span', 'ex__sub', n.sub));
    var kids = exKids(n);
    if (kids.length) {
      var dots = add(t, el('span', 'ex__dots')).lastChild;
      kids.slice(0, 40).forEach(function (k) { var d = add(dots, el('span', 'ex__dot ex__s--' + (k.state || 'open'))).lastChild; d.title = k.title; });
      if (kids.length > 40) add(dots, el('span', 'ex__more', '+' + (kids.length - 40)));
    } else if (n.load && !n.children) add(t, el('span', 'ex__hint', 'Go in to read'));
    var pill = add(t, el('span', 'ex__pill', n.state || 'open')).lastChild;
    pill.setAttribute('aria-hidden', 'true');
    t.setAttribute('aria-label', (EXPLORE_KINDS[n.kind] || n.kind) + ': ' + n.title + (n.sub ? ', ' + n.sub : '') + ', ' + (n.state || 'open'));
    return t;
  }
  function exDraw() {
    var stage = $('ex-stage'), n = exCurrent();
    clear(stage);
    exPath();
    exTree();
    var gh2 = $('ex-github');
    if (n && n.url) { gh2.href = n.url; gh2.hidden = false; } else { gh2.hidden = true; gh2.removeAttribute('href'); }
    $('ex-out').disabled = explore.path.length <= 1;
    if (!n) { none(stage, 'Nothing to explore yet: no repository is chosen.'); exStatus('Choose a repository in the side column.'); return; }
    var head = add(stage, el('div', 'ex__head ex__s--' + (n.state || 'open'))).lastChild;
    add(head, el('span', 'ex__kind', EXPLORE_KINDS[n.kind] || n.kind), el('h3', 'ex__name', n.title));
    if (n.sub) add(head, el('p', 'ex__sub', n.sub));
    if (n.kind === 'step' || n.kind === 'log') return exDrawLog(stage, n);
    if (n.failed) {
      none(stage, n.failed);
      var again = add(stage, el('button', 'ex__tool', 'Try again')).lastChild;
      again.type = 'button';
      again.addEventListener('click', function () { n.failed = ''; exGo(explore.path.slice()); });
      exStatus('This level could not be read.');
      return;
    }
    if (!n.children) { none(stage, 'Reading from GitHub...'); exStatus('Reading...'); return; }
    var kids = exKids(n);
    if (!kids.length) {
      none(stage, n.unread || exEmpty(n));
      if (n.load) add(stage, exAgain('Read this level again', function () { n.children = null; }));
      exStatus('Nothing below this level.');
      return;
    }
    var grid = add(stage, el('div', 'ex__grid')).lastChild;
    kids.forEach(function (k, i) { grid.appendChild(exTile(k, i)); });
    if (kids.more) add(stage, el('p', 'admin__none', kids.more));
    if (n.load) add(stage, exAgain('Read this level again', function () { n.children = null; }));
    exStatus(plural(kids.length, 'item') + '. Click a tile, or scroll up on it, to go in; scroll down or press Backspace to come out.');
  }
  // what a run still going shows changes, so a level read below a task can be read again by hand
  function exAgain(words, forget) {
    var b = el('button', 'ex__tool ex__again', words);
    b.type = 'button';
    b.addEventListener('click', function () { forget(); exGo(explore.path.slice()); });
    return b;
  }
  function exEmpty(n) {
    if (n.kind === 'repo') return explore.s && !explore.s.ready ? 'The issues are still being read.' : 'No open issue yet. Tasks, epics and goals appear here as they are opened.';
    if (n.kind === 'pull' || n.kind === 'branch') return 'No GitHub Actions run on this branch.';
    if (n.kind === 'run') return 'This run has no job.';
    if (n.kind === 'epic' || n.kind === 'goal') return 'No sub-issue: add tasks on the issue\'s page under Sub-issues.';
    return 'Nothing here.';
  }
  function exDrawLog(stage, n) {
    var job = n.job, box = add(stage, el('div', 'ex__log')).lastChild;
    var link = n.url ? el('a', 'ex__link', 'Open the log on GitHub') : null;
    if (link) { link.href = n.url; link.target = '_blank'; link.rel = 'noopener'; }
    none(box, 'Reading the log...');
    exStatus('Reading the log...');
    var era = explore.era;
    exLog(job).then(function (all) {
      if (era !== explore.era || exCurrent() !== n) return;
      var lines = n.kind === 'step' ? exStepLines(all, job, n.step) : all;
      clear(box);
      if (!lines.length || (lines.length === 1 && !lines[0].text)) { none(box, 'No line of the log falls in this step.'); if (link) add(box, link); exStatus('An empty step.'); return; }
      var pre = add(box, el('pre', 'ex__lines')).lastChild;
      lines.slice(0, EXPLORE_LOG_LINES).forEach(function (l) {
        var cls = /^##\[group\]/.test(l.text) ? 'ex__group' : /^##\[error\]/.test(l.text) ? 'ex__error' : /^##\[warning\]/.test(l.text) ? 'ex__warning' : '';
        add(pre, el('span', cls ? 'ex__line ' + cls : 'ex__line', l.text.replace(/^##\[(group|endgroup|error|warning)\]/, '')));
      });
      if (lines.length > EXPLORE_LOG_LINES) add(box, el('p', 'admin__none', 'The first ' + EXPLORE_LOG_LINES + ' of ' + lines.length + ' lines; the rest are on GitHub.'));
      if (link) add(box, link);
      add(box, exAgain('Read the log again', function () { job.logRead = null; }));
      exStatus(plural(Math.min(lines.length, EXPLORE_LOG_LINES), 'line') + (n.claude ? ' of the step that runs Claude.' : '.') + ' Backspace comes back out.');
    }).catch(function (e) {
      if (era !== explore.era || exCurrent() !== n) return;
      clear(box);
      none(box, 'The log could not be read: ' + e.message);
      if (link) add(box, link);
      exStatus('The log could not be read here; GitHub shows it.');
    });
  }
  function exPath() {
    var nav = $('ex-path');
    clear(nav);
    explore.path.forEach(function (n, i) {
      if (i) add(nav, el('span', 'ex__sep', '\u203a'));
      var last = i === explore.path.length - 1;
      var b = add(nav, el(last ? 'span' : 'button', last ? 'ex__here' : 'ex__crumb', n.title)).lastChild;
      if (!last) { b.type = 'button'; b.addEventListener('click', function () { exGo(explore.path.slice(0, i + 1)); }); }
      else b.setAttribute('aria-current', 'location');
    });
  }
  // the outline: every level read so far, open along the path
  function exTree() {
    var box = $('ex-tree');
    clear(box);
    if (!explore.root) return;
    (function walk(n, chain, depth, parent) {
      var on = explore.path.indexOf(n) >= 0;
      var row = add(parent, el('div', 'ex__node' + (n === exCurrent() ? ' ex__current' : ''))).lastChild;
      row.style.paddingLeft = (depth * 12 + 4) + 'px';
      var b = add(row, el('button', 'ex__nodename ex__s--' + (n.state || 'open'), n.title)).lastChild;
      b.type = 'button';
      b.title = n.title;
      if (n === exCurrent()) b.setAttribute('aria-current', 'location');
      b.addEventListener('click', function () { exGo(chain); });
      if (on) exKids(n).forEach(function (k) { walk(k, chain.concat([k]), depth + 1, parent); });
    })(explore.root, [explore.root], 0, box);
  }

  // going to a level: its children read where they are not yet, then drawn
  // the keys stay with the tab: a person who went in from inside it is left on the new level's
  // first tile, or on the level itself where it has none
  function exGo(path, from) {
    var n = path[path.length - 1];
    var held = $('tab-explore').contains(document.activeElement);
    explore.path = path;
    exZoom(from);
    exDraw();
    if (n && !n.children && n.load && !n.failed) {
      var era = explore.era;
      if (!n.reading) n.reading = n.load().then(function (kids) { n.children = kids; }).catch(function (e) { n.failed = 'Not read: ' + e.message; }).then(function () { n.reading = null; });
      n.reading.then(function () { if (era === explore.era && exCurrent() === n) { held = held || document.activeElement === document.body; exDraw(); exFocus(held); } });
    } else exFocus(held);
  }
  function exIn(i, tile) {
    var n = exCurrent(), k = n && exKids(n)[i];
    if (k) exGo(explore.path.concat([k]), tile);
  }
  function exOut() { if (explore.path.length > 1) exGo(explore.path.slice(0, -1)); }
  function exFocus(held) {
    if (!held) return;
    var tile = $('ex-stage').querySelector('.ex__tile');
    (tile || $('ex-stage')).focus({ preventScroll: true });
  }
  // a short growth of the tile into the stage, so the move reads as going in; none for a reader who
  // asked for less motion
  function exZoom(tile) {
    var stage = $('ex-stage');
    if (!tile || !stage.getBoundingClientRect || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    // the box is placed in the stage's parent, so both ends are measured from it
    var a = tile.getBoundingClientRect(), b = stage.getBoundingClientRect(), p = stage.parentNode.getBoundingClientRect();
    var z = el('div', 'ex__zoom');
    z.style.left = (a.left - p.left) + 'px';
    z.style.top = (a.top - p.top) + 'px';
    z.style.width = a.width + 'px';
    z.style.height = a.height + 'px';
    stage.parentNode.appendChild(z);
    z.getBoundingClientRect();
    z.style.left = (b.left - p.left) + 'px'; z.style.top = (b.top - p.top) + 'px'; z.style.width = b.width + 'px'; z.style.height = b.height + 'px'; z.style.opacity = '0';
    setTimeout(function () { if (z.parentNode) z.parentNode.removeChild(z); }, 320);
  }
  // Only the first event of a gesture that starts at an edge moves a level: scrolling up from the
  // top over a tile goes into it, scrolling down from the bottom comes out. A gesture that reaches
  // the edge partway, or glides on after a move, only scrolls. A pinch (ctrl and the wheel) is the
  // browser's own zoom.
  function exWheel(e) {
    var now = Date.now(), first = now - explore.wheelLast > EXPLORE_GESTURE_GAP;
    explore.wheelLast = now;
    if (e.ctrlKey || Math.abs(e.deltaY) < 4) return;
    var stage = $('ex-stage'), n = exCurrent();
    if (!n || n.kind === 'step' || n.kind === 'log') return;
    if (e.deltaY < 0) {
      var tile = e.target.closest ? e.target.closest('.ex__tile') : null;
      if (!tile || stage.scrollTop > 0) return;
      e.preventDefault();
      if (first) exIn(Number(tile.getAttribute('data-ex')), tile);
    } else {
      if (stage.scrollTop + stage.clientHeight < stage.scrollHeight - 2 || explore.path.length <= 1) return;
      e.preventDefault();
      if (first) exOut();
    }
  }
  function exKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var tiles = Array.prototype.slice.call($('ex-stage').querySelectorAll('.ex__tile'));
    var at = tiles.indexOf(document.activeElement);
    if (e.key === 'Backspace' || e.key === 'Escape') { if (explore.path.length > 1) { e.preventDefault(); exOut(); } return; }
    // the arrows move between tiles only from a tile or the stage, never from the outline or the trail
    if (!tiles.length || (at < 0 && e.target !== $('ex-stage'))) return;
    if (e.key === 'Enter' && at >= 0) { e.preventDefault(); exIn(at, tiles[at]); return; }
    var across = 1;
    if (tiles.length > 1) { var top0 = tiles[0].offsetTop; while (across < tiles.length && tiles[across].offsetTop === top0) across++; }
    var to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + across, ArrowUp: at - across, Home: 0, End: tiles.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    tiles[Math.max(0, Math.min(tiles.length - 1, at < 0 ? 0 : to))].focus();
  }

  // the tab opened, or the issues were read again while it is open: the tree built afresh from what
  // the console holds, the path kept as far as its levels are still there
  function openExplore() {
    var s = state;
    if (!s.repo) { explore.root = null; explore.path = []; explore.s = s; exDraw(); return; }
    if (explore.s === s && explore.issues === s.issues && explore.pulls === s.pulls && explore.draw === (s.graphLast || null) && explore.failed === (s.graphFailed || '') && explore.root) { exDraw(); return; }
    var keys = explore.s && explore.s.repo === s.repo ? explore.path.map(function (n) { return n.key; }) : [];
    var old = explore.s && explore.s.repo === s.repo ? explore.path.slice() : [];
    explore.era++;
    explore.s = s;
    explore.issues = s.issues;
    explore.pulls = s.pulls;
    explore.failed = s.graphFailed || '';
    explore.draw = s.graphLast || null;
    explore.root = exBuild(s);
    var path = [explore.root];
    for (var i = 1; i < keys.length; i++) {
      var here = path[path.length - 1], kids = exKids(here), next = null;
      kids.forEach(function (k) { if (k.key === keys[i]) next = k; });
      // a level read below a task is carried over as it was, since the issues' read did not touch it
      if (!next && here.load && !here.children && old[i - 1] && old[i - 1].key === here.key && old[i - 1].children) { here.children = old[i - 1].children; kids = here.children; kids.forEach(function (k) { if (k.key === keys[i]) next = k; }); }
      if (!next) break;
      path.push(next);
    }
    exGo(path);
  }
  function initExploreTab() {
    $('ex-out').addEventListener('click', exOut);
    $('ex-stage').addEventListener('click', function (e) {
      var tile = e.target.closest ? e.target.closest('.ex__tile') : null;
      if (tile) exIn(Number(tile.getAttribute('data-ex')), tile);
    });
    $('ex-stage').addEventListener('wheel', exWheel, { passive: false });
    $('tab-explore').addEventListener('keydown', exKey);
    consoleOnOpen.explore = openExplore;
  }

  // the Agents tab puts one in each agent's row
  window.tokenAssignBox = tokenAssignBox;

  // the cost page carries a signed-in box of its own, so its marker is read first
  // tokens.html was a page of its own until the console took it in as a tab: it sends a visitor there
  if ($('tokens-moved')) location.replace('/symphony/control/' + location.search + '#tokens');
  else if ($('cost-app')) initCost();
  else if ($('cp-app')) { initConsole(); initPanel(); if ($('tk-tiles')) initTokensTab(); if ($('sh-who')) initShareTab(); if ($('fd-connect')) initFoldersTab(); if ($('ex-stage')) initExploreTab(); }
})();
