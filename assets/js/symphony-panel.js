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
   Sign-in by code (GitHub's device flow, for the Home Screen app) is built
   and switched off by CODE_SIGNIN; while it is off, no page offers it.

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
  // Sign-in by code (GitHub's device flow, below), built and switched off. While it is false no page
  // offers a code, and the Home Screen app's Sign in with GitHub leaves for GitHub's page as a
  // browser's does. It works only with "Enable Device Flow" ticked on SymphonyBoard, and that tick
  // lets anyone ask GitHub for a SymphonyBoard code and talk a person into typing it, which hands
  // whoever asked a token that acts as that person; GitHub advises against it outside command lines
  // and devices with no browser. So it is the owner's switch alone, turned on only if the usual sign-in
  // does not come back into the installed app (symphony-app's signin/README.md, step 9).
  var CODE_SIGNIN = false;
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
  // a line's words drawn anew, its addresses as links (rich)
  function richText(node, text) { clear(node); return rich(node, text); }
  // words that may name an address: each https address becomes a link that opens it, so a message
  // that says where to fix something is one press from the fix (Ashley, 2026-10-19); a full stop,
  // comma or bracket that ends the sentence stays out of the link
  function rich(node, text) {
    var words = String(text == null ? '' : text);
    var at = /https:\/\/[^\s<>"']+/g, from = 0, m;
    while ((m = at.exec(words))) {
      var href = m[0].replace(/[.,;:!?)\]]+$/, '');
      if (m.index > from) node.appendChild(document.createTextNode(words.slice(from, m.index)));
      node.appendChild(link(href, href));
      from = m.index + href.length;
      at.lastIndex = from;
    }
    if (from < words.length) node.appendChild(document.createTextNode(words.slice(from)));
    return node;
  }
  function none(parent, text) { return add(parent, el('p', 'admin__none', text)); }
  // the page's note over the screen's foot; a task under way there (msgTask) stays under it, since
  // its work goes on, while a finished one gives way to the new words as any message did
  function say(text, warn, plainText) {
    var m = $('msg');
    if (!m) return;
    Array.prototype.slice.call(m.childNodes).forEach(function (n) {
      if (!(n.classList && n.classList.contains('msgtask') && n.getAttribute('data-state') === 'live')) m.removeChild(n);
    });
    // a note that quotes a file's name keeps it as text, since a name can look like an address
    if (text) m.insertBefore(plainText ? el('p', 'msg__note', text) : rich(el('p', 'msg__note'), text), m.firstChild);
    m.className = warn ? 'admin__box admin__warn' : 'admin__box';
    clearTimeout(noteTimer);
    if (text && !warn) { var note = m.firstChild; noteTimer = setTimeout(function () { fadeNote(note); }, NOTE_MS); }
  }
  // A plain note goes by itself after a while, so the note over the screen's foot never sits over
  // the page with nothing to do; a warning, a note with something to press or type, and a task stay
  // until Clear, and a note the pointer or the focus is on waits until they leave it. While the
  // panel is signed out the note is the only word of why (forgotten in another tab, refused by
  // GitHub), so it stays for whoever comes back to the sign-in.
  var NOTE_MS = 8000;
  var noteTimer = 0;
  function fadeNote(note) {
    var m = $('msg');
    if (!m || !note || note.parentNode !== m || /admin__warn/.test(m.className)) return;
    if (note.querySelector('input, button, select, textarea')) return;
    if ($('cp-app').classList.contains('hidden')) return;
    var foot = m.closest('.console__status');
    if ((foot && foot.matches(':hover')) || (foot && foot.contains(document.activeElement))) { noteTimer = setTimeout(function () { fadeNote(note); }, NOTE_MS); return; }
    m.removeChild(note);
    if (!m.firstChild) { m.className = 'admin__box'; toastFocusBack(); }
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
    // and so does what was under way in the note, whose calls now go unanswered
    msgTasksDrop();
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
    // another way in ends a sign-in by code still asking, whose token would otherwise come later and
    // take this one's place; its words go with it, since GitHub's return says nothing of its own and
    // the panel that opens next finds no code left to clear them for
    if (endCode()) say('');
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
  /* ---------- sign-in by code, for the Home Screen app, while CODE_SIGNIN is on ---------- */
  // The panel installed as a Home Screen app runs in a window of its own, and a sign-in that leaves
  // for GitHub's page may come back to the browser rather than into the app, leaving the sign-in's
  // secret behind in the app's storage. GitHub's device flow signs in without leaving: the sign-in
  // service asks GitHub for a code, the page shows it, the person types it at github.com/login/device,
  // and the page asks the service, no faster than GitHub allows, for the token the code earns
  // (symphony-app's signin/README.md, the device routes). It is the same token, renewed the same way.
  var DEVICE_PAGE = 'https://github.com/login/device';
  function codeWay() { return CODE_SIGNIN && signinAvailable(); }
  // the page as a Home Screen app: iOS says so through navigator.standalone, the rest through the
  // manifest's display mode
  function inApp() {
    try { if (window.navigator.standalone === true) return true; } catch (e) { /* not iOS */ }
    try { return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e2) { return false; }
  }
  // one sign-in by code at a time: a new press, Cancel, another way in or a sign-out ends the one
  // before, and a late answer to an ended one is dropped, its token revoked
  var codeTurn = 0;
  var codeTimer = null;
  var codeLive = false;
  // ends the sign-in by code under way, if any, and says whether one was
  function endCode() {
    var live = codeLive;
    codeLive = false;
    codeTurn++;
    if (codeTimer) { clearTimeout(codeTimer); codeTimer = null; }
    var box = $('cp-code-box');
    if (!box) return live;
    var focus = document.activeElement;
    var lost = live && (!focus || focus === document.body || box.contains(focus));
    box.hidden = true;
    if ($('cp-code-said')) $('cp-code-said').hidden = true;
    ['cp-signin', 'cp-signin-code'].forEach(function (id) { if ($(id) && signinAvailable()) $(id).disabled = false; });
    // focus the code took (its button held, or a button of its box now hidden) goes back to the button
    // that starts a sign-in by code, so a keyboard is never left on nothing
    var back = $('cp-signin-code') && !$('cp-signin-code').hidden ? $('cp-signin-code') : $('cp-signin');
    if (lost && back && back.getClientRects().length) back.focus({ preventScroll: true });
    return live;
  }
  // whether the whole of a node shows, under no header or note held to the window's edge
  function inSight(node) {
    var r = node.getBoundingClientRect();
    var x = r.left + Math.min(r.width / 2, 24);
    return [r.top + 1, r.bottom - 1].every(function (y) { var at = document.elementFromPoint(x, y); return !!(at && node.contains(at)); });
  }
  // on a phone the code's box opens below the fold, behind the note over the window's foot,
  // so it is brought up to the window's middle; where it shows whole already nothing moves
  function bringIntoSight(node) {
    if (inSight(node)) return;
    try { scrollInDeck(node, { block: 'center' }); } catch (e) { /* the code is in the note too */ }
  }
  function showCode(code) {
    $('cp-code').textContent = code;
    var box = $('cp-code-box');
    box.hidden = false;
    if ($('cp-code-said')) $('cp-code-said').hidden = true;
    bringIntoSight(box);
    // the pressed button is held while the code is up, which takes a keyboard's focus from it, so the
    // focus goes on to the box's first step, unless the person has moved it somewhere meanwhile
    var focus = document.activeElement;
    if (!focus || focus === document.body || /^cp-signin/.test(focus.id || '')) $('cp-code-open').focus({ preventScroll: true });
  }
  // the code's words go to the page's line; where that line is not held in view, as on the cost page,
  // where it stands above the sign-in box, they are said in the box's own line too
  function codeSays(text, warn) {
    say(text, warn);
    var line = $('cp-code-said');
    if (!line || $('console')) return;
    line.textContent = text;
    line.className = 'admin__lead control__codesaid' + (warn ? ' admin__warn' : '');
    line.hidden = !text;
    if (text) bringIntoSight(line);
  }
  var CODE_WORDS = {
    expired_token: 'The code ran out before it was typed on GitHub; press the button again for a new one.',
    access_denied: 'GitHub says the sign-in was cancelled on its page; press the button again to start over.',
    device_flow_disabled: 'Sign-in by code is not turned on for SymphonyBoard yet (the App\'s owner ticks "Enable Device Flow" in its settings); use a token below meanwhile.',
    no_such_route: 'The sign-in service does not offer sign-in by code yet; use a token below meanwhile.'
  };
  // asks for the token until the person has typed the code, GitHub refuses, or the code runs out; a
  // moment the service or GitHub cannot be reached is asked again at the same pace
  function pollCode(turn, device, every, until) {
    return new Promise(function (resolve, reject) {
      function later() { codeTimer = setTimeout(ask, every * 1000); }
      function ask() {
        codeTimer = null;
        if (turn !== codeTurn) { resolve(null); return; }
        if (Date.now() >= until) { var out = new Error(CODE_WORDS.expired_token); out.code = 'expired_token'; reject(out); return; }
        exchange('/device/token', { device_code: device }).then(resolve, function (e) {
          if (turn !== codeTurn) { resolve(null); return; }
          if (e.code === 'authorization_pending') { later(); return; }
          if (e.code === 'slow_down') { every = Math.min(Math.max(every + 5, Number(e.interval) || 0), 120); later(); return; }
          // the service's own limit on one address's calls: it is asked again, more slowly
          if (e.code === 'too_many_requests') { every = Math.min(every + 5, 120); later(); return; }
          if (!e.code || e.code === 'github_unreachable') { later(); return; }
          reject(e);
        });
      }
      later();
    });
  }
  function startCode(onSignedIn) {
    endCode();
    var turn = codeTurn;
    codeLive = true;
    ['cp-signin', 'cp-signin-code'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
    codeSays('Asking GitHub for a code...');
    exchange('/device', {}).then(function (got) {
      if (turn !== codeTurn) return null;
      var code = typeof got.user_code === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(got.user_code) ? got.user_code : '';
      if (!code || typeof got.device_code !== 'string' || !got.device_code) throw new Error('The sign-in service answered without a code.');
      showCode(code);
      say('Type ' + code + ' on GitHub\'s page; this page signs you in as soon as you have.');
      var until = Date.now() + Math.min(Math.max(Number(got.expires_in) || 900, 60), 3600) * 1000;
      var every = Math.min(Math.max(Number(got.interval) || 5, 5), 60);
      return pollCode(turn, got.device_code, every, until);
    }).then(function (answer) {
      if (!answer) return;
      // a token GitHub gave for a code this page has let go of (Cancel, another way in, a sign-out) is
      // nobody's, so GitHub is asked to revoke it, as storeSignin does for the tokens it replaces
      if (turn !== codeTurn) {
        if (answer.access_token) exchange('/revoke', { access_token: answer.access_token }).catch(function () { /* it runs out in eight hours */ });
        return;
      }
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      // the tick as it stands when the token comes: the page never left, and the box beneath the code
      // could be ticked or unticked while the code was up
      var keep = $('cp-keep') ? $('cp-keep').checked : false;
      endCode();
      // as a pasted token does: the panel stays closed until GitHub names this one
      showGate();
      state = emptyState(state.repo);
      keepOauth(answer, keep);
      say('');
      onSignedIn();
    }).catch(function (e) {
      if (turn !== codeTurn) return;
      endCode();
      codeSays(CODE_WORDS[e.code] || (e.message + ' Press the button again, or use a token below.'), true);
      offerToken();
    });
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
          // GitHub's slow_down names the longer wait it asks for (the device routes)
          if (typeof data.interval === 'number') err.interval = data.interval;
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
    return exchangeCode({ code: code, code_verifier: kept.verifier, redirect_uri: pageAddress() }, 0).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without a token.');
      keepOauth(answer, !!kept.keep);
      return true;
    }).catch(function (e) {
      if (githubLimiting(e)) say('GitHub is limiting sign-ins for the moment, so this one did not finish. Wait a minute, then press Sign in with GitHub again, or use a token.', true);
      else say(e.message + ' Press Sign in with GitHub to try again, or use a token.', true);
      offerToken();
      return false;
    });
  }
  // GitHub holds its sign-in endpoint to a limit per address, and the sign-in service reaches it
  // from addresses its host shares, so a 429 can come from others' sign-ins. GitHub declines such a
  // request before acting on it, so the one-time code is not spent and is sent again after a wait;
  // a 5xx is not, since GitHub may have spent the code before failing
  var SIGNIN_RETRY_MS = [2000, 6000];
  function githubLimiting(e) {
    var words = String(e && e.message || '');
    if (/GitHub answered 429\b|it answered 429\b/.test(words)) return true;
    return !!e && e.code === 'github_unreachable' && !/answered 5\d\d\b/.test(words);
  }
  function exchangeCode(body, tries) {
    return exchange('/exchange', body).catch(function (e) {
      if (tries >= SIGNIN_RETRY_MS.length || !githubLimiting(e)) throw e;
      say('GitHub is busy for the moment; trying the sign-in again...', false);
      return new Promise(function (resolve) { setTimeout(resolve, SIGNIN_RETRY_MS[tries]); }).then(function () { return exchangeCode(body, tries + 1); });
    });
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
  // where a refusal at a path is fixed: the page of SymphonyBoard's installation that accepts its
  // permissions, and the page that installs it, for the account the path names
  function fixPages(path) {
    var orgAt = /^\/orgs\/([A-Za-z0-9-]+)/.exec(path || ''), repoAt = /^\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/.exec(path || '');
    var install = 'https://github.com/apps/' + APP_SLUG + '/installations/new';
    if (orgAt) return { accept: 'https://github.com/organizations/' + orgAt[1] + '/settings/installations', install: install };
    if (repoAt) return { accept: 'https://github.com/' + repoAt[1] + '/' + repoAt[2] + '/settings/installations', install: install };
    return { accept: 'https://github.com/settings/installations', install: install };
  }
  function explain(status, data, path, byApp) {
    var m = data && data.message ? String(data.message) : '';
    var fix = fixPages(path);
    if (status === 401) return byApp
      ? 'GitHub refused the sign-in\'s token (401): it was revoked or has run out. Press Sign in with GitHub again.'
      : 'GitHub refused the token (401). Paste one that is still valid' + (signinAvailable() ? ', or press Sign in with GitHub.' : '.');
    if (status === 429 || (status === 403 && /rate limit|secondary/i.test(m))) return 'GitHub\'s rate limit for this token is reached (' + status + '). Wait a minute, then press Refresh.';
    if (status === 403) return byApp
      ? 'The sign-in may not do this (403' + (m ? ': ' + m : '') + '): it acts within SymphonyBoard\'s permissions and your own access, on the repositories the App is installed on. An administrator accepts the App\'s newest permissions at ' + fix.accept + ' (Configure beside SymphonyBoard).'
      : 'The token may not do this (403' + (m ? ': ' + m : '') + '). A fine-grained token needs the permission the sign-in box names for it; make one at https://github.com/settings/personal-access-tokens/new.';
    if (status === 404) return 'GitHub has nothing at ' + path + ' (404): the repository, the branch or the file is not there, or ' + (byApp ? 'the sign-in does not reach it, since SymphonyBoard is not installed there; install it at ' + fix.install + '.' : 'the token does not reach it.');
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
    if (signin && codeWay()) {
      addCodeWay(signin, onSignedIn);
      signin.addEventListener('click', function () { if (inApp()) startCode(onSignedIn); else { endCode(); startOauth(); } });
    } else if (signin && signinAvailable()) signin.addEventListener('click', startOauth);
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
  // The code's box under "Sign in with GitHub": in the Home Screen app that button itself signs in by
  // code, and the gate's first words say so in place of the redirect's; in a browser a second,
  // quieter button offers the same, for wherever GitHub's return does not come back to the page. The
  // box warns beside the code that a code is typed only where and when this page asks: anyone can
  // start a SymphonyBoard code, and whoever started the one a person types is signed in as them.
  function addCodeWay(signin, onSignedIn) {
    var row = signin.parentNode;
    var app = inApp();
    var other = el('button', 'control__codeway quiet', 'Sign in with a code instead');
    other.type = 'button';
    other.id = 'cp-signin-code';
    other.hidden = app;
    other.addEventListener('click', function () { startCode(onSignedIn); });
    row.appendChild(document.createTextNode(' '));
    row.appendChild(other);
    var open = el('a', 'control__codeopen', 'Copy it and open GitHub');
    open.id = 'cp-code-open';
    open.href = DEVICE_PAGE;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.addEventListener('click', function () {
      var code = $('cp-code').textContent;
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).catch(function () { /* the code stays on the page to read */ }); } catch (e) { /* the same */ }
    });
    var cancel = el('button', 'quiet', 'Cancel');
    cancel.type = 'button';
    cancel.id = 'cp-code-cancel';
    cancel.addEventListener('click', function () { endCode(); say(''); });
    var code = el('output', 'control__code', '');
    code.id = 'cp-code';
    var warn = el('p', 'control__codewarn', 'Type a code only there, on github.com/login/device, and only one you started on this page a moment ago. A code someone sends you, by mail, chat or another page, would sign them in as you.');
    warn.id = 'cp-code-warn';
    var box = add(el('div', 'control__codebox'), el('p', '', 'Type this code on GitHub\'s page, github.com/login/device, where GitHub names SymphonyBoard and asks whether it may act as you; allow it:'), code, add(el('div', 'control__codebar'), open, cancel), warn);
    box.id = 'cp-code-box';
    box.hidden = true;
    row.parentNode.insertBefore(box, row.nextSibling);
    var said = el('p', 'admin__lead control__codesaid', '');
    said.id = 'cp-code-said';
    said.hidden = true;
    row.parentNode.insertBefore(said, box.nextSibling);
    // the page's own words for the app, which the gate's markup carries beside the redirect's
    var how = $('cp-signin-how');
    if (app && how && how.getAttribute('data-in-app')) how.textContent = how.getAttribute('data-in-app');
    // what the page sends, which names the code's requests only where they can be made
    if ($('cp-sent-code')) $('cp-sent-code').hidden = false;
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
    // the panel opening (a kept sign-in found at load, GitHub's return, a paste) is another way in: a
    // sign-in by code started meanwhile would go on asking unseen under it, its code and Cancel hidden
    // with the gate, so it ends here, and its words with it
    if (endCode()) say('');
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
    // a sign-in by code still asking would sign the page in again after it was signed out
    endCode();
    // Forget the token is the browser's sign-out, so every connection kept on it goes
    writeKept({});
    forgetToken();
    dropDrive();
    showGate();
    var era = choices;
    var where = 'The token is forgotten in this tab and on this browser';
    var others = ' Another tab signed in for that tab alone keeps its sign-in until you forget it there or close it.';
    // a classic token is deleted on another page of GitHub's settings than a fine-grained one
    var pages = [];
    if (pasted.some(function (t) { return /^ghp_/.test(t); })) pages.push('https://github.com/settings/tokens');
    if (pasted.some(function (t) { return !/^ghp_/.test(t); })) pages.push('https://github.com/settings/personal-access-tokens');
    var pat = !pasted.length ? '' : pasted.length === 1
      ? ' The personal access token itself stays valid at GitHub until it runs out or you delete it at ' + pages[0] + '.'
      : ' The personal access tokens themselves stay valid at GitHub until they run out or you delete them at ' + pages.join(' and ') + '.';
    if (dead.length && signinAvailable()) {
      say(where + '; asking GitHub to revoke the sign-in\'s token...');
      // a sign-in or paste made before GitHub answers has the page's words by then
      Promise.all(dead.map(function (t) { return exchange('/revoke', { access_token: t }); })).then(function () {
        if (era === choices) say(where + ', and the sign-in\'s token is revoked at GitHub.' + others + pat + listed);
      }).catch(function (e) {
        if (era === choices) say(where + ', but GitHub could not be asked to revoke the sign-in\'s token (' + e.message + '). It runs out within eight hours; Revoke beside SymphonyBoard at https://github.com/settings/apps/authorizations ends it now.' + others + pat + listed, true);
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
    'dlg-share': function () { shareDialogOpen(); },
    // a read of what the repository tracks that failed is tried again when the steps are opened
    // the drives to add: the sign-in service is asked which it serves, if this load has not asked yet
    'dlg-cloud': function () { if (!driveConfig && !driveAsked) wireConnect(); },
    'dlg-track': function () { var s = $('fd-say'); if (s) clear(s); if (foldersRepo() !== foldersFor) loadFolders(); }
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
    add(form, el('p', 'tkdlg__note admin__lead', 'Ask comments on the issue mentioning @claude, and the repository\'s Claude workflow answers there on the repository\'s own Claude token. For a question about the board, use the Claude button at the top right.'));
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
      richText($('cp-other'), 'The issues could not be read: ' + e.message);
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
    // the write goes out for the account the press was made as, since the read before it may name one
    var account = shownLogin;
    var task = msgTask(label.charAt(0).toUpperCase() + label.slice(1) + ' on ' + s.repo);
    task.tell('Starting...');
    return newestRunId(s.repo, 'agents.yml').then(function (after) {
      return gh('POST', '/repos/' + s.repo + '/actions/workflows/agents.yml/dispatches', { ref: branch, inputs: inputs }, undefined, false, account).then(function () {
        task.tell('Queued on ' + branch + '; the Runs tab shows it within a minute.');
        setTimeout(function () { if (!stale(s)) loadRuns(s); }, 4000);
        return followDispatched(s, 'agents.yml', after, task);
      });
    }).catch(function (e) {
      task.refuse(e.status === 404 ? 'This repository has no Agents workflow yet (.github/workflows/agents.yml); the template\'s next update brings it.'
        : e.message + (e.status === 403 ? ' Starting a workflow needs Actions: read and write on the sign-in or the token.' : ''));
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
      if (!runs.length) { var tr = el('tr'); add(tr, el('td', 'admin__none', 'No run yet.')).firstChild.colSpan = 7; body.appendChild(tr); }
      runs.forEach(function (run) {
        var tr = el('tr');
        add(tr, add(el('td'), link(run.html_url, run.name || run.display_title || 'run')));
        add(tr, el('td', '', run.event));
        add(tr, el('td', '', run.head_branch || ''));
        var w = conclusionWord(run);
        add(tr, el('td', '', w)).lastChild.className = w === 'success' ? 'admin__tag admin__tag--ok' : (w === 'failure' ? 'admin__tag admin__tag--wait' : 'admin__tag admin__tag--mid');
        add(tr, el('td', '', run.actor && run.actor.login ? run.actor.login : ''));
        add(tr, add(el('td'), timeEl(run.run_started_at || run.created_at)));
        add(tr, runControl(s, run));
        tr.setAttribute('data-outcome', outcomeOf(w));
        body.appendChild(cardCells(tr, ['name', 'event', 'branch', 'outcome', 'who', 'when', 'ctl']));
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
  // a run still going can be cancelled from here, as GitHub's own Cancel workflow does: a worker in
  // the cloud is stopped the same way it was started, with no machinery of ours
  function runControl(s, run) {
    var td = el('td');
    if (run.status === 'completed') return td;
    var stop = btn('Cancel', true, function () {
      if (!window.confirm('Cancel the run ' + (run.name || run.display_title || run.id) + '? Its jobs stop where they are.')) return;
      stop.disabled = true;
      gh('POST', '/repos/' + s.repo + '/actions/runs/' + encodeURIComponent(run.id) + '/cancel').then(function () {
        say('Cancelling ' + (run.name || 'the run') + '.');
        setTimeout(function () { if (!stale(s)) loadRuns(s); }, 3000);
      }, function (e) {
        stop.disabled = false;
        say(e.status === 403 || e.status === 404 ? 'Cancelling a run needs Actions: read and write (' + e.status + ').' : e.message);
      });
    });
    stop.id = 'cp-run-cancel-' + run.id;
    return add(td, stop);
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
        // the Claude dialog's answer finds a pull request's Merge button by its number; data-pull keeps
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
    var letGo = holdStage();
    graphReset('Reading the issues of ' + name + '...', false, true);
    try { history.replaceState(null, '', location.pathname + '?repo=' + encodeURIComponent(name) + location.hash); } catch (e) { /* the address stays */ }
    rememberRepo(name);
    fillRepoSelect($('cp-repo'), name);
    assistantRepo(s);
    if (consoleTab === 'tokens' && consoleOnOpen.tokens) consoleOnOpen.tokens();
    if (consoleTab === 'grid' && consoleOnOpen.grid) consoleOnOpen.grid();
    if (consoleTab === 'leaders' && consoleOnOpen.leaders) consoleOnOpen.leaders();
    foldersFor = null;
    if (consoleTab === 'folders' && consoleOnOpen.folders) consoleOnOpen.folders();
    if (consoleTab === 'share' && consoleOnOpen.share) consoleOnOpen.share();
    exploreForget();
    if (consoleTab === 'explore' && consoleOnOpen.explore) consoleOnOpen.explore();
    nbForget();
    if (consoleTab === 'notebooks') drawNotebooks();
    return loadMeta(s).then(function () {
      if (stale(s)) return;
      if (consoleTab === 'notebooks' && consoleOnOpen.notebooks) consoleOnOpen.notebooks();
      return Promise.all([loadBoard(s), loadWorkers(s), loadAgents(s), loadRuns(s), loadPulls(s)]);
    }).then(function () {
      letGo();
      if (stale(s)) return;
      s.ready = true;
      summary();
    }).catch(function (e) {
      letGo();
      if (stale(s)) return;
      failed(s, 'the repository', e);
      s.ready = true;
      say(e.message, true);
      graphReset('Not drawn: the repository could not be read.', true);
      // the Notebooks tab waits on the repository's meta, which never came: it says so in place of Reading
      if (!s.meta && consoleTab === 'notebooks' && consoleOnOpen.notebooks) consoleOnOpen.notebooks();
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
      add(box, el('p', '', meta.full_name + ' does not carry the topic symphony, so Symphony is not set up on it yet. The Folders tab\'s Track, and every tab that reads only what GitHub has, work on it as it is:'));
      add(box, add(el('p', 'admin__bar'), btn('Open ' + meta.full_name, false, function () { clear(box); closeDialog('dlg-repos'); loadRepo(meta.full_name); })));
      add(box, el('p', '', 'To set Symphony up on it as well, two steps on GitHub:'));
      var ol = el('ol');
      add(ol, add(el('li'), link(installLink(meta), 'Install SymphonyBoard on ' + meta.full_name), ' (the page comes with this one repository selected; it sends you on to Symphony Setup\'s install page, then to the form).'));
      add(ol, add(el('li'), 'On ', link(FORM_URL, 'the form'), ', press Create: the pull request lands within about two minutes and merges unless you asked to review it. Then come back here and press Add again.'));
      add(box, ol);
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
  // The repository with Symphony set up that was pushed most recently, of those the sign-in reaches:
  // the one a person works in, read from GitHub, since a new browser keeps no list of its own
  function usualRepo(groups) {
    var best = null;
    groups.forEach(function (g) {
      g.repos.forEach(function (r) {
        if (r.archived || !(r.topics && r.topics.indexOf(TOPIC) >= 0)) return;
        if (!best || String(r.pushed_at || '') > String(best.pushed_at || '')) best = r;
      });
    });
    return best ? best.full_name : '';
  }
  function openUsualRepo(again) {
    var asked = token, was = state;
    $('cp-summary').textContent = 'Looking for your repository with Symphony...';
    // a repository opened, a picker opened or a sign-in changed since the lookup began wins over it
    function chosenMeanwhile() { return state !== was || chosenRepo() || $('dlg-repos').open || !token; }
    function none() {
      $('cp-summary').textContent = 'No repository listed yet. Press + Add repository in the side column to pick one.';
      openDialog('dlg-repos');
    }
    pickerRead().then(function (groups) {
      if (chosenMeanwhile()) return;
      // the token renewed while GitHub listed them: the lookup is made once more with the new one
      if (!groups || token !== asked) { if (again) none(); else openUsualRepo(true); return; }
      var name = usualRepo(groups);
      if (!name) { none(); return; }
      loadRepo(name);
      say('Opened ' + name + ', your repository with Symphony pushed most recently. Press + Add repository to open another.');
    }).catch(function () {
      if (!chosenMeanwhile()) none();
    });
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
    }).catch(function (e) { richText($('rp-state'), 'GitHub did not list them: ' + e.message + ' Type OWNER/NAME above to open one by name.'); });
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
      // a repository the picker lists opens as it is: one without Symphony still serves the Folders
      // tab's Track and every tab that reads only GitHub, so setting it up is offered, never required
      closeDialog('dlg-repos');
      if (r.full_name !== state.repo) loadRepo(r.full_name);
    }
    card.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('a, button') && !ev.target.closest('.repos__name')) return; choose(); });
    return card;
  }
  // Open, or Enter in the search: a whole name is read by name; otherwise the first card shown opens
  function pickerOpenTyped() {
    var typed = ($('cp-add-name').value || '').trim();
    var cards = Array.prototype.slice.call($('rp-list').querySelectorAll('.repos__card'));
    var exact = cards.filter(function (c) { return typed && c.getAttribute('data-repo').toLowerCase() === typed.toLowerCase(); })[0];
    // a whole name typed is read by name, which opens one with Symphony at once and offers Open
    // first for one without; a card pressed opens its repository whatever it carries
    if (REPOSITORY.test(typed)) { addRepository(typed); return; }
    if (exact) { exact.click(); return; }
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
    // the dialog closes at once; what the request says comes to the note, and the fields keep
    // their words for another try
    closeDialog('dlg-task');
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
    closeDialog('dlg-task');
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
    closeDialog('dlg-worker');
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
    closeDialog('dlg-worker');
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
    // the write goes out for the account the press was made as, since the read before it may name one
    var account = shownLogin;
    var task = msgTask(label.charAt(0).toUpperCase() + label.slice(1) + ' on ' + s.repo);
    task.tell('Starting...');
    newestRunId(s.repo, workflow).then(function (after) {
      return gh('POST', '/repos/' + s.repo + '/actions/workflows/' + workflow + '/dispatches', { ref: branch }, undefined, false, account).then(function () {
        task.tell('Queued on ' + branch + '; the runs list shows it within a minute.');
        setTimeout(function () { if (!stale(s)) loadRuns(s); }, 4000);
        return followDispatched(s, workflow, after, task);
      });
    }).catch(function (e) { task.refuse(e.message + (e.status === 403 ? ' Starting a workflow needs Actions: read and write' + (signedInByApp() ? ', which the sign-in has once SymphonyBoard holds it; a fine-grained token with it starts one now.' : ' on the token.') : '')); });
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
    // on a phone a tab fills the screen, named in the bar over it beside the way back
    var c = $('console');
    if (c) c.classList.remove('console--home');
    var title = $('cp-phonetitle'), named = document.querySelector('.console__rail [data-tab="' + name + '"] .rail__name');
    if (title && named) title.textContent = named.textContent;
    // on a phone the rail scrolls sideways, so the chosen tab is brought into its view, without
    // moving the window
    var rail = document.querySelector('.console__rail');
    if (rail && getComputedStyle(rail).flexDirection === 'row') {
      var chosen = rail.querySelector('[data-tab="' + name + '"]');
      if (chosen) rail.scrollLeft = chosen.offsetLeft - Math.max(0, (rail.clientWidth - chosen.offsetWidth) / 2);
      railEdges();
    }
    // the state is kept, so a tab opened from the phone's home screen still steps back to it
    if (location.hash !== '#' + name) {
      try { history.replaceState(history.state, '', location.pathname + location.search + '#' + name); } catch (e) { /* the address stays */ }
    }
    if (changed && consoleOnOpen[name]) consoleOnOpen[name]();
  }
  // A phone shows one thing at a time (the owner, 2026-10-20): the tabs as a home screen of square
  // buttons, or one tab filling the screen, with a back button to the buttons; a dialog fills the
  // screen over the tab and gives it back when it closes (control.css, the phone's home screen).
  // The home screen keeps no tab in the address, so a reload there comes back to it, and a tab
  // opened from it is a step in the history, so the phone's own back gesture returns as the button does.
  var PHONE_QUERY = '(max-width: 900px), (max-height: 520px)';
  function phoneLayout() { return !!(window.matchMedia && window.matchMedia(PHONE_QUERY).matches); }
  function consoleAtHome() { var c = $('console'); return !!c && c.classList.contains('console--home'); }
  function showHome() {
    var c = $('console');
    if (!c || !phoneLayout()) return;
    // a tab's own dialog open over it (a token's, a notebook's) closes with the tab, never left
    // open and unseen with the page held behind it
    Array.prototype.forEach.call(c.querySelectorAll('.console__stage dialog[open]'), function (d) {
      try { d.close(); } catch (e) { d.removeAttribute('open'); }
    });
    c.classList.add('console--home');
    // no tab is shown under the home screen, so nothing a tab sets for itself reaches it; showTab
    // shows the tab again
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab-panel]'), function (p) { p.hidden = true; });
    if (location.hash) {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* the address stays */ }
    }
    var tabs = consoleTabs();
    tabs.forEach(function (t) { t.tabIndex = -1; });
    var chosen = tabs.filter(function (t) { return t.getAttribute('data-tab') === consoleTab; })[0] || tabs[0];
    if (chosen) chosen.tabIndex = 0;
    if (chosen && c.contains(document.activeElement)) chosen.focus();
  }
  // the console left the phone's layout (a window widened, a tablet turned): the tab it showed
  // before the home screen comes back, as a computer's console always shows one
  function leftPhone() {
    var c = $('console');
    if (!c || !c.classList.contains('console--home') || phoneLayout()) return;
    c.classList.remove('console--home');
    var name = consoleTab;
    consoleTab = '';
    showTab(name);
  }
  // the home screen's arrows move among the buttons as a grid, a row being the buttons level with
  // the first, and open nothing; Enter or Space presses the one in focus
  function homeArrow(e, i, all) {
    var across = all.filter(function (t) { return t.offsetTop === all[0].offsetTop; }).length || 1;
    var step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: across, ArrowUp: -across }[e.key];
    var to = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : step === undefined ? -1 : Math.min(all.length - 1, Math.max(0, i + step));
    if (to < 0) return;
    e.preventDefault();
    all[i].tabIndex = -1;
    all[to].tabIndex = 0;
    all[to].focus();
  }
  // a tab pressed on the home screen: a step in the history, then the tab
  function openFromHome(name) {
    if (location.hash !== '#' + name) {
      try { history.pushState({ consoleHome: 1 }, '', location.pathname + location.search + '#' + name); } catch (e) { /* replaced below */ }
    }
    showTab(name);
    if ($('cp-back')) $('cp-back').focus();
  }
  function leaveTab() {
    if (history.state && history.state.consoleHome) history.back(); else showHome();
  }
  function revealTab(node) {
    var panel = node && node.closest ? node.closest('[data-tab-panel]') : null;
    if (panel && panel.hidden) showTab(panel.getAttribute('data-tab-panel'));
    revealTaskList(node);
  }
  // The Tasks tab shows one list at a time, or All side by side (the owner, 2026-10-21: "tasks can be
  // split into tabs so you dont need all the nav to jump across a long row of tasks"); the chips in
  // its head are the sub-tabs, and the choice is kept in this browser
  var KEY_TASK_VIEW = 'symphony_panel_tasks_view';
  var TASK_VIEWS = ['queue', 'given', 'claimed', 'review', 'blocked', 'epics', 'all'];
  function taskBoard() { return document.querySelector('#tab-tasks .console__kanban'); }
  function taskView(view, keep) {
    var board = taskBoard();
    if (!board || TASK_VIEWS.indexOf(view) < 0) return;
    board.setAttribute('data-view', view);
    Array.prototype.forEach.call(document.querySelectorAll('#tab-tasks [data-taskview]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-taskview') === view ? 'true' : 'false');
    });
    if (keep) {
      try { localStorage.setItem(KEY_TASK_VIEW, view); } catch (e) { /* the choice lasts while the page is open */ }
    }
  }
  function keptTaskView() {
    var v = '';
    try { v = localStorage.getItem(KEY_TASK_VIEW) || ''; } catch (e) { v = ''; }
    return TASK_VIEWS.indexOf(v) >= 0 ? v : 'queue';
  }
  // a row or list shown from elsewhere (a readout, the assistant's focus, Centre its row) brings its
  // own list up, unless All already shows it, and leaves the person's own choice kept for next time
  function revealTaskList(node) {
    var board = taskBoard();
    if (!board || !node || !node.closest || !board.contains(node)) return;
    var col = node.closest('[data-col]');
    var view = board.getAttribute('data-view');
    if (col && view !== 'all' && view !== col.getAttribute('data-col')) taskView(col.getAttribute('data-col'));
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
    railEdges();
  }
  // on a phone the rail is a row that scrolls sideways, and its end fades where more tabs lie past
  // it, so the tabs out of sight are not taken for all there are (control.css, data-more)
  function railEdges() {
    var rail = $('console') && $('console').querySelector('.console__rail');
    if (rail) markEdges(rail, getComputedStyle(rail).flexDirection === 'row');
  }
  // which ends of a box that scrolls sideways have more past them, as data-more, which the
  // stylesheet fades: the rail on a phone, and the Dependencies tab's strip of tiles
  function markEdges(box, sideways) {
    var more = '';
    if (sideways && box.scrollWidth > box.clientWidth + 1) {
      var left = box.scrollLeft > 1, right = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
      more = left && right ? 'both' : (left ? 'left' : (right ? 'right' : ''));
    }
    if (more) box.setAttribute('data-more', more); else box.removeAttribute('data-more');
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
      // the phone's home screen draws a count as a badge, and as a phone does shows none for nothing
      if (span.classList.contains('rail__count')) span.toggleAttribute('data-zero', text === '0');
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
    // the task board shows the list's own sub-tab (revealTab, above), or, under All, lays the lists
    // side by side, so the jump is sideways there
    if (box.classList.contains('console__kanban') && getComputedStyle(box).display === 'grid') {
      box.scrollLeft = head.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
      head.classList.remove('console__flash');
      void head.offsetWidth;
      head.classList.add('console__flash');
    } else box.scrollTop = head.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  }
  // a message that arrives, or changes, flashes the note; emptying it does not.
  // say() replaces className, so the flash class is put back after it rather than kept
  function initFlash() {
    var m = $('msg');
    if (!m || !window.MutationObserver) return;
    var last = '';
    new MutationObserver(function (records) {
      var text = m.textContent;
      // a task's steps and its log change every few seconds, and do not flash
      var quiet = records.length > 0 && records.every(function (r) {
        var n = r.target.nodeType === 1 ? r.target : r.target.parentNode;
        return !!(n && n !== m && n.closest && n.closest('.msgtask__quiet'));
      });
      if (!text || text === last || quiet) { last = text; return; }
      last = text;
      m.classList.remove('console__flash');
      void m.offsetWidth;
      m.classList.add('console__flash');
    }).observe(m, { childList: true, characterData: true, subtree: true });
    m.addEventListener('animationend', function () { m.classList.remove('console__flash'); });
  }

  /* ---------- the view stays where it is while a tab is read again ---------- */
  // A box emptied while its new rows are on their way (the charts on Refresh, the tiles of the
  // Tokens tab) shrinks what holds it, and the window, or the tab's own scroll, lands somewhere
  // else: the view jumps. So a box being read again keeps its height until it is drawn, and on a
  // phone, where the page scrolls as a whole, the stage keeps its own through a refresh.
  // Each hold marks the node as its own, so the release of an older hold, a refresh that went stale
  // under a newer one or its own safety timer, lets nothing go once a newer hold has the node. The
  // height is measured here unless the caller took it first, to the fraction of a pixel: a height
  // rounded up stands a fraction taller than the box, and on a phone the page under it moves a pixel.
  var holdsMade = 0;
  function exactHeight(node) {
    var h = parseFloat(getComputedStyle(node).height);
    return isFinite(h) ? h : node.offsetHeight;
  }
  function holdHeight(node, height) {
    if (!node) return function () {};
    var mine = String(++holdsMade);
    node.setAttribute('data-held', mine);
    var h = height === undefined ? exactHeight(node) : height;
    if (h) node.style.minHeight = h + 'px';
    return function () {
      if (node.getAttribute('data-held') !== mine) return;
      node.removeAttribute('data-held');
      node.style.minHeight = '';
    };
  }
  // the stage through one refresh, where the page and not the deck scrolls; a refresh that never
  // ends, its calls dropped by a sign-out, lets it go after a while anyway
  // where the page and not the deck scrolls, as on a phone
  function pageScrolls() {
    var c = $('console');
    return !!c && getComputedStyle(c).overflow !== 'hidden';
  }
  function holdStage() {
    var c = $('console');
    if (!pageScrolls()) return function () {};
    var release = holdHeight(c.querySelector('.console__stage'));
    var timer = setTimeout(release, 20000);
    return function () { clearTimeout(timer); requestAnimationFrame(release); };
  }

  /* ---------- a piece of work that takes a while speaks in the note ---------- */
  // A workflow started from a button, or the sign-in of Add Token, held a dialog open or said one
  // line and went quiet. Now the dialog answers and closes at once, and the work speaks in the note
  // over the screen's foot: its name, where it is, the run's steps as GitHub lists them and the last
  // lines of a job's log once the job has ended (GitHub gives a log then, not while the job runs),
  // and the step it needs from the person as links and a box there, so nothing more pops up. A new
  // word flashes the note white, as any message does; the steps and the log do not, since they
  // change every few seconds. Clear hides a task and its work goes on; the button that started it
  // shows it again, and a message said meanwhile goes above it (say).
  var msgTasks = [];
  function msgTask(title) {
    // a new task takes the place of what was said before it, as a message does; tasks under way stay
    say('');
    var box = el('div', 'msgtask');
    box.setAttribute('data-state', 'live');
    var head = el('p', 'msgtask__head');
    var name = el('strong', '', title);
    var where = el('span', 'msgtask__where');
    add(head, name, where);
    var line = el('p', 'msgtask__line');
    var steps = el('ul', 'msgtask__steps msgtask__quiet');
    steps.hidden = true;
    var log = el('pre', 'msgtask__log msgtask__quiet');
    log.hidden = true;
    log.setAttribute('aria-live', 'off');
    var step = el('div', 'msgtask__step');
    var bar = el('p', 'admin__bar msgtask__bar');
    bar.hidden = true;
    // the step the person takes and the buttons come right under the line, before the steps and the
    // log, so in a phone's short note the sign-in's link is in view and the quiet parts are below
    add(box, head, line, step, bar, steps, log);
    var task = {
      box: box,
      step: step,
      live: true,
      dropped: false,
      show: function () { var m = $('msg'); if (m && !task.dropped && box.parentNode !== m) add(m, box); },
      hide: function () { if (box.parentNode) box.parentNode.removeChild(box); },
      retitle: function (text) { name.textContent = text; },
      // the latest word on where the work is
      tell: function (text, warn) {
        clear(line);
        rich(line, text);
        line.className = 'msgtask__line' + (warn ? ' admin__warn' : '');
        task.show();
      },
      // a link beside the name: the run on GitHub
      at: function (href, text) { clear(where); if (href) add(where, link(href, text)); },
      // the run's steps, each with its state (stepState)
      steps: function (list) {
        clear(steps);
        list.forEach(function (st) { var li = el('li', '', st.name); li.setAttribute('data-state', st.state); add(steps, li); });
        steps.hidden = !list.length;
      },
      // the last lines of the run's log
      lines: function (list) {
        log.textContent = list.join('\n');
        log.hidden = !list.length;
        log.scrollTop = log.scrollHeight;
      },
      button: function (label, onClick) { var b = btn(label, true, onClick); add(bar, b); bar.hidden = false; return b; },
      // the work is over: its last word is the newest, so a message said meanwhile goes as it would
      // before any message, and the box stays until Clear or the next message
      end: function (text, warn) {
        // a task a sign-out dropped has nothing left to say, and never touches what was said since
        if (task.dropped) return;
        task.live = false;
        box.setAttribute('data-state', warn ? 'failed' : 'done');
        bar.hidden = true;
        if (text) task.tell(text, warn);
        var m = $('msg');
        if (m) Array.prototype.slice.call(m.querySelectorAll(':scope > p.msg__note')).forEach(function (n) { m.removeChild(n); });
        msgTasks = msgTasks.filter(function (t) { return t !== task; });
      },
      // the work never started: the box goes, and the refusal is a plain message, as before a task
      refuse: function (text) {
        task.live = false;
        task.dropped = true;
        task.hide();
        msgTasks = msgTasks.filter(function (t) { return t !== task; });
        say(text, true);
      }
    };
    msgTasks.push(task);
    task.show();
    return task;
  }
  // a sign-out drops what was under way: its calls go unanswered, and nothing more of it is said
  function msgTasksDrop() {
    msgTasks.forEach(function (t) { t.live = false; t.dropped = true; t.hide(); });
    msgTasks = [];
  }

  /* ---------- the run a button started, followed from the note ---------- */
  // GitHub lists a workflow's runs newest first, so the run a press started is the first listed
  // whose id is above the newest before the press, the one the signed-in person started where
  // several are; one that is not listed within two minutes is left to the Runs tab. While it runs,
  // its jobs' steps are read every few seconds; once a job has ended, the last lines of its log are
  // read once, with the token alone and none of GitHub's headers, and a log the browser
  // may not read across origins is left out.
  var RUN_FIND_MS = 5000, RUN_FIND_FOR_MS = 2 * 60 * 1000, RUN_STEPS_MS = 6000, RUN_LOG_LINES = 12;
  var RUN_LOG_HEADERS = { 'Accept': null, 'X-GitHub-Api-Version': null };
  var followedRuns = {};
  function runsOf(repo, workflow, query) {
    return gh('GET', '/repos/' + repo + '/actions/workflows/' + workflow + '/runs?' + query + '&at=' + Date.now()).then(function (r) {
      return (r.data && Array.isArray(r.data.workflow_runs) ? r.data.workflow_runs : []).filter(function (run) { return run && typeof run === 'object' && typeof run.id === 'number'; });
    });
  }
  function newestRunId(repo, workflow) {
    return runsOf(repo, workflow, 'per_page=1').then(function (runs) { return runs.length ? runs[0].id : 0; }, function () { return 0; });
  }
  // a read of GitHub that fails is made again at the next look, since one lost answer says nothing
  // of the run; the follow gives up after this many in a row, and says so
  var RUN_FAILS = 3;
  function findRun(repo, workflow, after, over) {
    var until = Date.now() + RUN_FIND_FOR_MS, fails = 0;
    return new Promise(function (resolve) {
      function look() {
        if (over()) { resolve(null); return; }
        runsOf(repo, workflow, 'event=workflow_dispatch&per_page=5').then(function (runs) {
          fails = 0;
          var fresh = runs.filter(function (run) { return run.id > after && !followedRuns[run.id]; });
          // the signed-in person's own run, where GitHub names who started each: another person's,
          // started in the same minute, speaks in their note, and this person's is waited for
          var named = fresh.filter(function (run) { return isPlain(run.actor) && typeof run.actor.login === 'string' && run.actor.login; });
          var mine = named.filter(function (run) { return run.actor.login === shownLogin; });
          var run = mine[0] || (!shownLogin || !named.length ? fresh[0] : null);
          if (run) { resolve(run); return; }
          if (Date.now() > until) { resolve({ late: true }); return; }
          setTimeout(look, RUN_FIND_MS);
        }, function (e) {
          if (++fails >= RUN_FAILS) { resolve({ failed: e }); return; }
          setTimeout(look, RUN_FIND_MS);
        });
      }
      setTimeout(look, 2000);
    });
  }
  function stepState(st) {
    if (st.status !== 'completed') return st.status === 'in_progress' ? 'running' : 'waiting';
    if (st.conclusion === 'success') return 'done';
    if (st.conclusion === 'skipped' || st.conclusion === 'neutral') return 'skipped';
    return 'failed';
  }
  function logTail(repo, jobId) {
    return gh('GET', '/repos/' + repo + '/actions/jobs/' + encodeURIComponent(jobId) + '/logs', undefined, RUN_LOG_HEADERS, true).then(function (r) {
      return exLines(typeof r.data === 'string' ? r.data : '').map(function (l) { return l.text; })
        .filter(function (t) { return t.trim() && !/^##\[(group|endgroup)\]/.test(t); }).slice(-RUN_LOG_LINES);
    }, function () { return []; });
  }
  function durationWords(seconds) {
    var m = Math.floor(seconds / 60), sec = seconds % 60;
    return m ? m + ' min ' + sec + ' s' : sec + ' s';
  }
  function followRunSteps(repo, run, task, over) {
    var until = Date.now() + RUN_FOR_MS, read = {}, shown = [], fails = 0;
    followedRuns[run.id] = true;
    task.at(exHttps(run.html_url), 'Run #' + String(run.run_number || run.id) + ' on GitHub');
    return new Promise(function (resolve) {
      function look() {
        if (over()) { resolve(null); return; }
        gh('GET', '/repos/' + repo + '/actions/runs/' + encodeURIComponent(run.id) + '/jobs?per_page=20&at=' + Date.now()).then(function (r) {
          fails = 0;
          var jobs = (r.data && Array.isArray(r.data.jobs) ? r.data.jobs : []).filter(isPlain);
          var steps = [];
          jobs.forEach(function (job) {
            (Array.isArray(job.steps) ? job.steps : []).filter(isPlain).forEach(function (st) {
              steps.push({ name: (jobs.length > 1 ? String(job.name || '') + ': ' : '') + String(st.name || ''), state: stepState(st) });
            });
          });
          task.steps(steps);
          var ended = jobs.filter(function (j) { return j.status === 'completed' && !read[j.id]; });
          ended.forEach(function (j) { read[j.id] = true; });
          return Promise.all(ended.map(function (j) { return logTail(repo, j.id); })).then(function (tails) {
            tails.forEach(function (t) { shown = shown.concat(t); });
            if (tails.length) task.lines(shown.slice(-RUN_LOG_LINES));
            if (over()) { resolve(null); return; }
            if (jobs.length && jobs.every(function (j) { return j.status === 'completed'; })) {
              var ends = jobs.map(function (j) { return Date.parse(j.completed_at); }).filter(isFinite);
              var began = Date.parse(run.run_started_at || run.created_at);
              resolve({
                conclusion: jobs.every(function (j) { return j.conclusion === 'success' || j.conclusion === 'skipped'; }) ? 'success' : (jobs.some(function (j) { return j.conclusion === 'cancelled'; }) ? 'cancelled' : 'failure'),
                seconds: ends.length && isFinite(began) ? Math.max(0, Math.round((Math.max.apply(null, ends) - began) / 1000)) : 0
              });
              return;
            }
            if (Date.now() > until) { resolve({ conclusion: 'running' }); return; }
            setTimeout(look, RUN_STEPS_MS);
          });
        }, function (e) {
          if (++fails >= RUN_FAILS) { resolve({ conclusion: 'unread', message: e.message }); return; }
          setTimeout(look, RUN_STEPS_MS);
        });
      }
      look();
    });
  }
  // a run a launch button started: found, followed, and its end said. One GitHub could not be read
  // about, or did not list in time, ends the task with the reason, never as done while its line says
  // Running; one the page left, going to another repository, is left at its link.
  function followDispatched(s, workflow, after, task) {
    var era = ends;
    // the follow is over with a sign-out, with the task (Clear leaves it live; a drop does not) and
    // once the page shows another repository, whose note the run's end would otherwise land in
    function over() { return ends !== era || !task.live || stale(s); }
    function left() {
      if (task.live && ends === era) task.end('Left as the page went to another repository; the run goes on at its link.');
    }
    return findRun(s.repo, workflow, after, over).then(function (run) {
      if (!run) { left(); return; }
      if (run.failed) { task.end('GitHub could not be read while the run was looked for (' + run.failed.message + '); the Runs tab shows it.', true); return; }
      if (run.late) { task.end('Not listed within two minutes; the Runs tab shows the run once GitHub lists it.', true); return; }
      task.tell('Running; its steps show here as GitHub lists them.');
      return followRunSteps(s.repo, run, task, over).then(function (out) {
        if (!out) { left(); return; }
        if (out.conclusion === 'unread') { task.end('GitHub could not be read while the run was followed (' + out.message + '); the run on GitHub shows the rest.', true); return; }
        if (!stale(s)) loadRuns(s);
        if (out.conclusion === 'running') { task.end('Still running after 15 minutes; the run on GitHub shows the rest.', true); return; }
        task.end('Finished: ' + out.conclusion + (out.seconds ? ', in ' + durationWords(out.seconds) : '') + '.', out.conclusion !== 'success');
      });
    });
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
    // an iPhone gives a page no full screen, only a video, and has no F11 to press either, so where
    // the browser has neither the standard call nor WebKit's older one the button is not offered
    var can = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (b && !can) b.hidden = true;
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
  /* ---------- the site's bar hides itself, as a taskbar set to hide does ---------- */
  // On the control page the deck takes the whole window and the site's bar comes back over its top
  // only when it is wanted (the owner, 2026-10-19: "the top nav panel should hide and reappear when
  // the mouse is over it, like windows does with its taskbar"): when the pointer reaches the window's
  // top edge, a strip a few pixels tall; while keyboard focus is in the bar or one of its menus is
  // open; and on a touch screen, which has no pointer to bring to an edge, when the handle at the top
  // centre is tapped or swiped down. It goes a moment after the pointer leaves it and its menus, so a
  // pass across it does not flicker, and at once on Escape or a press outside it. control.css slides
  // it by transform, over the deck rather than pushing it down.
  var BAR_LEAVE_MS = 600, BAR_TOUCH_MS = 4000, BAR_EDGE_PX = 8;
  var bar = { over: false, timer: 0, handle: null, lastMove: null };
  // a pointer that hovers: a mouse or a pen, on a device that has one even where its main pointer is
  // a finger (a tablet with a mouse), since a phone, which has none, makes up mouse events at its
  // corner that no finger moved
  var hoverMedia = window.matchMedia ? window.matchMedia('(any-hover: hover)') : null;
  function hovering(e) { return e.pointerType !== 'touch' && (!hoverMedia || hoverMedia.matches); }
  // a pointer with no button held: a grip dragged past the window's top edge sizes its part, and a
  // text selection or a press run up to the edge selects or cancels, and none of them calls the bar
  function reachesBar(e) { return hovering(e) && !e.buttons && !barShown(); }
  function inBar(node) {
    return !!node && [$('nav'), $('flyouts')].some(function (part) { return part && part.contains(node); });
  }
  function barShown() { return document.body.classList.contains('console-bar-shown'); }
  // the pointer on the bar or on a section's strip it dropped down, focus from the keyboard in either,
  // or the phone's menu open holds the bar; a button a tap focused does not, or the tap would keep it
  function barHeld() {
    var focus = document.activeElement;
    var keyed = inBar(focus) && focus.matches && focus.matches(':focus-visible');
    return bar.over || keyed || !!($('navLinks') && $('navLinks').classList.contains('is-open'));
  }
  function showBar() {
    clearTimeout(bar.timer);
    document.body.classList.add('console-bar-shown');
    if (bar.handle) bar.handle.setAttribute('aria-expanded', 'true');
  }
  // the bar never goes with the focus left in it, where Enter would follow a link nobody sees: a
  // press on a grip, whose default the grip prevents, moves no focus out of it
  function hideBar() {
    if (inBar(document.activeElement)) document.activeElement.blur();
    clearTimeout(bar.timer);
    bar.over = false;
    // the phone's menu hangs from the bar and a section's strip drops from it, so both close as the
    // bar goes, each through main.js's own handler (the menu's button, the strips' mouseleave)
    if ($('navLinks') && $('navLinks').classList.contains('is-open') && $('navToggle')) $('navToggle').click();
    if ($('flyouts') && $('flyouts').querySelector('.is-open')) $('flyouts').dispatchEvent(new Event('mouseleave'));
    document.body.classList.remove('console-bar-shown');
    if (bar.handle) bar.handle.setAttribute('aria-expanded', 'false');
  }
  function hideBarSoon(ms) {
    clearTimeout(bar.timer);
    bar.timer = setTimeout(function () { if (barHeld()) hideBarSoon(ms); else hideBar(); }, ms || BAR_LEAVE_MS);
  }
  function initBar() {
    if (!$('nav')) return;
    document.body.classList.add('console-bar-auto');
    // the hot strip along the window's top edge, for a pointer that hovers (control.css shows it): a
    // move in it brings the bar, where an enter alone would also take the one a browser makes up at
    // the window's corner as the page loads; a pointer that leaves the window across the top edge,
    // past the strip between two of its moves, has reached the edge too, unless it was dragging
    var strip = el('div', 'console__barstrip');
    strip.setAttribute('aria-hidden', 'true');
    strip.addEventListener('pointermove', function (e) { if (reachesBar(e)) showBar(); });
    strip.addEventListener('pointerleave', function (e) { if (hovering(e)) hideBarSoon(); });
    document.addEventListener('mousemove', function (e) { bar.lastMove = { y: e.clientY, free: !e.buttons }; }, { passive: true });
    document.addEventListener('mouseout', function (e) {
      var last = bar.lastMove;
      if (!e.relatedTarget && e.clientY < BAR_EDGE_PX && last && last.free && last.y < 120 && reachesBar(e)) { showBar(); hideBarSoon(); }
    });
    // the handle, for a touch screen: a tap shows the bar, as a swipe down from it does
    var handle = bar.handle = el('button', 'console__barhandle');
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Show the site\'s menu');
    handle.setAttribute('aria-controls', 'nav');
    handle.setAttribute('aria-expanded', 'false');
    var swipe = null;
    function showForTouch() { showBar(); hideBarSoon(BAR_TOUCH_MS); }
    handle.addEventListener('pointerdown', function (e) { swipe = { y: e.clientY, done: false }; });
    handle.addEventListener('pointermove', function (e) {
      if (swipe && !swipe.done && e.clientY - swipe.y > 12) { swipe.done = true; showForTouch(); }
    });
    handle.addEventListener('click', function () {
      var swiped = swipe && swipe.done;
      swipe = null;
      if (!swiped) { if (barShown()) hideBar(); else showForTouch(); }
    });
    add(document.body, strip, handle);
    [$('nav'), $('flyouts')].forEach(function (part) {
      if (!part) return;
      part.addEventListener('pointerenter', function (e) { if (hovering(e)) { bar.over = true; if (barShown()) showBar(); } });
      part.addEventListener('pointerleave', function (e) { if (hovering(e)) { bar.over = false; if (barShown()) hideBarSoon(); } });
      // a touch in the bar starts its wait again, so it stays while it is used
      part.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch' && barShown()) hideBarSoon(BAR_TOUCH_MS); });
    });
    document.addEventListener('focusin', function (e) { if (inBar(e.target)) showBar(); });
    document.addEventListener('focusout', function (e) { if (inBar(e.target) && !inBar(e.relatedTarget)) hideBarSoon(); });
    // a press outside the bar sends it away at once, and Escape does too, each with the focus. One
    // Escape does one thing: where the keyboard is in the bar it is the bar's, before anything else
    // hears it, so the Dependencies tab's help stays open under it; elsewhere it is the bar's only
    // where nothing the key was pressed in took it first, as a chart's focus, the tab's key or its
    // help does, so the window hears it last
    document.addEventListener('pointerdown', function (e) {
      if (barShown() && !inBar(e.target) && e.target !== handle) hideBar();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !barShown() || !inBar(e.target)) return;
      e.preventDefault();
      hideBar();
    }, true);
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !barShown() || e.defaultPrevented) return;
      hideBar();
    });
  }
  // the window's top a page held to it keeps clear (the Dependencies tab on a phone, graphPhoneFit):
  // on this page the site's bar hides itself and comes back over the deck, never pushing it down,
  // so only the Home Screen app's top inset, which the body's padding keeps, is left clear; a bar
  // that stands in the page keeps its own height
  function barRoom() {
    if (document.body.classList.contains('console-bar-auto')) return parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    var nav = $('nav');
    return nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
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
    nbside: { prop: '--nbside-w', min: 220, max: 760, axis: 'x', sign: -1, measure: function () { return $('nb-side').offsetWidth; } }
  };
  // how much the text size scales a part: its size on screen over its size in its own pixels (the
  // phone's rules leave the deck unscaled whatever text size the desktop saved)
  function scaleOf(node) {
    var w = node.offsetWidth;
    return w ? node.getBoundingClientRect().width / w : zoomOf();
  }
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
      if (layout[k] != null) c.style.setProperty(LAYOUT_PARTS[k].prop, sizeWithin(LAYOUT_PARTS[k], layout[k]) + 'px');
      else c.style.removeProperty(LAYOUT_PARTS[k].prop);
    });
    c.style.setProperty('--console-zoom', String(zoomOf()));
    if ($('cp-zoom-reset')) $('cp-zoom-reset').textContent = Math.round(zoomOf() * 100) + '%';
    sayGrips();
  }
  // each grip says its part's size and the bounds it is held to, as a separator that takes the focus
  // must, so a screen reader tells what the arrow keys did; a grip the script draws later says it
  // when it takes the focus (initLayout)
  function sayGrips() {
    Array.prototype.forEach.call($('console').querySelectorAll('[data-split][role="separator"]'), function (grip) {
      var p = LAYOUT_PARTS[grip.getAttribute('data-split')];
      if (!p || !grip.getClientRects().length) return;
      grip.setAttribute('aria-valuemin', String(p.min));
      grip.setAttribute('aria-valuemax', String(p.max));
      grip.setAttribute('aria-valuenow', String(Math.min(p.max, Math.max(p.min, Math.round(p.measure(grip))))));
    });
  }
  // a grip made by the script, for a part the script draws (a token's panel, a notebook's)
  function splitGrip(part, what) {
    var g = el('div', 'console__split console__split--edge console__split--' + part);
    g.setAttribute('data-split', part);
    g.setAttribute('role', 'separator');
    g.setAttribute('aria-orientation', LAYOUT_PARTS[part].axis === 'x' ? 'vertical' : 'horizontal');
    g.setAttribute('aria-label', 'Drag to size ' + what + '; double-click to reset');
    g.tabIndex = 0;
    return g;
  }
  // a size held to a part's bounds
  function sizeWithin(p, px) {
    return Math.round(Math.min(p.max, Math.max(p.min, px)));
  }
  function setPart(part, px) {
    layout[part] = sizeWithin(LAYOUT_PARTS[part], px);
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
      var scale = scaleOf(grip);
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('console-dragging', 'console-dragging--' + p.axis);
      function move(ev) {
        setPart(part, start + p.sign * ((p.axis === 'x' ? ev.clientX : ev.clientY) - from) / scale);
      }
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
    c.addEventListener('focusin', function (e) { if (e.target.hasAttribute && e.target.hasAttribute('data-split')) sayGrips(); });
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

  // The note is laid over the screen's foot while it has something to say, so the stage gives up the
  // note's height at its foot (control.css, console--toast) and no tab's last row lies under it; and
  // the element the focus was on before it went into the note is where Clear sends it back.
  var toastFrom = null;
  function toastLayout() {
    var c = $('console'), m = $('msg'), foot = c && c.querySelector('.console__status');
    if (!c || !m || !foot) return;
    var shown = !!m.firstChild;
    c.classList.toggle('console--toast', shown);
    if (shown) c.style.setProperty('--toast-h', Math.ceil(foot.getBoundingClientRect().height / scaleOf(foot)) + 'px');
    else c.style.removeProperty('--toast-h');
  }
  function toastFocusBack() {
    var foot = document.querySelector('#console .console__status');
    var at = document.activeElement;
    if (at && at !== document.body && !(foot && foot.contains(at))) return;
    var back = toastFrom && toastFrom.isConnected && toastFrom.getClientRects().length ? toastFrom : $('cp-claude');
    if (back && back.getClientRects().length) back.focus(); else if (at && at.blur) at.blur();
  }
  function initToast() {
    var m = $('msg'), foot = m && m.closest('.console__status');
    if (!foot) return;
    document.addEventListener('focusin', function (e) { if (!foot.contains(e.target)) toastFrom = e.target; });
    if (window.MutationObserver) new MutationObserver(toastLayout).observe(m, { childList: true, subtree: true, characterData: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(toastLayout).observe(foot);
    toastLayout();
  }
  function initConsole() {
    var c = $('console');
    if (!c) return;
    initFlash();
    initBar();
    initFullScreen();
    initTiles();
    initLayout();
    taskView(keptTaskView());
    // the note over the screen's foot holds the page's message; Clear empties it. A task under way
    // there is only hidden, its work going on, and the button that started it shows it again, the
    // step the person was in the middle of (the code box of Add Token) kept as it was; the focus goes
    // back where it was before it went into the note
    initToast();
    if ($('cp-msg-close')) $('cp-msg-close').addEventListener('click', function () {
      var m = $('msg');
      msgTasks.forEach(function (t) { if (t.live) t.hide(); });
      Array.prototype.slice.call(m.childNodes).forEach(function (n) { m.removeChild(n); });
      m.className = 'admin__box';
      toastFocusBack();
    });
    fitConsole();
    window.addEventListener('resize', fitConsole);
    window.addEventListener('load', fitConsole);
    if (c.querySelector('.console__rail')) c.querySelector('.console__rail').addEventListener('scroll', railEdges, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitConsole);
    var asked = location.hash.slice(1);
    showTab(asked);
    if (!consoleTabs().some(function (t) { return t.getAttribute('data-tab') === asked; })) showHome();
    if ($('cp-back')) $('cp-back').addEventListener('click', leaveTab);
    if (window.matchMedia) {
      var phoneMedia = window.matchMedia(PHONE_QUERY);
      if (phoneMedia.addEventListener) phoneMedia.addEventListener('change', leftPhone); else if (phoneMedia.addListener) phoneMedia.addListener(leftPhone);
    }
    window.addEventListener('hashchange', function () {
      var name = location.hash.slice(1);
      if (!name || name === 'home') { showHome(); return; }
      // #repos was the Repositories tab before the picker took its place
      if (name === 'repos') { if (!$('cp-app').classList.contains('hidden')) openDialog('dlg-repos'); return; }
      if (consoleTabs().some(function (t) { return t.getAttribute('data-tab') === name; })) showTab(name);
    });
    consoleTabs().forEach(function (t, i, all) {
      t.addEventListener('click', function () {
        if (consoleAtHome() && phoneLayout()) openFromHome(t.getAttribute('data-tab')); else showTab(t.getAttribute('data-tab'));
      });
      t.addEventListener('keydown', function (e) {
        if (consoleAtHome() && phoneLayout()) { homeArrow(e, i, all); return; }
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
      var b = e.target && e.target.closest ? e.target.closest('[data-goto],[data-jump],[data-taskview],[data-press],[data-open],[data-focus]') : null;
      if (!b || b.getAttribute('role') === 'tab') return;
      if (b.hasAttribute('data-press')) {
        var target = $(b.getAttribute('data-press'));
        if (target && !target.disabled) target.click();
        return;
      }
      if (b.hasAttribute('data-goto')) showTab(b.getAttribute('data-goto'));
      if (b.hasAttribute('data-jump')) jumpTo(b.getAttribute('data-jump'));
      if (b.hasAttribute('data-taskview')) taskView(b.getAttribute('data-taskview'), true);
      if (b.hasAttribute('data-open')) openDialog(b.getAttribute('data-open'));
      var f = b.getAttribute('data-focus');
      // Ask Claude is the floating button's press, wherever it is made from
      if (f === 'cp-as-q') { pressClaude(); return; }
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
      nbForget();
      // a drive connected under another account than the one GitHub names now is dropped here,
      // and one connected before any was named is bound to this one
      heldDrive();
      var name = chosenRepo();
      fillRepoSelect($('cp-repo'), name);
      if (location.hash === '#repos') setTimeout(function () { openDialog('dlg-repos'); }, 0);
      if (name) loadRepo(name);
      else {
        $('cp-summary').textContent = 'No repository listed yet. Press + Add repository in the side column to pick one.';
        graphReset(GRAPH_NO_REPOSITORY);
        // the Folders tab needs no repository to connect a drive or make one
        if (consoleTab === 'folders' && consoleOnOpen.folders) consoleOnOpen.folders();
        // a browser that keeps nothing, a new one or a guest window, opens the usual repository, and
        // the picker opens by itself only where there is none, never over the Folders tab
        else if (location.hash !== '#repos') openUsualRepo();
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
  // what the person presses. The assistant is the Claude dialog that the floating Claude button at
  // the top right opens (pressClaude), and its answer opens under the box in the same dialog.
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
        if (!has) { a.noFile = true; assistantWords(['This repository\'s Claude workflow has no assistant yet: ' + ASSISTANT_FILE + ' is not on its default branch, so a question here would run as an ordinary @claude mention, with the tools that write. Bring in the template release that carries it first.']); return; }
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
    if (!lines.length) { if (consoleTab === 'explore') exploreAfterDraw(); return; }
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
      else if (BS_LINK.test(line) || BS_NODE.test(line)) said = bsOffer(line);
      else said = 'Not acted on, shown as written: ' + line;
      if (i) add(box, ' ');
      add(box, said);
    });
    // the ideas are drawn on Explore as the answer comes, where the tab is open
    if (consoleTab === 'explore') exploreAfterDraw();
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
    // a filter reaches across every list, so All shows them side by side
    if (kind !== 'none') { taskView('all'); revealTab($('cp-queue')); } else taskView(keptTaskView());
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
      // the press acts on the panel behind the Claude dialog, so the dialog gives way and the
      // person sees what it did, and any confirmation it asks for, or why it was refused
      closeDialog('dlg-claude');
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
  // The bar and its drawer are made here, into the Claude dialog's empty #cp-askbar, the drawer
  // under the bar in the same dialog
  function assistantBuildBar() {
    var bar = $('cp-askbar'), host = bar && bar.parentNode;
    if (!bar || !host || $('cp-as-q')) return;
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
    add(drawer, head, body);
    host.appendChild(drawer);
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
      if (bs.epic) lines.push('I am planning epic #' + bs.epic + ' on the Explore tab' + (bs.pending.length ? ', with ' + plural(bs.pending.length, 'change') + ' waiting to be pushed' : '') + '.');
    } else if (tab === 'folders') {
      var last = crumbs[crumbs.length - 1];
      var it = explorer.items.filter(function (x) { return String(x.id) === explorer.selected; })[0];
      if (last && last.search) lines.push('I am looking at the results of a search of my OneDrive for ' + ownQuote(last.search) + '.');
      else if (last) lines.push('The OneDrive folder open is ' + ownQuote(crumbs.map(function (c) { return c.name; }).join('/')) + (last.url ? ' (' + last.url + ')' : '') + '.');
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
  // The floating Claude button at the top right: where the repository has no Claude token yet it
  // opens the Tokens tab's Add Token, the first thing Claude needs; otherwise the Claude dialog, its
  // box ready for the question. Whether a token is set is the Tokens tab's own read (loadTokens),
  // made on the press where the tab has not made it for this repository, and in an organization's
  // repository the repository's own secrets and the organization's secrets it reaches besides, since
  // the main token may be a repository secret beside the pool. Add Token opens only where every one
  // of those reads answered and none lists a Claude token; a read that failed, or a pool the person
  // may not list (an organization's, read only by its owners), counts as maybe set, and the dialog
  // opens, since the assistant's own line then says whether Claude can answer. A repository whose
  // workflow has no assistant asks @claude through a task instead, as the Ask Claude launch did.
  var CLAUDE_SLOT_SECRET = /^SYMPHONY_CLAUDE_([1-9]|[12][0-9]|3[0-2])$/;
  var CLAUDE_WAIT_MS = 9000;
  var claudePress = 0;
  function isClaudeSecret(name) { return name === MAIN_SECRET || CLAUDE_SLOT_SECRET.test(name); }
  function secretNames(list) { return list.map(function (x) { return x && x.name; }); }
  // true, false, or null where it cannot be told
  function claudeTokenSet(repo) {
    var place = tk.place;
    if (!place || !tk.secrets || tk.secrets.unread) return Promise.resolve(null);
    var lists = [Promise.resolve(Object.keys(tk.secrets))];
    if (place.org) {
      lists.push(listed('/repos/' + repo + '/actions/secrets', 'secrets').then(secretNames));
      lists.push(listed('/repos/' + repo + '/actions/organization-secrets', 'secrets').then(secretNames));
    }
    return Promise.all(lists).then(function (all) {
      return all.some(function (names) { return names.some(isClaudeSecret); });
    }, function () { return null; });
  }
  function openClaude() {
    if (assistant.noFile && assistant.repo === tokensRepo()) {
      openTaskDialog();
      say('This repository has no assistant yet, so Claude is asked by an issue: write what it should do and press Ask @claude now.');
      return;
    }
    openDialog('dlg-claude');
    var q = $('cp-as-q');
    if (q && !$('cp-as-box').classList.contains('hidden')) q.focus();
  }
  function claudeToTokens() {
    if (consoleAtHome() && phoneLayout()) openFromHome('tokens'); else showTab('tokens');
    openTokenDialog('', true);
  }
  function pressClaude() {
    var repo = tokensRepo(), press = ++claudePress, began = Date.now(), tab = consoleTab;
    var b = $('cp-claude');
    function done() { if (press === claudePress && b) b.removeAttribute('aria-busy'); }
    if (!repo) { done(); openClaude(); return; }
    if (!(tk.repo === repo && tk.place)) loadTokens();
    if (b) b.setAttribute('aria-busy', 'true');
    (function settle() {
      // a later press, another repository, another tab or a dialog opened meanwhile takes over
      if (press !== claudePress) return;
      if (tokensRepo() !== repo || consoleTab !== tab || document.querySelector('dialog[open]')) { done(); return; }
      var read = tk.repo === repo && tk.place, failed = tokenReadFailed === repo;
      if (!read && !failed && Date.now() - began < CLAUDE_WAIT_MS) { setTimeout(settle, 150); return; }
      if (!read) { done(); openClaude(); return; }
      claudeTokenSet(repo).then(function (set) {
        if (press !== claudePress) return;
        done();
        if (tokensRepo() !== repo || consoleTab !== tab || document.querySelector('dialog[open]')) return;
        if (set === false) claudeToTokens(); else openClaude();
      });
    })();
  }
  function initAssistant() {
    assistantBuildBar();
    if ($('cp-claude')) $('cp-claude').addEventListener('click', pressClaude);
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
    // Escape shuts the drawer from inside it or from the bar, and only the drawer: the dialog
    // round them waits for the next Escape
    [$('cp-as-drawer'), $('cp-askbar')].forEach(function (n) {
      n.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('cp-as-drawer').hidden) { e.preventDefault(); assistantDrawer(false); $('cp-as-toggle').focus(); } });
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
  // the typeface Mermaid lays labels out in, the site's own, so a label is measured in the face it shows in
  var GRAPH_FONT = '"IBM Plex Sans", system-ui, sans-serif';
  // the colours Mermaid draws with, the console's: a dark ground, nodes a shade lighter, and grey
  // arrows that show on it; Mermaid's own shadow is a light grey made for a white page, so it is
  // given a dark one
  var GRAPH_THEME = {
    darkMode: true, background: '#0F1916', primaryColor: '#16221F', primaryTextColor: '#E4ECE8', primaryBorderColor: '#5D7069',
    lineColor: '#8A9E97', textColor: '#E4ECE8', fontFamily: GRAPH_FONT, fontSize: '14px',
    useGradient: false, dropShadow: 'drop-shadow(0 3px 8px rgba(0, 0, 0, 0.45))'
  };

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
  // a box emptied to be read again keeps its height until the charts are drawn (graphRender), so the
  // tab does not shrink under the reader; one emptied for good lets it go
  var graphHeld = function () {};
  function graphReset(words, warn, reading) {
    var box = $('cp-graph');
    // the height is taken before the earlier hold is let go: a box that hold emptied stands at
    // nothing of its own, so a read begun under a read would hold it at nothing and the tab would
    // shrink while the sub-issues are read
    var h = box ? exactHeight(box) : 0;
    var tab = $('tab-dependencies');
    var th = tab ? exactHeight(tab) : 0;
    graphHeld();
    graphHeld = function () {};
    if (reading) {
      var heldBox = holdHeight(box, h);
      // where the page scrolls as a whole, the chips and the line above the box, emptied with it, would
      // still pull the page up, so the tab holds its height too
      var heldTab = pageScrolls() ? holdHeight(tab, th) : function () {};
      graphHeld = function () { heldBox(); heldTab(); };
    }
    clear(box);
    graphStripClear();
    $('cp-graph-said').textContent = '';
    graphWords(words, warn);
  }
  // The tiles that let a person see one epic's chart at a time, or a zoomed-out goals chart, the
  // next step of the owner's 2026-10-17 ask ("if there are multiple epics per repo the board should
  // allow focusing on one epic ... or a more zoomed out view where epics are shown connected to each
  // other to reach product goals", docs/research/control-board-graph.md). The charts are the same,
  // drawn the same, from the same reads; the tiles only show one of their cards at a time, with an
  // All tile that shows every one at once, each fitted in a cell of its own. They appear only where
  // there are two charts or more, so a repository with one epic reads as it did; which tile a person
  // last chose is kept per repository in this browser, as the panel's sizes are. It writes nothing of
  // the repository and asks nothing of anyone.
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
  // the charts of the latest draw, so a card the tiles show or hide is found with its stage
  var graphShown = [];
  function graphChartOf(sec) {
    for (var i = 0; i < graphShown.length; i++) if (graphShown[i].section === sec) return graphShown[i];
    return null;
  }
  function graphTiles() { return Array.prototype.slice.call($('cp-graph-focus').querySelectorAll('.graph__chip')); }
  function graphStripClear() {
    var strip = $('cp-graph-focus');
    if (strip) {
      clear(strip);
      strip.hidden = true;
      strip.removeAttribute('data-form');
      strip.style.gridTemplateColumns = '';
    }
    graphStripPage = 0;
    graphKey(false);
    // a draw done again drops its cards with any focus open on them, and the room that focus took
    var tab = $('tab-dependencies');
    if (tab) tab.classList.remove('graph--near');
  }
  // the key to the colours and the arrows, shown only while there are charts to read it by; where
  // room is short it folds behind its Key button, which opens it over the stage (graphKeyFold)
  function graphKey(shown) {
    var key = $('cp-graph-key'), b = $('cp-graph-keybtn');
    if (key) key.hidden = !shown;
    if (b) b.hidden = !shown;
    if (!shown) graphKeyOpen(false);
    else graphKeyFold();
  }
  function graphKeyOpen(open) {
    var key = $('cp-graph-key'), b = $('cp-graph-keybtn');
    if (!key || !b) return;
    if (open) key.setAttribute('data-open', ''); else key.removeAttribute('data-open');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // The key keeps its line above the charts where there is room for it, and folds where room is
  // short: on a phone, where its one line is wider than the tab, and in a deck too short to spare
  // the line, which the chart is given instead. The key is laid out on one line (control.css), so a
  // line wider than the tab shows as more to scroll than the box holds, read with the fold let go.
  var GRAPH_KEY_ROOM = 620;
  function graphKeyFold() {
    var tab = $('tab-dependencies'), key = $('cp-graph-key');
    if (!tab || !key || key.hidden || !tab.clientWidth) return;
    tab.classList.remove('graph--keyfold');
    var fold = pageScrolls() || tab.clientHeight < GRAPH_KEY_ROOM || key.scrollWidth > key.clientWidth + 1;
    tab.classList.toggle('graph--keyfold', fold);
    if (!fold) graphKeyOpen(false);
  }
  // show the chart a tile names, or every chart for All, and press that tile; the cards are the
  // page's own and read by their data-focus, so the assistant's "show dependencies" can reset to the
  // first without the draw's own list. A card left behind, or every card under All, opens again
  // whole: a focus belongs to the one chart shown
  function graphSelect(key, repo) {
    var strip = $('cp-graph-focus');
    if (!strip) return;
    graphTiles().forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-focus') === key ? 'true' : 'false'); });
    var box = $('cp-graph'), all = key === 'all';
    box.classList.toggle('graph--all', all);
    Array.prototype.forEach.call(box.querySelectorAll('.graph__section'), function (sec) {
      var shown = all || sec.getAttribute('data-focus') === key;
      var chart = graphChartOf(sec);
      if (chart && chart.focus != null && (all || !shown)) graphNearClose(chart);
      sec.hidden = !shown;
      // a person's press fades the chosen chart in, so the change reads as a move rather than a jump
      sec.classList.remove('graph__section--enter');
      if (shown && repo) { void sec.offsetWidth; sec.classList.add('graph__section--enter'); }
    });
    graphStripLayout(true);
    graphAllLayout();
    graphKeyOpen(false);
    if (repo) graphFocusSet(repo, key);
  }
  // The tiles never scroll (the owner, 2026-10-19: "I literally never in any case want to scroll"):
  // they share the row's width in one of two forms, the full one (its kind and count over its title
  // and bar) where each tile has room for it, and a compact one (its kind, its title cut short and
  // its bar, the count left to its name, which a reader hears) where it has not; a second row where
  // the deck is tall enough to spare one, though never on a phone, whose height is the chart's; and
  // where there are more tiles than fit even so, a page of them at a time, turned by the arrows at
  // the row's ends, by a swipe across the row, or by the arrow keys moving past a page's end. Read
  // again whenever the tab changes size, so the same tiles fit a phone held either way and a screen
  // of any width.
  var GRAPH_TILE_FULL = 168, GRAPH_TILE_SMALL = 80, GRAPH_TILE_GAP = 6, GRAPH_TILE_TALL = 640;
  var graphStripPage = 0, graphStripPer = 0;
  function graphStripLayout(follow) {
    var strip = $('cp-graph-focus'), tab = $('tab-dependencies');
    if (!strip || strip.hidden || !strip.clientWidth) return;
    var tiles = graphTiles(), n = tiles.length, w = strip.clientWidth, gap = GRAPH_TILE_GAP;
    function each(k) { return (w - gap * (k - 1)) / k; }
    var tall = !pageScrolls() && tab.clientHeight >= GRAPH_TILE_TALL;
    var form = 'small', cols = n, per = n;
    if (each(n) >= GRAPH_TILE_FULL) form = 'full';
    else if (each(n) < GRAPH_TILE_SMALL && tall && each(Math.ceil(n / 2)) >= GRAPH_TILE_SMALL) cols = Math.ceil(n / 2);
    else if (each(n) < GRAPH_TILE_SMALL) {
      var arrow = parseFloat(getComputedStyle(strip).getPropertyValue('--gpage')) || 28;
      cols = Math.max(1, Math.floor((w - 2 * (arrow + gap) + gap) / (GRAPH_TILE_SMALL + gap)));
      per = cols * (tall ? 2 : 1);
    }
    var pages = Math.ceil(n / per);
    var pressed = tiles.map(function (t) { return t.getAttribute('aria-pressed'); }).indexOf('true');
    if (follow && pressed >= 0) graphStripPage = Math.floor(pressed / per);
    graphStripPage = Math.max(0, Math.min(pages - 1, graphStripPage));
    graphStripPer = per;
    strip.setAttribute('data-form', form);
    tiles.forEach(function (t, i) { t.hidden = pages > 1 && Math.floor(i / per) !== graphStripPage; });
    var paged = pages > 1;
    strip.style.gridTemplateColumns = (paged ? 'var(--gpage) ' : '') + 'repeat(' + cols + ', minmax(0, 1fr))' + (paged ? ' var(--gpage)' : '');
    Array.prototype.forEach.call(strip.querySelectorAll('.graph__page'), function (b) {
      var step = Number(b.getAttribute('data-step'));
      b.hidden = !paged;
      b.disabled = graphStripPage + step < 0 || graphStripPage + step >= pages;
      b.style.gridRow = '1 / span ' + Math.ceil(Math.min(per, n) / cols);
      b.setAttribute('aria-label', (step < 0 ? 'Earlier tiles' : 'Later tiles') + ', page ' + (graphStripPage + 1) + ' of ' + pages);
    });
  }
  // a page of tiles turned by its arrows or a swipe; the tile pressed stays pressed, the chart shown
  // stays shown, and only the tiles in sight change
  function graphStripTurn(step) {
    if (!graphStripPer) return false;
    var pages = Math.ceil(graphTiles().length / graphStripPer);
    var to = graphStripPage + step;
    if (to < 0 || to >= pages) return false;
    graphStripPage = to;
    graphStripLayout(false);
    return true;
  }
  function graphPageButton(step) {
    var b = el('button', 'graph__page', step < 0 ? '\u2039' : '\u203a');
    b.type = 'button';
    b.hidden = true;
    b.setAttribute('data-step', String(step));
    b.style.gridColumn = step < 0 ? '1' : '-2';
    b.addEventListener('click', function () { graphStripTurn(step); });
    return b;
  }
  // a swipe across a row of pages turns its page where there are pages, and the press it ends is
  // none of the row's buttons'; the tiles' row and the help's pages take it
  function graphSwipes(node, turn) {
    var down = null, swiped = false;
    node.addEventListener('pointerdown', function (e) { down = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    node.addEventListener('pointerup', function (e) {
      if (!down || down.id !== e.pointerId) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      down = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < 1.3 * Math.abs(dy)) return;
      swiped = turn(dx < 0 ? 1 : -1);
      if (swiped) setTimeout(function () { swiped = false; }, 0);
    });
    node.addEventListener('pointercancel', function () { down = null; });
    node.addEventListener('click', function (e) {
      if (!swiped) return;
      swiped = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }
  // The tab's help opens over the tab under its head, never a box that scrolls: its paragraphs side
  // by side, as many as the tab's width holds at a readable measure, where each fits the room; a
  // page of them at a time where they do not, turned by the arrows under them or a swipe across
  // them; and where one paragraph alone is taller than the room, as at the largest text size on a
  // short screen, its words drawn smaller until it fits. Laid out again whenever the tab changes size.
  var GRAPH_HELP_COL = 300, GRAPH_HELP_FLOOR = 0.6, graphHelpPage = 0;
  function graphHelpParts() {
    var tab = $('tab-dependencies'), help = tab && tab.querySelector('.console__help'), box = help && help.querySelector(':scope > div');
    return box ? { tab: tab, help: help, box: box, paras: Array.prototype.slice.call(box.querySelectorAll(':scope > p')), pager: box.querySelector('.graph__helppager') } : null;
  }
  function graphHelpInit() {
    var h = graphHelpParts();
    if (!h) return;
    var pager = el('div', 'graph__helppager');
    pager.setAttribute('role', 'group');
    pager.setAttribute('aria-label', 'Pages of the help');
    [-1, 1].forEach(function (step) {
      var b = el('button', 'graph__page', step < 0 ? '\u2039' : '\u203a');
      b.type = 'button';
      b.setAttribute('data-step', String(step));
      b.addEventListener('click', function () { graphHelpTurn(step); });
      add(pager, b);
      if (step < 0) add(pager, el('span', 'graph__pos'));
    });
    h.box.appendChild(pager);
    graphSwipes(h.box, graphHelpTurn);
    h.help.addEventListener('toggle', function () { graphHelpPage = 0; graphHelpLayout(); });
  }
  function graphHelpTurn(step) {
    var h = graphHelpParts();
    if (!h || !h.help.open || h.pager.hidden) return false;
    var to = graphHelpPage + step, per = Number(h.box.getAttribute('data-per')) || h.paras.length;
    if (to < 0 || to >= Math.ceil(h.paras.length / per)) return false;
    graphHelpPage = to;
    graphHelpLayout();
    return true;
  }
  function graphHelpLayout() {
    var h = graphHelpParts();
    if (!h || !h.help.open) return;
    var box = h.box, paras = h.paras, n = paras.length, head = h.tab.querySelector('.console__head');
    box.style.top = (head.offsetTop + head.offsetHeight + 6) + 'px';
    box.style.fontSize = '';
    paras.forEach(function (p) { p.hidden = false; });
    var cs = getComputedStyle(box), px = function (v) { return parseFloat(v) || 0; };
    // the arrows' row, measured while it is shown, is the room a page of paragraphs gives up to it
    h.pager.hidden = false;
    var pagerRoom = h.pager.offsetHeight + px(cs.rowGap);
    h.pager.hidden = true;
    var W = box.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), H = box.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
    if (W <= 0 || H <= 0) return;
    function tallest() { return Math.max.apply(null, paras.map(function (p) { return p.offsetHeight; })); }
    var per = 1, room = H;
    for (var cols = Math.max(1, Math.min(n, Math.floor(W / GRAPH_HELP_COL))); cols >= 1; cols--) {
      box.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      room = H - (cols < n ? pagerRoom : 0);
      per = cols;
      if (tallest() <= room) break;
    }
    var size = px(cs.fontSize);
    while (per === 1 && tallest() > room && size > px(cs.fontSize) * GRAPH_HELP_FLOOR) { size *= 0.92; box.style.fontSize = size + 'px'; }
    var pages = Math.ceil(n / per);
    graphHelpPage = Math.max(0, Math.min(pages - 1, graphHelpPage));
    box.setAttribute('data-per', String(per));
    paras.forEach(function (p, i) { p.hidden = Math.floor(i / per) !== graphHelpPage; });
    h.pager.hidden = pages < 2;
    h.pager.querySelector('.graph__pos').textContent = (graphHelpPage + 1) + ' of ' + pages;
    Array.prototype.forEach.call(h.pager.querySelectorAll('button'), function (b) {
      var to = graphHelpPage + Number(b.getAttribute('data-step'));
      b.disabled = to < 0 || to >= pages;
      b.setAttribute('aria-label', (to < graphHelpPage ? 'Earlier' : 'Later') + ' help, page ' + (graphHelpPage + 1) + ' of ' + pages);
    });
  }
  // the tiles for a draw's charts: All, then one per chart, the last chosen one pressed or, where none
  // was or it is gone, the first chart; a chart is a card the tiles show and hide by its key.
  // A tile says what its chart is, its title, a bar of its issues by state in the colours they are
  // drawn in, and how far it has got, so the epics read side by side before one is opened (the
  // owner, 2026-10-19: "make the epics more intuitive and navigating that page more fluent").
  function graphStrip(draw, charts) {
    var strip = $('cp-graph-focus');
    if (!strip) return;
    clear(strip);
    if (charts.length < 2) { strip.hidden = true; return; }
    strip.hidden = false;
    var keys = charts.map(function (c) { return c.key; });
    var saved = graphFocusGet(draw.repo);
    var selected = saved === 'all' || keys.indexOf(saved) >= 0 ? saved : charts[0].key;
    // All's bar is every epic's tasks together; the goals chart's nodes are the epics themselves
    var tasks = {};
    charts.forEach(function (c) {
      if (c.key === 'goals') return;
      Object.keys(c.counts).forEach(function (k) { tasks[k] = (tasks[k] || 0) + c.counts[k]; });
    });
    add(strip, graphPageButton(-1));
    add(strip, graphTile(draw, { key: 'all', kind: 'All', title: 'Every chart', counts: tasks, foot: plural(charts.length, 'chart'), heading: 'Show every chart' }));
    charts.forEach(function (c, i) {
      add(strip, graphTile(draw, c));
      graphStepper(draw, c, charts[i - 1], charts[i + 1], i, charts.length);
    });
    add(strip, graphPageButton(1));
    graphSelect(selected, '');
  }
  function graphTile(draw, c) {
    var b = el('button', 'graph__chip graph__tile');
    b.type = 'button';
    b.setAttribute('data-focus', c.key);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', c.kind + (c.title ? ': ' + c.title : '') + ', ' + c.foot);
    b.title = c.heading;
    // an epic's number rides with its title, shown before it where the short form gives up the kind
    // (control.css), so epics whose titles begin alike still tell apart
    var title = el('span', 'graph__ttitle', c.title), num = /#[0-9]+$/.exec(c.kind || '');
    if (num) title.setAttribute('data-num', num[0]);
    add(b, el('span', 'graph__tkind', c.kind), title, graphStateBar(c.counts), el('span', 'graph__tfoot', c.foot));
    b.addEventListener('click', function () { graphSelect(c.key, draw.repo); });
    return b;
  }
  // a bar of a chart's issues, one stretch per state in the order work moves through them, as wide as
  // its share; the tile's words and the card's pills say the same, so the bar is hidden from a reader
  function graphStateBar(counts) {
    var bar = el('span', 'graph__tbar');
    bar.setAttribute('aria-hidden', 'true');
    var total = 0;
    GRAPH_COUNTS.forEach(function (pair) { total += counts[pair[0]] || 0; });
    GRAPH_COUNTS.forEach(function (pair) {
      var n = counts[pair[0]] || 0;
      if (!n) return;
      var seg = el('span', 'graph__seg graph__seg--' + (pair[0] || 'plain'));
      seg.style.width = (100 * n / total) + '%';
      add(bar, seg);
    });
    return bar;
  }
  // Previous and Next on each card, with its place among the charts, so the charts are stepped through
  // one after another from where a person reads, without going back up to the tiles; the button
  // pressed keeps the keyboard's focus on the card it shows, or its other button at the last chart.
  // They stand in the card's row of tools, which keeps one place on every card (control.css), so a
  // button pressed again and again stays under the mouse from card to card. A swipe across a whole
  // chart, and the left and right arrow keys on it, step the same way (graphGo).
  function graphStepper(draw, c, prev, next, i, n) {
    var nav = el('div', 'graph__step');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Step through the charts');
    function step(cls, to, glyph, words) {
      var b = el('button', 'graph__stepbtn ' + cls, glyph);
      b.type = 'button';
      if (!to) {
        b.disabled = true;
        b.setAttribute('aria-label', words);
        return b;
      }
      b.setAttribute('aria-label', words + ': ' + to.heading);
      b.title = to.heading;
      b.addEventListener('click', function () {
        graphSelect(to.key, draw.repo);
        var same = to.section.querySelector('.graph__step .' + cls);
        var other = to.section.querySelector('.graph__step .graph__stepbtn:not(:disabled)');
        var focus = same && !same.disabled ? same : other;
        if (focus) focus.focus({ preventScroll: true });
      });
      return b;
    }
    c.prev = prev;
    c.next = next;
    add(nav, step('graph__prev', prev, '‹', 'Previous chart'), el('span', 'graph__pos', (i + 1) + ' of ' + n), step('graph__next', next, '›', 'Next chart'));
    c.section.querySelector('.graph__tools').appendChild(nav);
  }
  // the tiles answer the arrow keys as tabs do: Left and Right, Home and End move to a tile and show
  // its chart, turning the page of tiles where the one moved to is on another
  function graphStripKeys(e) {
    var moves = { ArrowLeft: -1, ArrowRight: 1, Home: -1e9, End: 1e9 };
    if (!(e.key in moves) || e.altKey || e.ctrlKey || e.metaKey) return;
    var tiles = graphTiles();
    var at = tiles.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    var to = tiles[Math.max(0, Math.min(tiles.length - 1, at + moves[e.key]))];
    // a key at either end moves nowhere, so it changes nothing: no fade again, no choice written
    if (to === tiles[at]) return;
    to.click();
    to.focus({ preventScroll: true });
  }
  // the assistant's "show dependencies ... at its first chart": the first card shown, so its
  // heading is the one in view, without changing the tile a person chose for next time
  function graphShowFirst() {
    var strip = $('cp-graph-focus');
    if (!strip || strip.hidden) return;
    var first = $('cp-graph').querySelector('.graph__section');
    if (first) graphSelect(first.getAttribute('data-focus'), '');
  }
  // All shows every chart at once, each fitted in a cell of its own, in the grid of columns and rows
  // that draws the smallest of them the largest, by each chart's own size in the face it is drawn
  // largest in, so a wide goals chart and a tall epic both read as well as the deck allows; a press
  // on a cell opens its chart. No cell is narrower or shorter than its title and a chart can be told
  // apart in (GRAPH_ALL_MIN_W by GRAPH_ALL_MIN_H of the tab's own pixels): where the deck cannot hold
  // every cell at that size, as with many epics at a large text size, All shows a page of them at a
  // time, turned by the arrows under them or a swipe across them, never a grid of cells too small
  // to say what they are
  var GRAPH_ALL_MIN_W = 150, GRAPH_ALL_MIN_H = 110, GRAPH_ALL_GAP = 10, graphAllPage = 0;
  function graphAllLayout() {
    var box = $('cp-graph');
    if (!box) return;
    var pager = $('cp-graph-allpager');
    if (!box.classList.contains('graph--all')) {
      box.style.gridTemplateColumns = '';
      box.style.gridTemplateRows = '';
      if (pager) pager.parentNode.removeChild(pager);
      return;
    }
    var cells = Array.prototype.slice.call(box.querySelectorAll('.graph__section'));
    var n = cells.length, W = box.clientWidth, H = box.clientHeight, gap = GRAPH_ALL_GAP;
    if (!n || !W || !H) return;
    function fits(h) { return Math.max(1, Math.floor((W + gap) / (GRAPH_ALL_MIN_W + gap))) * Math.max(1, Math.floor((h + gap) / (GRAPH_ALL_MIN_H + gap))); }
    var per = Math.min(n, fits(H));
    if (per < n) {
      pager = pager || graphAllPager(box);
      H -= pager.offsetHeight + gap;
      per = Math.min(n, fits(H));
    } else if (pager) { pager.parentNode.removeChild(pager); pager = null; }
    var pages = Math.ceil(n / per);
    graphAllPage = Math.max(0, Math.min(pages - 1, graphAllPage));
    var page = cells.slice(graphAllPage * per, graphAllPage * per + per);
    cells.forEach(function (sec) { sec.hidden = page.indexOf(sec) < 0; });
    if (pager) graphAllPagerSay(pager, pages);
    // what a cell keeps from its stage, its title, gap, padding and frame, read off a cell's own
    // parts and not off its size, which may be the grid's last guess; its title grows with the
    // console's text size
    var aside = graphAllAside(page[0]), m = page.length;
    var faces = page.map(function (sec) { var st = stageOf(sec.querySelector('.control__chart')); return st && st.faces.length ? st.faces : [{ w: 400, h: 300 }]; });
    var colsMost = Math.max(1, Math.floor((W + gap) / (GRAPH_ALL_MIN_W + gap))), rowsMost = Math.max(1, Math.floor((H + gap) / (GRAPH_ALL_MIN_H + gap)));
    var best = Math.min(m, colsMost), bestScale = -1;
    for (var cols = 1; cols <= Math.min(m, colsMost); cols++) {
      var rows = Math.ceil(m / cols);
      if (rows > rowsMost) continue;
      var cw = (W - gap * (cols - 1)) / cols - aside.w - 2 * STAGE_PAD, ch = (H - gap * (rows - 1)) / rows - aside.h - 2 * STAGE_PAD;
      var scale = Math.min.apply(null, faces.map(function (fs) { return Math.max.apply(null, fs.map(function (f) { return Math.min(cw / f.w, ch / f.h, 1); })); }));
      if (scale > bestScale + 1e-6) { best = cols; bestScale = scale; }
    }
    box.style.gridTemplateColumns = 'repeat(' + best + ', minmax(0, 1fr))';
    box.style.gridTemplateRows = 'repeat(' + Math.ceil(m / best) + ', minmax(0, 1fr))' + (pager ? ' auto' : '');
  }
  // All's pages: an arrow either side of where it stands among them, under the cells
  function graphAllPager(box) {
    var pager = el('div', 'graph__allpager');
    pager.id = 'cp-graph-allpager';
    pager.setAttribute('role', 'group');
    pager.setAttribute('aria-label', 'Pages of the charts');
    [-1, 1].forEach(function (step) {
      var b = el('button', 'graph__page', step < 0 ? '\u2039' : '\u203a');
      b.type = 'button';
      b.setAttribute('data-step', String(step));
      b.addEventListener('click', function () { graphAllTurn(step, 0); });
      add(pager, b);
      if (step < 0) add(pager, el('span', 'graph__pos'));
    });
    box.appendChild(pager);
    return pager;
  }
  function graphAllPagerSay(pager, pages) {
    pager.querySelector('.graph__pos').textContent = 'Page ' + (graphAllPage + 1) + ' of ' + pages;
    Array.prototype.forEach.call(pager.querySelectorAll('button'), function (b) {
      var to = graphAllPage + Number(b.getAttribute('data-step'));
      b.disabled = to < 0 || to >= pages;
      b.setAttribute('aria-label', (to < graphAllPage ? 'Earlier charts' : 'Later charts') + ', page ' + (graphAllPage + 1) + ' of ' + pages);
    });
  }
  // a page of All's cells turned by its arrows or a swipe across them, which the cells' stages hand
  // here; sideways only, and nowhere past either end
  function graphAllTurn(dx, dy) {
    var pager = $('cp-graph-allpager');
    if (!pager || Math.abs(dx) < Math.abs(dy) || !dx) return false;
    var before = graphAllPage, buttons = pager.querySelectorAll('button');
    var next = buttons[dx > 0 ? 1 : 0];
    if (next.disabled) return false;
    graphAllPage += dx > 0 ? 1 : -1;
    graphAllLayout();
    return graphAllPage !== before;
  }
  function graphAllAside(sec) {
    var cs = getComputedStyle(sec), head = sec.querySelector('.graph__head'), stage = sec.querySelector('.control__chart');
    var px = function (v) { return parseFloat(v) || 0; };
    var frame = stage ? [stage.offsetWidth - stage.clientWidth, stage.offsetHeight - stage.clientHeight] : [0, 0];
    return {
      w: px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) + frame[0],
      h: (head ? head.offsetHeight + px(cs.rowGap) : 0) + px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) + frame[1]
    };
  }
  // the tab laid out again for its size: its short form, the key's fold, the tiles' rows and pages,
  // All's grid; each chart fits itself to its own stage as that changes size (stageMake). A tab under
  // GRAPH_SHORT of its own pixels tall, as on a phone held sideways or a laptop at a large text size,
  // which a media query cannot see, gives its cards' heads to the stage (control.css, graph--short)
  var GRAPH_SHORT = 520;
  function graphLayout() {
    var tab = $('tab-dependencies');
    graphPhoneFit(false);
    if (tab && tab.clientHeight) tab.classList.toggle('graph--short', tab.clientHeight < GRAPH_SHORT);
    graphKeyFold();
    graphStripLayout(true);
    graphAllLayout();
    graphHelpLayout();
  }
  // On a phone the page scrolls as a whole and the deck has no height of its own (the console's
  // phone layout), so while this tab is shown the page is held still (graph--held on the document,
  // control.css: no scroll, no bounce, and no gesture of the browser's own on the tab), the window
  // put where the rail of tabs stands at the window's top, so the person can always leave for
  // another tab, and the tab takes the rest of the screen's height: the whole tab in front of the person and nothing a finger can scroll. The
  // site's bar takes none of it: it hides itself on this page and comes back over the deck when its
  // handle is tapped or swiped down (initBar, barRoom), held sideways as upright. Opening the tab
  // and turning the phone bring the window back there;
  // any other tab lets the page go. Elsewhere the deck holds the window and the tab simply fills
  // its stage.
  var GRAPH_PHONE_MIN = 160;
  function graphPhoneFit(bring) {
    var tab = $('tab-dependencies');
    if (!tab) return;
    var phone = pageScrolls(), shown = graphTabShown(tab);
    document.documentElement.classList.toggle('graph--held', phone && shown);
    if (!phone) { tab.style.height = ''; return; }
    if (!shown) return;
    var h = Math.floor(window.innerHeight - graphHeldAround(tab));
    tab.style.height = Math.max(h, GRAPH_PHONE_MIN) + 'px';
    var rail = document.querySelector('.console__rail') || tab;
    if (bring) window.scrollTo({ left: 0, top: Math.max(0, rail.getBoundingClientRect().top + window.pageYOffset - barRoom()), behavior: 'instant' });
  }
  // what the held tab needs of the window besides its own height: the top kept clear (barRoom), the
  // rail of tabs and the gap under it, and the stage's padding under the tab, with a few pixels over
  function graphHeldAround(tab) {
    var rail = document.querySelector('.console__rail') || tab, stage = tab.closest('.console__stage');
    var lead = tab.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    var below = stage ? parseFloat(getComputedStyle(stage).paddingBottom) + parseFloat(getComputedStyle(stage).borderBottomWidth) : 0;
    return barRoom() + lead + below + 6;
  }
  function graphTabShown(tab) { return !!tab && !tab.hidden && tab.getClientRects().length > 0; }
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
      // the sub-issues in another repository, which GitHub's summary on the epic counts and no chart
      // draws, are counted, so the card's pills can still add up to its bar
      draw.elsewhere[number] = list.filter(function (c) { return isPlain(c) && !('pull_request' in c); }).length - children.length;
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
    var draw = { s: s, n: s.graphDraw = (s.graphDraw || 0) + 1, repo: repo, claimed: {}, reads: 0, left: left, reading: '', subIssues: {}, elsewhere: {}, blockedBy: {}, others: {}, listed: {} };
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
    graphReset('Reading the sub-issues of ' + plural(planned.length, 'epic or goal', 'epics and goals') + '...', false, true);
    return planned.reduce(function (p, parent) { return p.then(function () { return graphReadParent(draw, parent); }); }, Promise.resolve()).then(function () {
      draw.reading = '';
      // the pull requests are read beside the issues, and say which tasks a claim branch holds
      return s.pullsRead;
    }).then(function () {
      if (!graphLive(draw)) return;
      draw.claimed = graphClaimed(s.pulls, repo);
      graphRender(draw);
      // Explore plans from the latest draw, and redraws while it is open
      s.graphLast = draw;
      s.graphFailed = '';
      exploreAfterDraw();
    }).catch(function (e) {
      if (!graphLive(draw)) return;
      graphHeld();
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
  // a tile's title for an epic: its title folded as the board folds it and its spaces closed up; the
  // stylesheet cuts it at two lines, where the card's heading says it in full
  function graphTileTitle(epic) {
    return graphFold(epic.title).split(GRAPH_SPACE).filter(Boolean).join(' ');
  }
  // the states a card counts, in the order work moves through them, with the words of its pills
  var GRAPH_COUNTS = [['todo', 'to do'], ['claimed', 'claimed'], ['review', 'in review'], ['blocked', 'blocked'], ['', 'open'], ['closed', 'closed']];
  // a card's head: its heading, then, for an epic, a bar of its closed tasks, and a pill per state
  // of its own issues, each in the colour its nodes are drawn in, so the card reads before the chart;
  // an epic's own are its sub-issues in this repository, which its chart draws; its sub-issues in
  // another repository, which GitHub's summary and so the bar count and no chart draws, have a pill
  // of their own, so the pills add up to the bar's total, and a blocker from outside the epic,
  // which is none of its tasks, is counted apart, in a last pill
  function graphCounts(draw, chart, own) {
    var counts = {};
    chart.nodes.forEach(function (it) {
      if (own && own.indexOf(it.number) < 0) return;
      var c = graphClass(it, draw.claimed);
      counts[c] = (counts[c] || 0) + 1;
    });
    return counts;
  }
  function graphCardHead(draw, heading, chart, progress, own, elsewhere) {
    var head = el('div', 'graph__head');
    // a long heading is cut at two lines (control.css), so the stage keeps its room; its whole words
    // are the tile's, the tooltip's and a reader's
    var h3 = add(head, el('h3', '', heading)).lastChild;
    h3.title = heading;
    var meta = el('div', 'graph__meta');
    if (progress && progress[1] > 0) {
      var done = Math.min(progress[0], progress[1]);
      var bar = el('div', 'graph__bar'), fill = el('span');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(progress[1]));
      bar.setAttribute('aria-valuenow', String(done));
      // named for its card, since All shows several, and read as the words beside it say it
      bar.setAttribute('aria-label', heading + ': tasks closed');
      bar.setAttribute('aria-valuetext', done + ' of ' + progress[1] + ' closed');
      fill.style.width = Math.round(100 * done / progress[1]) + '%';
      add(meta, add(el('div', 'graph__progress'), add(bar, fill), el('span', 'graph__done', done + ' of ' + progress[1] + ' closed')));
    }
    var counts = graphCounts(draw, chart, own);
    var pills = el('div', 'graph__pills');
    GRAPH_COUNTS.forEach(function (pair) {
      if (!counts[pair[0]]) return;
      // its words in a span of their own, which a phone hides from sight and keeps for a reader
      var pill = add(el('span', 'graph__pill graph__pill--' + (pair[0] || 'plain')), el('b', '', counts[pair[0]]), el('span', 'graph__pword', ' ' + pair[1]));
      pill.title = counts[pair[0]] + ' ' + pair[1];
      add(pills, pill);
    });
    if (elsewhere) add(pills, add(el('span', 'graph__pill graph__pill--elsewhere'), el('b', '', elsewhere), ' in another repository'));
    var outside = own ? chart.nodes.filter(function (it) { return own.indexOf(it.number) < 0; }).length : 0;
    if (outside) add(pills, add(el('span', 'graph__pill graph__pill--outside'), el('b', '', outside), ' from outside the epic'));
    add(meta, pills);
    add(head, meta);
    return head;
  }
  // One chart's card: its head (its heading, its tools, its bar and pills), then its body, which
  // holds the chart's stage, the card a focus fills beside or under it, and the list that says the
  // same in words, shown in the chart's place by the card's List switch and by itself where the
  // chart cannot be drawn. Nothing in it scrolls: the stage fits the chart and the list fits itself.
  function graphSection(draw, box, heading, chart, relation, relationCell, key, tile) {
    var progress = tile.progress;
    var sec = el('section', 'graph__section');
    sec.setAttribute('data-focus', key);
    sec.setAttribute('data-view', 'chart');
    var head = graphCardHead(draw, heading, chart, progress, tile.own, tile.elsewhere);
    add(sec, head);
    var host = el('div', 'control__chart', 'Drawing the chart...');
    var near = el('div', 'graph__near');
    near.hidden = true;
    near.setAttribute('aria-live', 'polite');
    var text = graphChart(draw, chart.nodes, chart.edges);
    var c = { draw: draw, host: host, near: near, section: sec, heading: heading, text: text, key: key, view: 'chart', focus: null, turns: true,
      edges: graphEdgesOf(text), kind: tile.kind, title: tile.title, counts: graphCounts(draw, chart, tile.own) };
    // a focus is drawn from the same text the chart is, through the same generator, for the node and
    // the issues one edge away from it, and the edges between them
    c.nearText = function (near) {
      return graphChart(draw, chart.nodes.filter(function (it) { return near[it.number]; }), chart.edges.filter(function (e) {
        var m = GRAPH_EDGE.exec('  ' + e);
        return m && near[Number(m[1])] && near[Number(m[3])];
      }));
    };
    c.record = function (n) {
      var it = graphIssueOf(draw, n);
      return { title: it.title, state: graphClass(it, draw.claimed), worker: workerOf(it.labels), url: it.html_url || 'https://github.com/' + draw.repo + '/issues/' + n };
    };
    var table = el('table', 'control__tasks'), row = el('tr');
    ['Issue', 'Title', 'State', relation, 'Worker'].forEach(function (h) { add(row, el('th', '', h)); });
    add(row, add(el('th'), el('span', 'admin__sr', 'Actions')));
    add(table, add(el('thead'), row));
    var body = el('tbody');
    chart.nodes.forEach(function (it) {
      var tr = el('tr');
      add(tr, add(el('td'), graphIssueLink(draw, it.number)));
      add(tr, el('td', '', it.title));
      add(tr, el('td', '', GRAPH_STATES[graphClass(it, draw.claimed)]));
      // a phone stacks each row and hides the heads (control.css), so these two cells carry theirs
      var rel = relationCell(draw, it), who = el('td', '', workerOf(it.labels));
      rel.setAttribute('data-label', relation);
      who.setAttribute('data-label', 'Worker');
      add(tr, rel, who);
      // the row's button does a node's press and the old click's job both: the issue opens in focus
      // in the chart, for when the person comes back, and its row is centred in the Tasks tab
      var go = btn('Centre its row', true, function () {
        if (c.whole) { graphView(c, 'chart'); graphNearOpen(c, it.number); }
        graphFocus(it.number);
      });
      go.title = 'Open #' + it.number + ' in focus in the chart, and centre its row in the Tasks tab';
      add(tr, add(el('td', 'admin__act'), go));
      body.appendChild(tr);
    });
    add(table, body);
    var list = add(el('div', 'graph__list'), table);
    list.hidden = true;
    c.list = list;
    c.table = table;
    add(sec, add(el('div', 'graph__body'), host, near, list));
    add(head, add(el('div', 'graph__tools'), graphViewSwitch(c), graphZoomTools(c)));
    add(box, sec);
    // under All a press anywhere on a card opens its chart, the stage's own press (and Enter) among
    // them, and a swipe across the cells turns All's page; otherwise a press on a node opens it in
    // focus. Two fingers anywhere on the card pinch its chart
    function all() { return $('cp-graph').classList.contains('graph--all'); }
    function open() { if (all()) graphSelect(key, draw.repo); }
    graphStage(c, {
      area: sec,
      zooms: function () { return !all(); },
      wheel: function () { return true; },
      go: function (dx, dy) { return all() ? graphAllTurn(dx, dy) : graphGo(c, dx, dy); },
      corner: function () { return graphCorner(c, host); },
      tap: function (n) {
        if (all()) open();
        else if (n != null && n !== c.focus) graphNearOpen(c, n);
      }
    });
    // the list is a stage of its own, fitted, zoomed and panned as the chart is, and its rows'
    // buttons and links keep their own presses; a swipe across it whole steps to the chart beside it
    stageMake(list, {
      zooms: function () { return !all(); },
      wheel: function () { return true; },
      area: sec,
      go: function (dx, dy) { return all() ? graphAllTurn(dx, dy) : graphStepChart(c, dx, dy); },
      corner: function () { return graphCorner(c, list); },
      tap: open,
      moved: function (st) { if (c.view === 'list' && c.fit) c.fit.classList.toggle('graph__fit--idle', st.whole); }
    });
    head.addEventListener('click', open);
    if (typeof ResizeObserver === 'function') {
      var watch = new ResizeObserver(function () { if (!list.isConnected) watch.disconnect(); else if (!list.hidden) graphListFit(c); });
      watch.observe(list);
      var nearWatch = new ResizeObserver(function () { if (!near.isConnected) nearWatch.disconnect(); else if (!near.hidden) { graphNearRoom(c); graphNearFit(c); } });
      nearWatch.observe(near);
    }
    c.foot = progress && progress[1] > 0 ? Math.min(progress[0], progress[1]) + ' of ' + progress[1] + ' closed' : plural(chart.nodes.length, 'issue');
    return c;
  }
  // Chart and List at the top of a card: the picture, or the same in words in the picture's place
  function graphViewSwitch(c) {
    var g = el('div', 'graph__views');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', 'Show ' + c.heading + ' as');
    [['chart', 'Chart'], ['list', 'List']].forEach(function (pair) {
      var b = el('button', 'graph__view', pair[1]);
      b.type = 'button';
      b.setAttribute('data-view', pair[0]);
      b.setAttribute('aria-pressed', pair[0] === 'chart' ? 'true' : 'false');
      b.addEventListener('click', function () { graphView(c, pair[0]); });
      add(g, b);
    });
    return g;
  }
  function graphView(c, view) {
    c.view = view;
    c.section.setAttribute('data-view', view);
    Array.prototype.forEach.call(c.section.querySelectorAll('.graph__view'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false'); });
    c.host.hidden = view !== 'chart';
    c.near.hidden = view !== 'chart' || c.focus == null;
    c.list.hidden = view !== 'list';
    if (view === 'list') { var st = stageOf(c.list); if (st) st.whole = true; graphListFit(c); }
    else if (c.fit && c.stage) c.fit.classList.toggle('graph__fit--idle', c.focus == null && c.stage.whole);
  }
  // The list laid out at the width that draws it largest whole, and put on its stage, which fits it
  // The list is laid out as its chart is fitted: as a table at the stage's own width where its rows
  // fit, and wider where they do not, so its words wrap less and each row takes fewer lines; or, where
  // that draws them larger, as cards, each row its issue and title over the rest, in as many columns
  // as the stage's width holds, as a box wider than tall does best with many rows (a phone held
  // sideways); a phone upright has the cards always (control.css). The table is kept unless the cards
  // draw the rows a good deal larger, its columns reading more easily; a reader hears the same table
  // whatever its form or size. A zoom the person made is kept.
  var GRAPH_LIST_WIDTHS = [1, 1.4, 2, 2.8, 4], GRAPH_LIST_COLUMN = 220, GRAPH_LIST_CARDS = 1.15;
  function graphListFit(c) {
    var box = c.list, t = c.table, st = stageOf(box);
    if (!st || !box.clientWidth || !box.clientHeight || (st.svg && !st.whole)) return;
    var W = Math.max(1, box.clientWidth - 2 * STAGE_PAD), H = Math.max(1, box.clientHeight - 2 * STAGE_PAD);
    function scale(cards, m, cols) {
      box.classList.toggle('graph__list--cards', cards);
      t.style.setProperty('--gcols', String(cols));
      t.style.width = Math.round(W * m) + 'px';
      return Math.min(1, W / t.offsetWidth, H / t.offsetHeight);
    }
    var table = null, cards = null, i, k;
    for (i = 0; i < GRAPH_LIST_WIDTHS.length; i++) {
      k = scale(false, GRAPH_LIST_WIDTHS[i], 1);
      if (!table || k > table.k + 1e-3) table = { cards: false, m: GRAPH_LIST_WIDTHS[i], cols: 1, k: k };
      if (k >= 1) break;
    }
    for (i = 1; table.k < 1 && i <= Math.max(1, Math.floor(W / GRAPH_LIST_COLUMN)); i++) {
      k = scale(true, 1, i);
      if (!cards || k > cards.k + 1e-3) cards = { cards: true, m: 1, cols: i, k: k };
    }
    var best = cards && cards.k > table.k * GRAPH_LIST_CARDS ? cards : table;
    scale(best.cards, best.m, best.cols);
    stageShow(box, [{ svg: t, w: t.offsetWidth, h: t.offsetHeight }], 1);
  }
  // a chart that was not drawn shows its list, so its card still says what it holds, and keeps it
  function graphUndrawn(chart) {
    if (!chart.list) return;
    graphView(chart, 'list');
    var b = chart.section.querySelector('.graph__view[data-view="chart"]');
    if (b) { b.disabled = true; b.title = 'This chart could not be drawn; its list says the same'; }
  }
  function graphRender(draw) {
    var box = $('cp-graph');
    var goals = graphWithSubIssues(draw, 'goal'), epics = graphWithSubIssues(draw, 'epic');
    clear(box);
    box.classList.remove('graph--all');
    graphShown = [];
    graphStripClear();
    if (!goals.length && !epics.length) {
      graphHeld();
      graphWords('Nothing to draw yet: ' + plural(draw.reads, 'read') + ' of GitHub found no sub-issue of an open epic or goal in this repository. ' + GRAPH_START + graphCut(draw));
      return;
    }
    var charts = [];
    if (goals.length) charts.push(graphSection(draw, box, 'Goals', graphGoals(draw, goals), 'Its epics', graphEpicsOf, 'goals', { kind: 'Goals', title: goals.length === 1 ? 'The goal and its epics' : 'The goals and their epics' }));
    epics.forEach(function (epic) { charts.push(graphSection(draw, box, graphHeading(epic), graphEpic(draw, epic.number), 'Blocked by', graphBlockedBy, 'epic-' + epic.number, { kind: 'Epic #' + epic.number, title: graphTileTitle(epic), progress: epic.progress, own: draw.subIssues[epic.number] || [], elsewhere: draw.elsewhere[epic.number] || 0 })); });
    graphShown = charts;
    graphStrip(draw, charts);
    graphKey(true);
    graphPhoneFit(false);
    graphLayout();
    var drew = (goals.length ? [plural(goals.length, 'goal')] : []).concat(epics.length ? [plural(epics.length, 'epic')] : []);
    var drawn = 'from ' + plural(draw.reads, 'read') + ' of GitHub: ' + drew.join(' and ') + ' with sub-issues';
    graphWords('Drawing ' + drawn + '...');
    // each chart is drawn on its own, so one Mermaid cannot draw leaves the others drawn and is
    // named, its list standing in for it
    loadMermaid().then(function (m) {
      var undrawn = [];
      return charts.reduce(function (p, chart) {
        return p.then(function () {
          if (!graphLive(draw)) return;
          return graphDraw(m, chart).catch(function (e) { graphUndrawn(chart); undrawn.push(chart.heading + ': ' + e.message); });
        });
      }, Promise.resolve()).then(function () { return undrawn; });
    }).then(function (undrawn) {
      if (!graphLive(draw)) return;
      graphHeld();
      graphAllLayout();
      // a phone that opened the tab before its charts were drawn brings it into view now, once
      if (graphBring && !$('tab-dependencies').hidden) { graphBring = false; graphPhoneFit(true); }
      // the key is for charts; where none could be drawn the cards hold their lists alone
      if (undrawn.length === charts.length) graphKey(false);
      if (!undrawn.length) graphWords('Drawn ' + drawn + '. A node\'s shade is its state; press one to see it with its neighbours.' + graphCut(draw));
      else graphWords('Drawn ' + (charts.length - undrawn.length) + ' of ' + plural(charts.length, 'chart') + ' ' + drawn + '; ' + plural(undrawn.length, 'chart') + ' could not be drawn (' + undrawn.join('; ') + '), and ' + (undrawn.length === 1 ? 'its list says' : 'the list of each says') + ' the same.' + graphCut(draw), true);
    }, function (e) {
      if (!graphLive(draw)) return;
      graphHeld();
      graphKey(false);
      charts.forEach(graphUndrawn);
      graphWords('The charts could not be drawn (' + e.message + '); the lists say the same ' + drawn + '.', true);
    });
  }
  // Mermaid sizes each box by measuring its words, so the face it measures in, the site's, is waited
  // for first, or a box measured in the fallback face would cut its words short once the site's
  // arrives; only that face is waited for, and for GRAPH_FONT_WAIT at most, so a font download that
  // stalls costs the charts a moment and never holds them (a late face changes how a label looks)
  var GRAPH_FONT_WAIT = 2500;
  function graphFontReady() {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    var waited = new Promise(function (resolve) { setTimeout(resolve, GRAPH_FONT_WAIT); });
    return Promise.race([document.fonts.load('14px "IBM Plex Sans"'), waited]).then(function () {}, function () {});
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
          'dompurifyConfig', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily'],
        // the console's own look: Mermaid's rounded "neo" look in the console's dark colours and the
        // site's typeface, arrows turning at rounded corners, and room around each label; the shade of a node by its
        // state is the stylesheet's (graphRestyle), the board's classes naming it
        look: 'neo', theme: 'base', fontFamily: GRAPH_FONT,
        themeVariables: GRAPH_THEME,
        flowchart: { padding: 16, nodeSpacing: 34, rankSpacing: 54, wrappingWidth: 190 } });
      return graphFontReady().then(function () { return m; });
    }).catch(function (e) {
      // whatever failed, the next draw tries the load again, as the words tell the person Refresh does
      mermaidLoad = null;
      throw e;
    });
    return mermaidLoad;
  }
  // one chart drawn under ids of its own, since Mermaid takes any element already carrying the id it
  // draws under off the page; a Dependencies chart in both its faces, top to bottom and left to
  // right, a Board chart in the board's own, since its stage takes the picture's own height on a
  // board that scrolls; the picture is put on the chart's stage, which fits it whole in the face
  // drawn larger
  function graphDraw(m, chart) {
    return graphRenderFaces(m, chart.text, !!chart.turns).then(function (texts) {
      var svgs = graphSvgs(texts, function (svg) {
        return (chart.heading || 'The board\'s chart') + ': a chart of ' + plural(svg.querySelectorAll('g.node').length, 'issue') + '; press a node to see it with its neighbours' + (chart.list ? ', or List for the same in words' : '');
      }, false);
      clear(chart.host);
      if (!svgs.length) return;
      chart.faces = svgs;
      chart.whole = svgs[0];
      chart.host.appendChild(svgs[0]);
      stageShow(chart.host, svgs, 1);
    });
  }

  /* ---------- the stage: a chart fitted to its box, zoomed and panned in place ---------- */
  // The owner, 2026-10-19: "I want all the nodes visible without scrolling, I literally never in any
  // case want to scroll, I'd prefer to need to zoom ... Just pinch and zoom on mobile, touch to
  // focus". So a chart is drawn in a box that never scrolls (control.css: overflow hidden and no
  // touch scrolling of its own), opened whole, fitted to the box in both directions and centred,
  // never drawn larger than its natural size, and moved by a CSS transform on the drawing alone:
  // pinched with two fingers; zoomed about the pointer by the trackpad's pinch (a wheel event with
  // ctrlKey) and, where the stage allows it, the mouse's wheel; by + and - and back whole by 0 when
  // the stage has the keyboard; and in about a point by a double tap or a double click; from the
  // whole view to a few times natural size. Once zoomed in, one finger or the mouse drags it, kept
  // within the picture's edges, so it is never lost off the box; at the whole view the same drag is
  // a swipe, which the chart's own hooks turn into a step to the next chart or the next neighbour.
  // A picture may come in more than one face, a chart drawn top to bottom and the same drawn left to
  // right, and the stage shows the face drawn largest in its box, choosing again whenever the box
  // changes shape while the picture is whole (the owner's "you just have to get better layout
  // dynamically"): a tall box takes a tall face and a wide one a wide face. The same functions serve
  // the Dependencies tab's charts and lists and the Board tab's charts, each stage with hooks of its
  // own: whether it zooms now, whether the plain wheel zooms it, where a press and a swipe go.
  var STAGE_PAD = 12, STAGE_MAX = 3, STAGE_NEAR_MAX = 2, STAGE_TAP_MS = 280, STAGE_CLICK_MS = 500, STAGE_SLOP = 8, STAGE_TURN = 1.08;
  var stages = new WeakMap();
  function stageOf(host) { return host ? stages.get(host) || null : null; }
  function stageUnder(node) {
    for (var n = node; n && n.nodeType === 1; n = n.parentNode) if (stages.has(n)) return stages.get(n);
    return null;
  }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  // a stage for a box, its listeners wired once; refitted whenever the box changes size, as when its
  // tab or card is first shown, a phone is turned or the console's text size changes. hooks.area, a
  // box round the stage (a chart's card), lets a finger that lands on it join a pinch on the stage
  function stageMake(host, hooks) {
    var st = { host: host, hooks: hooks, svg: null, faces: [], w: 0, h: 0, k: 1, x: 0, y: 0, fit: 1, cap: 1, floor: 0, whole: true, pointers: {}, drag: null, pinch: null, lastTap: null, lastType: '', tapTimer: 0, outBy: 1 };
    stages.set(host, st);
    host.tabIndex = 0;
    host.addEventListener('pointerdown', function (e) { stageDown(st, e); });
    host.addEventListener('pointermove', function (e) { stageMove(st, e); });
    host.addEventListener('pointerup', function (e) { stageUp(st, e, false); });
    host.addEventListener('pointercancel', function (e) { stageUp(st, e, true); });
    // only the stage's own capture lost ends a gesture; a button's or a link's, which a finger holds
    // until the stage takes it at its first move, bubbles here too and means nothing
    host.addEventListener('lostpointercapture', function (e) { if (e.target === host) stageUp(st, e, true); });
    host.addEventListener('wheel', function (e) { stageWheel(st, e); }, { passive: false });
    host.addEventListener('keydown', function (e) { host.classList.remove('stage--touched'); stageKeys(st, e); });
    // the mark of a finger's press lasts while the stage keeps the keyboard it gave, so the keyboard's
    // own way back to the stage later draws its ring
    host.addEventListener('blur', function () { host.classList.remove('stage--touched'); });
    // a double click is the stage's own zoom, never a selection of the words under it, and the mouse's
    // is the browser's own, which keeps the system's double-click time
    host.addEventListener('dblclick', function (e) { e.preventDefault(); stageDouble(st, e); });
    // Safari reports a pinch as a gesture too, which would zoom the whole page
    host.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    // a box whose overflow is hidden can still be scrolled by the browser, to show a button given the
    // keyboard inside it; the stage moves its picture itself (stageReveal), so the box stays put
    host.addEventListener('scroll', function () { if (host.scrollLeft || host.scrollTop) { host.scrollLeft = 0; host.scrollTop = 0; } });
    host.addEventListener('focusin', function (e) { if (e.target !== host) stageReveal(st, e.target); });
    if (hooks.area) stageArea(st, hooks.area);
    if (typeof ResizeObserver === 'function') {
      var watch = new ResizeObserver(function () { if (!host.isConnected) watch.disconnect(); else stageResized(st); });
      watch.observe(host);
    }
    return st;
  }
  // a face of a picture: the element drawn and its natural size, a drawing's from its viewBox
  function stageFace(svg) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    return { svg: svg, w: vb && vb.width > 0 ? vb.width : 1, h: vb && vb.height > 0 ? vb.height : 1 };
  }
  // A picture put on the stage, the whole chart, a focus or a list, in one face or several, and
  // fitted whole in the face drawn largest; cap is the most the fit may enlarge it, 1 for a chart,
  // more for a focus. opts.floor is the least it is drawn at, where fitting it whole would draw it
  // smaller (a focus is never drawn smaller than its whole chart drew it), and then it opens centred
  // on the point opts.focal gives, the rest of it a pan or a swipe away
  function stageShow(host, faces, cap, opts) {
    var st = stageOf(host);
    if (!st) return;
    opts = opts || {};
    st.faces = (Array.isArray(faces) ? faces : [faces]).map(function (f) { return f.svg ? f : stageFace(f); });
    st.cap = cap;
    st.floor = opts.floor || 0;
    st.focal = opts.focal || null;
    st.svg = null;
    stageSet(st, stagePick(st) || st.faces[0]);
    stageWhole(st, false);
  }
  // the face drawn largest in the box as it is now; the one shown is kept unless another is drawn
  // larger by a margin, so a box near the balance does not turn the picture at every pixel
  function stagePick(st) {
    var best = null, bestK = -1, at = null, atK = 0;
    st.faces.forEach(function (f) {
      var k = stageFaceScale(st, f);
      if (k > bestK) { best = f; bestK = k; }
      if (f.svg === st.svg) { at = f; atK = k; }
    });
    return at && bestK <= atK * STAGE_TURN ? at : best;
  }
  function stageFaceScale(st, f) {
    var w = st.w, h = st.h;
    st.w = f.w;
    st.h = f.h;
    var k = stageFitScale(st);
    st.w = w;
    st.h = h;
    return k;
  }
  // a face made the one shown: in the box in place of the face of the same picture shown before, or
  // added to the box; a drawing keeps its natural size whatever the stage's width, since the
  // transform alone scales it: a page style or Mermaid's own max-width shrinking it too would fit it
  // twice
  function stageSet(st, face) {
    var el = face.svg;
    if (!el.isConnected) {
      var shown = st.faces.filter(function (f) { return f.svg !== el && f.svg.parentNode === st.host; })[0];
      if (shown) st.host.replaceChild(el, shown.svg); else st.host.appendChild(el);
    }
    st.svg = el;
    st.w = face.w;
    st.h = face.h;
    if (el instanceof SVGElement) {
      el.setAttribute('width', String(st.w));
      el.setAttribute('height', String(st.h));
      el.style.maxWidth = 'none';
      el.style.minWidth = st.w + 'px';
    }
    if (st.hooks.face) st.hooks.face(el);
  }
  // the box's inner size in its own pixels, which the console's text size (a CSS zoom on the deck)
  // makes differ from the window's
  function stageRoom(st) { return { x: 0, y: 0, w: st.host.clientWidth, h: st.host.clientHeight }; }
  // the part of the box a picture is fitted to: all of it, or, where the card's tools float over its
  // top left corner (a short tab, control.css), the larger for this picture of the part below them
  // and the part beside them, so no node is drawn under them
  function stageFitRoom(st) {
    var r = stageRoom(st), c = st.hooks.corner ? st.hooks.corner() : null;
    if (!c) return r;
    var below = { x: 0, y: c.h, w: r.w, h: r.h - c.h }, beside = { x: c.w, y: 0, w: r.w - c.w, h: r.h };
    return stageScaleIn(st, below) >= stageScaleIn(st, beside) ? below : beside;
  }
  function stageScaleIn(st, r) {
    if (!(r.w > 2 * STAGE_PAD && r.h > 2 * STAGE_PAD)) return 0;
    return Math.min((r.w - 2 * STAGE_PAD) / st.w, (r.h - 2 * STAGE_PAD) / st.h, st.cap);
  }
  function stageFitScale(st) { return stageScaleIn(st, stageFitRoom(st)); }
  // the whole picture, centred; or, where a floor draws it larger than its box, the floor's size
  // about its focal point, kept within the box's edges; a box laid out with no size yet, as in a
  // hidden tab, is fitted the first time it has one
  function stageWhole(st, animate) {
    if (!st.svg) return;
    var r = stageFitRoom(st), k = stageScaleIn(st, r);
    if (!k) { st.whole = true; return; }
    k = Math.max(k, Math.min(st.floor, st.cap));
    st.fit = k;
    st.k = k;
    var f = k > stageScaleIn(st, r) + 1e-9 && st.focal ? st.focal(st.svg, st.w, st.h) : null;
    st.x = f ? r.x + r.w / 2 - f.x * k : r.x + (r.w - st.w * k) / 2;
    st.y = f ? r.y + r.h / 2 - f.y * k : r.y + (r.h - st.h * k) / 2;
    if (f) stageClamp(st, false);
    st.whole = true;
    stageApply(st, animate);
  }
  // a box that changes size takes the face drawn largest in it, if the picture is whole, and is
  // fitted again; a zoom the person made is kept, its picture within the box, centred where it fits
  function stageResized(st) {
    if (!st.svg) return;
    if (st.whole) {
      var face = stagePick(st);
      if (face && face.svg !== st.svg) { stageSet(st, face); stageWhole(st, false); return; }
    }
    var k = stageFitScale(st);
    if (!k) return;
    st.fit = Math.max(k, Math.min(st.floor, st.cap));
    if (st.whole || st.k < st.fit) stageWhole(st, false);
    else { stageClamp(st, true); stageApply(st, false); }
  }
  // the most a picture is enlarged: a few times its natural size, or its fit where that is more
  function stageMax(st) { return Math.max(st.fit, STAGE_MAX); }
  // each way, a picture larger than the box keeps its edges at the box's, so it is never dragged off
  // and lost, and one that fits the box is kept wholly in it, where the pointer zoomed or the finger
  // left it; centred, as a box that changed size asks, one that fits the part it is fitted to is
  // centred there
  function stageClamp(st, centre) {
    var r = stageRoom(st), f = stageFitRoom(st);
    st.x = stageClampWay(st.x, st.w * st.k, r.w, f.x, f.w, centre);
    st.y = stageClampWay(st.y, st.h * st.k, r.h, f.y, f.h, centre);
  }
  function stageClampWay(at, size, box, from, room, centre) {
    if (centre && size <= room - 2 * STAGE_PAD) return from + (room - size) / 2;
    if (size <= box - 2 * STAGE_PAD) return Math.max(STAGE_PAD, Math.min(box - STAGE_PAD - size, at));
    return Math.min(STAGE_PAD, Math.max(box - STAGE_PAD - size, at));
  }
  // the picture placed; a step taken by a button, a key or a double tap glides there, unless the
  // person asks for less motion, while a finger's or the mouse's move follows at once
  function stageApply(st, animate) {
    if (!st.svg) return;
    st.svg.classList.toggle('stage__glide', !!animate && !reducedMotion());
    st.svg.style.transform = 'translate(' + st.x + 'px, ' + st.y + 'px) scale(' + st.k + ')';
    if (st.hooks.moved) st.hooks.moved(st);
  }
  // zoomed by a factor about a point of the box, which stays where it is under the pointer, until
  // the picture reaches the box's edges
  function stageZoom(st, factor, px, py, animate) {
    if (!st.svg) return;
    var k = Math.max(st.fit, Math.min(stageMax(st), st.k * factor));
    st.x = px - (px - st.x) * k / st.k;
    st.y = py - (py - st.y) * k / st.k;
    st.k = k;
    st.whole = k <= st.fit * 1.001;
    if (st.whole) stageWhole(st, animate);
    else { stageClamp(st, false); stageApply(st, animate); }
  }
  // a step in or out from a button or a key, about the box's middle; a step out from a focus drawn
  // whole goes back to the whole chart, as a pinch outward does
  function stageStep(host, factor) {
    var st = stageOf(host);
    if (!st || !st.svg) return;
    if (factor < 1 && st.whole && st.hooks.out && st.hooks.out()) return;
    var r = stageFitRoom(st);
    stageZoom(st, factor, r.x + r.w / 2, r.y + r.h / 2, true);
  }
  // where a pointer is, in the box's own pixels from its inner top left corner
  function stagePoint(st, e) {
    var b = st.host.getBoundingClientRect(), f = st.host.offsetWidth ? b.width / st.host.offsetWidth : 1;
    return { x: (e.clientX - b.left) / f - st.host.clientLeft, y: (e.clientY - b.top) / f - st.host.clientTop };
  }
  function stageNodeAt(target) {
    var node = target && target.closest ? target.closest('g.node') : null;
    var m = node ? /-flowchart-i([0-9]{1,9})-[0-9]+$/.exec(node.id || '') : null;
    return m ? Number(m[1]) : null;
  }
  // The stage takes the pointer only once it moves: a press that never moves is the element's under
  // it, so a list's buttons and links on the stage get their own clicks; the stage reads the press
  // to know a tap, and captures the pointer at its first move, so a drag that leaves the box goes on.
  function stageDown(st, e) {
    if (!st.svg || (e.pointerType === 'mouse' && e.button !== 0)) return;
    st.lastType = e.pointerType;
    // the stage takes the keyboard, so + - 0 and the arrows work from where the person pressed: the
    // mouse's press gives it by itself, as a press does, with no ring drawn round the box (control.css
    // keeps its words from being selected), and a finger's is given it here, marked so its ring is
    // not drawn either, a ring being for the keyboard
    if (e.pointerType !== 'mouse') {
      st.host.classList.add('stage--touched');
      if (document.activeElement !== st.host && !(e.target.closest && e.target.closest('button, a'))) st.host.focus({ preventScroll: true });
    }
    st.pointers[e.pointerId] = stagePoint(st, e);
    var ids = Object.keys(st.pointers);
    if (ids.length === 2 && st.hooks.zooms()) { stagePinchStart(st); return; }
    if (ids.length > 1) return;
    var p = st.pointers[e.pointerId];
    st.drag = { id: e.pointerId, type: e.pointerType, x0: p.x, y0: p.y, sx: st.x, sy: st.y, dx: 0, dy: 0, t: Date.now(), moved: false, node: stageNodeAt(e.target),
      control: !!(e.target.closest && e.target.closest('button, a')), pan: !st.whole };
    // the stage holds the pointer from the press, so a drag that leaves it at once, over the tools
    // floating at its corner, is still its own; a press on a button or a link inside it (a row's
    // Centre its row in the list) is held only once it moves, so a press that stays is that button's
    if (!st.drag.control) stageCapture(st, e.pointerId);
  }
  function stageCapture(st, id) {
    try { st.host.setPointerCapture(id); } catch (x) { /* a pointer already gone */ }
  }
  function stageMove(st, e) {
    if (!st.pointers[e.pointerId]) return;
    var p = stagePoint(st, e);
    st.pointers[e.pointerId] = p;
    if (st.pinch) { stagePinchMove(st); return; }
    var d = st.drag;
    if (!d || d.id !== e.pointerId) return;
    // a mouse whose release never came, as when a menu opened on the press took it, ends the drag
    // at its first move with no button held
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { stageUp(st, e, true); return; }
    d.dx = p.x - d.x0;
    d.dy = p.y - d.y0;
    if (!d.moved && Math.abs(d.dx) + Math.abs(d.dy) < STAGE_SLOP) return;
    if (!d.moved) stageCapture(st, e.pointerId);
    d.moved = true;
    // the finger left down after a pinch that drew the picture whole moves nothing
    if (!st.hooks.zooms() || (d.after && !d.pan)) return;
    st.host.classList.add('control__chart--panning');
    // zoomed in, the drag pans; at the whole view the picture follows the finger as a swipe, sideways
    // alone between charts and either way between neighbours
    st.x = d.sx + d.dx;
    st.y = d.sy + (d.pan || st.hooks.near ? d.dy : 0);
    if (d.pan) stageClamp(st, false);
    stageApply(st, false);
  }
  function stageUp(st, e, cancelled) {
    if (!st.pointers[e.pointerId]) return;
    delete st.pointers[e.pointerId];
    st.host.classList.remove('control__chart--panning');
    if (st.pinch) {
      if (Object.keys(st.pointers).length < 2) stagePinchEnd(st);
      return;
    }
    var d = st.drag;
    if (!d || d.id !== e.pointerId) return;
    st.drag = null;
    if (!d.moved) { if (!cancelled) stageTap(st, d); return; }
    if (d.after) { if (st.whole) stageWhole(st, true); return; }
    if (d.pan) return;
    // a swipe: far enough, or quick, and more along its way than across it between charts
    var far = Math.max(40, 0.12 * stageRoom(st).w), quick = Date.now() - d.t < 300 && Math.max(Math.abs(d.dx), Math.abs(d.dy)) > 24;
    var sideways = Math.abs(d.dx) > 1.3 * Math.abs(d.dy);
    var swiped = !cancelled && (Math.max(Math.abs(d.dx), Math.abs(d.dy)) > far || quick) && (st.hooks.near || sideways);
    // the picture is moved the way the finger went, as a map is, so what lay the other way comes in;
    // a stage that does not zoom now (All's cells) keeps its picture still and only steps
    if (swiped && st.hooks.go && st.hooks.go(-d.dx, st.hooks.near ? -d.dy : 0)) return;
    if (st.hooks.zooms()) stageWhole(st, true);
  }
  // A tap presses a node. A finger's waits a moment, in which a second tap near it makes a double
  // tap, which zooms in about that point, or back to the whole view from the most it zooms; the
  // mouse's waits for the browser's own double click (stageDouble), whose time is the system's, as
  // long as the longest a system sets by default; a press on a button or a link is its own.
  function stageTap(st, d) {
    var now = Date.now(), last = st.lastTap;
    if (!st.hooks.zooms()) { if (st.hooks.tap) st.hooks.tap(d.node); return; }
    if (d.control) return;
    clearTimeout(st.tapTimer);
    if (d.type !== 'mouse' && last && now - last.t < STAGE_TAP_MS && Math.abs(d.x0 - last.x) + Math.abs(d.y0 - last.y) < 30) {
      st.lastTap = null;
      stageZoomAt(st, d.x0, d.y0);
      return;
    }
    st.lastTap = { t: now, x: d.x0, y: d.y0 };
    st.tapTimer = setTimeout(function () {
      st.lastTap = null;
      if (d.node != null && st.hooks.tap) st.hooks.tap(d.node);
    }, d.type === 'mouse' ? STAGE_CLICK_MS : STAGE_TAP_MS);
  }
  function stageDouble(st, e) {
    if (st.lastType !== 'mouse' || !st.svg || !st.hooks.zooms() || (e.target.closest && e.target.closest('button, a'))) return;
    clearTimeout(st.tapTimer);
    st.lastTap = null;
    var p = stagePoint(st, e);
    stageZoomAt(st, p.x, p.y);
  }
  function stageZoomAt(st, x, y) {
    if (st.k >= stageMax(st) * 0.99) stageWhole(st, true);
    else stageZoom(st, 2, x, y, true);
  }
  // two fingers: the point of the picture under their middle stays under it as they spread or close
  // and move; past the whole view it gives a little, and comes back on release, or, from a focus,
  // goes back to the whole chart; the finger left down when the other lifts carries on as a drag
  function stagePinchPair(st) {
    var ids = Object.keys(st.pointers), a = st.pointers[ids[0]], b = st.pointers[ids[1]];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  function stagePinchStart(st) {
    clearTimeout(st.tapTimer);
    st.lastTap = null;
    st.drag = null;
    Object.keys(st.pointers).forEach(function (id) { stageCapture(st, Number(id)); });
    var q = stagePinchPair(st);
    st.pinch = { d: q.d, k: st.k, cx: (q.x - st.x) / st.k, cy: (q.y - st.y) / st.k };
  }
  function stagePinchMove(st) {
    var q = stagePinchPair(st), k = Math.max(st.fit * 0.6, Math.min(stageMax(st), st.pinch.k * q.d / st.pinch.d));
    st.k = k;
    st.x = q.x - st.pinch.cx * k;
    st.y = q.y - st.pinch.cy * k;
    st.whole = false;
    if (k >= st.fit) stageClamp(st, false);
    stageApply(st, false);
  }
  function stagePinchEnd(st) {
    var under = st.k < st.fit * 0.85;
    st.pinch = null;
    if (under && st.hooks.out && st.hooks.out()) return;
    if (st.k <= st.fit * 1.001) stageWhole(st, true);
    else { stageClamp(st, false); stageApply(st, true); }
    var ids = Object.keys(st.pointers);
    if (ids.length !== 1) return;
    var p = st.pointers[ids[0]];
    st.drag = { id: Number(ids[0]), type: 'touch', x0: p.x, y0: p.y, sx: st.x, sy: st.y, dx: 0, dy: 0, t: Date.now(), moved: true, node: null, control: false, pan: !st.whole, after: true };
  }
  // a finger on the stage's card joins a pinch on the stage, and one on the stage joins a finger on
  // the card, so two fingers that land either side of the stage's edge still pinch the chart; the
  // card's own buttons keep their fingers, and a finger alone on the card does nothing
  // A finger in the area but on no stage, the card's own words or edge, joins a pinch on the stage
  // shown there; one on a stage, this one or another in the same card (the list beside the chart),
  // is that stage's alone, and a stage hidden takes none
  function stageArea(st, area) {
    function outside(e) { return e.pointerType === 'touch' && st.host.getClientRects().length > 0 && !stageUnder(e.target); }
    area.addEventListener('pointerdown', function (e) {
      if (!outside(e) || !st.svg || (e.target.closest && e.target.closest('button, a, summary'))) return;
      st.pointers[e.pointerId] = stagePoint(st, e);
      if (Object.keys(st.pointers).length === 2 && st.hooks.zooms()) stagePinchStart(st);
    });
    area.addEventListener('pointermove', function (e) { if (outside(e)) stageMove(st, e); });
    area.addEventListener('pointerup', function (e) { if (outside(e)) stageUp(st, e, false); });
    area.addEventListener('pointercancel', function (e) { if (outside(e)) stageUp(st, e, true); });
  }
  // the trackpad's pinch comes as a wheel event with ctrlKey, the mouse's wheel as a plain one; where
  // the stage takes the plain wheel too (the Dependencies tab, where nothing scrolls) both zoom about
  // the pointer, and the page never scrolls instead; a turn outward from a focus drawn whole goes
  // back to the whole chart once it has gone far enough to be meant. A wheel that counts in lines
  // or pages, as Firefox's mouse does, is counted in pixels first
  function stageWheel(st, e) {
    if (!st.svg || !st.hooks.zooms() || !(e.ctrlKey || st.hooks.wheel())) return;
    e.preventDefault();
    var d = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? st.host.clientHeight : 1));
    var factor = Math.exp(-d * (e.ctrlKey ? 0.01 : 0.002));
    if (factor < 1 && st.whole && st.hooks.out) {
      st.outBy *= factor;
      if (st.outBy < 0.7) { st.outBy = 1; st.hooks.out(); }
      return;
    }
    st.outBy = 1;
    var p = stagePoint(st, e);
    stageZoom(st, factor, p.x, p.y, false);
  }
  // the keys, once the stage has the keyboard: + and - zoom about its middle and 0 draws it whole;
  // the arrows pan a picture zoomed in, and otherwise go the chart's own way (the next chart, or the
  // neighbour that way); Escape goes back from a focus. A key held with Ctrl, Alt or the Command key
  // is the browser's, its own zoom among them
  function stageKeys(st, e) {
    if (e.altKey || e.ctrlKey || e.metaKey || !st.svg) return;
    if (e.target !== st.host && /^(Enter| |Spacebar)$/.test(e.key)) return;
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!st.hooks.zooms()) {
      if (e.key !== 'Enter' || !st.hooks.tap) return;
      st.hooks.tap(null);
    } else if (e.key === '+' || e.key === '=') stageStep(st.host, 1.4);
    else if (e.key === '-' || e.key === '_') stageStep(st.host, 1 / 1.4);
    else if (e.key === '0') stageWhole(st, true);
    else if (e.key === 'Escape' && st.hooks.out && st.hooks.out()) { /* back to the whole chart */ }
    else if (arrows[e.key]) {
      var a = arrows[e.key];
      if (!st.whole) { st.x -= a[0] * 60; st.y -= a[1] * 60; st.whole = false; stageClamp(st, false); stageApply(st, true); }
      else if (!st.hooks.go || !st.hooks.go(a[0], a[1])) return;
    } else return;
    e.preventDefault();
  }
  // an element given the keyboard inside the stage, a list's button, brought into the box, the
  // picture moved by as little as shows it whole
  function stageReveal(st, node) {
    if (!st.svg || !st.svg.contains(node)) return;
    var b = st.host.getBoundingClientRect(), r = node.getBoundingClientRect(), f = st.host.offsetWidth ? b.width / st.host.offsetWidth : 1;
    var l = (r.left - b.left) / f, t = (r.top - b.top) / f, w = r.width / f, h = r.height / f, W = st.host.clientWidth, H = st.host.clientHeight;
    var dx = l < STAGE_PAD ? STAGE_PAD - l : (l + w > W - STAGE_PAD ? W - STAGE_PAD - l - w : 0);
    var dy = t < STAGE_PAD ? STAGE_PAD - t : (t + h > H - STAGE_PAD ? H - STAGE_PAD - t - h : 0);
    if (!dx && !dy) return;
    st.x += dx;
    st.y += dy;
    st.whole = false;
    stageClamp(st, false);
    stageApply(st, false);
  }

  /* ---------- a node in focus ---------- */
  // A node pressed opens in focus (the owner, 2026-10-19: "if I select a node it will be blown up and
  // only its immediate neighbors will be visible but I can swipe to navigate"): a small chart of its
  // own, drawn through the same chart text and restyle as the whole one, of the node, the issues one
  // edge away from it either way and the edges between them, top to bottom and left to right, the
  // stage showing the face drawn larger, fitted to the stage and drawn up to twice its size, and
  // never smaller than the whole chart drew it, with the node edged in the deck's teal; and beside or
  // under it a card with its state, its worker, a link to it on GitHub and Centre its row, the old
  // press's job, then its whole title and its arrows in words, each neighbour there a button. A press
  // on a neighbour, a swipe or an arrow key moves the focus to the neighbour that way as drawn;
  // Escape, Whole chart and a pinch outward go back to the whole chart. Each focus drawn is kept for
  // the chart, so moving back and forth draws nothing again.
  var GRAPH_EDGE = /^  i([1-9][0-9]{0,8}) (-->|-\.->|==>) i([1-9][0-9]{0,8})$/;
  function graphEdgesOf(text) {
    return String(text).split('\n').map(function (line) { return GRAPH_EDGE.exec(line); }).filter(Boolean)
      .map(function (m) { return { from: Number(m[1]), kind: m[2], to: Number(m[3]) }; });
  }
  function graphNeighbours(view, n) {
    var near = {};
    near[n] = true;
    view.edges.forEach(function (e) { if (e.from === n) near[e.to] = true; if (e.to === n) near[e.from] = true; });
    return near;
  }
  // the same chart drawn left to right: only its first line differs from the board's, and it is
  // handed to the drawing alone, never compared with the board or written anywhere
  function graphTurned(text) { return String(text).replace(/^flowchart TD\n/, 'flowchart LR\n'); }
  // a chart's text drawn in both faces, the top to bottom one first; where the first is drawn with no
  // size, as a stand-in for the drawing draws it, the second is not asked for
  function graphRenderFaces(m, text, turn) {
    var ids = [];
    function one(t) {
      var id = 'cp-graph-' + (++graphRenders);
      ids.push(id);
      return m.render(id, t).then(function (r) { return r.svg; });
    }
    return one(text).then(function (first) {
      if (!turn || !/viewBox="[-0-9.e]+ [-0-9.e]+ [0-9.e]*[1-9]/.test(first)) return [first];
      return one(graphTurned(text)).then(function (second) { return [first, second]; });
    }).catch(function (e) {
      // what a failed drawing may leave on the page: the library's own picture of the error, under an id of its own
      ids.forEach(function (id) { var left = document.getElementById('d' + id); if (left && left.parentNode) left.parentNode.removeChild(left); });
      throw e;
    });
  }
  // the drawn texts made elements, restyled to the console's look, each read as the picture it is
  function graphSvgs(texts, label, near) {
    return texts.map(function (text) {
      var wrap = el('div');
      wrap.innerHTML = text;
      var svg = wrap.querySelector('svg');
      if (!svg) return null;
      graphRestyle(wrap);
      if (near) svg.classList.add('graph__nearsvg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label(svg));
      return svg;
    }).filter(Boolean);
  }
  // the hooks every chart's stage shares: a press opens a focus, a step out of a focus closes it,
  // the Whole chart button says whether there is anything to go back from, and the whole chart's face
  // shown is the one a focus hides and a close shows again
  function graphStage(view, hooks) {
    hooks.tap = hooks.tap || function (n) { if (n != null && n !== view.focus) graphNearOpen(view, n); };
    hooks.out = function () { if (view.focus == null) return false; graphNearClose(view); return true; };
    hooks.moved = function (st) { if (view.fit) view.fit.classList.toggle('graph__fit--idle', view.focus == null && st.whole); };
    hooks.face = function (svg) { if (!svg.classList.contains('graph__nearsvg')) view.whole = svg; };
    view.stage = stageMake(view.host, hooks);
  }
  // the corner of a card's stage its tools float over, in the stage's own pixels with a little room,
  // where they float over it, as on a short tab (control.css); else none
  function graphCorner(view, host) {
    var tools = view.section.querySelector('.graph__tools');
    if (!tools || getComputedStyle(tools).position !== 'absolute') return null;
    var t = tools.getBoundingClientRect(), h = host.getBoundingClientRect(), f = host.offsetWidth ? h.width / host.offsetWidth : 1;
    if (t.right <= h.left || t.bottom <= h.top || t.left >= h.right || t.top >= h.bottom) return null;
    return { w: (t.right - h.left) / f - host.clientLeft + 4, h: (t.bottom - h.top) / f - host.clientTop + 4 };
  }
  function graphNearOpen(view, n) {
    if (!view.whole) return;
    view.want = n;
    view.nearSvg = view.nearSvg || {};
    var near = graphNeighbours(view, n);
    var drawn = view.nearSvg[n] ? Promise.resolve(view.nearSvg[n]) : loadMermaid().then(function (m) {
      return graphRenderFaces(m, view.nearText(near), true);
    }).then(function (texts) { view.nearSvg[n] = texts; return texts; });
    return drawn.then(function (texts) {
      if (view.want !== n || !view.host.isConnected) return;
      graphNearShow(view, n, texts, near);
    }, function (e) {
      if (view.want !== n) return;
      view.want = null;
      say('#' + n + ' could not be drawn in focus (' + e.message + ').', true);
    });
  }
  // A focus blows its node up (the owner, 2026-10-19: "if I select a node it will be blown up"): it is
  // drawn at least this much larger than the whole chart drew it, about its node, even where its
  // neighbours then run past the stage's edges, as a hub's many do; a swipe or an arrow key goes to them
  var GRAPH_NEAR_GROW = 1.25;
  function graphNearShow(view, n, texts, near) {
    var st = view.stage;
    // the size the whole chart was drawn at, which the focus is drawn larger than; kept from the
    // whole chart as the focus moves from neighbour to neighbour
    if (view.focus == null) view.wholeFit = st ? st.fit : 0;
    Array.prototype.forEach.call(view.host.querySelectorAll(':scope > svg.graph__nearsvg'), function (old) { old.parentNode.removeChild(old); });
    var svgs = graphSvgs(texts, function () { return '#' + n + ' with ' + plural(Object.keys(near).length - 1, 'neighbour'); }, true);
    if (!svgs.length) return;
    svgs.forEach(function (svg) {
      Array.prototype.forEach.call(svg.querySelectorAll('g.node'), function (g) { if (stageNodeAt(g) === n) g.classList.add('graph__focal'); });
    });
    view.whole.style.display = 'none';
    view.focus = n;
    view.host.classList.add('control__chart--near');
    // on a phone the tiles and the card's heading give their room to the focus, so the node comes up
    // larger than the whole chart drew it, as the request asks (control.css, graph--near)
    if (view.section) $('tab-dependencies').classList.add('graph--near');
    if (st) st.hooks.near = true;
    graphNearCard(view, n);
    stageShow(view.host, svgs, STAGE_NEAR_MAX, { floor: view.wholeFit * GRAPH_NEAR_GROW, focal: graphFocal });
  }
  // the focus's node in its picture's own units, which a focus drawn at its floor is centred on
  function graphFocal(svg, w, h) {
    var g = svg.querySelector('g.node.graph__focal'), s = svg.getBoundingClientRect();
    if (!g || !s.width || !s.height) return null;
    var r = g.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - s.left) / s.width * w, y: (r.top + r.height / 2 - s.top) / s.height * h };
  }
  function graphNearClose(view) {
    view.want = null;
    if (view.focus == null) return;
    Array.prototype.forEach.call(view.host.querySelectorAll(':scope > svg.graph__nearsvg'), function (svg) { svg.parentNode.removeChild(svg); });
    view.focus = null;
    view.host.classList.remove('control__chart--near');
    if (view.section) $('tab-dependencies').classList.remove('graph--near');
    if (view.stage) view.stage.hooks.near = false;
    view.near.hidden = true;
    view.near.style.marginTop = '';
    clear(view.near);
    view.whole.style.display = '';
    stageShow(view.host, view.faces || [view.whole], 1);
  }
  // the words of the edges at a node, as the key names the arrows, each neighbour named there a
  // button that moves the focus to it, so every neighbour is a key's reach away, not only the one
  // nearest each arrow's way
  function graphNearWords(view, n) {
    var p = el('p', 'graph__nearrel'), parts = [];
    var into = view.edges.filter(function (e) { return e.to === n; }), out = view.edges.filter(function (e) { return e.from === n; });
    function part(words, edges, end, after) { if (edges.length) parts.push({ words: words, ns: edges.map(function (e) { return e[end]; }), after: after || '' }); }
    part('blocked by ', into.filter(function (e) { return e.kind === '-->'; }), 'from');
    part('blocked by ', into.filter(function (e) { return e.kind === '-.->'; }), 'from', ', now closed');
    part('blocks ', out.filter(function (e) { return e.kind !== '==>'; }), 'to');
    part('an epic of ', into.filter(function (e) { return e.kind === '==>'; }), 'from');
    part('its epics are ', out.filter(function (e) { return e.kind === '==>'; }), 'to');
    if (!parts.length) { p.textContent = 'No arrow joins it to another issue in this chart.'; return p; }
    parts.forEach(function (q, i) {
      add(p, (i ? '; ' : '') + (i ? q.words : q.words.charAt(0).toUpperCase() + q.words.slice(1)));
      q.ns.forEach(function (m, j) {
        var b = el('button', 'graph__nearto', '#' + m);
        b.type = 'button';
        b.setAttribute('aria-label', 'Show #' + m + ' in focus');
        b.addEventListener('click', function () { graphNearOpen(view, m); });
        add(p, j ? ', ' : '', b);
      });
      add(p, q.after);
    });
    add(p, '.');
    return p;
  }
  // the focus's card: its number, state and worker, then its link and Centre its row, which stand
  // above its title so they stay in sight however long the title is, then its whole title and its
  // arrows in words
  function graphNearCard(view, n) {
    var it = view.record(n), card = view.near;
    clear(card);
    var head = el('p', 'graph__nearhead');
    add(head, el('b', 'graph__nearnum', '#' + n), el('span', 'graph__pill graph__pill--' + (it.state || 'plain'), GRAPH_STATES[it.state] || 'open'));
    if (it.worker) add(head, el('span', 'graph__nearwho', 'worker ' + it.worker));
    var acts = el('div', 'graph__nearacts');
    add(acts, link(it.url, 'Open #' + n + ' on GitHub'), btn('Centre its row', true, function () { graphFocus(n); }));
    add(card, head, acts, el('p', 'graph__neartitle', it.title || 'This issue\'s title is not known here.'), graphNearWords(view, n));
    card.hidden = false;
    graphNearRoom(view);
    graphNearFit(view);
  }
  // Where the card's tools float over the stage's corner (a short tab), they run on past a stage a
  // focus has narrowed, over the card beside it, so the card starts under them
  function graphNearRoom(view) {
    var card = view.near, tools = view.section && view.section.querySelector('.graph__tools');
    if (!card || !tools) return;
    card.style.marginTop = '';
    if (card.hidden || getComputedStyle(tools).position !== 'absolute') return;
    var t = tools.getBoundingClientRect(), c = card.getBoundingClientRect(), f = card.offsetWidth ? c.width / card.offsetWidth : 1;
    if (!c.width || t.right <= c.left || t.left >= c.right || t.bottom <= c.top || t.top >= c.bottom) return;
    card.style.marginTop = Math.ceil((t.bottom - c.top) / f + 6) + 'px';
  }
  // The card's title is shown whole where the card has the room, and where it has not, as for a
  // very long title at a large text size, it alone gives way: its words smaller, then the arrows'
  // words, which the picture draws too, kept for a reader and the keyboard but out of sight, then its
  // words smaller still, and only then cut at the lines the card holds, the whole title kept in its
  // tooltip and for a reader; the state, the link and Centre its row never give way
  var GRAPH_NEAR_FLOOR = 0.62;
  function graphNearFit(view) {
    var card = view.near, title = card && card.querySelector('.graph__neartitle'), rel = card && card.querySelector('.graph__nearrel');
    if (!title || card.hidden || !card.clientHeight) return;
    title.style.fontSize = '';
    title.style.webkitLineClamp = '';
    title.classList.remove('graph__neartitle--cut');
    title.removeAttribute('title');
    if (rel) rel.classList.remove('graph__nearrel--away');
    function over() { return card.scrollHeight > card.clientHeight + 1; }
    var size = parseFloat(getComputedStyle(title).fontSize), floor = size * GRAPH_NEAR_FLOOR;
    function shrink(to) { while (over() && size > to + 0.01) { size = Math.max(to, size * 0.92); title.style.fontSize = size + 'px'; } }
    shrink(size * 0.8);
    if (over() && rel) rel.classList.add('graph__nearrel--away');
    shrink(floor);
    if (!over()) return;
    title.classList.add('graph__neartitle--cut');
    title.title = title.textContent;
    var line = parseFloat(getComputedStyle(title).lineHeight) || size * 1.35;
    title.style.webkitLineClamp = String(Math.max(1, Math.floor((title.clientHeight - (card.scrollHeight - card.clientHeight)) / line)));
  }
  // the neighbour the way asked, as drawn: of those within a wide angle of it, the one closest in
  // angle to the way, and of two alike, the nearer
  function graphNearStep(view, dx, dy) {
    var svg = view.host.querySelector('svg.graph__nearsvg');
    if (view.focus == null || !svg) return false;
    var at = {};
    Array.prototype.forEach.call(svg.querySelectorAll('g.node'), function (g) {
      var n = stageNodeAt(g), r = g.getBoundingClientRect();
      if (n != null) at[n] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    var from = at[view.focus], len = Math.hypot(dx, dy) || 1, best = null;
    if (!from) return false;
    Object.keys(at).forEach(function (k) {
      var n = Number(k);
      if (n === view.focus) return;
      var vx = at[k].x - from.x, vy = at[k].y - from.y, d = Math.hypot(vx, vy) || 1;
      var cos = (vx * dx + vy * dy) / (d * len);
      if (cos < 0.3) return;
      if (!best || cos > best.cos + 0.05 || (Math.abs(cos - best.cos) <= 0.05 && d < best.d)) best = { n: n, cos: cos, d: d };
    });
    if (!best) return false;
    graphNearOpen(view, best.n);
    return true;
  }
  // a swipe or an arrow key on a chart: from a focus, to the neighbour that way; on a whole chart,
  // sideways to the chart beside it, as Previous and Next step
  function graphGo(c, dx, dy) {
    if (c.focus != null) return graphNearStep(c, dx, dy);
    return graphStepChart(c, dx, dy);
  }
  function graphStepChart(c, dx, dy) {
    var to = dx > 0 ? c.next : (dx < 0 ? c.prev : null);
    if (!to || Math.abs(dx) < Math.abs(dy)) return false;
    graphSelect(to.key, c.draw.repo);
    var shown = to.view === 'list' ? to.list : to.host;
    if (shown) shown.focus({ preventScroll: true });
    return true;
  }
  // the zoom's buttons, at the top of a card and over the Board tab's charts: out, in, and Whole
  // chart, which draws the chart whole again, from a zoom or from a focus; a card's list zooms by the
  // same buttons while it is shown
  function graphZoomTools(view) {
    var g = el('div', 'graph__zoom');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', 'Zoom the chart');
    function shown() { return view.view === 'list' && view.list ? view.list : view.host; }
    var out = el('button', 'graph__zbtn', '\u2212');
    out.type = 'button';
    out.setAttribute('aria-label', 'Zoom out');
    out.addEventListener('click', function () { stageStep(shown(), 1 / 1.4); });
    var inn = el('button', 'graph__zbtn', '+');
    inn.type = 'button';
    inn.setAttribute('aria-label', 'Zoom in');
    inn.addEventListener('click', function () { stageStep(shown(), 1.4); });
    var whole = el('button', 'graph__fit graph__fit--idle', 'Whole chart');
    whole.type = 'button';
    whole.title = 'Draw the whole chart again, fitted to its card';
    whole.addEventListener('click', function () {
      if (view.view === 'list') { var ls = stageOf(view.list); if (ls) stageWhole(ls, true); }
      else if (view.focus != null) graphNearClose(view);
      else { var st = stageOf(view.host); if (st) stageWhole(st, true); }
    });
    view.fit = whole;
    return add(g, out, inn, whole);
  }
  // The board's classes paint a node light (a white, yellow, blue, red or grey fill and black words),
  // which Mermaid writes onto each node's own elements, where no stylesheet reaches; those colours are
  // taken off the drawn nodes, and nothing else, so the console's stylesheet shades each node by the
  // class it keeps (control.css), dark with its state's colour at the edge, and the chart's text stays
  // the board's byte for byte. The node's box gets rounded corners, as the neo look draws them where
  // it draws its own shapes.
  function graphRestyle(host) {
    Array.prototype.forEach.call(host.querySelectorAll('g.node'), function (node) {
      [node].concat(Array.prototype.slice.call(node.querySelectorAll('[style]'))).forEach(function (part) {
        ['fill', 'stroke', 'color'].forEach(function (k) { part.style.removeProperty(k); });
      });
      Array.prototype.forEach.call(node.querySelectorAll(':scope > rect.label-container'), function (box) {
        box.setAttribute('rx', '10');
        box.setAttribute('ry', '10');
      });
    });
  }
  // a node pressed, or Centre its row: the task's row is centred and marked in the Tasks tab, which
  // opens, as the assistant's focus opens it, where the task tables hold the task, and nothing else
  // happens; no window or page opens. The words go to the note over the screen's foot too, on every
  // press, whichever tab it leaves shown, so the note never keeps an earlier press's focus.
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
  // gives up the chart's class, whose dotted ground and frame are for a drawing, so its words and
  // its text read on the Board tab's own ground, as any other block of code on the board does
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
  // text; Mermaid is loaded only where a block is a chart the board writes. Each is a stage as the
  // Dependencies tab's charts are, fitted, zoomed and focused the same way, with its zoom's buttons
  // above it and the card its focus fills under it
  function boardCharts(s, box) {
    var views = Array.prototype.slice.call(box.querySelectorAll('.control__chart[data-chart]')).filter(function (host) {
      if (boardChartLines(host.getAttribute('data-chart'))) return true;
      boardNotChart(host);
      return false;
    }).map(function (host) { return boardView(s, host); });
    if (!views.length) return;
    // a chart that could not be drawn keeps its text under the words, as the Dependencies tab keeps
    // its list, so the board still says what it holds
    function undrawn(view, e) {
      var host = view.host, text = host.getAttribute('data-chart');
      [view.tools, view.near].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      host.removeAttribute('class');
      host.removeAttribute('tabindex');
      host.style.height = '';
      clear(host);
      add(host, el('p', 'admin__lead', 'This chart could not be drawn (' + e.message + '); it is shown here as text.'));
      add(host, el('pre', 'admin__text', text));
    }
    loadMermaid().then(function (m) {
      return views.reduce(function (p, view) {
        return p.then(function () {
          if (stale(s)) return;
          return graphDraw(m, view).then(function () { boardChartHeight(view); }, function (e) { undrawn(view, e); });
        });
      }, Promise.resolve());
    }).catch(function (e) { if (!stale(s)) views.forEach(function (view) { undrawn(view, e); }); });
  }
  // A board chart's stage. The board is a document that scrolls, so its chart keeps to its natural
  // height, or to two thirds of the board's box where it is taller, and the mouse's wheel and a
  // finger's move up and down over a whole chart scroll the board as they do anywhere else on it; a
  // trackpad's pinch, a pinch with two fingers, a double tap and the buttons zoom it, and once it is
  // zoomed in or in focus, it holds the finger, as the Dependencies tab's charts always do.
  function boardView(s, host) {
    var text = host.getAttribute('data-chart');
    var view = { host: host, text: text, edges: graphEdgesOf(text), focus: null };
    view.nearText = function (near) { return boardNearText(text, near); };
    view.record = function (n) { return boardRecord(s, text, n); };
    view.tools = add(el('div', 'graph__tools graph__tools--board'), graphZoomTools(view));
    view.near = el('div', 'graph__near graph__near--board');
    view.near.hidden = true;
    view.near.setAttribute('aria-live', 'polite');
    host.parentNode.insertBefore(view.tools, host);
    host.parentNode.insertBefore(view.near, host.nextSibling);
    host.style.touchAction = 'pan-y';
    graphStage(view, {
      zooms: function () { return true; },
      wheel: function () { return false; },
      go: function (dx, dy) { return graphNearStep(view, dx, dy); }
    });
    var moved = view.stage.hooks.moved;
    view.stage.hooks.moved = function (st) { moved(st); host.style.touchAction = st.whole && view.focus == null ? 'pan-y' : 'none'; };
    return view;
  }
  function boardChartHeight(view) {
    var st = stageOf(view.host), box = view.host.closest('.console__scroll');
    if (!st || !st.svg) return;
    var room = box && !pageScrolls() ? box.clientHeight : window.innerHeight;
    view.host.style.height = Math.round(Math.min(st.h + 2 * STAGE_PAD, Math.max(240, room * 2 / 3))) + 'px';
  }
  // the board's own lines for a node, its neighbours and the edges between them, in the board's order
  function boardNearText(text, near) {
    return String(text).split('\n').filter(function (line, i) {
      var node = /^  i([1-9][0-9]{0,8})\[/.exec(line), edge = GRAPH_EDGE.exec(line);
      if (node) return !!near[Number(node[1])];
      if (edge) return !!(near[Number(edge[1])] && near[Number(edge[3])]);
      return true;
    }).join('\n');
  }
  // what the page knows of an issue a board chart draws: the open issues it read, then what the
  // Dependencies tab's reads brought, and else the board's own label, cut as the board cuts it, and
  // its class; the title is said to be the board's where that is all there is
  function boardRecord(s, text, n) {
    var raw = (s.issues || []).filter(function (it) { return Number(it.number) === n && !it.pull_request; })[0];
    var draw = s.graphLast, it = raw ? graphIssue(raw) : (draw && (draw.listed[n] || draw.others[n])) || null;
    var line = String(text).split('\n').filter(function (l) { return l.indexOf('  i' + n + '["') === 0; })[0] || '';
    var m = /^  i[0-9]+\["#[0-9]+ ?(.*)"\](?::::([a-z]+))?$/.exec(line);
    var label = m ? m[1].replace(/ \([0-9]+\/[0-9]+\)$/, '') : '';
    [['#quot;', '"'], ['#124;', '|'], ['#lt;', '<'], ['#gt;', '>'], ['#36;', '$'], ['#37;', '%'], ['#35;', '#']].forEach(function (pair) { label = label.split(pair[0]).join(pair[1]); });
    return {
      title: it && it.title ? it.title : (label ? label + ' (as the board writes it)' : ''),
      state: m && m[2] ? m[2] : (it ? graphClass(it, {}) : ''),
      worker: it ? workerOf(it.labels) : '',
      url: it && it.html_url ? it.html_url : 'https://github.com/' + s.repo + '/issues/' + n
    };
  }
  function initGraph() {
    var strip = $('cp-graph-focus'), tab = $('tab-dependencies'), keyBtn = $('cp-graph-keybtn');
    strip.addEventListener('keydown', graphStripKeys);
    graphSwipes(strip, graphStripTurn);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(graphLayout).observe(tab);
      new ResizeObserver(graphAllLayout).observe($('cp-graph'));
    }
    // a phone turned brings the tab back where it is held, the window's old place no longer its
    window.addEventListener('resize', function () { graphPhoneFit(!tab.hidden); });
    keyBtn.addEventListener('click', function () { graphKeyOpen(keyBtn.getAttribute('aria-expanded') !== 'true'); });
    graphHelpInit();
    // a phone cuts the line of what was drawn to a line or two (control.css); a press shows it whole
    // and another cuts it again, and a reader hears it whole either way
    $('cp-graph-state').addEventListener('click', function () { this.toggleAttribute('data-open'); });
    // the key opened over the stage closes on Escape, on a press anywhere else, and with the next chart
    document.addEventListener('pointerdown', function (e) {
      if (keyBtn.getAttribute('aria-expanded') === 'true' && !(e.target.closest && e.target.closest('#cp-graph-key, #cp-graph-keybtn'))) graphKeyOpen(false);
    });
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (keyBtn.getAttribute('aria-expanded') === 'true') { graphKeyOpen(false); keyBtn.focus(); e.preventDefault(); return; }
      // the help, which covers the tab when open, closes first, the keys back on its ?
      var help = tab.querySelector('.console__help');
      if (help && help.open) { help.open = false; help.querySelector('summary').focus(); e.preventDefault(); return; }
      // a focus closed from its card's buttons too, not only from its stage
      var open = graphShown.filter(function (c) { return c.focus != null && !c.section.hidden; })[0];
      if (open) { graphNearClose(open); open.host.focus({ preventScroll: true }); e.preventDefault(); }
    });
    // and from wherever else the keyboard is while it is open, as on the page itself after a press
    // inside it, which gives no element the keyboard
    document.addEventListener('keydown', function (e) {
      var help = tab.querySelector('.console__help');
      if (e.key !== 'Escape' || e.defaultPrevented || tab.hidden || !help || !help.open) return;
      help.open = false;
      help.querySelector('summary').focus();
      e.preventDefault();
    });
    // a phone brings the tab into view when it is opened, or, opened before its charts were drawn,
    // when they first are
    consoleOnOpen.dependencies = function () {
      graphLayout();
      if (graphShown.length) graphPhoneFit(true); else graphBring = true;
    };
    if (!tab.hidden) graphBring = true;
  }
  var graphBring = false;

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

  // the repository whose last read of the tokens failed, so a press waiting on it settles at once
  var tokenReadFailed = '';
  function loadTokens() {
    var asked = ++reading;
    var repo = tokensRepo();
    tokensFor = repo;
    tokenReadFailed = '';
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
    if (place && !place.org) return ' Writing a slot on a personal account\'s repository needs the SymphonyBoard App\'s repository permissions Secrets and Variables: read and write, accepted on its installation at https://github.com/settings/installations (Configure beside SymphonyBoard, then accept the new permissions); until Variables is accepted the repository takes one token, its main one. A fine-grained token needs the same two repository permissions.';
    var owner = place ? place.owner : '';
    return ' Writing a slot needs an owner of ' + (owner || 'the organization') + ', and the SymphonyBoard App\'s organization permissions Secrets and Variables: read and write, accepted on its installation' + (owner ? ' at https://github.com/organizations/' + owner + '/settings/installations' : '') + '. Someone who is not an owner adds their own token with Add Token, which puts it into the pool for them; the owners are listed at ' + (owner ? 'https://github.com/orgs/' + owner + '/people?query=role%3Aowner' : 'the organization\'s People page') + '.';
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
    if (tk.repo !== repo) { yourLent = null; lendTo = null; lendToFor = ''; lendToError = ''; lendToBusy = ''; tk = { repo: repo, place: null, secrets: null, settings: {}, labels: {}, pool: null, admin: false, side: '' }; drawTiles(); }
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
    }).catch(function (e) { if (asked === reading) { tokenReadFailed = repo; say('The tokens could not be read: ' + e.message, true); } });
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
    lent: '<!-- symphony-token: lent -->',
    failed: '<!-- symphony-token: failed -->'
  };
  var RUN_BOT = 'github-actions[bot]';
  var RUN_POLL_MS = 3000;
  var RUN_FOR_MS = 15 * 60 * 1000;
  // what claude.ai shows after the sign-in, as tools/token_run.py's CODE_SHAPE takes it
  var SIGN_IN_CODE = /^[A-Za-z0-9_.~#-]{8,512}$/;
  var ACTIONS_NEEDED = ' Starting the workflow needs the SymphonyBoard App\'s repository permission Actions: read and write, and opening the issue Issues: read and write; an administrator accepts them on the App\'s installation, at https://github.com/settings/installations for a personal account or the organization\'s own installations page, Configure beside SymphonyBoard.';
  var ADOPT_BRANCH = 'symphony/adopt';
  // the template's sync offers an adopted repository its board files, the workflow Token among them,
  // from this branch (symphony-template's tools/sync_adopted.py)
  var SYNC_BRANCH = 'symphony/sync';
  var STOPPED = 'Stopped; nothing was saved. Press Add Token to start again.';
  // the sign-in under way, one at a time since each opens an issue and starts a run: its task in
  // the note, shown again when Add Token is pressed after Clear hid it, and how to stop it
  var tokenRun = null;
  // the slot whose settings Save and sign in is saving before its sign-in starts, with the sign-out
  // count of the press, so a save that never answers after a sign-out holds nothing
  var tokenAdding = null;

  // the sign-in in the note (msgTask): a line that says where the run is, the run's steps
  // under it, and the step it needs from the person, the claude.ai link and the code's box; the
  // dialog that asked for it has closed already, with its task handed on
  function signInView(title, given) {
    var task = given || msgTask(title);
    if (given) task.retitle(title);
    var stop = task.button('Stop this sign-in', function () { if (tokenRun && tokenRun.view.stop === stop) tokenRun.stop(); });
    stop.id = 'tk-stop';
    return {
      task: task,
      tell: task.tell,
      step: task.step,
      stop: stop,
      // shown again, with a note above it when Add Token or Renew asked for something else meanwhile
      show: function (why) { task.show(); if (why) say(why, true); }
    };
  }
  // the hint for a repository without the workflow Token: one not adopted yet, or whose adoption pull
  // request is still open, as a repository named before its merge is
  function noTokenWorkflow(repo, view) {
    var hint = ' ' + repo + ' has no workflow Token yet (.github/workflows/token.yml), which comes with Symphony\'s adoption' + (tk.place && tk.place.org ? ', and no other repository of ' + tk.place.owner + ' that you may push to and that carries the topic symphony has it.' : '.');
    var reach = gh('GET', '/repos/' + repo).then(function () { return true; }, function (e) { return e.status !== 404; });
    return reach.then(function (reached) {
      if (!reached) return ' The sign-in does not reach ' + repo + ': SymphonyBoard is not installed on it; install it at https://github.com/apps/' + APP_SLUG + '/installations/new, then press Add Token again.';
      return adoptionHint(repo, view, hint);
    });
  }
  function openPull(repo, branch) {
    return gh('GET', '/repos/' + repo + '/pulls?state=open&per_page=1&head=' + encodeURIComponent(repo.split('/')[0] + ':' + branch)).then(function (r) {
      var pr = (r.data || [])[0];
      if (!pr || !/^https:\/\/github\.com\//.test(pr.html_url || '')) throw new Error('none open');
      return pr;
    });
  }
  // a repository adopted before it was offered the workflow Token gets it by the sync's pull request
  function adoptionHint(repo, view, hint) {
    return openPull(repo, ADOPT_BRANCH).then(function (pr) {
      add(view.step, add(el('p', 'admin__bar'), link(pr.html_url, 'Open the adoption pull request #' + pr.number)));
      return hint + ' Merge its adoption pull request first, then press Add Token again.';
    }).catch(function () {
      return openPull(repo, SYNC_BRANCH).then(function (pr) {
        add(view.step, add(el('p', 'admin__bar'), link(pr.html_url, 'Open the pull request #' + pr.number)));
        return hint + ' Merge its pull request "Bring Symphony\'s board files up to date" first, then press Add Token again.';
      });
    }).catch(function () {
      return hint + ' Merge its adoption pull request first, or adopt it if it never was, at ' + FORM_URL + ', then press Add Token again.';
    });
  }

  // a repository of the organization that carries the workflow Token, for one that has none, as a
  // repository adopted for the protocol alone has not: the run goes there and lends the token to the
  // repository shown, through the workflow's input lend_to (tools/token_run.py, lend_target). An adopted
  // repository carries the topic symphony, so those are tried, newest push first, among the ones the
  // person may push to, since the dispatch needs that; found once per organization and person
  var tokenHomes = {};
  function tokenHome(place, repo) {
    if (!place.org) return Promise.resolve('');
    var key = place.owner + '/' + shownLogin;
    if (tokenHomes[key]) return Promise.resolve(tokenHomes[key]);
    // a listing or a probe GitHub refuses finds nothing, so the repository's own word stands
    return gh('GET', '/orgs/' + place.owner + '/repos?per_page=100&sort=pushed&type=all').then(function (r) {
      var names = (r.data || []).filter(function (x) {
        return x && x.full_name && x.full_name !== repo && !x.archived && (x.topics || []).indexOf('symphony') >= 0 && x.permissions && x.permissions.push;
      }).map(function (x) { return x.full_name; });
      function probe(i) {
        if (i >= names.length) return '';
        return gh('GET', '/repos/' + names[i] + '/actions/workflows/' + TOKEN_WORKFLOW).then(function (w) {
          if (w.data && w.data.state === 'active') { tokenHomes[key] = names[i]; return names[i]; }
          return probe(i + 1);
        }, function () { return probe(i + 1); });
      }
      return probe(0);
    }, function () { return ''; });
  }

  // given: the task the token's dialog opened for the settings it saved first, carried on here
  function addByActions(repo, place, button, wanted, given) {
    // a sign-in begun before the page signed out waits on calls that never answer, so it is let go
    if (tokenRun && tokenRun.era !== ends) tokenRun = null;
    if (tokenRun) {
      var busy = tokenRun.repo !== repo || (wanted && wanted !== tokenRun.wanted) ? 'Another sign-in is under way; finish it or stop it first.' : '';
      if (given) given.end(busy || 'This sign-in is under way already; its task is the one above.', !!busy);
      tokenRun.view.show(given ? '' : busy);
      return;
    }
    var issue = 0, slot = '', ids = place.org ? [place.id] : [], key = null, mainMissing = false, step = 'secrets', stopped = false, after = 0;
    // where the workflow runs: this repository, or another of the organization's when this one has none
    var home = repo;
    var renewing = wanted && tk.secrets && tk.secrets[slotSecret(wanted)];
    var pooled = intoPool(place);
    var view = signInView((renewing ? 'Renew ' + tileName(wanted) : pooled ? 'Add your token to ' + place.owner + '\'s pool' : 'Add a token') + ' on ' + repo, given);
    // a stop frees Add Token at once, whatever call is on its way; the chain ends quietly when it answers
    var run = tokenRun = { view: view, repo: repo, wanted: wanted || '', era: ends, stop: function () {
      stopped = true;
      if (issue) closeRunIssue(home, issue, true);
      over();
      clear(view.step);
      view.task.end(STOPPED, true);
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
      if (pooled && wanted) throw new Error('Renewing a token in ' + place.owner + '\'s pool is for an owner of ' + place.owner + '; add a new one with Add Token, and ask an owner to remove the old one (the owners are listed at https://github.com/orgs/' + place.owner + '/people?query=role%3Aowner).');
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
    }).then(null, function (e) {
      // a repository without the workflow: one of the organization's that has it runs the sign-in
      if (step !== 'workflow' || e.status !== 404 || !place.org || stopped) throw e;
      return tokenHome(place, repo).then(function (found) {
        if (!found) throw e;
        home = found;
        view.tell('Starting the sign-in on GitHub Actions in ' + home + ', since ' + repo + ' has no workflow Token; the token is lent to ' + repo + '.');
        return { data: { state: 'active' } };
      });
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
      return gh('POST', '/repos/' + home + '/issues', { title: pooled ? 'Add a Claude account to ' + place.owner + '\'s pool' : 'Add a Claude account as ' + (slot === 'main' ? 'main' : 'slot ' + slot),
        body: 'The control panel\'s Tokens page opened this issue for one sign-in through the workflow Token (.github/workflows/token.yml)' + (home === repo ? '' : ', for ' + repo + ', which has no workflow Token of its own') + '. The run posts the sign-in link here and the token only as a sealed box GitHub alone can open; the page closes the issue when the slot is saved.' });
    }).then(function (r) {
      issue = r.data.number;
      step = 'dispatch';
      return Promise.all([gh('GET', '/repos/' + home), newestRunId(home, TOKEN_WORKFLOW)]);
    }).then(unlessStopped).then(function (both) {
      after = both[1];
      var inputs = pooled ? { issue: String(issue), store: 'pool' } : { issue: String(issue), key: key.key, key_id: key.key_id };
      if (pooled && home !== repo) inputs.lend_to = String(place.id);
      return gh('POST', '/repos/' + home + '/actions/workflows/' + TOKEN_WORKFLOW + '/dispatches', { ref: both[0].data.default_branch || 'main', inputs: inputs });
    }).then(function () {
      step = 'run';
      view.tell('The sign-in is starting on GitHub Actions' + (home === repo ? '' : ' in ' + home) + '; its link appears here in about a minute.');
      // the run's steps, and its log once it has ended, show under the words meanwhile; the issue's
      // comments, below, are what the sign-in goes by
      function over() { return stopped || !view.task.live; }
      // a run not found, or not read, leaves only the steps out: the sign-in goes by the comments
      findRun(home, TOKEN_WORKFLOW, after, over).then(function (found) { if (found && typeof found.id === 'number') return followRunSteps(home, found, view.task, over); }).catch(function () { /* the words stand */ });
      return followRun(home, issue, pooled ? null : key.key_id, view, function () { return stopped; });
    }).then(unlessStopped).then(function (sealed) {
      // the sign-in is done, so the person's step (the link and the code box) and Stop go, whichever
      // way the token lands: a stop now would only cut the saving short
      view.stop.hidden = true;
      clear(view.step);
      if (pooled) return { pooled: sealed.stored || sealed.lent, already: !!sealed.lent };
      step = 'secrets';
      view.tell('Saving the token...');
      return storeSealed(place, repo, slot, sealed, key.key_id, ids, '').then(function () {
        if (mainMissing) return putSecret(place, place.base + '/secrets/' + MAIN_SECRET, sealed, key.key_id, ids).then(function () { return true; });
        return false;
      });
    }).then(function (alsoMain) {
      closeRunIssue(home, issue);
      over();
      if (alsoMain && alsoMain.pooled) {
        view.task.end(alsoMain.already
          ? 'You have a token already (slot ' + alsoMain.pooled + ' of ' + place.owner + '\'s pool), so it is now lent to ' + repo + ' too; no new sign-in was needed. Your token, on the Tokens tab, shows every repository it is lent to.'
          : 'Your token is saved in slot ' + alsoMain.pooled + ' of ' + place.owner + '\'s pool, marked as yours, and lent to ' + repo + '. Press Add Token in another repository to lend it there too.');
        readTokenPlace(repo, reading);
        return;
      }
      view.task.end(tileName(slot) + ' is saved' + (alsoMain ? ', and as main too, which @claude and the workers read and which was not set yet' : '') + '. Its use shows on its tile after its first run, or press its tile and Read use now.');
      readTokenPlace(repo, reading);
    }).catch(function (e) {
      // a stop has closed the issue and said so already
      if (e.stopped || stopped) return;
      if (issue) closeRunIssue(home, issue, true);
      // the repository found for the workflow is looked for again next time, since it may have lost it
      if (home !== repo) delete tokenHomes[place.owner + '/' + shownLogin];
      over();
      clear(view.step);
      // the pool's secrets refused someone the page could not tell was an owner: they are not one,
      // so the same press goes on into the pool through the Token run (intoPool), with no error
      // only before the sign-in's issue is opened: once the person has signed in, a second sign-in
      // would put a second copy of their token in the pool
      if (step === 'secrets' && !issue && !pooled && !wanted && place.org && tk.place === place && tk.admin !== true && place.push !== false && (e.status === 403 || e.status === 404)) {
        tk.admin = false;
        drawTiles();
        if (view.stop.parentNode) view.stop.parentNode.removeChild(view.stop);
        say('GitHub lets only an owner of ' + place.owner + ' read its slots, so your token goes into its pool through the Token run instead, marked as yours.');
        addByActions(repo, place, button, '', view.task);
        return;
      }
      if (e.page) add(view.step, add(el('p', 'admin__bar'), link(e.page, 'Open the workflow Token')));
      var hint = Promise.resolve('');
      var said = e.message;
      if ((step === 'workflow' || step === 'dispatch') && e.status === 404) {
        // the repository answered, so the 404 is the missing file, never a missing install
        hint = noTokenWorkflow(repo, view).then(function (text) { said = ''; return text.replace(/^ /, ''); });
      }
      else if ((step === 'workflow' || step === 'dispatch' || step === 'issue') && e.status === 403) hint = Promise.resolve(ACTIONS_NEEDED);
      else if (step === 'secrets' && (e.status === 403 || e.status === 404)) hint = Promise.resolve(secretsNeeded(place));
      hint.then(function (text) { view.task.end(said + text, true); });
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
            // a person's own token, lent here, or where it is lent after a list, revoke or delete:
            // the slot, then the ids of the repositories it is lent to
            if (lines[0] === TOKEN_MARK.lent && !keyId) {
              if (!/^([1-9]|[12][0-9]|3[0-2])$/.test(lines[1] || '')) { reject(new Error('The run answered without naming the slot; see the issue.')); return; }
              resolve({ lent: lines[1], ids: String(lines[2] || '').split(',').filter(function (x) { return x === 'all' || x === 'organization' || /^[1-9][0-9]{0,15}$/.test(x); }) });
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
  // the step the person takes, in the note: the sign-in as a link, which a phone opens as it
  // opens any, and the code's box beside it
  function drawSignIn(repo, issue, url, view) {
    var m = view.step;
    clear(m);
    view.tell('Sign in as the Claude account this token is for.');
    var open = link(url, 'Sign in to claude.ai');
    open.className = 'msgtask__go';
    open.id = 'tk-open';
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
    add(m, el('p', 'admin__lead', '1. Open Sign in to claude.ai, sign in as the account and press Authorize. 2. Copy the code claude.ai shows. 3. Paste it here and send it.'));
    add(m, add(el('p', 'admin__bar'), open), add(el('p', 'admin__bar tkdlg__code'), code, ' ', send));
  }
  // Your token, for someone who is not an owner of the organization: one token per person in the
  // pool, lent to the repositories they choose (the owner's choice of 2026-10-19). Only the Token
  // run may read or change the pool for them, so each press is a short run with no sign-in.
  var yourLent = null, yourBusy = '';
  function yourTokenBox() {
    var box = el('div', 'toks__note');
    var line = el('p', 'admin__lead');
    var list = el('div');
    var where = btn('Where is my token lent?', true, function () { manageToken('list', '', line, list); });
    var gone = btn('Delete my token', true, function () {
      if (!window.confirm('Delete your Claude token from ' + tk.place.owner + '\'s pool? Every repository it is lent to loses it at once.')) return;
      manageToken('delete', '', line, list);
    });
    where.disabled = gone.disabled = yourBusy;
    add(box, el('h3', 'console__boxh', 'Your token'), add(el('p', 'admin__bar'), where, ' ', gone), line, list);
    if (yourBusy) line.textContent = yourBusy;
    else if (yourLent) drawLent(yourLent, line, list);
    return box;
  }
  function drawLent(found, line, list) {
    clear(list);
    if (found.failed) { line.textContent = found.failed; return; }
    if (!found.ids.length) { line.textContent = found.deleted ? 'Your token is deleted.' : 'Your token (slot ' + found.lent + ') is lent to no repository.'; return; }
    if (found.ids[0] === 'all') { line.textContent = 'Your token (slot ' + found.lent + ') is on in every repository of ' + tk.place.owner + ', which an owner set.'; return; }
    // lent with no say: the organization places it, and the lender is told no repository
    if (found.ids[0] === 'organization') { line.textContent = 'Your token (slot ' + found.lent + ') is in ' + tk.place.owner + '\'s keeping: its owners choose where it runs, and you can delete it at any time.'; return; }
    line.textContent = 'Your token (slot ' + found.lent + ') is lent to:';
    found.ids.forEach(function (id) {
      var row = el('p', 'admin__bar');
      var name = el('span', '', 'repository ' + id);
      gh('GET', '/repositories/' + id).then(function (r) { name.textContent = r.data.full_name; }, function () { name.textContent = 'a repository you cannot see (' + id + ')'; });
      var back = btn('Take back', true, function () { manageToken('revoke', id, line, list); });
      back.disabled = yourBusy;
      add(row, name, ' ', back);
      add(list, row);
    });
  }
  function manageToken(action, target, line, list) {
    // one run at a time, since each opens its own issue and nothing else stops a second
    if (yourBusy) return;
    yourBusy = action === 'list' ? 'Asking the Token run where your token is lent...' : action === 'revoke' ? 'Taking your token back...' : 'Deleting your token...';
    drawTiles();
    var repo = tk.repo, issue = 0;
    function done() { yourBusy = ''; if (action !== 'list') readTokenPlace(repo, reading); else drawTiles(); }
    gh('POST', '/repos/' + repo + '/issues', { title: 'Your Claude token: ' + action,
      body: 'The control panel\'s Tokens page opened this issue for one run of the workflow Token (.github/workflows/token.yml) on your own token in the pool. The page closes it when the run answers.' }).then(function (r) {
      issue = r.data.number;
      return gh('GET', '/repos/' + repo);
    }).then(function (r) {
      return gh('POST', '/repos/' + repo + '/actions/workflows/' + TOKEN_WORKFLOW + '/dispatches',
        { ref: r.data.default_branch || 'main', inputs: { issue: String(issue), store: 'manage', manage: action, target: String(target || '') } });
    }).then(function () {
      return followRun(repo, issue, null, { step: el('div') }, function () { return false; });
    }).then(function (found) {
      closeRunIssue(repo, issue);
      found.deleted = action === 'delete';
      if (found.deleted) found.ids = [];
      yourLent = found;
      done();
    }).catch(function (e) {
      if (issue) closeRunIssue(repo, issue, true);
      yourLent = { lent: '', ids: [], failed: 'That did not work: ' + e.message };
      done();
    });
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
      return 'Adding a token to ' + place.owner + '\'s pool takes write access to this repository, which you do not have. Ask to join, below, and an administrator lets you in from their Share tab; or pick a repository of your own in the Repository box.';
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
    if (unread && intoPool(tk.place)) {
      add(box, el('p', 'admin__none toks__note', 'Only an owner of ' + tk.place.owner + ' sees every token in its pool. Add Token lends yours to this repository, or makes it if you have none yet.'));
      add(box, yourTokenBox());
    }
    else if (unread) add(box, el('p', 'admin__none toks__note', 'GitHub would not list the secrets' + (tk.secrets && tk.secrets.unread ? ' (' + tk.secrets.unread.message + ')' : '') + ', so the tokens set are not shown.'));
    // an owner whose membership GitHub would not show (tk.admin null) keeps the owner's path here too
    if (tk.admin !== false && tk.place.org) add(box, lendToBox());
    drawSide();
  }

  // Where tokens lent with no say run: the organization variable SYMPHONY_LEND_TO, a list of
  // repository ids an owner keeps here, which the Token run lends each such token to as it comes
  // (the owner's choice of 2026-10-19). Someone who lends with no say never sees this list.
  var LEND_TO_VARIABLE = 'SYMPHONY_LEND_TO';
  var lendTo = null, lendToFor = '', lendToBusy = '', lendToError = '', repoNames = {};
  function lendToIds(value) { return String(value || '').split(/[,\s]+/).filter(function (w) { return /^[1-9][0-9]{0,15}$/.test(w); }); }
  // every call here is made for one place; one that answers after the repository changed is dropped
  function lendToStale(place) { return place !== tk.place; }
  function lendToBox() {
    var box = el('div', 'toks__note');
    var line = el('p', 'admin__lead');
    var list = el('div');
    var place = tk.place;
    add(box, el('h3', 'console__boxh', 'Tokens lent with no say run on'), line, list);
    if (lendToFor !== tk.repo) {
      lendToFor = tk.repo;
      lendTo = null;
      lendToError = '';
      readOne(place.base + '/variables/' + LEND_TO_VARIABLE).then(function (have) {
        if (lendToStale(place)) return;
        lendTo = lendToIds(have && have.value);
        if (have && have.visibility !== 'selected') closeLendTo(place);
        drawTiles();
      }, function (e) {
        if (lendToStale(place)) return;
        lendTo = [];
        lendToError = 'The list could not be read: ' + e.message;
        drawTiles();
      });
    }
    if (lendToBusy) { line.textContent = lendToBusy; return box; }
    if (!lendTo) { line.textContent = 'Reading the list...'; return box; }
    clear(line);
    rich(line, lendToError || (lendTo.length
      ? 'A token someone lends to ' + place.owner + ' without a say runs in these repositories from the moment it arrives:'
      : 'No repository yet: a token lent to ' + place.owner + ' without a say waits in its slot until you lend it from its tile, or add a repository here.'));
    lendTo.forEach(function (id) {
      var row = el('p', 'admin__bar');
      var name = el('span', '', repoNames[id] || 'repository ' + id);
      // named once, since every redraw of the tiles draws this box again
      if (!repoNames[id]) gh('GET', '/repositories/' + id).then(function (r) { repoNames[id] = r.data.full_name; name.textContent = repoNames[id]; }, function () { name.textContent = 'a repository that cannot be read (' + id + ')'; });
      add(row, name, ' ', btn('Take off', true, function () { writeLendTo(place, lendTo.filter(function (x) { return x !== id; })); }));
      add(list, row);
    });
    var field = el('input');
    field.type = 'text';
    field.placeholder = place.owner + '/repository';
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'Repository to add');
    var addRepo = btn('+ Add repository', true, function () {
      var full = field.value.trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/.test(full)) { line.textContent = 'Type the repository as owner/name.'; return; }
      lendToBusy = 'Reading ' + full + '...';
      drawTiles();
      gh('GET', '/repos/' + full).then(function (r) {
        if (lendToStale(place)) return;
        if (r.data.owner.login.toLowerCase() !== place.owner.toLowerCase()) throw new Error(full + ' is not a repository of ' + place.owner + ', whose secrets reach only its own.');
        lendToBusy = '';
        return writeLendTo(place, union(lendTo, [String(r.data.id)]));
      }).catch(function (e) {
        if (lendToStale(place)) return;
        lendToBusy = '';
        lendToError = e.status === 404 ? full + ' could not be read; check its name.' : e.message;
        drawTiles();
      });
    });
    add(box, add(el('p', 'admin__bar'), field, ' ', addRepo));
    return box;
  }
  // an older page wrote the list readable by the organization's private repositories' workflows;
  // an owner who opens the tab closes it to every repository, leaving its value as it is, and a
  // failure is left for the next save, which closes it too
  function closeLendTo(place) {
    gh('PATCH', place.base + '/variables/' + LEND_TO_VARIABLE, { visibility: 'selected', selected_repository_ids: [] }).catch(function () {});
  }
  function writeLendTo(place, ids) {
    lendToBusy = 'Saving the list...';
    lendToError = '';
    drawTiles();
    // the run reads the list with the App's token, so no repository's workflows need it: it is
    // written for selected repositories with none selected, which every write sets again, so a
    // list an older page made readable by the private repositories is closed at its next save;
    // an empty list is the variable gone, since GitHub keeps no empty value
    var path = place.base + '/variables/' + LEND_TO_VARIABLE;
    var body = { name: LEND_TO_VARIABLE, value: ids.join(','), visibility: 'selected', selected_repository_ids: [] };
    var write = !ids.length
      ? gh('DELETE', path).catch(function (e) { if (e.status !== 404) throw e; })
      : readOne(path).then(function (have) { return have ? gh('PATCH', path, body) : gh('POST', place.base + '/variables', body); });
    return write.then(function () {
      if (lendToStale(place)) return;
      lendTo = ids;
    }, function (e) {
      if (lendToStale(place)) return;
      lendToError = 'The list could not be saved: ' + e.message + secretsNeeded(place);
    }).then(function () { if (lendToStale(place)) return; lendToBusy = ''; drawTiles(); });
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
    // a token whose settings are still being saved is one press's: a second press meanwhile would
    // save the slot again under another id and start a second sign-in
    if (adding && tokenAdding && tokenAdding.era === ends) { say('A token is being added already; it speaks in the note at the foot of the screen.'); return; }
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
      // the Token run's marks stay through a save here: the account id while the token still belongs
      // to the same login, since a login can pass to someone else, and the word that a token lent
      // with no say is in the organization's keeping; a save that dropped them would let the run name
      // repositories to that lender, and refuse them their own token from an issue
      if (s.uid != null && who && typeof s.owner === 'string' && who.toLowerCase() === s.owner.toLowerCase()) out.uid = s.uid;
      if (s.keeping) out.keeping = s.keeping;
      return out;
    }
    function check() {
      var text = label.value.trim();
      if (text && !SLOT_LABEL.test(text)) return 'A name is a word or a few, of letters, digits, blanks, dots, dashes and underscores, at most 40, never an e-mail address.';
      if (owner && owner.value.trim() && !LOGIN.test(owner.value.trim())) return 'Belongs to takes a GitHub login, such as ' + (shownLogin || 'octocat') + '.';
      return '';
    }
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
      var wanted = slot, labelText = wanted === 'main' ? '' : label.value.trim(), at = tk.place;
      // the dialog answers and closes at once; the saving speaks in the note, and so does the
      // sign-in that follows it, as one task
      d.close();
      var task = adding ? msgTask('Add ' + tileName(wanted) + ' on ' + tk.repo) : null;
      if (adding) tokenAdding = { era: ends };
      if (task) task.tell('Saving the settings of ' + tileName(wanted) + '...');
      else say('Saving the settings of ' + tileName(wanted) + '...');
      saveTokenSettings(wanted, chosen(), labelText).then(function () {
        tokenAdding = null;
        drawTiles();
        if (adding) { addByActions(tk.repo, tk.place, $('tk-tile-add') || save, wanted, task); return; }
        say('Saved the settings of ' + tileName(wanted) + '; its runs follow them from their next start.');
      }, function (e) {
        tokenAdding = null;
        // GitHub refused the owner's path to someone the page could not tell was an owner, as when
        // their membership could not be read: they are not one here, so their token goes into the
        // pool through the Token run, as for anyone who may write but owns no secret (intoPool)
        if (adding && at && tk.place === at && at.org && tk.admin !== true && at.push !== false && (e.status === 403 || e.status === 404)) {
          tk.admin = false;
          drawTiles();
          say('GitHub lets only an owner of ' + at.owner + ' write its slots directly, so your token goes into its pool through the Token run instead, marked as yours, in the next free slot; an owner of ' + at.owner + ' sets its model and where it runs.');
          addByActions(tk.repo, tk.place, $('tk-tile-add') || save, '', task);
          return;
        }
        var words = 'The settings of ' + tileName(wanted) + ' could not be saved: ' + e.message + (e.status === 403 || e.status === 404 ? secretsNeeded(tk.place) : '');
        if (task) task.end(words, true); else say(words, true);
      });
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
          d.close();
          say('Putting ' + tileName(slot) + ' back in the pool...');
          saveTokenSettings(slot, next, tk.labels[slot] || '').then(function () { drawTiles(); say(tileName(slot) + ' is back in the pool from the workers\' next run.'); },
            function (e) { say(tileName(slot) + ' could not be resumed: ' + e.message + (e.status === 403 || e.status === 404 ? secretsNeeded(tk.place) : ''), true); });
        });
        resume.id = 'tk-resume';
        add(bar, ' ', resume);
      }
      var renew = btn('Sign in again to renew', true, function () { d.close(); addByActions(tk.repo, tk.place, renew, slot); });
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
    save.addEventListener('click', function () { save.disabled = true; d.close(); addByActions(tk.repo, tk.place, $('tk-tile-add') || save, ''); });
    var bar = add(el('p', 'admin__bar tkdlg__bar'), btn('Cancel', true, function () { d.close(); }), ' ', save);
    // without write access, asking to join is the way in, answered on the administrators' Share tab
    if (barred && tk.place.org) {
      var ask = btn('Ask to join ' + tk.repo, true, function () {
        ask.disabled = true;
        requestAccess(tk.repo, function (t, failed) { richText(problem, t); if (failed) ask.disabled = false; });
      });
      add(bar, ' ', ask);
    }
    add(form, bar);
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

  /* ---------- the grid's Claude accounts (hpcworker framework 21, symphony-template grid-accounts.yml) ---------- */
  // The Claude accounts signed in on the WSU grid for the owner's Beethoven worker, one in use at a
  // time (the owner, 2026-10-21: "see my account usage, reset, initiate claude swap, turn on auto mode,
  // all from the control board"). Every press dispatches grid-accounts.yml with a name of the page's
  // own (request), and the page reads the answer the run writes on the branch grid: accounts.json, the
  // list with e-mails masked, and for a sign-in link.json, Anthropic's link sealed for an RSA-OAEP key
  // this page made for that one press and keeps only in memory. Polled every two seconds while a press
  // is under way, every thirty while the tab is open.
  var GRID_BRANCH = 'grid';
  var GRID_WORKFLOW = 'grid-accounts.yml';
  var GRID_POLL_MS = 2000;
  var GRID_IDLE_MS = 30000;
  var GRID_PRESS_MS = 6 * 60 * 1000;
  var gr = { repo: '', rec: null, read: false, missing: false, side: '', busy: null, sign: null, timer: 0 };
  // The grid is one place whatever repository the panel has open: its gate is set up for one
  // repository (docs/setup/grid.md), the owner's symphony-template, or the one this browser keeps
  // under symphony_grid_repo for a lab whose gate names another (the owner, 2026-10-21, after the tab
  // followed an open repository with no gate)
  var GRID_HOME = 'OpenSpineConsortium/symphony-template';
  function gridRepo() {
    var kept = '';
    try { kept = localStorage.getItem('symphony_grid_repo') || ''; } catch (e) { kept = ''; }
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(kept) ? kept : GRID_HOME;
  }
  function gridFile(repo, name) {
    return gh('GET', '/repos/' + repo + '/contents/' + name + '?ref=' + GRID_BRANCH + '&at=' + Date.now(), undefined, RAW, true)
      .then(function (r) { try { return JSON.parse(r.data); } catch (e) { return null; } })
      .catch(function (e) { if (e.status === 404) return null; throw e; });
  }
  function gridNote(text) { var n = $('gr-note'); if (!n) return; n.hidden = !text; richText(n, text || ''); }
  function loadGrid() {
    var repo = gridRepo();
    if (!repo) return Promise.resolve();
    if (gr.repo !== repo) { gr = { repo: repo, rec: null, read: false, missing: false, side: '', busy: null, sign: null, timer: gr.timer }; drawGrid(); }
    return gridFile(repo, 'accounts.json').then(function (rec) {
      if (gr.repo !== repo) return;
      gr.read = true;
      gr.missing = !rec;
      if (rec && rec.list) gr.rec = rec;
      else if (rec && !gr.rec) gr.rec = rec;
      drawGrid();
      return rec;
    }).catch(function (e) { if (gr.repo === repo) { gr.read = true; gridNote(e.message); drawGrid(); } });
  }
  function gridIdle() {
    clearTimeout(gr.timer);
    gr.timer = setTimeout(function () {
      if (consoleTab === 'grid' && !gr.busy && !document.hidden) loadGrid();
      if (consoleTab === 'grid') gridIdle();
    }, GRID_IDLE_MS);
  }
  function requestName() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function b64(buf) { var s = '', a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(text) { var s = atob(text), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  // the key a sign-in's link is sealed for: made for the one press, never stored or sent but its public half
  function gridKeys() {
    return crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['decrypt'])
      .then(function (pair) { return crypto.subtle.exportKey('spki', pair.publicKey).then(function (spki) { return { priv: pair.privateKey, pub: b64(spki) }; }); });
  }
  function unseal(sealed, priv) {
    return crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, unb64(sealed.key)).then(function (raw) {
      return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    }).then(function (aes) {
      return crypto.subtle.decrypt({ name: 'AES-CBC', iv: unb64(sealed.iv) }, aes, unb64(sealed.data));
    }).then(function (plain) {
      var url = new TextDecoder().decode(plain);
      // only Anthropic's own sign-in pages are ever opened from here
      return /^https:\/\/(claude\.ai|claude\.com)\//.test(url) ? url : '';
    });
  }
  // one press: the workflow started, then the branch read until the run's answer for this request is there
  function gridPress(action, slot, label, extra) {
    var repo = gridRepo();
    if (!repo || gr.busy) return;
    var request = requestName();
    var inputs = { action: action, slot: slot || '', request: request };
    Object.keys(extra || {}).forEach(function (k) { inputs[k] = extra[k]; });
    gr.busy = { action: action, slot: slot || '', label: label, request: request, since: Date.now() };
    gridNote('');
    drawGrid();
    var keyed = action === 'login' ? gridKeys() : Promise.resolve(null);
    keyed.then(function (keys) {
      if (keys) { inputs.key = keys.pub; gr.sign = { slot: slot, request: request, priv: keys.priv, url: '', state: 'waiting' }; }
      return gh('GET', '/repos/' + repo).then(function (r) {
        return gh('POST', '/repos/' + repo + '/actions/workflows/' + GRID_WORKFLOW + '/dispatches', { ref: r.data.default_branch || 'main', inputs: inputs });
      });
    }).then(function () { gridFollow(repo, request); }, function (e) {
      gr.busy = null;
      if (gr.sign && gr.sign.request === request) gr.sign = null;
      gridNote(e.status === 404 ? repo + ' has no workflow Grid accounts (.github/workflows/grid-accounts.yml); choose the repository whose grid gate is set up, as OpenSpineConsortium/symphony-template.' : e.message + (e.status === 403 ? ' Starting it needs Actions: read and write, and the run itself an admin of ' + repo + '.' : ''));
      drawGrid();
    });
  }
  function gridDone(rec, busy) {
    if (!rec || rec.request !== busy.request) return false;
    var list = rec.list || {};
    if (busy.action === 'usage') return list.usage_job !== 'running' || rec.rc !== 0;
    if (busy.action === 'login') {
      var st = loginOf(list, busy.slot).state;
      return (gr.sign && gr.sign.url) || st === 'failed' || st === 'signed-in' || rec.rc !== 0;
    }
    if (busy.action === 'code') return loginOf(list, busy.slot).state !== 'code';
    return true;
  }
  function gridFollow(repo, request) {
    var busy = gr.busy;
    if (!busy || busy.request !== request || gr.repo !== repo) return;
    if (Date.now() - busy.since > GRID_PRESS_MS) {
      gr.busy = null;
      gridNote('No answer from the grid in six minutes. The run is under Runs (workflow Grid accounts), where its log says why.');
      drawGrid(); return;
    }
    var reads = [gridFile(repo, 'accounts.json')];
    if (gr.sign && gr.sign.request === request && !gr.sign.url) reads.push(gridFile(repo, 'link.json'));
    Promise.all(reads).then(function (got) {
      if (gr.busy !== busy) return;
      var rec = got[0], sealed = got[1];
      var opened = sealed && sealed.request === request && sealed.sealed && gr.sign && !gr.sign.url
        ? unseal(sealed.sealed, gr.sign.priv).then(function (url) { if (url && gr.sign) gr.sign.url = url; }, function () { gridNote('The sign-in link could not be opened on this page; press Sign in again.'); })
        : Promise.resolve();
      return opened.then(function () {
        if (rec && rec.request === request) {
          if (rec.list) gr.rec = rec;
          if (rec.rc && !rec.list) gridNote((rec.said || []).slice(-1)[0] || 'The grid did not take that; the run under Runs says why.');
        }
        if (gridDone(rec, busy)) {
          gr.busy = null;
          var said = rec && (rec.said || []).filter(function (l) { return /^HPCW-ACCOUNTS /.test(l); }).slice(-1)[0];
          if (said && rec.rc) gridNote(said.replace(/^HPCW-ACCOUNTS /, ''));
          else say(busy.label + ': done.');
        }
        drawGrid();
        if (gr.busy === busy) setTimeout(function () { gridFollow(repo, request); }, GRID_POLL_MS);
      });
    }).catch(function () { if (gr.busy === busy) setTimeout(function () { gridFollow(repo, request); }, GRID_POLL_MS * 2); });
  }
  function loginOf(list, slot) {
    var a = ((list && list.accounts) || []).filter(function (x) { return x && x.slot === slot; })[0];
    return (a && a.login) || { state: 'none', line: '' };
  }
  function gridAccounts() { return (gr.rec && gr.rec.list && Array.isArray(gr.rec.list.accounts)) ? gr.rec.list.accounts : []; }
  function untilWords(iso) {
    var t = moment(iso);
    if (t == null) return '';
    var s = (t - Date.now()) / 1000;
    if (s <= 0) return 'reset';
    if (s < 5400) return 'resets in ' + Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 172800) return 'resets in ' + Math.round(s / 3600) + ' h';
    return 'resets in ' + Math.round(s / 86400) + ' days';
  }
  function gridWindow(use, key) {
    var each = use && use.windows && use.windows[key];
    if (!each) return null;
    var out = { utilization: each.utilization, resetsAt: each.resetsAt };
    var r = moment(each.resetsAt);
    if (r != null && r <= Date.now()) { out.utilization = 0; out.reset = true; }
    return out;
  }
  function gridBars(use) {
    var box = el('span', 'tok__use');
    [['five_hour', '5h'], ['seven_day', '7d']].forEach(function (p) {
      var each = gridWindow(use, p[0]), u = each ? used(each.utilization) : null;
      var bar = el('span', 'tok__bar' + (u != null && u >= POOL_THRESHOLD ? ' tok__bar--full' : ''));
      bar.title = (p[0] === 'five_hour' ? 'Five hours' : 'Seven days') + ': ' + (u == null ? 'not read yet' : percent(u) + ' used' + (each.resetsAt ? ', ' + untilWords(each.resetsAt) : ''));
      var fill = el('span', 'tok__fill');
      fill.style.width = (u == null ? 0 : Math.round(Math.min(u, 1) * 100)) + '%';
      add(box, add(el('span', 'tok__window'), el('span', 'tok__wname', p[1]), add(bar, fill), el('span', 'gr__pct', u == null ? '' : percent(u))));
    });
    return box;
  }
  function gridAccountName(a) {
    var who = a.who || {};
    return who.signed_in ? (who.email || 'Account ' + a.slot) : 'Account ' + a.slot;
  }
  function gridAccountState(a) {
    var busy = gr.busy && gr.busy.slot === a.slot ? gr.busy : null;
    var login = a.login || {};
    if (busy) return { text: busy.label + '...', cls: 'tok__state--warn' };
    if (login.state && login.state !== 'none' && login.state !== 'signed-in') return { text: login.line || login.state, cls: login.state === 'failed' ? 'tok__state--warn' : '' };
    if (a.current) return { text: 'In use', cls: 'tok__state--go' };
    if (a.who && a.who.signed_in === false) return { text: 'Not signed in', cls: 'tok__state--warn' };
    if (a.use && a.use.status === 'rejected') return { text: 'At its limit', cls: 'tok__state--warn' };
    return { text: a.who ? 'Ready' : 'Not read yet', cls: '' };
  }
  function gridTile(a) {
    var wrap = el('div', 'tok' + (gr.side === a.slot ? ' tok--on' : '') + (a.current ? ' gr--current' : ''));
    var open = el('button', 'tok__open');
    open.type = 'button';
    open.id = 'gr-tile-' + a.slot;
    var who = a.who || {}, st = gridAccountState(a);
    add(open, el('span', 'tok__icon', a.slot), el('span', 'tok__name', gridAccountName(a)),
        el('span', 'tok__meta', who.plan ? 'Claude ' + who.plan : who.signed_in === false ? 'signed out' : ''),
        gridBars(a.use), el('span', 'tok__state ' + st.cls, st.text));
    open.addEventListener('click', function () { gr.side = gr.side === a.slot ? '' : a.slot; drawGrid(); });
    return add(wrap, open);
  }
  function freeSlot() {
    var taken = gridAccounts().map(function (a) { return a.slot; });
    for (var n = 1; n <= 32; n++) if (taken.indexOf(String(n)) < 0) return String(n);
    return '';
  }
  function gridBarButtons() {
    var bar = $('gr-bar');
    if (!bar) return;
    clear(bar);
    var list = (gr.rec && gr.rec.list) || {};
    var auto = !!list.auto;
    var refresh = el('button', 'chip', 'Refresh');
    refresh.type = 'button'; refresh.id = 'gr-refresh';
    refresh.addEventListener('click', function () { gridPress('list', '', 'Refreshing'); });
    var usage = el('button', 'chip', list.usage_job === 'running' ? 'Reading usage...' : 'Read usage');
    usage.type = 'button'; usage.id = 'gr-usage';
    usage.title = 'Asks each account for one word on Haiku, which spends that word of its window';
    usage.addEventListener('click', function () { gridPress('usage', '', 'Reading usage'); });
    var autoB = el('button', 'chip' + (auto ? ' chip--go' : ''), auto ? 'Auto mode: on' : 'Auto mode: off');
    autoB.type = 'button'; autoB.id = 'gr-auto';
    autoB.setAttribute('aria-pressed', auto ? 'true' : 'false');
    autoB.title = 'On: your worker moves to the signed-in account with the most room when its account reaches 90% of a window';
    autoB.addEventListener('click', function () { gridPress(auto ? 'auto-off' : 'auto-on', '', auto ? 'Turning auto mode off' : 'Turning auto mode on'); });
    [refresh, usage, autoB].forEach(function (b) { b.disabled = !!gr.busy; add(bar, b); });
    if (gr.busy) add(bar, el('span', 'gr__busy', gr.busy.label + '...'));
  }
  var GRID_NAME = /^[A-Za-z0-9_-]{1,24}$/;
  // every worker of the last day, the main one and each kept to an account of its own (framework 22)
  function gridWorkers(list) {
    if (Array.isArray(list.workers)) return list.workers.filter(function (w) { return w && w.name; });
    return list.worker ? [list.worker] : [];
  }
  function workerLine(w) {
    if (!w) return null;
    var p = el('p', 'gr__worker');
    p.id = 'gr-worker-' + w.name;
    var state = w.state === 'online' ? 'online' : w.state || 'unknown';
    var ended = state === 'stopped' || state === 'error';
    add(p, el('span', 'gr__dot gr__dot--' + (state === 'online' ? 'go' : state === 'need_login' || state === 'error' ? 'warn' : 'wait')),
        'Worker ' + (w.name || '') + ': ' + state.replace(/_/g, ' ') + (w.account ? ', on account ' + w.account : '') +
        (w.pinned ? ' (kept there)' : '') + (w.node ? ', ' + w.node : ''));
    if (w.link && !ended) add(p, ' ', link(w.link, 'Open the session'));
    if (w.name) add(p, el('span', 'tkdlg__faint', ' claims as grid-' + w.name));
    if (!ended && w.name && GRID_NAME.test(w.name)) {
      var stop = btn('Stop', true, function () {
        if (!window.confirm('Stop worker ' + w.name + ' on the grid? Its job ends and queues no successor; its session and files stay.')) return;
        gridPress('worker-stop', '', 'Stopping worker ' + w.name, { name: w.name });
      });
      stop.id = 'gr-stop-' + w.name;
      stop.disabled = !!gr.busy;
      add(p, ' ', stop);
    }
    return p;
  }
  function drawGrid() {
    gridBarButtons();
    var box = $('gr-tiles');
    if (!box) return;
    clear(box);
    if (!gr.read) { none(box, 'Reading the grid\'s accounts...'); drawGridSide(); return; }
    var list = gr.rec && gr.rec.list;
    if (!list) {
      none(box, gr.missing ? 'Nothing read from the grid yet for ' + gr.repo + '. Refresh asks it now (the repository needs the workflow Grid accounts and the grid gate, docs/setup/grid.md).' : 'The grid gave no list last time; Refresh asks again.');
      add(box, toksNote());
      drawGridSide(); return;
    }
    var workers = gridWorkers(list);
    if (workers.length) {
      var wbox = el('div', 'toks__note');
      wbox.id = 'gr-workers';
      workers.forEach(function (w) { add(wbox, workerLine(w)); });
      add(box, wbox);
    }
    gridAccounts().forEach(function (a) { add(box, gridTile(a)); });
    var plus = el('button', 'tok__open tok--add');
    plus.type = 'button'; plus.id = 'gr-add';
    var n = freeSlot();
    add(plus, el('span', 'tok__plus', '+'), el('span', 'tok__name', 'Sign in another'));
    plus.disabled = !n || !!gr.busy;
    plus.addEventListener('click', function () { gr.side = n; gridPress('login', n, 'Signing in account ' + n); });
    add(box, add(el('div', 'tok'), plus));
    if (gr.rec.at) add(box, add(el('p', 'admin__none toks__note'), 'Read from the grid ', timeEl(gr.rec.at), ', through ' + gr.repo + '.'));
    drawGridSide();
  }
  function toksNote() { return null; }
  function drawGridSide() {
    var side = $('gr-side');
    if (!side) return;
    var slot = gr.side;
    var a = gridAccounts().filter(function (x) { return x.slot === slot; })[0];
    var signing = gr.sign && gr.sign.slot === slot ? gr.sign : null;
    if (!slot || (!a && !signing)) { side.hidden = true; clear(side); return; }
    clear(side);
    side.hidden = false;
    a = a || { slot: slot, login: { state: 'waiting' } };
    var close = el('button', 'tkside__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { gr.side = ''; drawGrid(); });
    var who = a.who || {};
    add(side, close, el('h3', 'console__boxh', gridAccountName(a)), el('p', 'tok__owner', 'Account ' + slot + (who.plan ? ', Claude ' + who.plan : '')));
    var st = gridAccountState(a);
    add(side, el('p', 'tok__state ' + st.cls, st.text));
    [['five_hour', 'Five hours'], ['seven_day', 'Seven days']].forEach(function (p) {
      var each = gridWindow(a.use, p[0]);
      var m = sideMeter(p[1], each);
      if (each && each.resetsAt && !each.reset) add(m, el('p', 'tkside__reset', untilWords(each.resetsAt)));
      add(side, m);
    });
    ((a.use && a.use.scoped) || []).forEach(function (x) { add(side, sideMeter(x.name + ' weekly', gridWindow({ windows: { w: x } }, 'w'))); });
    if (a.use && a.use.read_at) add(side, add(el('p', 'tkdlg__fact tkdlg__faint'), 'Usage read ', timeEl(a.use.read_at)));
    if (a.use && a.use.error) add(side, el('p', 'tkdlg__fact admin__warn', a.use.error));
    var login = a.login || {};
    if (signing || ['waiting', 'link', 'code'].indexOf(login.state) >= 0) add(side, signInBox(slot, signing, login));
    var bar = el('p', 'admin__bar');
    if (!a.current && who.signed_in) {
      var use = btn('Use this account', false, function () { gridPress('use', slot, 'Moving to account ' + slot); });
      use.id = 'gr-use';
      use.title = 'Your running worker moves to this account now; its session then shows in this account on claude.ai';
      add(bar, use);
    }
    if (who.signed_in) add(side, startBox(slot));
    var again = btn(who.signed_in ? 'Sign in again' : 'Sign in', true, function () { gridPress('login', slot, 'Signing in account ' + slot); });
    again.id = 'gr-signin';
    add(bar, again);
    if (!a.current && a.who !== undefined) {
      var forget = btn('Forget', true, function () {
        if (!window.confirm('Forget account ' + slot + ' on the grid? Its folder is moved aside there, never deleted.')) return;
        gridPress('forget', slot, 'Forgetting account ' + slot);
      });
      forget.id = 'gr-forget';
      add(bar, forget);
    }
    Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) { b.disabled = !!gr.busy; });
    add(side, bar);
  }
  // a worker of its own on this account: its own Slurm job and its own Remote Control session there
  function startBox(slot) {
    var box = el('div', 'gr__start');
    var running = gridWorkers((gr.rec && gr.rec.list) || {}).filter(function (w) {
      return w.pinned === slot && w.state !== 'stopped' && w.state !== 'error';
    })[0];
    if (running) {
      add(box, el('p', 'tkdlg__fact', 'Worker ' + running.name + ' runs on this account; it shows above with its Stop button.'));
      return box;
    }
    var input = el('input');
    input.type = 'text'; input.id = 'gr-wname'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'account' + slot; input.maxLength = 24;
    var go = btn('Start a worker on this account', false, function () {
      var name = input.value.trim() || 'account' + slot;
      if (!GRID_NAME.test(name)) { gridNote('A worker\'s name is up to 24 letters, digits, _ or -.'); return; }
      gridPress('worker-start', slot, 'Starting worker ' + name, { name: name });
    });
    go.id = 'gr-start';
    go.title = 'A Claude Code worker of its own on this account, as its own Slurm job; it claims issues as grid-<name> and spends allocation like your main worker';
    go.disabled = !!gr.busy;
    add(box, el('p', 'tkdlg__fact tkdlg__faint', 'Runs beside your main worker, kept to this account, and claims its own issues as grid-<name>.'), add(el('p', 'gr__coderow'), input, go));
    return box;
  }
  function signInBox(slot, signing, login) {
    var box = el('div', 'gr__sign');
    add(box, el('p', 'tkdlg__fact', login.line || 'Waiting for a computer on the grid and for Claude Code\'s link.'));
    if (signing && signing.url) {
      var go = link(signing.url, 'Open Anthropic\'s sign-in');
      go.className = 'button gr__go';
      go.id = 'gr-link';
      add(box, add(el('p', ''), go));
      add(box, el('p', 'tkdlg__fact tkdlg__faint', 'Sign in there with the account to add. If the page shows a code, paste it here; if it says you are signed in, nothing more is needed.'));
    } else if (signing) add(box, el('p', 'tkdlg__fact tkdlg__faint', 'The link comes here, for this page alone, as soon as the grid prints it.'));
    var input = el('input');
    input.type = 'text'; input.id = 'gr-code'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'Code from Anthropic\'s page';
    var send = btn('Send code', false, function () {
      var code = input.value.trim();
      if (!/^[A-Za-z0-9_#.~-]{8,512}$/.test(code)) { gridNote('That is not a code Anthropic\'s page shows.'); return; }
      input.value = '';
      gridPress('code', slot, 'Checking the code', { code: code });
    });
    send.id = 'gr-send';
    send.disabled = !!gr.busy && gr.busy.action !== 'login';
    add(box, add(el('p', 'gr__coderow'), input, send));
    return box;
  }
  function initGridTab() {
    consoleOnOpen.grid = function () { if (gr.repo !== gridRepo() || !gr.read) loadGrid(); gridIdle(); };
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
    }).catch(function (e) { if (leadersFor === repo) richText($('lb-lead'), 'The leaderboard could not be read: ' + e.message); });
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
  // the repository variable drive-sync.yml's half-hourly run waits for, and the organization
  // variable naming the one drive an organization's secret holds
  var SYNC_SWITCH = 'SYMPHONY_DRIVE';
  var DRIVE_ID_VAR = 'SYMPHONY_DRIVE_ID';
  var DRIVE_WORKFLOW = 'drive-sync.yml';
  // the walk-only workflow a drive-organizing repository carries in place of the sync
  var CATALOG_WORKFLOW = 'drive-catalog.yml';
  var DRIVE_BRANCH = 'symphony/drive';
  // the drive organizer's catalog, which the Notebooks tab reads: catalog.json on the branch
  // drive-catalog, a flat list of the drive's folders and files whose paths start with this root
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
  // Globus, the second drive (the owner, 2026-10-20: the WSU grid's files with no VPN and no
  // download, "as high speed ... as possible", "with as few intermediate steps as possible"): the
  // page signs in to Globus Auth itself, as a native app with PKCE and no secret, since Globus Auth
  // answers a browser's token exchange, so no sign-in service route is needed; it lists a
  // collection's folders through the Transfer API as the person, and a double click opens a file
  // over the collection's own HTTPS address, where Globus Connect Server streams it to the browser
  // after one sign-in click there, as Globus's own file manager opens files. The page writes
  // nothing to a Globus collection: the grid's files are read here, never changed. The client id
  // is the owner's registration of this page at Globus (app.globus.org/settings/developers, a
  // "thick client" with this console's address as its redirect); '' until it is registered.
  var GLOBUS_CLIENT = '478419be-5bc2-436e-ac71-ca8920101271';
  var GLOBUS_AUTH = 'https://auth.globus.org/v2/oauth2';
  var GLOBUS_TRANSFER = 'https://transfer.api.globus.org/v0.10';
  var GLOBUS_RS = 'transfer.api.globus.org';
  var GLOBUS_SCOPE = 'openid profile urn:globus:auth:scope:transfer.api.globus.org:all';
  // the collections the page knows by name: the first is looked up and connected on Connect Globus,
  // so the person chooses nothing; its id, once known, lets the one sign-in carry the
  // collection's consents too, and a blank one costs one more consent page the first time
  // the collection's id, given by the owner on 2026-10-21, so the first sign-in carries its consents
  // and no search is needed; the name is still checked against what Globus answers for the id
  var GLOBUS_KNOWN = [{ name: 'wsugrid#globus', label: 'WSU grid', id: 'ddb59d22-6d04-11e5-ba46-22000b92c6ec' }];
  // how many entries of a folder the list takes; the grid has folders of a million files
  var GLOBUS_PAGE = 2000;
  // a preview fetched into the page is this large at most; a bigger file opens in its own tab
  var GLOBUS_PREVIEW_MAX = 50 * 1024 * 1024;
  // where a person goes when the collection will not read here: Globus's own file manager, the
  // consents page and the service's status; and Beethoven, which gives a shell and jobs on the grid,
  // since Globus moves files only
  var GLOBUS_MANAGER = 'https://app.globus.org/file-manager';
  var GLOBUS_CONSENTS = 'https://app.globus.org/settings/consents';
  var GLOBUS_STATUS = 'https://status.globus.org/';
  var BEETHOVEN_PAGE = 'https://openspineconsortium.com/beethoven/';
  var BEETHOVEN_STORE = 'https://chromewebstore.google.com/detail/beethoven/heoopgbkbkfckhhpbkkcgigohfekjicn';
  var GLOBUS_HOP = 'symphony_panel_globus_hop';
  var DRIVE_PARAMS =['code', 'state', 'error', 'error_description', 'error_uri', 'session_state', 'admin_consent'];
  // the newest repositories "Find the repository I just made" looks through
  var NEWEST = 10;
  // the folder's shape as drive-sync.yml reads it, one path segment; it ends in no dot or blank,
  // which the workflow's rule admits and Windows refuses
  var FOLDER_NAME = /^[A-Za-z0-9_]([A-Za-z0-9_. -]{0,78}[A-Za-z0-9_])?$/;
  // the connection, in this page's memory, with the GitHub account it belongs to, and its refresh
  // token kept on this browser for that account (below); the provider the service listed; what is
  // ticked, and the repository whose file ticked it
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
  // the chosen repository walks the drive (drive-catalog.yml) and has no sync: Track keeps the token alone
  var walkOnly = false;
  var folderReading = 0;
  var listing = 0;
  // the repository the tab last read, null when it is to be read again; the connection its list
  // was last drawn for
  var foldersFor = null;
  var listedFor = null;
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
  function driveName(provider) { return provider === 'microsoft' ? 'OneDrive' : provider === 'google' ? 'Google Drive' : provider === 'globus' ? 'Globus' : provider; }
  // the drive connected now is Globus, read-only here
  function onGlobus() { return !!(drive && drive.provider === 'globus'); }
  function canWrite() { return !!drive && !onGlobus(); }
  // the name at the root of the address and the tree: OneDrive, or the Globus collection's
  function rootName() { return onGlobus() ? (drive.name || 'Globus') : 'OneDrive'; }
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

  /* ---------- the connection: Microsoft's consent, and the drive's tokens ---------- */
  // The connection is kept on this browser by GitHub account, so a reload, a sign-in that ran out or
  // a new sign-in as the same account finds the drive still connected, as the owner chose on
  // 2026-10-20: only the refresh token, the day it was issued and the drive's name and id, never the
  // hour's access token, until Forget OneDrive, Forget the token, Microsoft refusing it, or the 90
  // days a Microsoft refresh token lasts
  var KEY_DRIVE_KEPT = 'symphony_panel_drive_kept';
  function keptDrives() {
    try {
      var m = JSON.parse(localStorage.getItem(KEY_DRIVE_KEPT) || '{}');
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch (e) { return {}; }
  }
  function writeKept(m) {
    try {
      if (Object.keys(m).length) localStorage.setItem(KEY_DRIVE_KEPT, JSON.stringify(m));
      else localStorage.removeItem(KEY_DRIVE_KEPT);
    } catch (e) { /* a browser that refuses its storage keeps the drive for this page alone */ }
  }
  // another tab may have connected again since this page read the kept token, so an older one is
  // never written over a newer one
  // OneDrive's connection is kept under the account's login, as before this page knew a second
  // drive, so nothing kept earlier is lost; Globus's under the login and its name
  function keptKey(login, provider) { return String(login || '').toLowerCase() + (provider === 'globus' ? '|globus' : ''); }
  function keepDrive(d) {
    if (!d || !d.login || !d.refresh) return;
    var m = keptDrives(), key = keptKey(d.login, d.provider), had = m[key];
    if (had && had.refresh !== d.refresh && String(had.connected || '') > String(d.connected || '')) return;
    var kept = { provider: d.provider, refresh: d.refresh, connected: d.connected || dayOf(new Date()), owner: d.owner || '', id: d.id || '', type: d.type || '' };
    // Globus gives one refresh token per service, the collection's HTTPS server among them; the
    // collection's name and address are kept so the tab draws it before any call
    if (d.provider === 'globus') {
      kept.tokens = {};
      Object.keys(d.tokens || {}).forEach(function (rs) { if (d.tokens[rs] && d.tokens[rs].refresh) kept.tokens[rs] = { refresh: d.tokens[rs].refresh }; });
      kept.name = d.name || '';
      kept.https = d.https || '';
      kept.home = d.home || '';
    }
    m[key] = kept;
    writeKept(m);
  }
  // given the refresh token, only that one is forgotten, so a tab's dead token never takes
  // another tab's new connection with it
  function forgetKept(login, refresh, provider) {
    var m = keptDrives(), key = keptKey(login, provider);
    if (!String(login || '') || !m[key] || (refresh && m[key].refresh !== refresh)) return;
    delete m[key];
    writeKept(m);
  }
  // the account's kept connection, as a drive whose access token is to be fetched on its first call
  function keptFor(login, provider) {
    var k = login ? keptDrives()[keptKey(login, provider)] : null;
    if (!k || typeof k !== 'object' || typeof k.refresh !== 'string' || !k.refresh || typeof k.provider !== 'string') return null;
    if (k.provider === 'globus') {
      var tokens = {};
      Object.keys(k.tokens && typeof k.tokens === 'object' ? k.tokens : {}).forEach(function (rs) { if (k.tokens[rs] && typeof k.tokens[rs].refresh === 'string') tokens[rs] = { access: '', refresh: k.tokens[rs].refresh, expiresAt: 0 }; });
      if (!tokens[GLOBUS_RS]) tokens[GLOBUS_RS] = { access: '', refresh: k.refresh, expiresAt: 0 };
      return { provider: 'globus', access: '', refresh: k.refresh, expiresAt: 0, tokens: tokens, connected: String(k.connected || ''), owner: String(k.owner || ''), id: String(k.id || ''), type: 'globus', name: String(k.name || ''), https: httpsOnly(k.https), home: globusHomeOf(k.home), login: login };
    }
    var end = daysAfter(String(k.connected || ''), MS_REFRESH_DAYS);
    if (!end || end <= dayOf(new Date())) { forgetKept(login); return null; }
    return { provider: k.provider, access: '', refresh: k.refresh, expiresAt: 0, connected: String(k.connected), owner: String(k.owner || ''), id: String(k.id || ''), type: String(k.type || ''), login: login };
  }
  // which of the account's kept drives the tab shows, remembered on this browser; with both kept,
  // the other is a second root in the folder tree, and a press on it switches
  var KEY_DRIVE_ACTIVE = 'symphony_panel_drive_active';
  function activeProvider(login) {
    try { var m = JSON.parse(localStorage.getItem(KEY_DRIVE_ACTIVE) || '{}'); var p = m && m[String(login || '').toLowerCase()]; return p === 'globus' ? 'globus' : 'microsoft'; } catch (e) { return 'microsoft'; }
  }
  function setActiveProvider(login, provider) {
    try { var m = JSON.parse(localStorage.getItem(KEY_DRIVE_ACTIVE) || '{}'); if (!m || typeof m !== 'object') m = {}; m[String(login || '').toLowerCase()] = provider; localStorage.setItem(KEY_DRIVE_ACTIVE, JSON.stringify(m)); } catch (e) { /* the choice holds for this page alone */ }
  }
  function otherKept() {
    if (!drive || !shownLogin) return null;
    return keptFor(shownLogin, drive.provider === 'globus' ? 'microsoft' : 'globus');
  }
  function restoreDrive() {
    if (!drive && token && shownLogin) {
      var first = activeProvider(shownLogin);
      drive = keptFor(shownLogin, first) || keptFor(shownLogin, first === 'globus' ? 'microsoft' : 'globus');
    }
    return drive;
  }
  // the other kept drive takes the tab: the list, the tree and the head are drawn for it
  function switchDrive(d) {
    if (!d) return;
    setActiveProvider(shownLogin, d.provider);
    drive = d;
    crumbs = [];
    resetExplorer();
    listedFor = d;
    showConnectState();
    nameDrive();
    if (d.provider === 'globus') globusHome(); else listFolder();
  }
  // The connection belongs to the GitHub account the page named when Connect OneDrive was pressed,
  // or, pressed while it named nobody, the first it names after the return; another account named
  // since, in this tab or by another tab's token, finds no drive,
  // so one person's refresh token is never sealed into another's repository
  function heldDrive() {
    if (!restoreDrive()) return null;
    if (!drive.login) { drive.login = shownLogin; keepDrive(drive); setActiveProvider(shownLogin, drive.provider === 'globus' ? 'globus' : 'microsoft'); }
    else if (shownLogin && drive.login !== shownLogin) { dropDrive(); return restoreDrive(); }
    return drive;
  }
  // Forget OneDrive: the connection goes from this page and from this browser; the secrets Track
  // saved stay, since they are the repositories'
  function forgetDrive() {
    var d = drive;
    var globus = !!(d && d.provider === 'globus');
    forgetKept(d && d.login || shownLogin, '', globus ? 'globus' : 'microsoft');
    dropDrive();
    if (globus) say('Globus is forgotten on this browser. Its consent stays at Globus until you withdraw it at ' + GLOBUS_CONSENTS + '.');
    else say('OneDrive is forgotten on this browser. The repositories that track it keep their secret until you delete it there or withdraw Symphony\'s access at Microsoft.');
    // the other kept drive, if any, takes the tab
    var next = restoreDrive();
    if (next) { listedFor = null; openFolders(); }
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
    drawConnectState();
    // the drives' dialog says why OneDrive cannot be pressed, since the head is behind it while it is open
    var said = $('fd-cloud-note');
    if (said) said.textContent = $('fd-connect').disabled && !onGlobus() ? $('fd-connect-note').textContent : '';
    drawGlobusTile();
  }
  function drawConnectState() {
    var button = $('fd-connect'), note = $('fd-connect-note');
    // where the keyboard is, read before any button is hidden or moved, since hiding the one it
    // is on takes it to the page's body at once
    var keyboard = keyboardOnStrip();
    // the next step's button is the one filled: Connect until a drive is held, then Track
    heldDrive();
    button.classList.toggle('console__primary', !drive);
    $('fd-track').classList.toggle('console__primary', !!drive && !onGlobus());
    note.classList.toggle('folders__who--on', !!drive && !onGlobus());
    note.classList.toggle('folders__who--globus', onGlobus());
    // with no drive the tab's own tile is the one + Add; the head's comes once one is connected
    $('fd-add').hidden = !drive;
    $('fd-forget').hidden = !drive;
    var forget = 'Forget ' + (drive ? driveName(drive.provider) : 'OneDrive');
    $('fd-forget').textContent = '';
    add($('fd-forget'), el('span', 'admin__sr', forget));
    $('fd-forget').title = forget;
    var other = otherKept();
    drawAccounts(other, keyboard);
    if (drive && drive.provider === 'globus') {
      var held = !signinAvailable() ? 'Connecting OneDrive goes through the sign-in service, which the page does not name yet.' : driveConfig && (!driveConfig.microsoft || !driveConfig.microsoft.client_id) ? 'The owner has not set OneDrive up on the sign-in service yet.' : '';
      button.disabled = !!held;
      button.textContent = other ? 'Connect OneDrive again' : 'Connect OneDrive';
      note.textContent = 'Connected to Globus' + (drive.name ? ', ' + drive.name : '') + (drive.owner ? ', as ' + drive.owner : '') + ', read-only, kept on this browser for ' + (drive.login || 'this GitHub account') + '.' + (other ? ' OneDrive is connected too: press its card to switch.' : '') + (held ? ' ' + held : '');
      // the cards say the same, so the words are read aloud and shown only with something to add
      note.classList.toggle('folders__who--quiet', !held);
      return;
    }
    if (drive) {
      button.disabled = false;
      button.textContent = 'Connect OneDrive again';
      note.textContent = 'Connected to ' + driveName(drive.provider) + (drive.owner ? ' as ' + drive.owner : '') + ', kept on this browser for ' + (drive.login || 'this GitHub account') + '.' + (other ? ' Globus is connected too: press ' + (other.name || 'Globus') + ' to switch.' : '');
      note.classList.add('folders__who--quiet');
      return;
    }
    note.classList.remove('folders__who--quiet');
    button.textContent = 'Connect OneDrive';
    if (!signinAvailable()) { button.disabled = true; note.textContent = 'Connecting a drive goes through the sign-in service, which the page does not name yet.'; return; }
    if (!driveConfig) { button.disabled = false; note.textContent = ''; return; }
    if (!driveConfig.microsoft || !driveConfig.microsoft.client_id) { button.disabled = true; note.textContent = 'The owner has not set OneDrive up on the sign-in service yet, so this button cannot be pressed.'; return; }
    button.disabled = false;
    note.textContent = '';
  }
  // The drives mounted on this browser, drawn in the head as the Workers tab draws its cards: the
  // drive shown is lit, a press on the other switches to it, the eject on the lit one forgets it,
  // and the dashed card adds a drive. The eject and the dashed card are the head's own two
  // buttons, moved into the strip, so their ids and listeners stay.
  // which card's press or eject the keyboard is on, by the card's drive, or the dashed card
  function keyboardOnStrip() {
    var strip = $('fd-accounts'), active = document.activeElement;
    if (!strip || !active) return '';
    if (active === $('fd-add')) return 'add';
    if (active === $('fd-forget')) return 'eject';
    var card = strip.contains(active) && active.closest ? active.closest('.acct') : null;
    return card ? 'card:' + (card.getAttribute('data-provider') || '') : '';
  }
  function drawAccounts(other, held) {
    var strip = $('fd-accounts'), eject = $('fd-forget'), plus = $('fd-add');
    if (!strip) return;
    // redrawn only when a card would change, so the owner's name arriving, or any other redraw of
    // the state, never takes the keyboard's place from a card
    var key = [drive, other].map(function (d) { return d ? [d.provider, d.name || '', d.owner || '', d.login || ''].join('\t') : ''; }).join('\n');
    if (strip.getAttribute('data-drawn') === key) return;
    strip.setAttribute('data-drawn', key);
    // the two buttons go back to the head before the strip is cleared, so a clear never drops them
    add(strip.parentNode, eject, plus);
    clear(strip);
    strip.hidden = !drive;
    if (!drive) { if (held) focusLater($('fd-add-tile') || plus); return; }
    function card(d, on) {
      var box = el('div', 'acct' + (on ? ' acct--on' : ''));
      box.setAttribute('data-provider', d.provider);
      var pick = btn('', true, function () { if (!on) switchDrive(d); });
      pick.className = 'acct__pick';
      if (on) pick.setAttribute('aria-current', 'true');
      pick.title = on ? 'Shown now' : 'Switch to ' + accountName(d);
      var sub = d.provider === 'globus' ? [d.owner, 'read-only'].filter(Boolean).join(' \u00B7 ') : (d.owner || 'Connected');
      add(pick, el('span', 'acct__icon'), add(el('span', 'acct__words'), el('span', 'acct__name', accountName(d)), el('span', 'acct__sub', sub)));
      add(box, pick);
      return box;
    }
    var lit = card(drive, true);
    add(lit, eject);
    add(strip, lit);
    if (other) add(strip, card(other, false));
    add(strip, plus);
    // the keyboard goes back where it was: the same drive's card where it still stands, else
    // the lit card, which is the one a switch lit or a forget left
    if (held === 'add') focusLater(plus);
    else if (held) { var same = strip.querySelector('.acct[data-provider="' + held.slice(5) + '"] .acct__pick'); focusLater(held.indexOf('card:') === 0 && same ? same : lit.firstChild); }
  }
  function focusLater(node) {
    if (node && node.focus) node.focus();
  }
  function accountName(d) { return d.provider === 'globus' ? (d.name || 'Globus') : driveName(d.provider); }
  // the Globus tile needs no service: it is pressable once the page is registered at Globus
  function drawGlobusTile() {
    var tile = $('fd-globus');
    if (!tile) return;
    var sub = tile.querySelector('.clouds__sub');
    var connected = onGlobus() || !!(shownLogin && keptFor(shownLogin, 'globus'));
    tile.disabled = !GLOBUS_CLIENT;
    var word = tile.querySelector('.clouds__name');
    if (word) word.textContent = connected ? 'Connect Globus again' : 'Connect Globus';
    if (sub) sub.textContent = !GLOBUS_CLIENT ? 'Not registered at Globus yet' : (GLOBUS_KNOWN[0] ? GLOBUS_KNOWN[0].label + ' (' + GLOBUS_KNOWN[0].name + ')' : 'A Globus collection');
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
      $('fd-connect-note').classList.remove('folders__who--quiet');
      richText($('fd-connect-note'), 'The sign-in service could not say whether OneDrive is set up (' + e.message + '); press Connect OneDrive to ask it again.');
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
    var name = kept.provider === 'globus' ? 'Globus' : 'OneDrive';
    if (!ours) {
      say('The ' + name + ' connection did not come back the way it left (its state differs), so nothing was exchanged; press Connect ' + name + ' to start it again.', true);
      return Promise.resolve(true);
    }
    if (error) { say((kept.provider === 'globus' ? 'Globus' : 'Microsoft') + ' did not connect the drive (' + error.slice(0, 64) + (description ? ': ' + description.slice(0, 200) : '') + '). Press Connect ' + name + ' to try again.', true); return Promise.resolve(true); }
    if (kept.provider === 'globus') return globusReturn(kept, code);
    if (!signinAvailable()) return Promise.resolve(true);
    say('Connecting OneDrive...');
    return exchange('/drive/connect', { provider: kept.provider, code: code, code_verifier: kept.verifier, redirect_uri: driveAddress() }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without the drive\'s access token.');
      if (!answer.refresh_token) throw new Error('Microsoft gave no refresh token, so the sync could not run: the consent did not include keeping access when you are away.');
      drive = { provider: kept.provider, access: answer.access_token, refresh: answer.refresh_token, expiresAt: Date.now() + (Number(answer.expires_in) || 3600) * 1000, connected: dayOf(new Date()), owner: '', id: '', login: typeof kept.login === 'string' ? kept.login : '' };
      keepDrive(drive);
      say('OneDrive is connected, and stays connected on this browser for your GitHub account until you press Forget OneDrive. Tick what to track in the list.');
      return true;
    }).catch(function (e) { say(e.message + ' Press Connect OneDrive to try again.', true); return true; });
  }
  /* ---------- Globus: the sign-in, the tokens, the Transfer API ---------- */
  // Connect Globus: PKCE straight to Globus Auth, the pending state kept beside OneDrive's under
  // the same key, since one connection is pending at a time; the collection's consents ride on
  // the same sign-in where its id is known, else the first list asks for them (globusConsent)
  function startGlobusConnect(scopes, collection) {
    if (!GLOBUS_CLIENT) { say('This page is not registered at Globus yet, so Connect Globus cannot be pressed.', true); return; }
    if (!window.crypto || !crypto.subtle || !crypto.getRandomValues) { say('This browser cannot make the connection\'s secret (no Web Crypto).', true); return; }
    var tile = $('fd-globus');
    if (tile) tile.disabled = true;
    var state = randomHex(16);
    var verifier = randomHex(32);
    var known = collection || (drive && drive.provider === 'globus' && drive.id) || (GLOBUS_KNOWN[0] && GLOBUS_KNOWN[0].id) || '';
    var scope = scopes || (known ? globusScopes(known) : GLOBUS_SCOPE);
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      var challenge = base64url(new Uint8Array(hash));
      try {
        sessionStorage.setItem(KEY_DRIVE, JSON.stringify({ provider: 'globus', state: state, verifier: verifier, back: location.search, login: shownLogin, collection: known, scope: scope }));
      } catch (e) { if (tile) tile.disabled = false; say('This browser refuses session storage, which the connection needs to come back.', true); return; }
      location.href = GLOBUS_AUTH + '/authorize?client_id=' + encodeURIComponent(GLOBUS_CLIENT)
        + '&response_type=code&redirect_uri=' + encodeURIComponent(driveAddress())
        + '&scope=' + encodeURIComponent(scope) + '&state=' + encodeURIComponent(state)
        + '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256&access_type=offline';
    }).catch(function (e) { if (tile) tile.disabled = false; say('The connection could not start: ' + e.message, true); });
  }
  // the scopes a collection needs: the Transfer API with the collection's data_access as its
  // dependent, and the collection's HTTPS server for previews fetched into the page
  function globusScopes(collection) {
    return 'openid profile urn:globus:auth:scope:transfer.api.globus.org:all[*https://auth.globus.org/scopes/' + collection + '/data_access] https://auth.globus.org/scopes/' + collection + '/https';
  }
  // a call to Globus Auth's token endpoint, form-encoded as it takes, with no secret
  function globusTokenCall(fields, query) {
    var body = Object.keys(fields).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]); }).join('&');
    return fetch(GLOBUS_AUTH + '/token' + (query || ''), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: body, signal: within(30000) })
      .catch(function () { throw new Error('Globus Auth could not be reached.'); })
      .then(function (r) {
        return r.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
          if (!r.ok || !data || typeof data !== 'object') {
            var e = new Error('Globus Auth answered ' + r.status + (data && data.error ? ' (' + String(data.error).slice(0, 64) + (data.error_description ? ': ' + String(data.error_description).slice(0, 200) : '') + ')' : '') + '.');
            e.code = data && data.error ? String(data.error) : '';
            throw e;
          }
          return data;
        });
      });
  }
  // every token a Globus Auth answer holds, by the service it is for: the first is the sign-in's
  // own (openid), the rest ride in other_tokens
  function globusTokensOf(answer, into) {
    var tokens = into || {};
    [answer].concat(Array.isArray(answer.other_tokens) ? answer.other_tokens : []).forEach(function (t) {
      if (!t || typeof t !== 'object' || typeof t.resource_server !== 'string' || typeof t.access_token !== 'string') return;
      var had = tokens[t.resource_server] || {};
      tokens[t.resource_server] = { access: t.access_token, refresh: typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : (had.refresh || ''), expiresAt: Date.now() + (Number(t.expires_in) || 172800) * 1000 };
    });
    return tokens;
  }
  // the return from Globus Auth: the code exchanged here, in the page, then the collection found
  // and the list opened at the account's home folder on it
  function globusReturn(kept, code) {
    say('Connecting Globus...');
    return globusTokenCall({ grant_type: 'authorization_code', code: code, client_id: GLOBUS_CLIENT, code_verifier: kept.verifier, redirect_uri: driveAddress() }, '?include_consented_scopes=true').then(function (answer) {
      // a consent asked for after the first connection keeps the drive's other tokens
      var was = drive && drive.provider === 'globus' ? drive : (kept.login ? keptFor(kept.login, 'globus') : null);
      var tokens = globusTokensOf(answer, was ? was.tokens : {});
      if (!tokens[GLOBUS_RS]) throw new Error('Globus Auth gave no token for the Transfer API.');
      if (!tokens[GLOBUS_RS].refresh) throw new Error('Globus Auth gave no refresh token, so the connection could not be kept: the sign-in did not include keeping access when you are away.');
      drive = { provider: 'globus', access: '', refresh: tokens[GLOBUS_RS].refresh, expiresAt: 0, tokens: tokens, connected: was && was.connected ? was.connected : dayOf(new Date()), owner: was ? was.owner : '', id: kept.collection || (was ? was.id : ''), type: 'globus', name: was ? was.name : '', https: was ? was.https : '', home: globusHomeOf(was && was.home), login: typeof kept.login === 'string' ? kept.login : '', fresh: true };
      keepDrive(drive);
      setActiveProvider(drive.login || shownLogin, 'globus');
      say('Globus is connected, and stays connected on this browser for your GitHub account until you press Forget Globus.');
      return true;
    }).catch(function (e) { say(e.message + ' Press Connect Globus to try again.', true); return true; });
  }
  // the access token for one Globus service, renewed with its own refresh token when its two
  // days are nearly up; Globus refusing the refresh token ends the kept connection
  function globusAccess(rs) {
    var d = heldDrive();
    if (!d || d.provider !== 'globus') return Promise.reject(new Error('Globus is not connected to this page: press Connect Globus first.'));
    var t = d.tokens[rs];
    if (!t) return Promise.reject(plain('no token for ' + rs));
    if (t.access && Date.now() < t.expiresAt - 60000) return Promise.resolve(t.access);
    if (!t.refresh) return Promise.reject(plain('no refresh token for ' + rs));
    if (t.renewing) return t.renewing;
    t.renewing = globusTokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GLOBUS_CLIENT }).catch(function (e) {
      if (e.code === 'invalid_grant' && rs === GLOBUS_RS) {
        var words = 'Globus no longer takes the connection kept on this browser (' + e.message + '); press Connect Globus again.';
        forgetKept(d.login, d.refresh, 'globus');
        if (drive === d) { dropDrive(); say(words, true); }
        throw new Error(words);
      }
      // a consent withdrawn for one service alone (the collection's HTTPS, the sign-in's own)
      // loses that token; the Transfer connection goes on
      if (e.code === 'invalid_grant') { delete d.tokens[rs]; keepDrive(d); throw plain('Globus no longer takes the token for ' + rs + ' kept here; its consent is asked for again on the next press.'); }
      throw e;
    }).then(function (answer) {
      if (drive !== d) throw new Error('The connection changed while its token was renewed.');
      globusTokensOf(answer, d.tokens);
      if (!d.tokens[rs] || !d.tokens[rs].access) throw new Error('Globus Auth answered without an access token for ' + rs + '.');
      keepDrive(d);
      return d.tokens[rs].access;
    });
    var done = function () { t.renewing = null; };
    t.renewing.then(done, done);
    return t.renewing;
  }
  // a read of the Transfer API as the person; an error carries Globus's code, and ConsentRequired
  // its required_scopes
  function transfer(path) {
    return globusAccess(GLOBUS_RS).then(function (access) {
      return fetch(GLOBUS_TRANSFER + path, { headers: { 'Authorization': 'Bearer ' + access, 'Accept': 'application/json' }, redirect: 'error', signal: within(60000) }).catch(function () { throw new Error('The Globus Transfer API could not be reached.'); });
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var e = new Error('Globus answered ' + r.status + (data && data.message ? ': ' + String(data.message).slice(0, 200) : '') + '.');
          e.status = r.status;
          e.code = data && typeof data.code === 'string' ? data.code : '';
          e.scopes = data && Array.isArray(data.required_scopes) ? data.required_scopes.filter(function (s) { return typeof s === 'string'; }) : [];
          if (r.status === 401) e.message = 'Globus refused the connection\'s token (401); press Connect Globus again.';
          throw e;
        }
        return data || {};
      });
    });
  }
  // the collection, by its id or by the known name: its address for files and its home folder
  function globusSetup() {
    var d = drive;
    var found = d.id ? Promise.resolve(d.id) : transfer('/endpoint_search?filter_scope=all&limit=5&filter_fulltext=' + encodeURIComponent(GLOBUS_KNOWN[0] ? GLOBUS_KNOWN[0].name : '')).then(function (r) {
      var want = GLOBUS_KNOWN[0] ? GLOBUS_KNOWN[0].name.toLowerCase() : '';
      var hits = Array.isArray(r.DATA) ? r.DATA.filter(function (c) { return c && typeof c.id === 'string'; }) : [];
      // the name must match exactly, in either of the names Globus gives: the search ranks by
      // words, and its first hit can be a stranger's collection with a similar name
      var hit = hits.filter(function (c) { return String(c.display_name || '').toLowerCase() === want || String(c.canonical_name || '').toLowerCase() === want; })[0];
      if (!hit) throw plain('Globus found no collection named ' + (GLOBUS_KNOWN[0] ? GLOBUS_KNOWN[0].name : '') + ' that you may see.');
      return hit.id;
    });
    return found.then(function (id) {
      return transfer('/endpoint/' + encodeURIComponent(id)).then(function (c) {
        if (drive !== d) return;
        d.id = id;
        d.name = String(c.display_name || (GLOBUS_KNOWN[0] && GLOBUS_KNOWN[0].label) || 'Globus');
        d.https = httpsOnly(c.https_server);
        d.home = globusHomeOf(c.default_directory);
        keepDrive(d);
        showConnectState();
      });
    });
  }
  // a collection's default folder is a path only when Globus gives one: '/~/' and a placeholder
  // such as {server_default} say that the server decides, and the first listing's absolute_path
  // then says where that is
  function globusHomeOf(p) {
    p = typeof p === 'string' ? p : '';
    return p && p !== '/~/' && p.indexOf('{') < 0 ? p : '';
  }
  // a Globus folder path as the tab keeps it: absolute, ending in a slash
  function globusPath(p) {
    p = String(p || '');
    if (!p) return '/';
    if (p.charAt(0) !== '/') p = '/' + p;
    return p.charAt(p.length - 1) === '/' ? p : p + '/';
  }
  function globusCrumbs(abs) {
    var out = [], so = '/';
    globusPath(abs).split('/').filter(Boolean).forEach(function (seg) { so += seg + '/'; out.push({ id: so, name: seg }); });
    return out;
  }
  // the account's home folder on the collection opened, the path above it walked for Up; a
  // folder the grid will not show opens the root instead
  function globusHome() {
    var d = drive;
    explorer.items = [];
    explorer.loading = true;
    drawBrowser();
    return (d.id && d.name ? Promise.resolve() : globusSetup()).then(function () {
      if (drive !== d) return;
      var home = globusHomeOf(d.home);
      return (home ? Promise.resolve(home) : transfer('/operation/endpoint/' + encodeURIComponent(d.id) + '/ls?limit=1').then(function (r) { return typeof r.absolute_path === 'string' ? r.absolute_path : '/'; }).catch(function (e) { if (e.code === 'ConsentRequired') throw e; return '/'; })).then(function (abs) {
        if (drive !== d) return;
        d.home = globusPath(abs);
        keepDrive(d);
        crumbs = globusCrumbs(abs);
        explorer.back = [];
        listFolder();
      });
    }).catch(function (e) {
      if (drive !== d) return;
      var main = $('fd-main');
      if (e.code === 'ConsentRequired') { globusConsent(e.scopes); return; }
      if (main) { clear(main); globusTrouble(main, 'The collection could not be read: ' + e.message); }
    });
  }
  // what to press when the collection will not read here: the same folder in Globus's own file
  // manager, Connect Globus again, the consents, Globus's status; and Beethoven for a shell or a
  // job on the grid, which Globus, a file service, never gives
  function globusTrouble(main, why) {
    var d = drive, at = here() && !here().search ? String(here().id || '') : (d && d.home) || '/';
    var p = el('p', 'admin__none fx__trouble');
    if (why) add(p, el('strong', '', why), ' ');
    add(p, 'Try it in ', link(GLOBUS_MANAGER + (d && d.id ? '?origin_id=' + encodeURIComponent(d.id) + '&origin_path=' + encodeURIComponent(at) : ''), 'Globus\'s own file manager'), ', which says what the collection answers; ');
    add(p, btn('Connect Globus again', true, function () { startGlobusConnect('', d && d.id); }), ' for a fresh sign-in; ');
    add(p, 'check ', link(GLOBUS_CONSENTS, 'your Globus consents'), ' and ', link(GLOBUS_STATUS, 'Globus\'s status'), '.');
    main.appendChild(p);
    var q = el('p', 'admin__none fx__trouble');
    add(q, 'Globus moves and streams files only. A shell, a job or Claude Code on the grid is Beethoven\'s: ', link(BEETHOVEN_PAGE, 'what Beethoven does'), ', ', link(BEETHOVEN_STORE, 'install Beethoven in Chrome'), ' (an approved account), then press its button in the toolbar; the portal itself is ', link('https://ondemand.grid.wayne.edu', 'OnDemand'), ' on the VPN.');
    main.appendChild(q);
  }
  // the collection asks for a consent of its own (data_access, on a mapped collection): one more
  // sign-in page, at once after Connect Globus, else on a press, so the page never leaves on its own
  function globusConsent(scopes) {
    var d = drive;
    var asked = (scopes && scopes.length ? scopes : []).concat(d.id ? ['https://auth.globus.org/scopes/' + d.id + '/https'] : []);
    var scope = ('openid profile ' + asked.filter(function (s, i) { return asked.indexOf(s) === i; }).join(' ')).trim();
    var hopped = '';
    try { hopped = sessionStorage.getItem(GLOBUS_HOP) || ''; } catch (e) { hopped = 'unknown'; }
    if (d.fresh && hopped !== String(d.id || 'none')) {
      d.fresh = false;
      try { sessionStorage.setItem(GLOBUS_HOP, String(d.id || 'none')); } catch (e) { /* the button below is the way then */ }
      startGlobusConnect(scope, d.id);
      return;
    }
    d.fresh = false;
    var main = $('fd-main');
    if (!main) return;
    clear(main);
    var p = none(main, (d.name || 'The collection') + ' needs your consent before Globus lists it for this page' + (hopped === String(d.id || 'none') ? ', and the consent Globus took a moment ago did not cover it' : '') + '. ');
    add(p, btn('Allow it at Globus', false, function () { startGlobusConnect(scope, d.id); }));
    globusTrouble(main, '');
  }
  // one folder of the collection as the Transfer API lists it, in the list's own shape: a folder's
  // id is its path with a slash at the end, a file's its path, and a file's address is the
  // collection's HTTPS server's; a search is the folder's own entries filtered by name
  function globusList(folder, filter) {
    var d = drive;
    // the tree asks for the root's folders while the collection is still being looked up
    if (!d.id) return Promise.resolve([]);
    var abs = globusPath(folder);
    var q = '/operation/endpoint/' + encodeURIComponent(d.id) + '/ls?path=' + encodeURIComponent(abs) + '&show_hidden=false&limit=' + GLOBUS_PAGE;
    if (filter) q += '&filter=' + encodeURIComponent('name:~*' + filter.replace(/[*?\/,]/g, ' ').trim() + '*');
    return transfer(q).then(function (r) {
      try { sessionStorage.removeItem(GLOBUS_HOP); } catch (e) { /* nothing kept */ }
      var at = globusPath(typeof r.absolute_path === 'string' && r.absolute_path ? r.absolute_path : abs);
      var rows = Array.isArray(r.DATA) ? r.DATA.filter(function (f) { return f && typeof f === 'object' && typeof f.name === 'string' && f.name; }) : [];
      var out = rows.map(function (f) { return globusItem(f, at, d); });
      out.cut = rows.length >= GLOBUS_PAGE || (typeof r.total === 'number' && r.total > rows.length);
      return out;
    });
  }
  function globusItem(f, at, d) {
    var dir = f.type === 'dir';
    var when = typeof f.last_modified === 'string' ? f.last_modified.replace(' ', 'T') : '';
    var it = { id: dir ? at + f.name + '/' : at + f.name, name: f.name, size: typeof f.size === 'number' && !dir ? f.size : undefined, lastModifiedDateTime: when, parentReference: { id: at, path: '/drive/root:' + at.split('/').map(encodeURIComponent).join('/').replace(/\/$/, '') }, webUrl: d.https ? d.https + at.split('/').map(encodeURIComponent).join('/') + encodeURIComponent(f.name) : '', globus: { type: String(f.type || ''), permissions: String(f.permissions || ''), user: f.user == null ? '' : String(f.user), group: f.group == null ? '' : String(f.group), link: f.link_target == null ? '' : String(f.link_target) } };
    if (dir) it.folder = {};
    return it;
  }
  // a file of the collection fetched into the page with the collection's own token, for the
  // preview pane; the server must allow the page's origin, which the double click never needs
  function globusFetch(it) {
    var d = drive;
    if (!d || !d.https || !it.webUrl) return Promise.reject(plain('no address'));
    if (typeof it.size === 'number' && it.size > GLOBUS_PREVIEW_MAX) return Promise.reject(plain('too large to preview here'));
    // the collection's own token: asked for on the sign-in where the collection was known, else
    // on a press (the preview pane offers it), since the first sign-in may have known no collection
    if (!d.tokens[d.id]) { var missing = plain('this page is not yet allowed to fetch the collection\'s files'); missing.code = 'NoCollectionToken'; return Promise.reject(missing); }
    return globusAccess(d.id).then(function (access) {
      return fetch(it.webUrl, { headers: { 'Authorization': 'Bearer ' + access }, redirect: 'error', signal: within(120000) });
    }).then(function (r) {
      if (!r.ok) throw plain('the collection answered ' + r.status);
      return r.blob();
    });
  }

  // the access token for a Graph call, renewed through the service when its hour is nearly up
  function driveAccess() {
    var d = heldDrive();
    if (!d) return Promise.reject(new Error('No drive is connected to this page: press Connect OneDrive first.'));
    if (d.provider === 'globus') return Promise.reject(new Error('The drive connected is Globus, which Microsoft Graph does not reach.'));
    if (Date.now() < d.expiresAt - 60000) return Promise.resolve(d.access);
    // the calls that find the token run out together, as the drive's name and its list do after a
    // reload, share one renewal
    if (d.renewing) return d.renewing;
    d.renewing = exchange('/drive/token', { provider: d.provider, refresh_token: d.refresh }).catch(function (e) {
      // Microsoft refusing the refresh token (withdrawn, or past its days) ends the kept connection too
      if (e.code === 'invalid_grant') {
        var words = 'Microsoft no longer takes the OneDrive connection kept on this browser (' + e.message + '); press Connect OneDrive again.';
        forgetKept(d.login, d.refresh);
        if (drive === d) { dropDrive(); say(words, true); }
        throw new Error(words);
      }
      throw e;
    }).then(function (answer) {
      if (!answer.access_token) throw new Error('The sign-in service answered without an access token.');
      if (drive !== d) throw new Error('The connection changed while its token was renewed.');
      d.access = answer.access_token;
      d.expiresAt = Date.now() + (Number(answer.expires_in) || 3600) * 1000;
      return d.access;
    });
    var done = function () { d.renewing = null; };
    d.renewing.then(done, done);
    return d.renewing;
  }
  // a call to Graph as the drive's owner: a read (GET, the default), or a write with a JSON body or,
  // given its type, the bytes of a file; a full address is Graph's next page, and the token goes to
  // Graph alone
  function graph(url, method, body, type) {
    return driveAccess().then(function (access) {
      var full = url.indexOf(GRAPH + '/') === 0 ? url : GRAPH + url;
      var headers = { 'Authorization': 'Bearer ' + access, 'Accept': 'application/json' };
      var sent;
      if (body != null) { headers['Content-Type'] = type || 'application/json'; sent = type ? body : JSON.stringify(body); }
      return fetch(full, { method: method || 'GET', headers: headers, body: sent, signal: within(type ? 600000 : 30000) }).catch(function () { throw new Error('Microsoft Graph could not be reached.'); });
    }).then(graphAnswer);
  }
  function graphAnswer(r) {
    return r.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
      if (!r.ok) {
        var m = data && data.error && data.error.message ? ': ' + String(data.error.message).slice(0, 200) : '';
        if (r.status === 401) throw new Error('Microsoft refused the drive\'s token (401' + m + '); press Connect OneDrive again.');
        var e = new Error('Microsoft Graph answered ' + r.status + m + '.');
        e.status = r.status;
        throw e;
      }
      return data || {};
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
    var asked = drive;
    if (asked && asked.provider === 'globus') {
      // who is signed in at Globus, a nicety from Globus Auth's own userinfo
      return globusAccess('auth.globus.org').then(function (access) {
        return fetch(GLOBUS_AUTH + '/userinfo', { headers: { 'Authorization': 'Bearer ' + access, 'Accept': 'application/json' }, signal: within(20000) }).then(function (r) { return r.ok ? r.json() : {}; });
      }).then(function (u) {
        if (!drive || drive !== asked) return;
        drive.owner = String(u.preferred_username || u.name || '');
        keepDrive(drive);
        showConnectState();
      }).catch(function () { /* the name is a nicety; the list says the rest */ });
    }
    return graph('/me/drive?$select=id,driveType,owner').then(function (d) {
      if (!drive || drive !== asked) return;
      var who = d.owner && d.owner.user ? d.owner.user.displayName : '';
      drive.owner = (who || '') + (d.driveType ? ' (' + d.driveType + ')' : '');
      drive.id = typeof d.id === 'string' ? d.id : '';
      drive.type = typeof d.driveType === 'string' ? d.driveType : '';
      keepDrive(drive);
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
    // the head's button says how much is ticked, in every folder, since the list shows one folder
    $('fd-track-open').textContent = pickedOrder.length ? 'Track in a repository (' + pickedOrder.length + ' ticked)' : 'Track in a repository';
    // the drive's list shows what is ticked, whichever answered first, the drive's or the repository's
    Array.prototype.forEach.call(document.querySelectorAll('#fd-items input[data-id]'), function (box) { box.checked = !!picked[box.getAttribute('data-id')]; });
  }
  /* ---------- the drive's list, drawn as a file explorer ---------- */
  // The list reads as Windows' File Explorer does: a folder tree on the left, an address bar with
  // Back, Forward and Up, a command bar, the folder's items in six views, sorted by a column's
  // heading, an optional preview pane, and a status bar. A double click opens a folder, or a Word,
  // Excel or PowerPoint file in its desktop app through Office's own address scheme, where it is
  // edited in place on the drive; any other file opens on OneDrive's own page. The verbs that write
  // (New folder, Upload, Rename, Delete, Cut, Copy and Paste, Share) act on the drive through
  // Graph as its owner, each only on a press of the person's own; the ticks are what Track records,
  // as before, and are apart from the selection.
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
  // Explorer's six views, in the order its View menu gives them; the status bar keeps two of them
  var VIEWS = [['icons', 'Large icons'], ['small', 'Small icons'], ['list', 'List'], ['details', 'Details'], ['tiles', 'Tiles'], ['content', 'Content']];
  // a file up to this size goes up in one request; a larger one through an upload session, in
  // pieces that are a multiple of 320 KiB, as Graph requires
  var UPLOAD_SIMPLE = 4 * 1024 * 1024;
  var UPLOAD_PIECE = 320 * 1024 * 10;
  // the characters and names OneDrive refuses in a name, Windows' own rules
  var BAD_NAME = /["*:<>?\/\\|]/;
  var RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|\.lock|desktop\.ini|_vti_)(\..*)?$/i;
  var explorer = { view: 'details', sort: 'name', down: false, filter: '', back: [], forward: [], items: [], selected: '', sel: Object.create(null), anchor: '', clip: null, busy: false, renaming: '', parentKey: Object.create(null), preview: false, previews: Object.create(null), thumbs: true, open: Object.create(null), cache: Object.create(null), cacheFor: null };

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
  function bytesWord(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? Math.max(1, Math.round(n / 1024)).toLocaleString('en-US') + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  }
  function sizeOf(it) {
    if (it.folder) return typeof it.folder.childCount === 'number' ? plural(it.folder.childCount, 'item') : '';
    if (typeof it.size !== 'number') return '';
    return bytesWord(it.size);
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
  // the folder an item sits in, as a path to read, from the drive's root ("" for the root itself)
  function folderPath(it) {
    var ref = it.parentReference || {};
    if (typeof ref.path !== 'string') return null;
    return ref.path.replace(/^\/drive(s\/[^\/]+)?\/root:?/, '').split('/').filter(Boolean).map(plainSegment).join('/');
  }
  function openInBrowser(it) {
    var url = httpsOnly(it.webUrl);
    if (!url) { say((onGlobus() ? 'The collection has no HTTPS address, so ' + it.name + ' cannot be opened in the browser; Globus\'s own file manager transfers it instead.' : 'OneDrive gave no address for ' + it.name + '.'), true, true); return; }
    window.open(url, '_blank', 'noopener');
    // the collection's server asks for a Globus sign-in in the new tab the first time, then
    // remembers it; the file streams from there, with no download
    if (onGlobus()) say('Opening ' + it.name + ' from ' + rootName() + ' in a new tab. The first time, Globus asks you to sign in there; after that files open at once.', false, true);
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
    say('Opening ' + it.name + ' in ' + appName(app) + '. If nothing opens, the app is not installed here: right-click the file and choose Open in the browser.', false, true);
  }
  function appName(app) { return { 'ms-word': 'Word', 'ms-excel': 'Excel', 'ms-powerpoint': 'PowerPoint', 'ms-visio': 'Visio' }[app] || 'its app'; }
  function openItem(it) {
    // a folder found by a search opens on its own, since the folders above it were never walked
    if (it.folder && onGlobus()) { go(globusCrumbs(String(it.id))); return; }
    if (it.folder) { go((searching() ? [] : crumbs).concat([{ id: String(it.id), name: String(it.name || ''), url: httpsOnly(it.webUrl) }])); return; }
    if (officeApp(it) && canWrite()) openInApp(it); else openInBrowser(it);
  }

  // a mark for an item's kind, drawn here, so no picture comes from anywhere; its letters are the
  // stylesheet's, from data-letter, so they are never part of the name's text. Where OneDrive made a
  // thumbnail and the view is large enough to show one, the thumbnail stands in its place
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
  function thumbOf(it) {
    var t = Array.isArray(it.thumbnails) && it.thumbnails[0] && it.thumbnails[0].medium;
    return t ? httpsOnly(t.url) : '';
  }
  function bigIcon(it, size) {
    var url = !it.folder && thumbOf(it);
    if (!url) return kindIcon(it, size);
    var img = el('img', 'fx__thumb');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.setProperty('--s', size + 'px');
    img.addEventListener('error', function () { img.replaceWith(kindIcon(it, size)); });
    return img;
  }

  // what the list holds, read once per folder per connection and kept until Refresh or a write
  // changes it; the tree and the list share one read of a folder, the one in flight included
  function cachedRead(key) {
    if (explorer.cacheFor !== drive) { explorer.cache = Object.create(null); explorer.open = Object.create(null); explorer.previews = Object.create(null); explorer.clip = null; explorer.cacheFor = drive; }
    return explorer.cache[key];
  }
  function listAddress(id) {
    // thumbnails come with the list where OneDrive will give them; once it refuses, never again
    var select = GRAPH_SELECT + (explorer.thumbs ? '&$expand=thumbnails($select=medium)' : '');
    return id ? '/me/drive/items/' + encodeURIComponent(id) + '/children' + select : '/me/drive/root/children' + select;
  }
  function readChildren(id) {
    if (onGlobus()) return readList(id || 'root', function () { return globusList(id || '/', ''); });
    return readList(id || 'root', function () { return listAddress(id); });
  }
  // the drive's own search, which looks through every folder, names and words inside the files alike
  function searchAddress(q) {
    return '/me/drive/root/search(q=\'' + encodeURIComponent(q.replace(/'/g, '\'\'')) + '\')' + GRAPH_SELECT;
  }
  function readList(key, address) {
    var have = cachedRead(key);
    if (have) return have;
    var d = drive;
    // on Globus the address function is the read itself; on OneDrive it names Graph's page
    var read = (onGlobus() ? address() : graphChildren(address()).catch(function (e) {
      if (e.status !== 400 || !explorer.thumbs || key.indexOf('search:') === 0) throw e;
      explorer.thumbs = false;
      return graphChildren(address());
    })).then(function (items) {
      var kept = items.filter(function (it) { return it && typeof it === 'object'; });
      kept.cut = !!items.cut;
      // the list a folder's own id names, the root's among them, so a write found by its item's
      // parent drops the right list
      if (key.indexOf('search:') !== 0) kept.forEach(function (it) { var p = it.parentReference && it.parentReference.id; if (typeof p === 'string' && p) explorer.parentKey[p] = key; });
      return kept;
    });
    explorer.cache[key] = read;
    read.catch(function () { if (d === drive && explorer.cache[key] === read) delete explorer.cache[key]; });
    return read;
  }
  // a path's last name, as the drive organizer's catalog writes paths (the Notebooks tab reads them)
  function catLast(path) { var s = String(path || '').split('/').filter(Boolean); return s.length ? s[s.length - 1] : ''; }
  function resetExplorer() {
    explorer.back = []; explorer.forward = []; explorer.items = []; explorer.filter = '';
    explorer.cache = Object.create(null); explorer.open = Object.create(null); explorer.previews = Object.create(null); explorer.cacheFor = null; explorer.clip = null;
    selectNone();
  }
  // where the list is: a folder (its id, '' for the root), or the results of a search of the drive
  function here() { return crumbs.length ? crumbs[crumbs.length - 1] : null; }
  function searching() { var h = here(); return !!(h && h.search); }
  function hereKey() { var h = here(); return !h ? 'root' : h.search ? 'search:' + (h.id || '') + ':' + h.search : h.id; }
  // the folder new things go into: the one shown, or none while search results are shown
  function hereFolder() { return searching() ? null : (here() ? here().id : ''); }
  function hereName() { var h = here(); return h ? h.name : rootName(); }
  // moving to a folder: the path walked is kept for Back, and Forward is cleared, as Explorer does
  // on a phone the preview covers the list, so moving to another folder closes it
  function narrow() { return window.matchMedia && window.matchMedia('(max-width: 900px)').matches; }
  function go(path) {
    if (narrow()) explorer.preview = false;
    explorer.back.push(crumbs.slice());
    explorer.forward = [];
    crumbs = path;
    explorer.filter = '';
    selectNone();
    listFolder();
  }
  function goBack() { if (!explorer.back.length) return; explorer.forward.push(crumbs.slice()); crumbs = explorer.back.pop(); explorer.filter = ''; selectNone(); listFolder(); }
  function goForward() { if (!explorer.forward.length) return; explorer.back.push(crumbs.slice()); crumbs = explorer.forward.pop(); explorer.filter = ''; selectNone(); listFolder(); }
  function goUp() { if (crumbs.length) go(crumbs.slice(0, -1)); }
  function searchDrive(q) {
    q = String(q || '').trim();
    if (!q) return;
    var base = crumbs.filter(function (c) { return !c.search; });
    // on Globus a path typed into the box opens that folder, and a word looks through the folder
    // shown by name, since the Transfer API lists one folder at a time
    if (onGlobus() && q.charAt(0) === '/') { go(globusCrumbs(q)); return; }
    if (onGlobus()) { go(base.concat([{ id: base.length ? base[base.length - 1].id : '/', search: q, name: 'Names matching "' + q + '" in ' + (base.length ? base[base.length - 1].name : rootName()) }])); return; }
    go(base.concat([{ id: '', search: q, name: 'Search results for "' + q + '"' }]));
  }

  function toolButton(label, title, enabled, onClick) {
    var b = btn(label, true, onClick);
    b.className = 'fx__tool';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !enabled;
    return b;
  }
  // the command bar's buttons, each with what it needs to be pressed, set again on every change of
  // the selection, the clipboard or the folder
  // the verbs that write stay off on a drive the page reads only (Globus)
  var COMMANDS = [
    ['new', 'New folder', 'New folder (Ctrl+Shift+N or Ctrl+Alt+N)', function () { return canWrite() && hereFolder() !== null; }, function () { newFolder(); }],
    ['upload', 'Upload', 'Upload files into this folder, or drop them on the list', function () { return canWrite() && hereFolder() !== null; }, function () { pickUpload(hereFolder()); }],
    ['cut', 'Cut', 'Cut (Ctrl+X)', function (n) { return canWrite() && n > 0; }, function () { clip('cut'); }],
    ['copy', 'Copy', 'Copy (Ctrl+C)', function (n) { return canWrite() && n > 0; }, function () { clip('copy'); }],
    ['paste', 'Paste', 'Paste (Ctrl+V)', function () { return canWrite() && !!explorer.clip && hereFolder() !== null; }, function () { paste(hereFolder()); }],
    ['rename', 'Rename', 'Rename (F2)', function (n) { return canWrite() && n === 1; }, function () { startRename(selectedItems()[0]); }],
    ['share', 'Share', 'Make a sharing link', function (n) { return canWrite() && n === 1; }, function () { shareDialog(selectedItems()[0]); }],
    ['delete', 'Delete', 'Delete to the recycle bin (Delete)', function (n) { return canWrite() && n > 0; }, function () { askDelete(selectedItems()); }],
    ['download', 'Download', 'Download the selected files', function (n) { return n > 0 && selectedItems().some(function (it) { return !it.folder; }); }, function () { download(selectedItems()); }],
    ['props', 'Properties', 'Properties (Alt+Enter)', function (n) { return n > 0; }, function () { properties(selectedItems()); }]
  ];
  function drawCommands() {
    var n = selectedItems().length;
    COMMANDS.forEach(function (c) { var b = $('fx-cmd-' + c[0]); if (b) b.disabled = !c[3](n); });
    var p = $('fx-cmd-pane');
    if (p) p.setAttribute('aria-pressed', String(explorer.preview));
  }
  function drawBrowser() {
    var box = $('fd-browser');
    clear(box);
    hideMenu();
    if (!drive) {
      // nothing connected: one dashed tile, as + Add repository is, opening the drives to choose from
      var start = el('div', 'folders__start');
      var tile = el('button', 'folders__addtile', '+ Add a cloud drive');
      tile.type = 'button';
      tile.id = 'fd-add-tile';
      tile.setAttribute('data-open', 'dlg-cloud');
      add(start, tile, el('p', 'folders__startnote', 'Your files and folders are drawn here as File Explorer draws them, read as you, in this browser, once a drive is connected.'));
      add(box, start);
      return;
    }
    var win = el('div', 'fx');
    // the toolbar: Back, Forward, Up, Refresh, the address and the search box
    var bar = el('div', 'fx__bar');
    add(bar, toolButton('←', 'Back (Alt+Left)', explorer.back.length > 0, goBack),
      toolButton('→', 'Forward (Alt+Right)', explorer.forward.length > 0, goForward),
      toolButton('↑', 'Up to the folder above (Backspace)', crumbs.length > 0, goUp),
      toolButton('↻', 'Refresh (F5)', true, refresh));
    var address = el('nav', 'fx__address folders__crumbs');
    address.setAttribute('aria-label', 'Where you are in the drive');
    add(address, btn(rootName(), true, function () { if (crumbs.length) go([]); }));
    crumbs.forEach(function (c, i) {
      var b = btn(c.name, true, function () { if (i < crumbs.length - 1) go(crumbs.slice(0, i + 1)); });
      if (!c.search && canWrite()) dropTarget(b, c.id);
      add(address, el('span', 'fx__sep', '›'), b);
    });
    bar.appendChild(address);
    var search = el('input', 'fx__search');
    search.type = 'search';
    search.id = 'fd-search';
    search.placeholder = 'Search ' + (searching() ? rootName() : hereName());
    search.title = onGlobus() ? 'Typing narrows this folder; Enter asks the collection for the names, or opens a path that starts with /' : 'Typing narrows this folder; Enter searches all of OneDrive';
    search.setAttribute('aria-label', search.placeholder + (onGlobus() ? '; Enter asks the collection, or opens a path' : '; Enter searches all of OneDrive'));
    search.value = explorer.filter;
    search.addEventListener('input', function () { explorer.filter = search.value; drawItems(); });
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); searchDrive(search.value); }
      else if (ev.key === 'Escape' && search.value) { ev.preventDefault(); search.value = ''; explorer.filter = ''; drawItems(); }
    });
    bar.appendChild(search);
    win.appendChild(bar);
    // the command bar, Windows 11's row of verbs under the address
    var cmds = el('div', 'fx__cmds');
    cmds.setAttribute('role', 'toolbar');
    cmds.setAttribute('aria-label', 'Commands');
    COMMANDS.forEach(function (c, i) {
      var b = toolButton(c[1], c[2], false, c[4]);
      b.id = 'fx-cmd-' + c[0];
      if (i === 2 || i === 5 || i === 8) cmds.appendChild(el('span', 'fx__cmdsep'));
      cmds.appendChild(b);
    });
    cmds.appendChild(el('span', 'fx__cmdsep'));
    var view = toolButton('View ▾', 'Choose the view', true, function (ev) { var r = ev.currentTarget.getBoundingClientRect(); viewMenu(r.left, r.bottom + 2); });
    view.id = 'fx-cmd-view';
    view.setAttribute('aria-haspopup', 'menu');
    var pane = toolButton('Preview', 'Preview pane (Alt+P)', true, togglePreview);
    pane.id = 'fx-cmd-pane';
    add(cmds, view, pane);
    win.appendChild(cmds);
    var body = el('div', 'fx__body');
    var tree = el('div', 'fx__tree');
    tree.id = 'fd-tree';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Folders');
    body.appendChild(tree);
    var main = el('div', 'fx__main');
    main.id = 'fd-main';
    main.tabIndex = 0;
    main.setAttribute('aria-label', 'Items in ' + hereName());
    main.setAttribute('aria-multiselectable', 'true');
    main.addEventListener('keydown', onExplorerKey);
    main.addEventListener('contextmenu', function (ev) { if (ev.target === main || ev.target.classList.contains('fx__grid') || ev.target.classList.contains('admin__none')) { ev.preventDefault(); selectNone(); showMenu(null, ev.clientX, ev.clientY); } });
    main.addEventListener('click', function (ev) { if (ev.target === main || ev.target.classList.contains('fx__grid')) selectNone(); });
    if (!searching() && canWrite()) dropTarget(main, hereFolder());
    none(main, 'Reading ' + (crumbs.length ? hereName() : onGlobus() ? rootName() : 'your files') + '...');
    body.appendChild(main);
    var preview = el('aside', 'fx__preview');
    preview.id = 'fd-preview';
    preview.setAttribute('aria-label', 'Preview');
    preview.hidden = !explorer.preview;
    body.appendChild(preview);
    win.appendChild(body);
    // the status bar, with the two views at its right as Explorer keeps them
    var foot = el('div', 'fx__foot');
    var status = el('div', 'fx__status');
    status.id = 'fd-status';
    status.setAttribute('aria-live', 'polite');
    var views = el('div', 'fx__views');
    [['details', 'Details'], ['icons', 'Large icons']].forEach(function (v) {
      var b = toolButton(v[1], v[1] + ' view', true, function () { setView(v[0]); });
      b.setAttribute('aria-pressed', String(explorer.view === v[0]));
      views.appendChild(b);
    });
    add(foot, status, views);
    win.appendChild(foot);
    box.appendChild(win);
    var input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'fd-upload';
    input.hidden = true;
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      var to = input.getAttribute('data-to');
      input.value = '';
      if (files.length && to !== null) upload(files, to);
    });
    box.appendChild(input);
    drawTree();
    drawCommands();
    drawPreview();
  }
  function setView(v) {
    explorer.view = v;
    Array.prototype.forEach.call(document.querySelectorAll('#tab-folders .fx__views .fx__tool'), function (b) { b.setAttribute('aria-pressed', String(b.textContent === (v === 'details' ? 'Details' : v === 'icons' ? 'Large icons' : ''))); });
    drawItems();
  }
  function listFolder() {
    // what another folder held is never drawn, or acted on, under this one's address
    explorer.items = [];
    explorer.loading = true;
    drawBrowser();
    return relist();
  }
  // the list read again for where it is, without drawing the browser anew; a write's answer ends
  // here, so the bar, the tree and the focus stay where they were
  function relist() {
    var asked = ++listing;
    if (!heldDrive()) return Promise.resolve();
    var h = here();
    var read = h && h.search ? readList(hereKey(), function () { return onGlobus() ? globusList(h.id, h.search) : searchAddress(h.search); }) : readChildren(h ? h.id : '');
    return read.then(function (items) {
      if (asked !== listing) return;
      explorer.items = items;
      explorer.loading = false;
      // what is selected and no longer here is let go
      Object.keys(explorer.sel).forEach(function (id) { if (!items.some(function (it) { return String(it.id) === id; })) delete explorer.sel[id]; });
      if (explorer.selected && !explorer.sel[explorer.selected]) explorer.selected = '';
      drawItems();
    }).catch(function (e) {
      if (asked !== listing) return;
      explorer.items = [];
      explorer.loading = false;
      selectNone();
      var main = $('fd-main');
      // a Globus collection whose consent is missing asks for it in the list's place
      if (e.code === 'ConsentRequired' && onGlobus()) { globusConsent(e.scopes); return; }
      if (main) { clear(main); if (onGlobus()) globusTrouble(main, 'The list could not be read: ' + e.message); else none(main, 'The list could not be read: ' + e.message); }
    });
  }
  // a folder's list read again after a write changed it, and the list shown read again where it
  // is that folder or the results of a search; the tree is drawn again for a folder's change
  function changed(keys) {
    keys.forEach(function (k) {
      var key = k === '' || k == null ? 'root' : explorer.parentKey[k] || k;
      delete explorer.cache[key];
    });
    Object.keys(explorer.cache).forEach(function (k) { if (k.indexOf('search:') === 0) delete explorer.cache[k]; });
    drawTree();
    return relist();
  }
  function refresh() {
    delete explorer.cache[hereKey()];
    explorer.previews = Object.create(null);
    return listFolder();
  }
  function sortedItems() {
    var q = explorer.filter.trim().toLowerCase();
    var list = explorer.items.filter(function (it) { return !q || String(it.name || '').toLowerCase().indexOf(q) >= 0; });
    var key = explorer.sort, dir = explorer.down ? -1 : 1;
    function value(it) {
      if (key === 'changed') return it.lastModifiedDateTime || '';
      if (key === 'type') return kindName(it).toLowerCase();
      if (key === 'size') return it.folder ? (it.folder.childCount || 0) : (it.size || 0);
      if (key === 'where') return String(folderPath(it) || '').toLowerCase();
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
    if (!main || explorer.loading) return;
    // a name being edited is never drawn over; its end draws the list
    if (explorer.renaming) return;
    clear(main);
    var list = sortedItems();
    if (explorer.view === 'details') main.appendChild(detailsTable(list));
    else if (explorer.view === 'icons') main.appendChild(iconGrid(list));
    else main.appendChild(itemFlow(list, explorer.view));
    if (!explorer.items.length) none(main, searching() ? 'Nothing in ' + (onGlobus() ? 'this folder' : 'OneDrive') + ' matches "' + here().search + '".' : 'This folder is empty.');
    else if (!list.length) none(main, 'Nothing here matches "' + explorer.filter + '".');
    if (explorer.items.cut) none(main, 'More than ' + (onGlobus() ? GLOBUS_PAGE : GRAPH_PAGES * 200) + ' items are here; only the first are listed.' + (searching() || onGlobus() ? ' Search for something narrower.' : ' Tick the folder itself to track them all.'));
    drawStatus(list);
    drawPicked();
    drawCommands();
    drawPreview();
  }
  function drawStatus(list) {
    var status = $('fd-status');
    if (!status) return;
    var ticked = list.filter(function (it) { return picked[String(it.id || '')]; }).length;
    var chosen = selectedItems(), bytes = 0;
    chosen.forEach(function (it) { if (!it.folder && typeof it.size === 'number') bytes += it.size; });
    var sel = chosen.length ? '   ' + chosen.length + ' selected' + (bytes ? '  ' + bytesWord(bytes) : '') : '';
    var clipped = explorer.clip ? '   ' + plural(explorer.clip.items.length, 'item') + ' to ' + (explorer.clip.mode === 'cut' ? 'move' : 'copy') : '';
    status.textContent = plural(list.length, 'item') + sel + (ticked && !onGlobus() ? '   ' + ticked + ' ticked' : '') + clipped + '   Double-click to open; right-click for more.' + (onGlobus() ? '   Read-only.' : '');
  }
  // the ticks are what Track records of OneDrive; a Globus collection is read here, never tracked
  function tickBox(it) {
    if (onGlobus()) return el('span', 'fx__notick');
    var box = el('input');
    box.type = 'checkbox';
    box.setAttribute('data-id', String(it.id || ''));
    box.checked = !!picked[String(it.id || '')];
    box.setAttribute('aria-label', 'Track ' + String(it.name || ''));
    box.addEventListener('change', function () { tick(it, box.checked); drawStatus(sortedItems()); });
    box.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    return box;
  }
  function wire(node, it) {
    var id = String(it.id || '');
    node.setAttribute('data-item', id);
    node.setAttribute('aria-selected', String(!!explorer.sel[id]));
    node.addEventListener('click', function (ev) {
      if (ev.target.tagName === 'INPUT') return;
      if (ev.shiftKey) selectRange(id, ev.ctrlKey || ev.metaKey);
      else if (ev.ctrlKey || ev.metaKey) selectToggle(id);
      else select(id);
    });
    node.addEventListener('dblclick', function (ev) { if (ev.target.tagName !== 'INPUT') openItem(it); });
    node.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (!explorer.sel[id]) select(id); else explorer.selected = id;
      showMenu(it, ev.clientX, ev.clientY);
    });
    // an item is dragged onto a folder to move it there, the selection with it; nothing moves on
    // a drive the page reads only
    node.draggable = canWrite();
    node.addEventListener('dragstart', function (ev) {
      if (!canWrite()) { ev.preventDefault(); return; }
      if (!explorer.sel[id]) select(id);
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData(DRAG_TYPE, Object.keys(explorer.sel).join('\n'));
    });
    if (it.folder && canWrite()) dropTarget(node, id);
    if (explorer.sel[id]) node.classList.add('fx__selected');
    if (explorer.clip && explorer.clip.mode === 'cut' && explorer.clip.items.some(function (c) { return c.id === id; })) node.classList.add('fx__cutitem');
    return node;
  }
  function nameEl(it, cls) {
    var n = el(it.folder ? 'strong' : 'span', cls || '', String(it.name || ''));
    n.setAttribute('data-name', '');
    return n;
  }
  function detailsTable(list) {
    var scroll = el('div', 'table-scroll');
    var table = el('table', 'fx__details');
    table.id = 'fd-items';
    var tr = el('tr');
    add(tr, el('th', 'fx__tickh', ''));
    var cols = [['name', 'Name'], ['changed', 'Date modified'], ['type', 'Type'], ['size', 'Size']];
    if (searching()) cols.push(['where', 'Folder']);
    cols.forEach(function (h) {
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
      add(row, add(el('td', 'fx__name'), add(el('span', 'fx__namewrap'), kindIcon(it, 18), nameEl(it))));
      add(row, it.lastModifiedDateTime ? add(el('td'), timeEl(it.lastModifiedDateTime)) : el('td', '', ''));
      add(row, el('td', '', kindName(it)));
      add(row, el('td', 'fx__size', sizeOf(it)));
      if (searching()) { var p = folderPath(it); add(row, el('td', 'fx__where', p === null ? '' : p ? rootName() + '/' + p : rootName())); }
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
      add(tile, tickBox(it), bigIcon(it, 56), nameEl(it, 'fx__label'));
      grid.appendChild(wire(tile, it));
    });
    return grid;
  }
  // Small icons, List, Tiles and Content: one item each, laid out by the stylesheet for the view
  function itemFlow(list, view) {
    var flow = el('div', 'fx__flow fx__flow--' + view);
    flow.id = 'fd-items';
    list.forEach(function (it) {
      var item = el('div', 'fx__it');
      item.title = String(it.name || '') + '\n' + kindName(it) + (sizeOf(it) ? ', ' + sizeOf(it) : '');
      var size = view === 'tiles' ? 48 : view === 'content' ? 40 : 18;
      var text = el('span', 'fx__ittext');
      add(text, nameEl(it, 'fx__itname'));
      if (view === 'tiles') add(text, el('span', 'fx__itsub', kindName(it)), el('span', 'fx__itsub', sizeOf(it)));
      if (view === 'content') {
        var where = searching() ? folderPath(it) : null;
        add(text, el('span', 'fx__itsub', kindName(it) + (where !== null ? '  in ' + rootName() + (where ? '/' + where : '') : '')));
        var side = el('span', 'fx__itside');
        if (it.lastModifiedDateTime) add(side, add(el('span', 'fx__itsub'), 'Modified ', timeEl(it.lastModifiedDateTime)));
        if (sizeOf(it)) add(side, el('span', 'fx__itsub', 'Size ' + sizeOf(it)));
        add(item, tickBox(it), size > 18 ? bigIcon(it, size) : kindIcon(it, size), text, side);
      } else {
        add(item, tickBox(it), size > 18 ? bigIcon(it, size) : kindIcon(it, size), text);
      }
      flow.appendChild(wire(item, it));
    });
    return flow;
  }

  /* ---------- the selection: a click, Ctrl and Shift, as Explorer selects ---------- */
  function selectNone() { explorer.sel = Object.create(null); explorer.selected = ''; explorer.anchor = ''; markSelection(); }
  function select(id) {
    id = String(id || '');
    explorer.sel = Object.create(null);
    if (id) explorer.sel[id] = true;
    explorer.selected = id;
    explorer.anchor = id;
    markSelection();
  }
  function selectToggle(id) {
    if (explorer.sel[id]) delete explorer.sel[id]; else explorer.sel[id] = true;
    explorer.selected = id;
    explorer.anchor = id;
    markSelection();
  }
  // from the anchor to this item, in the order shown; with Ctrl the range adds to what is selected
  function selectRange(id, keep) {
    var list = sortedItems().map(function (it) { return String(it.id); });
    var a = list.indexOf(explorer.anchor), b = list.indexOf(id);
    if (a < 0) { select(id); return; }
    if (!keep) explorer.sel = Object.create(null);
    for (var i = Math.min(a, b); i <= Math.max(a, b); i++) explorer.sel[list[i]] = true;
    explorer.selected = id;
    markSelection();
  }
  function selectAll() {
    explorer.sel = Object.create(null);
    sortedItems().forEach(function (it) { explorer.sel[String(it.id)] = true; });
    markSelection();
  }
  function selectedItems() { return sortedItems().filter(function (it) { return explorer.sel[String(it.id)]; }); }
  function markSelection() {
    Array.prototype.forEach.call(document.querySelectorAll('#fd-main [data-item]'), function (n) {
      var on = !!explorer.sel[n.getAttribute('data-item')];
      n.classList.toggle('fx__selected', on);
      n.setAttribute('aria-selected', String(on));
    });
    drawStatus(sortedItems());
    drawCommands();
    drawPreview();
  }
  function onExplorerKey(ev) {
    var list = sortedItems();
    var at = list.findIndex(function (it) { return String(it.id) === explorer.selected; });
    var ctrl = ev.ctrlKey || ev.metaKey, k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    var step = explorer.view === 'icons' ? Math.max(1, Math.floor(($('fd-main').clientWidth || 600) / 112)) : 1;
    if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); goBack(); return; }
    if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); goForward(); return; }
    if (ev.altKey && k === 'p') { ev.preventDefault(); togglePreview(); return; }
    // a key on a tick or a column's heading is that control's own
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
    var chosen = selectedItems();
    // Ctrl+Shift+N is Explorer's, which a browser may keep for a private window; Ctrl+Alt+N too
    if (ctrl && (ev.shiftKey || ev.altKey) && k === 'n') { ev.preventDefault(); newFolder(); return; }
    // a Mac's Delete key is Backspace; Cmd+Backspace deletes there, as in Finder
    if (ev.metaKey && ev.key === 'Backspace') { ev.preventDefault(); if (chosen.length) askDelete(chosen); return; }
    if (ctrl && k === 'a') { ev.preventDefault(); selectAll(); return; }
    if (ctrl && k === 'x') { ev.preventDefault(); clip('cut'); return; }
    if (ctrl && k === 'c') { ev.preventDefault(); clip('copy'); return; }
    if (ctrl && k === 'v') { ev.preventDefault(); if (hereFolder() !== null) paste(hereFolder()); return; }
    if (ctrl && k === 'f' || ev.key === 'F3') { ev.preventDefault(); var s = $('fd-search'); if (s) s.focus(); return; }
    if (ev.key === 'F5') { ev.preventDefault(); refresh(); return; }
    if (ev.key === 'F2') { ev.preventDefault(); if (chosen.length === 1) startRename(chosen[0]); return; }
    if (ev.key === 'Delete') { ev.preventDefault(); if (chosen.length) askDelete(chosen); return; }
    if (ev.altKey && ev.key === 'Enter') { ev.preventDefault(); if (chosen.length) properties(chosen); return; }
    if (ev.key === 'Escape') { if (explorer.clip) { ev.preventDefault(); explorer.clip = null; drawItems(); } else if (chosen.length) { ev.preventDefault(); selectNone(); } return; }
    var next = -1;
    if (ev.key === 'ArrowDown') next = at + step;
    else if (ev.key === 'ArrowUp') next = at < 0 ? 0 : at - step;
    else if (ev.key === 'ArrowRight' && explorer.view !== 'details') next = at + 1;
    else if (ev.key === 'ArrowLeft' && explorer.view !== 'details') next = at - 1;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = list.length - 1;
    else if (ev.key === 'Enter' && at >= 0) { ev.preventDefault(); openItem(list[at]); return; }
    else if (ev.key === ' ' && at >= 0) { ev.preventDefault(); if (onGlobus()) return; var it = list[at]; tick(it, !picked[String(it.id)]); drawStatus(list); return; }
    else if (ev.key === 'Backspace') { ev.preventDefault(); goUp(); return; }
    else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      ev.preventDefault();
      var n = at >= 0 ? document.querySelector('#fd-main [data-item="' + CSS.escape(explorer.selected) + '"]') : null;
      var r = n ? n.getBoundingClientRect() : $('fd-main').getBoundingClientRect();
      showMenu(at >= 0 ? list[at] : null, r.left + 20, n ? r.bottom : r.top + 20);
      return;
    }
    else return;
    ev.preventDefault();
    if (!list.length) return;
    next = Math.max(0, Math.min(list.length - 1, next));
    var id = String(list[next].id);
    if (ev.shiftKey) selectRange(id, ctrl);
    else if (ctrl) { explorer.selected = id; markSelection(); markFocus(); }
    else select(id);
    var node = document.querySelector('#fd-main [data-item="' + CSS.escape(explorer.selected) + '"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
  // with Ctrl held the arrows move the focus without changing the selection, as Explorer does
  function markFocus() {
    Array.prototype.forEach.call(document.querySelectorAll('#fd-main [data-item]'), function (n) { n.classList.toggle('fx__focus', n.getAttribute('data-item') === explorer.selected); });
  }

  /* ---------- the menus: an item's, the list's own and the View menu ---------- */
  var menuAway = null;
  function hideMenu() {
    var m = $('fd-menu');
    if (m) m.remove();
    if (menuAway) { document.removeEventListener('mousedown', menuAway); menuAway = null; }
  }
  function menuAt(x, y, fill) {
    hideMenu();
    var menu = el('div', 'fx__menu');
    menu.id = 'fd-menu';
    menu.setAttribute('role', 'menu');
    function entry(label, act, enabled) {
      var b = btn(label, true, function () { hideMenu(); act(); });
      b.setAttribute('role', 'menuitem');
      if (enabled === false) b.disabled = true;
      menu.appendChild(b);
    }
    function line() { if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.appendChild(el('hr', 'fx__menusep')); }
    fill(entry, line);
    if (menu.lastChild && menu.lastChild.tagName === 'HR') menu.removeChild(menu.lastChild);
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
    var first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus();
    menu.addEventListener('keydown', function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button:not(:disabled)')), i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); hideMenu(); var main = $('fd-main'); if (main) main.focus(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    setTimeout(function () {
      if (!menu.isConnected) return;
      menuAway = function (ev) { if (!menu.contains(ev.target)) hideMenu(); };
      document.addEventListener('mousedown', menuAway);
    }, 0);
  }
  // an item's menu acts on the selection the item is in; the list's own, on the folder shown
  function showMenu(it, x, y) {
    menuAt(x, y, function (entry, line) {
      var writes = canWrite();
      if (!it) {
        var into = hereFolder();
        if (writes) {
          entry('New folder', newFolder, into !== null);
          entry('Upload files', function () { pickUpload(into); }, into !== null);
          entry('Paste', function () { paste(into); }, !!explorer.clip && into !== null);
          line();
        }
        entry('Select all', selectAll);
        entry('Refresh', refresh);
        return;
      }
      var chosen = selectedItems(), one = chosen.length <= 1;
      if (it.folder) entry('Open', function () { openItem(it); });
      var app = writes ? officeApp(it) : '';
      if (one && app) entry('Open in ' + appName(app), function () { openInApp(it); });
      if (one && !it.folder) entry(onGlobus() ? 'Open in a new tab' : 'Open in the browser', function () { openInBrowser(it); });
      if (one && it.folder && httpsOnly(it.webUrl) && writes) entry('Open in OneDrive', function () { openInBrowser(it); });
      line();
      if (chosen.some(function (c) { return !c.folder; })) entry('Download', function () { download(chosen); });
      if (writes) {
        entry('Cut', function () { clip('cut'); });
        entry('Copy', function () { clip('copy'); });
        if (one && it.folder) entry('Paste into this folder', function () { paste(String(it.id)); }, !!explorer.clip);
        line();
        if (one) entry('Share', function () { shareDialog(it); });
        if (one) entry('Rename', function () { startRename(it); });
        entry('Delete', function () { askDelete(chosen); });
      }
      line();
      var on = !!picked[String(it.id || '')];
      if (one && writes) entry(on ? 'Untick' : 'Tick to track', function () { tick(it, !on); drawStatus(sortedItems()); });
      entry('Properties', function () { properties(chosen); });
    });
  }
  function viewMenu(x, y) {
    menuAt(x, y, function (entry) {
      VIEWS.forEach(function (v) { entry((explorer.view === v[0] ? '✓ ' : '   ') + v[1], function () { setView(v[0]); }); });
    });
  }

  /* ---------- the verbs that write to the drive, each on the person's own press ---------- */
  // a folder by its id for Graph's addresses: '' is the drive's root
  function itemAddress(id) { return id ? '/me/drive/items/' + encodeURIComponent(id) : '/me/drive/root'; }
  // the root's own id, which Graph's moves and copies name a folder by, read once per connection
  function folderId(id) {
    if (id) return Promise.resolve(id);
    var d = drive;
    if (d.rootId) return Promise.resolve(d.rootId);
    return graph('/me/drive/root?$select=id').then(function (r) {
      if (typeof r.id !== 'string' || !r.id) throw new Error('Microsoft Graph gave no id for the drive\'s root.');
      d.rootId = r.id;
      return r.id;
    });
  }
  // the folder an item was listed in, as Graph names it, else the folder shown
  function parentOf(it) { var p = it.parentReference && it.parentReference.id; return typeof p === 'string' && p ? p : hereFolder(); }
  function nameProblem(name, was) {
    if (!name) return 'A name cannot be empty.';
    if (name.length > 255) return 'A name can be at most 255 characters.';
    if (BAD_NAME.test(name)) return 'A name cannot hold any of " * : < > ? / \\ |';
    if (RESERVED_NAME.test(name)) return name + ' is a name OneDrive keeps for itself.';
    if (/[. ]$/.test(name) || /^ /.test(name)) return 'A name cannot begin with a space or end with a space or a full stop.';
    // search results come from many folders, so there Graph's own answer says a name is taken
    var taken = !searching() && explorer.items.some(function (it) { return String(it.id) !== was && String(it.name || '').toLowerCase() === name.toLowerCase(); });
    return taken ? 'Something named ' + name + ' is already in this folder.' : '';
  }
  function newFolder() {
    var into = hereFolder();
    if (into === null || !canWrite()) return;
    var name = 'New folder', n = 2;
    while (explorer.items.some(function (it) { return String(it.name || '').toLowerCase() === name.toLowerCase(); })) name = 'New folder (' + (n++) + ')';
    say('Making ' + name + '...');
    graph(itemAddress(into) + '/children', 'POST', { name: name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }).then(function (made) {
      say('Made ' + (made.name || name) + '.');
      return changed([into]).then(function () {
        var it = explorer.items.filter(function (x) { return String(x.id) === String(made.id); })[0];
        if (it) { select(it.id); startRename(it); }
      });
    }).catch(function (e) { say('The folder could not be made: ' + e.message, true); });
  }
  // the name edited where it is drawn, as F2 does in Explorer: Enter or leaving it renames, Escape
  // keeps the name; a file's name is chosen up to its extension
  function startRename(it) {
    if (!it || !canWrite()) return;
    var node = document.querySelector('#fd-main [data-item="' + CSS.escape(String(it.id)) + '"] [data-name]');
    if (!node) return;
    var was = String(it.name || ''), parent = parentOf(it);
    explorer.renaming = String(it.id);
    var box = el('input', 'fx__rename');
    box.type = 'text';
    box.value = was;
    box.setAttribute('aria-label', 'New name for ' + was);
    node.replaceWith(box);
    var dot = it.folder ? -1 : was.lastIndexOf('.');
    box.focus();
    box.setSelectionRange(0, dot > 0 ? dot : was.length);
    var done = false;
    function end(keep) {
      if (done) return;
      done = true;
      explorer.renaming = '';
      var name = box.value.trim();
      if (keep || name === was) { drawItems(); focusMain(); return; }
      var problem = nameProblem(name, String(it.id));
      if (problem) { say(problem, true); drawItems(); focusMain(); return; }
      say('Renaming ' + was + ' to ' + name + '...');
      graph(itemAddress(String(it.id)), 'PATCH', { name: name }).then(function () {
        say('Renamed ' + was + ' to ' + name + '.');
        if (picked[String(it.id)]) picked[String(it.id)].name = name;
        return changed([parent, String(it.id)]);
      }).then(focusMain).catch(function (e) { say(was + ' could not be renamed: ' + conflictWord(e, name), true); drawItems(); });
    }
    box.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); end(false); }
      else if (ev.key === 'Escape') { ev.preventDefault(); end(true); }
    });
    box.addEventListener('click', function (ev) { ev.stopPropagation(); });
    box.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    box.addEventListener('blur', function () { end(false); });
  }
  function focusMain() { var m = $('fd-main'); if (m) m.focus(); }
  function conflictWord(e, name) { return e.status === 409 ? 'something named ' + name + ' is already there.' : e.message; }
  // Delete asks first in the page, never in a browser box, and says where the items go
  function askDelete(items) {
    if (!items.length || !canWrite()) return;
    var form = itemDialog(items.length === 1 ? 'Delete ' + items[0].name : 'Delete ' + plural(items.length, 'item'));
    add(form, el('p', 'admin__lead', (items.length === 1 ? 'This moves ' + items[0].name : 'This moves ' + plural(items.length, 'item')) + ' to OneDrive\'s recycle bin, where you can restore ' + (items.length === 1 ? 'it' : 'them') + ' from OneDrive\'s own page: for 30 days on a personal OneDrive, 93 on a work or school one.'));
    var bar = el('p', 'admin__bar');
    var go = btn('Delete', false, function () { closeDialog('dlg-item'); remove(items); });
    go.id = 'fx-delete-go';
    add(bar, go, ' ', btn('Cancel', true, function () { closeDialog('dlg-item'); focusMain(); }));
    form.appendChild(bar);
    go.focus();
  }
  function remove(items) {
    var gone = 0, failed = [];
    say('Deleting ' + plural(items.length, 'item') + '...');
    return items.reduce(function (p, it) {
      return p.then(function () {
        return graph(itemAddress(String(it.id)), 'DELETE').then(function () {
          gone++;
          if (picked[String(it.id)]) tick(it, false);
        }, function (e) { failed.push(it.name + ' (' + e.message + ')'); });
      });
    }, Promise.resolve()).then(function () {
      say((gone ? 'Moved ' + plural(gone, 'item') + ' to the recycle bin.' : '') + (failed.length ? ' Not deleted: ' + failed.join('; ') : ''), failed.length > 0);
      selectNone();
      return changed(items.map(parentOf).concat(items.filter(function (it) { return it.folder; }).map(function (it) { return String(it.id); })));
    });
  }
  // Cut and Copy keep the items in the page's memory until Paste; Escape forgets a cut
  function clip(mode) {
    var items = selectedItems();
    if (!items.length || !canWrite()) return;
    explorer.clip = { mode: mode, items: items.map(clipItem) };
    say((mode === 'cut' ? 'Cut ' : 'Copied ') + plural(items.length, 'item') + ': open a folder and press Paste (Ctrl+V).');
    drawItems();
  }
  function clipItem(it) { return { id: String(it.id), name: String(it.name || ''), from: parentOf(it), folder: !!it.folder }; }
  // the folders a paste into this folder would sit under: a folder never goes inside itself
  function above(into) {
    var path = crumbs.filter(function (c) { return !c.search; }).map(function (c) { return c.id; });
    if (into !== hereFolder()) path.push(into);
    return path;
  }
  function paste(into) {
    var c = explorer.clip;
    if (!c || into === null || into === undefined || explorer.busy || !canWrite()) return;
    var path = above(into);
    var inside = c.items.filter(function (it) { return it.folder && path.indexOf(it.id) >= 0; });
    if (inside.length) { say(inside.map(function (it) { return it.name; }).join(', ') + ' cannot go into itself or a folder inside it.', true, true); return; }
    explorer.busy = true;
    var free = function () { explorer.busy = false; };
    if (c.mode === 'cut') return move(c.items, into).then(free, free);
    var done = 0, failed = [];
    say('Copying ' + plural(c.items.length, 'item') + '...');
    return folderId(into).then(function (target) {
      return c.items.reduce(function (p, it) {
        return p.then(function () {
          return graph(itemAddress(it.id) + '/copy?@microsoft.graph.conflictBehavior=rename', 'POST', { parentReference: { driveId: drive.id || undefined, id: target } }).then(function () { done++; }, function (e) { failed.push(it.name + ' (' + e.message + ')'); });
        });
      }, Promise.resolve());
    }).then(function () {
      // OneDrive copies in the background; the copies show once it has made them
      say((done ? 'OneDrive is copying ' + plural(done, 'item') + '; ' + (done === 1 ? 'it shows' : 'they show') + ' here when it is done (Refresh).' : '') + (failed.length ? ' Not copied: ' + failed.join('; ') : ''), failed.length > 0);
      setTimeout(function () { changed([into]); }, 2500);
    }, function (e) { say('Nothing was copied: ' + e.message, true); }).then(free, free);
  }
  function move(items, into) {
    var moved = 0, failed = [], from = [], gone = [];
    return folderId(into).then(function (target) {
      return items.reduce(function (p, it) {
        return p.then(function () {
          if (it.id === into || it.id === target) { failed.push(it.name + ' (a folder cannot go into itself)'); return; }
          if (it.from === into || it.from === target) { gone.push(it.id); return; }
          return graph(itemAddress(it.id), 'PATCH', { parentReference: { id: target } }).then(function () { moved++; from.push(it.from); gone.push(it.id); }, function (e) { failed.push(it.name + ' (' + conflictWord(e, it.name) + ')'); });
        });
      }, Promise.resolve());
    }).then(function () {
      // what moved leaves a cut; what failed stays cut, to paste again
      if (explorer.clip && explorer.clip.mode === 'cut') {
        explorer.clip.items = explorer.clip.items.filter(function (c) { return gone.indexOf(c.id) < 0; });
        if (!explorer.clip.items.length) explorer.clip = null;
      }
      if (moved || failed.length) say((moved ? 'Moved ' + plural(moved, 'item') + '.' : '') + (failed.length ? ' Not moved: ' + failed.join('; ') : ''), failed.length > 0);
      selectNone();
      return changed(from.concat([into]));
    }, function (e) { say('Nothing was moved: ' + e.message, true); });
  }
  // dragging: files from the computer upload into the folder they are dropped on; items of the
  // list move into it
  var DRAG_TYPE = 'application/x-symphony-drive-items';
  function dropTarget(node, folder) {
    node.addEventListener('dragover', function (ev) {
      var types = Array.prototype.slice.call(ev.dataTransfer.types || []);
      if (types.indexOf('Files') < 0 && types.indexOf(DRAG_TYPE) < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = types.indexOf('Files') >= 0 ? 'copy' : 'move';
      node.classList.add('fx__drop');
    });
    node.addEventListener('dragleave', function () { node.classList.remove('fx__drop'); });
    node.addEventListener('drop', function (ev) {
      node.classList.remove('fx__drop');
      var ids = ev.dataTransfer.getData(DRAG_TYPE);
      var files = Array.prototype.slice.call(ev.dataTransfer.files || []);
      if (!ids && !files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ids) {
        var items = sortedItems().filter(function (it) { return ids.split('\n').indexOf(String(it.id)) >= 0; });
        var path = above(folder);
        if (items.some(function (it) { return it.folder && path.indexOf(String(it.id)) >= 0; })) { say('A folder cannot go into itself or a folder inside it.', true); return; }
        if (items.length) move(items.map(clipItem), folder);
        return;
      }
      // a dropped folder comes as an entry the browser cannot read as a file
      var entries = Array.prototype.slice.call(ev.dataTransfer.items || []).map(function (i) { return i.webkitGetAsEntry ? i.webkitGetAsEntry() : null; });
      var dirs = entries.filter(function (e) { return e && e.isDirectory; }).map(function (e) { return e.name; });
      if (dirs.length) say('Folders are not uploaded here (' + dirs.join(', ') + '): make the folder with New folder and drop the files inside it, or use OneDrive\'s own page.', true);
      var plain = files.filter(function (f) { return dirs.indexOf(f.name) < 0; });
      if (plain.length) upload(plain, folder);
    });
  }
  function pickUpload(into) {
    var input = $('fd-upload');
    if (!input || into === null || !canWrite()) return;
    input.setAttribute('data-to', into);
    input.click();
  }
  // Upload asks, as Explorer does, what to do with a name already in the folder: replace it,
  // keep both (OneDrive numbers the new one) or skip it
  function upload(files, into) {
    if (!canWrite()) return Promise.resolve();
    return readChildren(into).then(function (there) {
      var names = there.map(function (it) { return String(it.name || '').toLowerCase(); });
      var clash = files.filter(function (f) { return names.indexOf(f.name.toLowerCase()) >= 0; });
      if (!clash.length) return sendFiles(files, into, 'fail');
      var form = itemDialog(plural(clash.length, 'name') + ' already there');
      var chosen = false;
      $('dlg-item').addEventListener('close', function () { if (!chosen) say('Nothing was uploaded.'); }, { once: true });
      add(form, el('p', 'admin__lead', 'The folder already holds ' + clash.map(function (f) { return f.name; }).join(', ') + '.'));
      var bar = el('p', 'admin__bar');
      function choose(how) { chosen = true; closeDialog('dlg-item'); sendFiles(how === 'skip' ? files.filter(function (f) { return clash.indexOf(f) < 0; }) : files, into, how === 'skip' ? 'fail' : how); }
      var r = btn('Replace', false, function () { choose('replace'); });
      r.id = 'fx-up-replace';
      var k = btn('Keep both', true, function () { choose('rename'); });
      k.id = 'fx-up-both';
      var s = btn('Skip these', true, function () { choose('skip'); });
      s.id = 'fx-up-skip';
      add(bar, r, ' ', k, ' ', s);
      form.appendChild(bar);
    }, function (e) { say('The folder could not be read to upload into it: ' + e.message, true); });
  }
  function sendFiles(files, into, how) {
    if (!files.length) { say('Nothing was uploaded.'); return Promise.resolve(); }
    var sent = 0, failed = [];
    return files.reduce(function (p, f, i) {
      return p.then(function () {
        say('Uploading ' + f.name + ' (' + (i + 1) + ' of ' + files.length + ', ' + bytesWord(f.size) + ')...');
        return sendFile(f, into, how).then(function () { sent++; }, function (e) { failed.push(f.name + ' (' + conflictWord(e, f.name) + ')'); });
      });
    }, Promise.resolve()).then(function () {
      say((sent ? 'Uploaded ' + plural(sent, 'file') + '.' : '') + (failed.length ? ' Not uploaded: ' + failed.join('; ') : ''), failed.length > 0);
      return changed([into]);
    });
  }
  function sendFile(f, into, how) {
    var path = itemAddress(into) + ':/' + encodeURIComponent(f.name) + ':';
    if (f.size <= UPLOAD_SIMPLE) return graph(path + '/content?@microsoft.graph.conflictBehavior=' + how, 'PUT', f, f.type || 'application/octet-stream');
    return graph(path + '/createUploadSession', 'POST', { item: { '@microsoft.graph.conflictBehavior': how } }).then(function (s) {
      var url = httpsOnly(s.uploadUrl);
      if (!url) throw new Error('Microsoft gave no address to upload to.');
      // a session left after a failure is ended, so its part-written file is not kept
      return sendPieces(f, url, 0).catch(function (e) {
        fetch(url, { method: 'DELETE', signal: within(30000) }).catch(function () {});
        throw e;
      });
    });
  }
  // an upload session's address carries its own right to write, so the drive's token is never sent
  // there, as Microsoft's documentation says
  function sendPieces(f, url, from) {
    var to = Math.min(f.size, from + UPLOAD_PIECE);
    return fetch(url, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + from + '-' + (to - 1) + '/' + f.size }, body: f.slice(from, to), signal: within(600000) }).catch(function () { throw new Error('the upload was cut off'); }).then(graphAnswer).then(function () {
      say('Uploading ' + f.name + ': ' + Math.round(to * 100 / f.size) + '%...');
      return to < f.size ? sendPieces(f, url, to) : null;
    });
  }
  // Download hands the browser the address OneDrive makes for one download of the file, which
  // carries its own short-lived right to read, so no token goes with it; a folder has none
  function download(items) {
    var files = items.filter(function (it) { return !it.folder; });
    if (onGlobus()) {
      // the collection's server sends the file as a download when asked with ?download, as
      // Globus's own file manager asks; a folder needs a transfer there
      if (files.length < items.length) say('A folder is not downloaded from here: Globus\'s own file manager transfers it.', !files.length);
      var first = files[0], url = first ? httpsOnly(first.webUrl) : '';
      if (first && !url) { say('The collection has no HTTPS address, so ' + first.name + ' cannot be downloaded from here.', true, true); return Promise.resolve(); }
      // one press opens one tab: the browser blocks a second opened from the same press
      if (url) window.open(url + '?download', '_blank', 'noopener');
      if (files.length > 1) say('Only ' + first.name + ' was downloaded: the browser allows one download per press, so download each of the others by itself.', true, true);
      return Promise.resolve();
    }
    if (files.length < items.length) say('A folder downloads from OneDrive\'s own page, as a zip: right-click it and choose Open in OneDrive.', !files.length);
    return files.reduce(function (p, it, i) {
      return p.then(function () {
        return graph(itemAddress(String(it.id)) + '?$select=id,name,@microsoft.graph.downloadUrl').then(function (r) {
          var url = httpsOnly(r['@microsoft.graph.downloadUrl']);
          if (!url) throw new Error('OneDrive gave no download address for ' + it.name + '.');
          var a = el('a');
          a.href = url;
          a.download = String(it.name || '');
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          if (i < files.length - 1) return new Promise(function (r) { setTimeout(r, 400); });
        }).catch(function (e) { say(it.name + ' could not be downloaded: ' + e.message, true, true); });
      });
    }, Promise.resolve());
  }
  // Share makes a link of the kind chosen in the page, never before Create link is pressed
  function shareDialog(it) {
    if (!it || !canWrite()) return;
    var work = drive && drive.type && drive.type !== 'personal';
    var form = itemDialog('Share ' + it.name);
    // Enter on a choice makes no link and closes nothing; Create link does
    form.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') ev.preventDefault(); });
    add(form, el('p', 'admin__lead', 'A link to ' + it.name + ', made by OneDrive. Who can open it, and what they can do:'));
    function choice(name, options) {
      var row = el('p', 'admin__row fx__share');
      options.forEach(function (o, i) {
        var label = el('label');
        var r = el('input');
        r.type = 'radio';
        r.name = name;
        r.value = o[0];
        r.checked = i === 0;
        add(row, add(label, r, ' ' + o[1]));
      });
      form.appendChild(row);
    }
    choice('fx-share-scope', work ? [['organization', 'People in your organization'], ['anonymous', 'Anyone with the link']] : [['anonymous', 'Anyone with the link']]);
    choice('fx-share-type', [['view', 'Can view'], ['edit', 'Can edit']]);
    var out = el('p', 'admin__lead fx__shareout');
    out.id = 'fx-share-out';
    var bar = el('p', 'admin__bar');
    var make = btn('Create link', false, function () {
      var scope = form.querySelector('input[name="fx-share-scope"]:checked').value;
      var type = form.querySelector('input[name="fx-share-type"]:checked').value;
      make.disabled = true;
      clear(out);
      out.textContent = 'Making the link...';
      graph(itemAddress(String(it.id)) + '/createLink', 'POST', { type: type, scope: scope }).then(function (r) {
        var url = httpsOnly(r.link && r.link.webUrl);
        if (!url) throw new Error('OneDrive gave no link.');
        clear(out);
        var box = el('input', 'fx__sharelink');
        box.type = 'text';
        box.readOnly = true;
        box.value = url;
        box.setAttribute('aria-label', 'The link');
        var copy = btn('Copy the link', true, function () {
          var written = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject(new Error('no clipboard'));
          written.then(function () { copy.textContent = 'Copied'; }, function () { box.select(); copy.textContent = 'Press Ctrl+C to copy'; });
        });
        add(out, box, ' ', copy);
        box.select();
      }).catch(function (e) { make.disabled = false; clear(out); out.textContent = 'The link could not be made: ' + e.message; });
    });
    make.id = 'fx-share-make';
    add(bar, make);
    add(form, bar, out);
  }
  // Properties: what the list already holds, and for one item what Graph says of it besides
  function properties(items) {
    if (!items.length) return;
    if (items.length > 1) {
      var bytes = 0, folders = 0;
      items.forEach(function (it) { if (it.folder) folders++; else if (typeof it.size === 'number') bytes += it.size; });
      var f = itemDialog(plural(items.length, 'item') + ' Properties');
      add(f, fact('Selected:', plural(items.length - folders, 'file') + ', ' + plural(folders, 'folder')), fact('Size of the files:', bytesWord(bytes) + ' (' + bytes.toLocaleString('en-US') + ' bytes)'), fact('Location:', locationOf(items[0])));
      return;
    }
    var it = items[0];
    var form = itemDialog(it.name + ' Properties');
    var box = el('div', 'fx__props');
    box.id = 'fx-props';
    form.appendChild(box);
    if (onGlobus()) {
      // what the collection's listing said of it, which is all the Transfer API says
      var g = it.globus || {};
      add(box, fact('Type:', kindName(it) + (g.type && g.type !== 'file' && g.type !== 'dir' ? ' (' + g.type + ')' : '')), fact('Location:', locationOf(it)), fact('Path:', String(it.id || '')));
      if (typeof it.size === 'number') add(box, fact('Size:', bytesWord(it.size) + ' (' + it.size.toLocaleString('en-US') + ' bytes)'));
      if (it.lastModifiedDateTime) add(box, fact('Modified:', stamp(it.lastModifiedDateTime)));
      if (g.permissions) add(box, fact('Permissions:', g.permissions + (g.user ? '  ' + g.user : '') + (g.group ? ' ' + g.group : '')));
      if (g.link) add(box, fact('Link to:', g.link));
      if (httpsOnly(it.webUrl) && !it.folder) add(box, add(el('p', 'admin__bar'), link(httpsOnly(it.webUrl), 'Open in a new tab')));
      return;
    }
    add(box, el('p', 'admin__none', 'Reading...'));
    graph(itemAddress(String(it.id)) + '?$select=id,name,size,file,folder,parentReference,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,webUrl,shared').then(function (p) {
      clear(box);
      function by(x) { return x && x.user && x.user.displayName ? String(x.user.displayName) : ''; }
      add(box, fact('Type:', kindName(p)), fact('Location:', locationOf(p)));
      if (typeof p.size === 'number') add(box, fact(p.folder ? 'Size of what it holds:' : 'Size:', bytesWord(p.size) + ' (' + p.size.toLocaleString('en-US') + ' bytes)'));
      if (p.folder && typeof p.folder.childCount === 'number') add(box, fact('Contains:', plural(p.folder.childCount, 'item')));
      if (p.createdDateTime) add(box, fact('Created:', stamp(p.createdDateTime) + (by(p.createdBy) ? ' by ' + by(p.createdBy) : '')));
      if (p.lastModifiedDateTime) add(box, fact('Modified:', stamp(p.lastModifiedDateTime) + (by(p.lastModifiedBy) ? ' by ' + by(p.lastModifiedBy) : '')));
      add(box, fact('Shared:', p.shared ? 'Yes' : 'No'));
      if (httpsOnly(p.webUrl)) add(box, add(el('p', 'admin__bar'), link(httpsOnly(p.webUrl), 'Open in OneDrive')));
    }).catch(function (e) { clear(box); none(box, 'Its properties could not be read: ' + e.message); });
  }
  function locationOf(it) {
    var p = folderPath(it), root = rootName();
    if (p !== null) return p ? root + '/' + p : root;
    return searching() ? root : [root].concat(crumbs.map(function (c) { return c.name; })).join('/');
  }

  /* ---------- the preview pane, shown or hidden as Alt+P does in Explorer ---------- */
  function togglePreview() {
    explorer.preview = !explorer.preview;
    var p = $('fd-preview');
    if (p) p.hidden = !explorer.preview;
    drawCommands();
    drawPreview();
  }
  var previewTimer = 0;
  function previewClose() {
    var b = btn('×', true, togglePreview);
    b.className = 'fx__pvclose';
    b.setAttribute('aria-label', 'Close the preview pane');
    return b;
  }
  function drawPreview() {
    var pane = $('fd-preview');
    if (!pane || !explorer.preview) return;
    var chosen = selectedItems();
    // on a phone the pane covers the list only for one file, so a folder can still be opened
    pane.toggleAttribute('data-empty', chosen.length !== 1 || !!chosen[0].folder);
    if (chosen.length !== 1) { clearTimeout(previewTimer); clear(pane); add(pane, previewClose()); none(pane, chosen.length ? plural(chosen.length, 'item') + ' selected.' : 'Select a file to preview it.'); pane.removeAttribute('data-for'); return; }
    var it = chosen[0], id = String(it.id);
    // the same file asked again keeps the preview on its way
    if (pane.getAttribute('data-for') === id) return;
    clearTimeout(previewTimer);
    pane.setAttribute('data-for', id);
    clear(pane);
    add(pane, add(el('div', 'fx__pvhead'), kindIcon(it, 32), add(el('div'), el('strong', '', String(it.name || '')), el('div', 'fx__itsub', kindName(it) + (sizeOf(it) ? ', ' + sizeOf(it) : ''))), previewClose()));
    var body = el('div', 'fx__pvbody');
    pane.appendChild(body);
    if (it.folder) { none(body, sizeOf(it) ? 'This folder holds ' + sizeOf(it) + '.' : 'A folder.'); return; }
    none(body, 'Making the preview...');
    // a short wait, so arrowing through a list asks for no preview of what is only passed over
    previewTimer = setTimeout(function () {
      previewOf(it).then(function (p) {
        if (pane.getAttribute('data-for') !== id) return;
        clear(body);
        if (p.frame) {
          var f = el('iframe', 'fx__pvframe');
          f.src = p.frame;
          f.title = 'Preview of ' + it.name;
          // a blob fetched from a collection is same-origin with this page, so its frame runs no
          // script; Graph's preview page is another origin and keeps its own
          f.setAttribute('sandbox', p.blob ? '' : 'allow-scripts allow-same-origin allow-popups');
          f.referrerPolicy = 'no-referrer';
          body.appendChild(f);
        } else if (p.image) {
          var img = el('img', 'fx__pvimg');
          img.src = p.image;
          img.alt = 'Preview of ' + it.name;
          img.referrerPolicy = 'no-referrer';
          body.appendChild(img);
        } else if (p.media) {
          // a video or a sound plays from the collection's own address, streamed by its server
          // as the double click streams it; where the server will not play it here, the tab
          var media = el(kindKey(it) === 'audio' ? 'audio' : 'video', 'fx__pvmedia');
          media.controls = true;
          media.src = p.media;
          media.addEventListener('error', function () { clear(body); openHere(body, it, 'This browser could not play it here.'); });
          body.appendChild(media);
        } else if (typeof p.text === 'string') {
          body.appendChild(el('pre', 'fx__pvtext', p.text));
        } else if (onGlobus() && !it.folder) openHere(body, it, p.why || 'No preview is made here for this file.', p.consent);
        else none(body, 'No preview is available for this file.');
      });
    }, 300);
  }
  // the preview pane's way out: the file in its own tab, where the collection's server streams it
  function openHere(body, it, why, consent) {
    var p = none(body, why + ' ');
    if (httpsOnly(it.webUrl)) add(p, btn('Open in a new tab', false, function () { openInBrowser(it); }));
    // the collection's own token, missing where the first sign-in knew no collection
    if (consent && drive && drive.id) add(p, ' ', btn('Allow it at Globus', false, function () { startGlobusConnect(globusScopes(drive.id), drive.id); }));
  }
  // Graph's preview page for the file where it makes one, else its largest thumbnail; kept for the
  // sitting so going back to a file asks nothing again. On Globus a video or a sound plays from
  // the collection's address, an image, a PDF or a text is fetched into the page with the
  // collection's token, and anything else opens in its own tab
  // an image's media type from its name, for the blob a preview shows
  function imageType(it) {
    var m = /\.([a-z0-9]+)$/i.exec(String(it.name || ''));
    var ext = m ? m[1].toLowerCase() : '';
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'application/octet-stream';
  }
  function previewOf(it) {
    var id = String(it.id);
    if (explorer.previews[id]) return explorer.previews[id];
    if (onGlobus()) {
      var kind = kindKey(it), url = httpsOnly(it.webUrl);
      var made;
      if (!url) made = Promise.resolve({ why: 'The collection has no HTTPS address.' });
      else if (kind === 'video' || kind === 'audio') made = Promise.resolve({ media: url });
      else if (kind === 'image' || kind === 'pdf' || kind === 'text' || kind === 'code') {
        made = globusFetch(it).then(function (blob) {
          // the type is this page's, by the name, never the server's, so no file is shown as a page
          if (kind === 'image') return { image: URL.createObjectURL(new Blob([blob], { type: imageType(it) })) };
          if (kind === 'pdf') return { frame: URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })), blob: true };
          return blob.text().then(function (t) { return { text: t.length > 200000 ? t.slice(0, 200000) + '\n...' : t }; });
        }).catch(function (e) {
          if (e.code === 'NoCollectionToken') { delete explorer.previews[id]; return { why: 'This page is not yet allowed to fetch the collection\'s files into it.', consent: true }; }
          return { why: 'It could not be fetched into the page (' + e.message + ').' };
        });
      } else made = Promise.resolve({ why: 'No preview is made here for a ' + kindName(it).toLowerCase() + '.' });
      explorer.previews[id] = made;
      return made;
    }
    var image = kindKey(it) === 'image';
    var ask = image ? Promise.reject(new Error('an image shows its thumbnail')) : graph(itemAddress(id) + '/preview', 'POST', {});
    var p = ask.then(function (r) {
      var url = httpsOnly(r.getUrl);
      if (!url) throw new Error('no preview page');
      return { frame: url };
    }).catch(function () {
      return graph(itemAddress(id) + '/thumbnails?$select=large').then(function (r) {
        var t = Array.isArray(r.value) && r.value[0] && r.value[0].large;
        var url = t ? httpsOnly(t.url) : '';
        return url ? { image: url } : {};
      }).catch(function () { return {}; });
    });
    explorer.previews[id] = p;
    return p;
  }

  // the folder tree: the drive's folders, each opened a level at a time, the path shown open
  function drawTree() {
    var tree = $('fd-tree');
    if (!tree) return;
    clear(tree);
    // on Globus the tree starts at the account's home folder, since the cluster's root and the
    // folders above home hold thousands of other accounts' folders
    var top = onGlobus() && drive.home ? globusPath(drive.home) : '';
    var root = treeNode({ id: top, name: rootName() }, top ? globusCrumbs(top) : [], 0);
    tree.appendChild(root);
    // the account's other kept drive is a second root, closed; a press on it switches the tab to it
    var other = otherKept();
    if (!other) return;
    var wrap = el('div', 'fx__branch');
    var row = el('div', 'fx__node fx__otherroot');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', 'false');
    row.style.paddingLeft = '4px';
    var name = btn('', true, function () { switchDrive(other); });
    name.className = 'fx__nodename';
    name.id = 'fd-other-root';
    name.title = 'Switch to ' + (other.provider === 'globus' ? (other.name || 'Globus') : 'OneDrive');
    add(name, kindIcon({ folder: {} }, 16), el('span', '', other.provider === 'globus' ? (other.name || 'Globus') : 'OneDrive'));
    add(row, el('span', 'fx__twisty', '▸'), name);
    wrap.appendChild(row);
    tree.appendChild(wrap);
  }
  function treeNode(folder, path, depth) {
    var wrap = el('div', 'fx__branch');
    var row = el('div', 'fx__node');
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    var key = folder.id || 'root';
    var at = here() && !here().search ? here().id : searching() ? null : '';
    var onPath = folder.id === '' || depth === 0 || crumbs.some(function (c) { return c.id === folder.id; });
    var open = explorer.open[key] !== undefined ? explorer.open[key] : onPath;
    var twisty = btn(open ? '▾' : '▸', true, function (ev) { ev.stopPropagation(); explorer.open[key] = !open; drawTree(); });
    twisty.className = 'fx__twisty';
    twisty.setAttribute('aria-label', (open ? 'Close ' : 'Open ') + folder.name);
    var name = btn('', true, function () { if (folder.id !== at) go(path); });
    name.className = 'fx__nodename';
    add(name, kindIcon({ folder: {} }, 16), el('span', '', folder.name));
    if (folder.id === at) { row.classList.add('fx__current'); row.setAttribute('aria-current', 'true'); }
    row.setAttribute('aria-expanded', String(open));
    add(row, twisty, name);
    if (canWrite()) dropTarget(row, folder.id);
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
      none(box, repo + ' has no .github/workflows/' + DRIVE_WORKFLOW + (workflow === false ? ': it was not made from the template, or from one older than the drive sync, so there is no run to track a drive with. Choose a repository made from the template in the bar, make one under Need a new repository? below (GitHub\'s form for the enterprise\'s members, the front door for anyone else), or bring the workflow in.' : ' that could be read (' + workflow.message + ').'));
      if (workflow === false) { $('fd-track').disabled = true; drawPull(box, repo); return; }
    }
    // a sign-in that cannot reach the repository's secrets is told so before Connect, not after it
    var refused = !!(secret && secret.unread && secret.unread.status === 403);
    $('fd-track').disabled = refused;
    if (refused) none(box, secretsRefused(repo));
    if (!config) { none(box, repo + ' tracks no drive yet' + (refused ? '.' : ': the steps below set one up.')); drawPull(box, repo); return; }
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
      : secret ? 'The secret ' + DRIVE_SECRET + ' is set' + (secret.org ? ', as the organization\'s, which GitHub gives this repository' : '') + (secret.updated_at ? ', updated ' + stamp(secret.updated_at) : '') + '.'
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
  // a repository that walks the whole drive keeps only its refresh token, so Track asks for no tick
  function drawWalk(repo, secret) {
    var box = $('fd-tracked');
    clear(box);
    var refused = !!(secret && secret.unread && secret.unread.status === 403);
    $('fd-track').disabled = refused;
    if (refused) { none(box, secretsRefused(repo)); return; }
    var has = secret && !secret.unread;
    none(box, repo + ' walks the whole drive with .github/workflows/' + CATALOG_WORKFLOW + ' and has no sync, so Track saves only the drive\'s refresh token there, as ' + DRIVE_SECRET + ', and writes no file; nothing need be ticked.' + (has ? ' The secret is set; Track replaces it with this connection\'s.' : ' The secret is not set yet.'));
  }
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
    var account = shownLogin;
    letPrefilledGo(repo);
    foldersFor = repo;
    tracked = null;
    walkOnly = false;
    clear($('fd-tracked'));
    $('fd-track-head').textContent = repo ? 'Track in ' + repo : 'Track';
    $('fd-public').checked = false;
    $('fd-public-row').hidden = true;
    if (!repo) { $('fd-track').disabled = true; none($('fd-tracked'), 'No repository is chosen: choose one in the bar, or make one under Need a new repository? below.'); return; }
    if (!token) { $('fd-track').disabled = true; none($('fd-tracked'), 'Sign in to read what ' + repo + ' tracks.'); return; }
    // Track waits for the read, which says whether the repository syncs or only walks the drive
    $('fd-track').disabled = true;
    none($('fd-tracked'), 'Reading ' + repo + '...');
    Promise.all([
      readTracked(repo),
      readSecret(repo),
      readOne('/repos/' + repo + '/contents/.github/workflows/' + DRIVE_WORKFLOW).then(function (found) { return !!found; }, function (e) { return e; }),
      readOne('/repos/' + repo).catch(function () { return null; }),
      readOne('/repos/' + repo + '/contents/.github/workflows/' + CATALOG_WORKFLOW).then(function (found) { return !!found; }, function () { return false; })
    ]).then(function (all) {
      if (asked !== folderReading) return;
      tracked = all[0];
      walkOnly = all[2] === false && all[4] === true;
      if (walkOnly) drawWalk(repo, all[1]);
      else drawTracked(repo, tracked, all[1], all[2]);
      showPublic(all[3]);
      if (!walkOnly) switchSyncOn(repo, tracked, all[1], all[2], account, asked);
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
  // what Track, Find and Sync now answer is said in the Track dialog as well as in the note, which the
  // dialog covers while it is open
  function fdSay(text, warn) {
    say(text, warn);
    var s = $('fd-say');
    if (!s) return;
    clear(s);
    if (text) rich(s, text);
    s.classList.toggle('admin__warn', !!warn);
  }
  function findRepos() {
    var button = $('fd-reload');
    button.disabled = true;
    fdSay('Asking GitHub for your newest repositories...');
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
        fdSay('None of the ' + NEWEST + ' newest repositories ' + (signedInByApp() ? 'the sign-in' : 'this token') + ' reaches is new to the list and made from the template. ' + (signedInByApp()
          ? 'Signed in with GitHub, the page reaches only the repositories SymphonyBoard is installed on: add the new one to its installation, at https://github.com/apps/' + APP_SLUG + '/installations/new, then press this again.'
          : 'A fine-grained token reaches only the repositories it was made for.') + ' One made on GitHub\'s form without the template, which the form gives the enterprise\'s members alone, is neither: set it up through the front door under Need a new repository? in Track in a repository.' + (repos().length ? ' The bar keeps the one chosen.' : ''));
        return;
      }
      added.forEach(rememberRepo);
      fdSay('Added to the list: ' + added.join(', ') + '. ' + added[0] + ' is chosen.');
      loadRepo(added[0]);
    }).catch(function (e) { button.disabled = false; fdSay(e.message, true); });
  }
  function dispatchSync(repo, branch, account) {
    return gh('POST', '/repos/' + repo + '/actions/workflows/' + DRIVE_WORKFLOW + '/dispatches', { ref: branch }, undefined, false, account);
  }
  // short words for #msg, whose links are the tab's own, drawn in it
  function dispatchWords(repo, e) {
    if (e.status === 403) return 'The sync could not be started from here (403: no Actions permission); press "Run workflow" at the runs link in Track in a repository.';
    if (e.status === 404) return 'The sync could not be started from here (404): ' + repo + ' has no ' + DRIVE_WORKFLOW + ' on its default branch.';
    return 'The sync could not be started from here (' + e.message + '); press "Run workflow" at the runs link in Track in a repository.';
  }
  function syncNow(repo, button, lapsed) {
    if (button) button.disabled = true;
    fdSay('Starting the drive sync of ' + repo + '...');
    gh('GET', '/repos/' + repo).then(function (r) { return dispatchSync(repo, r.data.default_branch || 'main'); }).then(function () {
      if (button) button.disabled = false;
      if (lapsed) fdSay('The drive sync of ' + repo + ' is queued, but it will stop at the token trade: the OneDrive connection ran out on ' + lapsed + '. Press Connect OneDrive, then Track.', true);
      else fdSay('The drive sync of ' + repo + ' is queued; its summary says what came down and what went up.');
    }).catch(function (e) { if (button) button.disabled = false; fdSay(dispatchWords(repo, e), true); });
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
        return gh('POST', '/repos/' + repo + '/pulls', { title: message, head: DRIVE_BRANCH, base: branch, body: 'Made from the Folders tab of the control panel: ' + DRIVE_FILE + ' says what the drive sync tracks. Merge it, then press Sync now under Track in a repository on the tab: ' + tabLink(repo) }, undefined, false, account)
          .then(function (r) { return { branch: DRIVE_BRANCH, pull: r.data.html_url }; });
      });
    });
  }
  // the refresh token sealed in this browser with a public key of GitHub's, as its own secrets page seals one
  function sealed(seal, key, refresh) {
    return { encrypted_value: toBase64(seal(new TextEncoder().encode(refresh), fromBase64(key.key))), key_id: key.key_id };
  }
  // Where the refresh token is kept: the organization's secret, which every private and internal
  // repository of the organization reads, so one Track covers the whole organization as the owner chose on
  // 2026-10-20, where the person may set one; else the repository's own. An organization secret
  // holds one drive, so one that another drive holds is never written over, and a repository with a
  // secret of its own keeps it, since its own would shadow the organization's; a public repository
  // reads no secret of visibility private, and on GitHub Free no private repository reads one, so
  // both keep to their own. Says 'org' or 'repo'.
  function saveRefresh(repo, meta, refresh, driveId, account) {
    var owner = meta && meta.owner || {};
    var org = owner.type === 'Organization' ? String(owner.login || '') : '';
    var sealer = loadSealer();
    function inRepo() {
      return Promise.all([sealer, gh('GET', '/repos/' + repo + '/actions/secrets/public-key')]).then(function (both) {
        return gh('PUT', '/repos/' + repo + '/actions/secrets/' + DRIVE_SECRET, sealed(both[0], both[1].data, refresh), undefined, false, account);
      }).then(function () { return 'repo'; });
    }
    if (!org || !driveId || !meta.id) return inRepo();
    var base = '/orgs/' + org + '/actions';
    var reads = Promise.all([
      readOne('/repos/' + repo + '/actions/secrets/' + DRIVE_SECRET),
      gh('GET', base + '/secrets/public-key'),
      readOne(base + '/secrets/' + DRIVE_SECRET),
      readOne(base + '/variables/' + DRIVE_ID_VAR),
      readOne('/orgs/' + org)
    ]);
    return reads.then(function (all) {
      var ours = !all[2] || (all[3] && String(all[3].value) === driveId);
      // on GitHub Free a private repository reads no organization secret, so a plan the page cannot
      // see as paid keeps a private repository to its own
      var plan = all[4] && all[4].plan && all[4].plan.name;
      var reaches = !isPublic(meta) && !!plan && plan !== 'free';
      if (all[0] || !ours || !reaches) return inRepo();
      return sealer.then(function (seal) {
        var body = sealed(seal, all[1].data, refresh);
        body.visibility = 'private';
        return gh('PUT', base + '/secrets/' + DRIVE_SECRET, body, undefined, false, account).then(function () {
          // GitHub takes an organization secret it then withholds from a private repository on some
          // plans and policies, so the repository's own list says whether it reaches; where it does
          // not, or the list cannot be read, the repository keeps a secret of its own
          return orgSecretReaches(repo).then(function (reaches) {
            return reaches ? recordDrive(base, all[3], driveId, account) : inRepo();
          });
        }, function (e) {
          // a token that reads the organization's secrets and may not write them keeps to the repository
          if (e.status === 403 || e.status === 404) return inRepo();
          throw e;
        });
      });
    }, function () { return inRepo(); });
  }
  // A personal account has no secret of its own that all its repositories read, so Track there also
  // renews the secret in each other repository of the account that holds one and tracks the same
  // drive by its file, so one Connect and one Track keep every one of them current (the owner's
  // choice of 2026-10-20); a repository that only walks the drive names no drive and is left as it is.
  // Says how many were renewed and which could not be.
  var RENEW_AT_ONCE = 6;
  function renewOthers(repo, meta, refresh, driveId, account, connected) {
    var owner = meta && meta.owner || {};
    if (owner.type !== 'User' || !driveId) return Promise.resolve(null);
    var me = String(owner.login || '').toLowerCase();
    return ghList('/user/repos?affiliation=owner&per_page=100', 3).then(function (list) {
      var others = list.filter(function (r) {
        return r && typeof r.full_name === 'string' && !r.archived && r.full_name.toLowerCase() !== repo.toLowerCase()
          && String(r.owner && r.owner.login || '').toLowerCase() === me;
      }).map(function (r) { return r.full_name; });
      var renewed = [], failed = [];
      function next() {
        var other = others.shift();
        if (!other) return Promise.resolve();
        return renewOne(other, refresh, driveId, account, connected).then(function (done) { if (done) renewed.push(other); }, function () { failed.push(other); }).then(next);
      }
      var lanes = [];
      for (var i = 0; i < RENEW_AT_ONCE; i++) lanes.push(next());
      return Promise.all(lanes).then(function () { return { renewed: renewed, failed: failed }; });
    }, function () { return null; });
  }
  function renewOne(other, refresh, driveId, account, connected) {
    return readOne('/repos/' + other + '/actions/secrets/' + DRIVE_SECRET).then(function (own) {
      if (!own) return false;
      return readTracked(other).then(function (config) {
        var same = trackedItems(config || {}).some(function (i) { return typeof i.drive === 'string' && i.drive.toLowerCase() === driveId.toLowerCase(); });
        if (!same) return false;
        // a repository whose drive.json is dated no earlier than this connection holds a token as new
        if (connected && String(config.connected || '') >= connected) return false;
        return Promise.all([loadSealer(), gh('GET', '/repos/' + other + '/actions/secrets/public-key')]).then(function (both) {
          return gh('PUT', '/repos/' + other + '/actions/secrets/' + DRIVE_SECRET, sealed(both[0], both[1].data, refresh), undefined, false, account);
        }).then(function () { return true; });
      });
    });
  }
  function renewWords(r) {
    if (!r) return '';
    var w = '';
    if (r.renewed.length) w += 'The secret is renewed too in ' + r.renewed.join(', ') + ', which track' + (r.renewed.length === 1 ? 's' : '') + ' the same drive. ';
    if (r.failed.length) w += 'It could not be renewed in ' + r.failed.join(', ') + '; press Track there. ';
    return w;
  }
  // whether the organization's secret is among those GitHub gives this repository's workflows
  function orgSecretReaches(repo) {
    return ghListOf('/repos/' + repo + '/actions/organization-secrets?per_page=100', 'secrets', 10).then(function (list) {
      return list.some(function (x) { return x && x.name === DRIVE_SECRET; });
    }, function () { return false; });
  }
  // the repository's own secret, or else the organization's where GitHub gives it to the repository,
  // or { unread } where the repository's own cannot be read
  function readSecret(repo) {
    return readOne('/repos/' + repo + '/actions/secrets/' + DRIVE_SECRET).then(function (own) {
      if (own) return own;
      return orgSecretReaches(repo).then(function (reaches) { return reaches ? { name: DRIVE_SECRET, org: true } : null; });
    }, function (e) { return { unread: e }; });
  }
  // which drive the organization's secret holds, so a Track with another drive keeps to its
  // repository; read again after the write, since two Tracks at once may both have found it free
  function recordDrive(base, had, driveId, account) {
    var record = { name: DRIVE_ID_VAR, value: driveId, visibility: 'private' };
    var write = had ? gh('PATCH', base + '/variables/' + DRIVE_ID_VAR, record, undefined, false, account) : gh('POST', base + '/variables', record, undefined, false, account);
    return write.then(function () { return readOne(base + '/variables/' + DRIVE_ID_VAR); }).then(function (v) {
      if (v && String(v.value) !== driveId) return { where: 'org', note: 'Another Track wrote the organization\'s secret at the same time, with another drive: press Track again to keep this repository to a secret of its own.' };
      return 'org';
    }, function (e) {
      return { where: 'org', note: 'The record of which drive the organization\'s secret holds (' + DRIVE_ID_VAR + ') could not be written (' + e.message + '), so the next Track in the organization keeps to its repository\'s own secret.' };
    });
  }
  // the switch drive-sync.yml's half-hourly run waits for, turned on where it is not; says whether it wrote
  function ensureSyncOn(repo, account) {
    var path = '/repos/' + repo + '/actions/variables';
    return readOne(path + '/' + SYNC_SWITCH).then(function (v) {
      if (v && String(v.value).toLowerCase() === 'on') return false;
      var body = { name: SYNC_SWITCH, value: 'on' };
      return (v ? gh('PATCH', path + '/' + SYNC_SWITCH, body, undefined, false, account) : gh('POST', path, body, undefined, false, account)).then(function () { return true; });
    });
  }
  // A repository that tracks a drive already, its workflow, file and secret all there and the
  // connection not known to have run out, has its half-hourly sync switched on when the tab opens it,
  // as the owner chose on 2026-10-20, so a drive tracked before Track set the switch syncs without
  // another Track; only a switch never set is made, since one set to off was turned off by someone on
  // purpose, and only for the account the read was made as; said only when it wrote or could not
  function switchSyncOn(repo, config, secret, workflow, account, asked) {
    if (workflow !== true || !config || !secret || secret.unread || lapsedOn(config)) return;
    if (!account || account !== shownLogin) return;
    var path = '/repos/' + repo + '/actions/variables';
    var here = function () { return asked === folderReading; };
    readOne(path + '/' + SYNC_SWITCH).then(function (v) {
      if (v) return;
      return gh('POST', path, { name: SYNC_SWITCH, value: 'on' }, undefined, false, account).then(function () {
        if (here()) none($('fd-tracked'), 'The half-hourly sync was never switched on in ' + repo + ', so the repository variable ' + SYNC_SWITCH + ' is now set to on.');
      }, function (e) {
        // a write already made from another reading of the same repository is the switch on
        if (e.status === 409) return;
        if (here()) none($('fd-tracked'), 'The half-hourly sync is not switched on in ' + repo + ' and the repository variable ' + SYNC_SWITCH + ' could not be set to on (' + e.message + '); Sync now still runs it by hand.');
      });
    }, function (e) {
      if (here()) none($('fd-tracked'), 'Whether the half-hourly sync is switched on in ' + repo + ' could not be read (' + e.message + ').');
    });
  }
  // Track on a repository that only walks the drive: the secret alone, no file and no run, since
  // the walk is started by its own workflow and reads the drive from its root
  function trackWalk(button, repo, d) {
    button.disabled = true;
    var account = d.login || shownLogin;
    var refresh = d.refresh;
    fdSay('Sealing the drive\'s refresh token in this browser and saving ' + DRIVE_SECRET + ' on ' + repo + '...');
    gh('GET', '/repos/' + repo).then(function (r) {
      if (isPublic(r.data) && !$('fd-public').checked) {
        showPublic(r.data);
        throw plain(repo + ' is public, so what its walk writes of your drive, the names of your files among it, would be readable by anyone: tick the box under Track to go on, or choose a private repository in the bar.');
      }
      var meta = r.data;
      var save = saveRefresh(repo, meta, refresh, d.id, account);
      refresh = '';
      return save.then(function (where) {
        if (where !== 'repo') return [where, null];
        return renewOthers(repo, meta, d.refresh, d.id, account, d.connected).then(function (renewal) { return [where, renewal]; });
      });
    }).then(function (two) {
      var where = two[0], renewal = two[1];
      button.disabled = false;
      showConnectState();
      drawBrowser();
      fdSay(repo + ' keeps the drive\'s refresh token as ' + DRIVE_SECRET + keptWhere(where, repo) + ' for ' + CATALOG_WORKFLOW + ', which walks the whole drive; no file was written, and OneDrive stays connected on this browser.' + keptNote(where) + (renewal ? ' ' + renewWords(renewal) : ''), !!(where && where.note) || !!(renewal && renewal.failed.length));
      if (!(where && where.note) && !(renewal && renewal.failed.length)) closeDialog('dlg-track');
      if (foldersRepo() === repo) loadFolders();
    }).catch(function (e) {
      refresh = '';
      button.disabled = false;
      if (e.plain) fdSay(e.message, true);
      else if (e.status === 403) fdSay(secretsRefused(repo), true);
      else fdSay('The secret could not be saved (' + e.message + '), so nothing was written. Press Track to try again.', true);
    });
  }
  function keptWhere(where, repo) {
    var at = where && where.where || where;
    return at === 'org' ? ' (a secret of ' + repo.split('/')[0] + ', which every private repository of ' + repo.split('/')[0] + ' reads, so Track in any of them needs no other secret)' : '';
  }
  function keptNote(where) { return where && where.note ? ' ' + where.note : ''; }
  function track(button) {
    if (button.disabled) return;
    var repo = foldersRepo();
    var folder = ($('fd-folder').value || '').trim();
    var d = heldDrive();
    if (!repo) { fdSay('Choose a repository in the bar first (or make one under Need a new repository?).', true); return; }
    if (!d || !d.refresh) { showConnectState(); drawBrowser(); fdSay('Connect OneDrive first, under + Add a cloud drive: the drive\'s refresh token is what the repository keeps.', true); closeDialog('dlg-track'); ($('fd-add-tile') || $('fd-add')).focus(); return; }
    // a Globus collection is read here and never synced: Track is OneDrive's
    if (d.provider === 'globus') { fdSay('Track records folders of OneDrive for the repository\'s sync. ' + (d.name || 'The Globus collection') + ' is read here only; press OneDrive\'s card, or Connect OneDrive, to track a drive.', true); closeDialog('dlg-track'); return; }
    if (walkOnly && foldersFor === repo) { trackWalk(button, repo, d); return; }
    if (!pickedOrder.length) { fdSay('Tick at least one file or folder to track, in the list of your OneDrive.', true); return; }
    if (!FOLDER_NAME.test(folder) || folder.indexOf('..') >= 0) { fdSay('The folder is one name of up to 80 letters, digits, dots, dashes, underscores and blanks, ending in a letter or digit, as drive-sync.yml takes it; "papers" is the default.', true); return; }
    // an item ticked from what the repository tracked under another Microsoft account is out of
    // this drive's reach, and one item the sync cannot read stops every run
    var foreign = d.id ? pickedOrder.filter(function (id) { var i = picked[id]; return i.drive && i.drive.toLowerCase() !== d.id.toLowerCase(); }) : [];
    if (foreign.length) { fdSay(plural(foreign.length, 'ticked item is', 'ticked items are') + ' from another OneDrive than the one connected now (' + foreign.map(function (id) { return picked[id].name; }).join(', ') + '): untick them, or Connect OneDrive again as the account that holds them.', true); return; }
    button.disabled = true;
    // the drive is the account's it was connected under, and every write of the chain goes out for
    // that account, so a token another tab puts in place meanwhile stops the chain
    var account = d.login || shownLogin;
    var refresh = d.refresh;
    var config = { provider: d.provider, folder: folder, items: pickedOrder.map(function (id) { var i = picked[id]; return { id: i.id, name: i.name, drive: i.drive }; }), connected: d.connected || dayOf(new Date()) };
    var branch = '', wrote = null, saved = false, meta = null, where = '', switched = null, renewal = null;
    fdSay('Sealing the drive\'s refresh token in this browser and saving ' + DRIVE_SECRET + ' on ' + repo + '...');
    gh('GET', '/repos/' + repo).then(function (r) {
      meta = r.data;
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
      var save = saveRefresh(repo, meta, refresh, d.id, account);
      refresh = '';
      return save;
    }).then(function (w) {
      where = w;
      saved = true;
      fdSay('The secret is saved; writing ' + DRIVE_FILE + '...');
      return writeDriveFile(repo, branch, config, account);
    }).then(function (w) {
      wrote = w;
      // the half-hourly run waits for the repository's switch; one that cannot be set is said, and the
      // first run still goes; a file waiting on a pull request leaves the switch to its merge
      if (w.pull) { switched = true; return null; }
      return ensureSyncOn(repo, account).then(function () { switched = true; }, function (e) { switched = e; });
    }).then(function () {
      if (wrote.pull) return null;
      fdSay('The file is written; starting the first sync...');
      return dispatchSync(repo, branch, account).then(function () { return true; }, function (e) { return e; });
    }).then(function (started) {
      if (where !== 'repo') return started;
      fdSay('Renewing the secret in your other repositories that track this drive...');
      return renewOthers(repo, meta, d.refresh, d.id, account, d.connected).then(function (r) { renewal = r; return started; });
    }).then(function (started) {
      button.disabled = false;
      showConnectState();
      drawBrowser();
      if (wrote.pull) pendingPull[repo] = wrote.pull; else delete pendingPull[repo];
      var words = repo + ' tracks ' + plural(config.items.length, 'item') + ' of OneDrive in ' + folder + '/' + keptWhere(where, repo) + ', and OneDrive stays connected on this browser. ';
      if (switched !== true) words += 'The repository variable ' + SYNC_SWITCH + ' could not be set to on (' + switched.message + '), so a drive-sync.yml that waits for it does not run each half hour. ';
      words += keptNote(where) + renewWords(renewal);
      if (wrote.pull) words += 'Its default branch takes only pull requests: merge the one linked in Track in a repository, then press Sync now there.';
      else if (started === true) words += 'The first sync is queued.';
      else words += dispatchWords(repo, started);
      var trouble = (started !== true && !wrote.pull) || switched !== true || !!(where && where.note) || !!(renewal && renewal.failed.length);
      fdSay(words, trouble);
      // done: the steps close by themselves, the panel's note saying what was done; a
      // sync that could not be started or switched on keeps them open, with its runs link
      if (!trouble) closeDialog('dlg-track');
      if (foldersRepo() === repo) loadFolders();
    }).catch(function (e) {
      refresh = '';
      button.disabled = false;
      if (e.plain) fdSay(e.message, true);
      else if (!saved && e.status === 403) fdSay(secretsRefused(repo), true);
      else if (!saved) fdSay('The secret could not be saved (' + e.message + '), so nothing else was written. Press Track to try again.', true);
      else fdSay('The secret ' + DRIVE_SECRET + ' is saved, but ' + DRIVE_FILE + ' could not be written: ' + e.message + ' Until it is, the half-hourly sync runs with the new secret on the drive.json the default branch holds, if any. Press Track to write it again.', true);
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
    if (d) { if (listedFor !== d) { listedFor = d; crumbs = []; resetExplorer(); nameDrive(); if (d.provider === 'globus') globusHome(); else listFolder(); } }
    else drawBrowser();
    if (foldersFor !== foldersRepo()) loadFolders();
  }
  // a part of the console: the sign-in, the bar and the repository are the console's, so the tab
  // wires only its own buttons, and the drive's return is read by initPanel before GitHub's
  function initFoldersTab() {
    $('fd-reload').addEventListener('click', findRepos);
    $('fd-connect').addEventListener('click', startDriveConnect);
    if ($('fd-globus')) $('fd-globus').addEventListener('click', function () { startGlobusConnect(); });
    $('fd-forget').addEventListener('click', forgetDrive);
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
  // GitHub answers 403 alike whether the person does not administer the repository or the
  // installation has not accepted Administration, so the page finds out which: the repository's own
  // answer gives the person's role, and a sign-in through the App reads the installation's permissions
  function shareInstallationPage(inst) {
    return inst.account.type === 'Organization'
      ? 'https://github.com/organizations/' + inst.account.login + '/settings/installations/' + inst.id
      : 'https://github.com/settings/installations/' + inst.id;
  }
  function shareRefused(repo, e, doing) {
    if (e.status !== 403 && e.status !== 404) return Promise.resolve('GitHub refused ' + doing + ': ' + e.message);
    var owner = repo.split('/')[0].toLowerCase();
    var perms = state && state.repo === repo && state.meta ? state.meta.permissions : null;
    if (perms && perms.admin === false) {
      return Promise.resolve('GitHub refused ' + doing + ': only an administrator of ' + repo + ' may do it, and you ' + (perms.push ? 'have Write' : 'may not push') + ' there. An administrator does it from their own Share tab.');
    }
    if (!signedInByApp()) return Promise.resolve('GitHub refused ' + doing + ': this token needs the repository permission Administration: Read and write on ' + repo + '.');
    return ghListOf('/user/installations?per_page=100', 'installations', 2).then(function (installs) {
      var inst = installs.filter(function (i) { return i.account && String(i.account.login).toLowerCase() === owner; })[0];
      if (!inst) return 'GitHub refused ' + doing + ': SymphonyBoard is not installed where ' + repo + ' is, so the sign-in cannot act on it.';
      if (!inst.permissions || inst.permissions.administration !== 'write') {
        return 'GitHub refused ' + doing + ': SymphonyBoard\'s installation has not accepted the Administration permission yet. Accept it once at ' + shareInstallationPage(inst) + ' (Review request, then Accept).';
      }
      return 'GitHub refused ' + doing + ' (' + e.status + ') although you administer ' + repo + ' and SymphonyBoard holds Administration there: ' + e.message;
    }, function () {
      return 'GitHub refused ' + doing + ' (' + e.status + '): it needs you to administer ' + repo + ' and SymphonyBoard\'s Administration permission accepted on its installation, at ' + installationsPage(repo) + '.';
    });
  }
  function shareInviteFailed(e) {
    return shareRefused(shareRepo(), e, 'the invitation').then(function (words) { shareSay(words + ' Open GitHub\'s Add people instead.'); });
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
    var asking = accessRequests(repo).catch(function () { return null; });
    Promise.all([people, waiting, whoAmI().catch(function () { return ''; }), asking]).then(function (r) {
      if (mine !== shareSeq || state.repo !== repo) return;
      var list = r[0], invites = r[1], me = r[2], asks = r[3] || [];
      clear(body);
      var owner = state.meta && state.meta.owner;
      if (!org && owner && owner.login && !list.some(function (p) { return p.login === owner.login; })) list.unshift({ login: owner.login, role_name: 'admin' });
      asks.forEach(function (issue) { add(body, shareAskRow(issue)); });
      list.forEach(function (p) { add(body, sharePersonRow(p, me, owner)); });
      (invites || []).forEach(function (inv) { add(body, shareInviteRow(inv)); });
      add(body, addTileRow('+ Add people', 'sh-tile', function () { openDialog('dlg-share'); }, 5));
      $('sh-state').textContent = (r[3] === null ? 'the requests to join could not be read; ' : asks.length ? plural(asks.length, 'request') + ' to join, ' : '') + plural(list.length, 'person', 'people') + ' with access' + (org ? ' by name' : '') +
        (invites ? (invites.length ? ', ' + plural(invites.length, 'invitation') + ' waiting' : ', no invitation waiting') : '; the invitations could not be read') +
        (org ? '. Members of ' + owner.login + ' may reach it through the organization too: see GitHub\'s Collaborators and teams.' : '.');
    }).catch(function (e) {
      if (mine !== shareSeq) return;
      clear(body);
      var refused = e.status === 403 || e.status === 404;
      // someone who may not push here can still ask to join, which an administrator answers on this tab
      if (refused) add(body, addTileRow('+ Ask to join ' + repo, 'sh-ask', function () { requestAccess(repo, function (t) { if (mine === shareSeq && state.repo === repo) richText($('sh-state'), t); }); }, 5));
      add(body, addTileRow('+ Add people', 'sh-tile', function () { openDialog('dlg-share'); }, 5));
      $('sh-state').textContent = (refused
        ? 'GitHub shows who has access to ' + repo + ' only to people who may push to it' + (signedInByApp() ? ', through an installation that may read its administration' : ', with a token that may') + '. + Ask to join asks its administrators to let you in.'
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
      return shareRefused(repo, e, 'the role change').then(function (words) { richText(said, words); say(words, true); });
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
      return shareRefused(repo, e, pending ? 'withdrawing the invitation' : 'taking the access away').then(function (words) { say(words, true); });
    });
  }
  // A request to join is an issue whose first line is ACCESS_MARK, opened by the person asking, which
  // anyone who may open an issue can do with no role at all (the owner, 2026-10-19). Its author is who
  // asks, whatever its title says; an administrator answers it here, Invite or the X, and the issue's
  // close tells the person, since GitHub notifies an issue's author.
  var ACCESS_MARK = '<!-- symphony-access: request -->';
  function isAccessRequest(issue) {
    return !!issue && !issue.pull_request && !!issue.user && String(issue.body || '').split(/\r?\n/)[0].trim() === ACCESS_MARK;
  }
  function accessRequests(repo) {
    return ghList('/repos/' + repo + '/issues?state=open&per_page=100', 1).then(function (list) {
      var seen = {};
      // one row per person, their oldest request, since a second press opens no second row
      return list.filter(isAccessRequest).reverse().filter(function (i) {
        var who = i.user.login.toLowerCase();
        if (seen[who]) return false;
        seen[who] = true;
        return true;
      });
    });
  }
  function requestAccess(repo, tell) {
    tell('Asking ' + repo + '\'s administrators...');
    return whoAmI().then(function (me) {
      if (!me) throw new Error('Sign in first.');
      return ghList('/repos/' + repo + '/issues?state=open&creator=' + encodeURIComponent(me) + '&per_page=100', 1).catch(function () { return []; }).then(function (open) {
        var mine = open.filter(isAccessRequest).pop();
        if (mine) { tell('You asked already (issue #' + mine.number + '); an administrator answers it on the Share tab, and GitHub tells you when they do.'); return null; }
        return gh('POST', '/repos/' + repo + '/issues', { title: 'Access request: ' + me,
          body: ACCESS_MARK + '\n' + me + ' asks to join ' + repo + ' as a collaborator. An administrator answers on the control panel\'s Share tab (Invite, or the X to decline), or on GitHub\'s Collaborators and teams page; closing this issue tells ' + me + '.' }).then(function (r) {
          tell('Asked. ' + repo + '\'s administrators see your request on their Share tab (issue #' + r.data.number + '); GitHub tells you when they answer, and an invitation comes by email and at https://github.com/' + repo + '/invitations.');
        });
      });
    }).catch(function (e) {
      tell((e.status === 403 || e.status === 404 || e.status === 410 ? 'GitHub would not let you open an issue on ' + repo + ', so you cannot ask from here; ask one of its administrators directly; its owner\'s page is https://github.com/' + repo.split('/')[0] + '.' : 'Asking did not work: ' + e.message), true);
    });
  }
  function shareAskRow(issue) {
    var login = issue.user.login;
    var tr = el('tr', 'share__pending');
    var invite = btn('Invite', false, function () { shareAnswer(issue, true, invite); });
    invite.className = 'console__primary';
    var status = add(el('td', 'share__status'), 'Asked ', timeEl(issue.created_at), ' ', invite);
    add(tr, add(el('td', 'share__facecell'), shareInitial(login)), add(el('td', 'share__who'), link('https://github.com/' + encodeURIComponent(login), login)), add(el('td'), el('span', 'share__role', 'Asks to join')), status);
    add(tr, cardControls(tr, 'the request of ' + login, {
      open: function () {
        var form = itemDialog(login);
        add(form, fact('Stands:', 'Asks to join ' + shareRepo() + '; Invite gives them ' + (shareInOrg() ? 'Write' : 'collaborator') + ' access, which the gear changes later.'));
        add(form, fact('Asked:', timeEl(issue.created_at)));
        add(form, add(el('p', 'tkdlg__bar'), link('https://github.com/' + encodeURIComponent(login), 'Their profile'), link(issue.html_url, 'The request on GitHub')));
      },
      x: function (b) { shareAnswer(issue, false, b); }
    }));
    return tr;
  }
  // Invite, or decline with the X: the issue is closed with a word to the person either way
  function shareAnswer(issue, yes, button) {
    var repo = shareRepo(), login = issue.user.login;
    if (!yes && !window.confirm('Decline ' + login + '\'s request to join ' + repo + '?')) return;
    button.disabled = true;
    say(yes ? 'Inviting ' + login + '...' : 'Declining...');
    var invited = false, had = false;
    var call = yes
      ? gh('PUT', '/repos/' + repo + '/collaborators/' + encodeURIComponent(login), shareInOrg() ? { permission: 'push' } : undefined)
      : Promise.resolve(null);
    call.then(function (r) {
      // GitHub answers 204 when they have access already, through the organization or an earlier invitation
      invited = yes;
      had = yes && !!r && r.status !== 201;
      var words = !yes ? 'Declined by an administrator of ' + repo + '.' : had ? 'You have access to ' + repo + ' already.' : 'Invited: accept at https://github.com/' + repo + '/invitations.';
      return gh('POST', '/repos/' + repo + '/issues/' + issue.number + '/comments', { body: words }).catch(function () { return null; }).then(function () {
        return gh('PATCH', '/repos/' + repo + '/issues/' + issue.number, { state: 'closed', state_reason: yes ? 'completed' : 'not_planned' });
      });
    }).then(function () {
      say(!yes ? login + '\'s request is declined.' : had ? login + ' has access to ' + repo + ' already; the request is closed.' : 'Invited ' + login + ' with ' + (shareInOrg() ? 'Write' : 'collaborator') + ' access.');
      if (state.repo === repo) sharePeople();
    }).catch(function (e) {
      button.disabled = false;
      var why = e.status === 403 || e.status === 404 ? 'GitHub refused: answering a request needs you to administer ' + repo + ' and SymphonyBoard\'s Administration permission accepted on its installation, at ' + installationsPage(repo) + '.' : e.message;
      say(invited ? 'Invited ' + login + ', but the request could not be closed: ' + why : why, true);
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

  /* ---------- the Notebooks tab: the drive's files grouped, each group a private repository ---------- */
  // The drive organizer proposes notebooks in notebooks.json, beside catalog.json on the branch
  // drive-catalog of a private repository: each names a few of the catalog's files by path, with a
  // title, a summary and the name of the repository that is, or will be, the notebook's own, and
  // left_out lists the paths no notebook holds (tools/notebook.py in the template holds the shape and
  // checks a proposal against the catalog). The tab draws each notebook as a card counted from the
  // catalog's entries, as notebook.py show counts them, and writes the proposal back, as the person,
  // when a notebook is added, changed or taken out. The files themselves are never touched: a
  // notebook points at them where they are, and a file may sit in several.
  var NOTEBOOKS_FILE = 'notebooks.json';
  var NOTEBOOK_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var NOTEBOOK_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
  var NOTEBOOKS_MAX = 30;
  // the dialog draws this many of the catalog's files at a time; the search finds the rest
  var NOTEBOOK_PICK_SHOWN = 300;
  // a file's contents with its sha, whatever its size: past 1 MB GitHub gives the sha alone
  var OBJECT = { 'Accept': 'application/vnd.github.object+json' };
  // the repository read, its proposal and the catalog's files by path, and the sha of each file as
  // read; the note that stands in for the cards; the problems that keep the proposal read-only; the
  // card open in the side panel; whether each repository a notebook names exists, is public or is
  // not found
  var nb = { repo: '', era: 0, data: null, known: null, sha: null, catalogSha: null, note: '', problems: [], side: '', made: Object.create(null), admin: Object.create(null) };
  // the repository a write of notebooks.json is on its way to, the sign-in it went out under and which
  // write it is: kept apart from nb, which a Refresh or another repository clears, so a second write
  // never starts beside the first; a sign-out leaves the write's refusal unanswered (call), so the
  // lock goes with the sign-in, and a write that lands after one frees no lock a later write holds
  var nbWriting = '', nbWritingEnds = 0, nbWriteId = 0;
  function nbBusy() { if (nbWriting && nbWritingEnds !== ends) nbWriting = ''; return nbWriting; }
  function nbForget() { nb.era++; nb.repo = ''; nb.data = null; nb.known = null; nb.sha = null; nb.catalogSha = null; nb.note = ''; nb.problems = []; nb.side = ''; nb.made = Object.create(null); nb.admin = Object.create(null); }
  // private, internal (which every member of its enterprise may read) or public, by GitHub's word
  function nbVisibility(meta) {
    if (isPlain(meta) && (meta.visibility === 'private' || meta.visibility === 'internal' || meta.visibility === 'public')) return meta.visibility;
    return isPlain(meta) && meta.private === true ? 'private' : 'public';
  }
  // a repository a notebook names that is there, whoever may read it
  function nbFound(name) { var made = nb.made[name]; return made === 'yes' || made === 'public' || made === 'internal'; }
  function nbParsed(text) { try { var v = JSON.parse(text); return isPlain(v) ? v : null; } catch (e) { return null; } }
  // the catalog's files by path, as notebook.py reads them
  function nbKnown(made) {
    if (!made || !Array.isArray(made.files)) return null;
    var known = Object.create(null);
    made.files.forEach(function (f) { if (isPlain(f) && typeof f.path === 'string') known[f.path] = f; });
    return known;
  }
  // each way a proposal does not hold together with the catalog, in notebook.py's words, so the tab
  // and the skill refuse the same file
  function nbProblems(proposal, known) {
    if (!isPlain(proposal)) return ['the proposal is not an object'];
    var books = proposal.notebooks;
    if (!Array.isArray(books) || !books.length) return ['notebooks is not a list of at least one notebook'];
    if (books.length > NOTEBOOKS_MAX) return [books.length + ' notebooks, more than ' + NOTEBOOKS_MAX];
    var problems = [], slugs = Object.create(null);
    books.forEach(function (book, i) {
      var where = 'notebook ' + (i + 1);
      if (!isPlain(book)) { problems.push(where + ' is not an object'); return; }
      if (typeof book.slug !== 'string' || !NOTEBOOK_SLUG.test(book.slug)) { problems.push(where + '\'s slug is not lowercase letters, digits and dashes'); return; }
      where = 'notebook ' + book.slug;
      if (slugs[book.slug]) problems.push(where + ' is named twice');
      slugs[book.slug] = true;
      ['title', 'summary'].forEach(function (field) { if (typeof book[field] !== 'string' || !book[field].trim()) problems.push(where + ' has no ' + field); });
      if (typeof book.repository !== 'string' || !NOTEBOOK_REPO.test(book.repository)) problems.push(where + '\'s repository is not a repository name');
      var files = book.files;
      if (!Array.isArray(files) || !files.length || !files.every(function (p) { return typeof p === 'string'; })) { problems.push(where + ' holds no list of file paths'); return; }
      var seen = Object.create(null), twice = false;
      files.forEach(function (p) {
        if (!(p in known)) problems.push(where + ' names ' + p + ', which the catalog does not list');
        if (seen[p]) twice = true;
        seen[p] = true;
      });
      if (twice) problems.push(where + ' names a file twice');
    });
    var left = proposal.left_out === undefined ? [] : proposal.left_out;
    if (!Array.isArray(left) || !left.every(function (p) { return typeof p === 'string'; })) return problems.concat(['left_out is not a list of paths']);
    left.forEach(function (p) { if (!(p in known)) problems.push('left_out names ' + p + ', which the catalog does not list'); });
    return problems;
  }
  // a file on the branch drive-catalog with the sha of the version read, asked past the browser's
  // cache (GitHub lets a signed-in read be kept a minute), so a write goes over the version drawn and
  // no other; a file over 1 MB comes as its blob, by that sha, which no later change can alter
  function nbRead(repo, name) {
    var path = '/repos/' + repo + '/contents/' + name + '?ref=' + encodeURIComponent(CATALOG_BRANCH) + '&at=' + Date.now();
    return gh('GET', path, undefined, OBJECT).then(function (r) {
      var d = r.data;
      if (!isPlain(d) || d.type !== 'file' || typeof d.sha !== 'string') throw new Error(name + ' on ' + CATALOG_BRANCH + ' is not a file.');
      if (d.encoding === 'base64') return { text: new TextDecoder().decode(fromBase64(String(d.content || '').replace(/\s+/g, ''))), sha: d.sha };
      return gh('GET', '/repos/' + repo + '/git/blobs/' + d.sha, undefined, RAW, true).then(function (b) { return { text: typeof b.data === 'string' ? b.data : '', sha: d.sha }; });
    }, function (e) { if (e.status === 404) return null; throw e; });
  }
  function openNotebooks() {
    var repo = foldersRepo();
    // the repository's meta is still being read: loadRepo opens the tab again once it is in, since
    // whether the repository is private decides what is read
    if (!state.meta && repo && token && !state.ready) { if (nb.repo !== repo) { nbForget(); drawNotebooks(); } return; }
    if (nb.repo === repo && (nb.data || nb.note)) { drawNotebooks(); return; }
    loadNotebooks(repo);
  }
  function loadNotebooks(repo) {
    nbForget();
    var era = nb.era;
    nb.repo = repo;
    if (!repo) nb.note = 'No repository is chosen: choose one in the bar.';
    else if (!token) nb.note = 'Sign in to read the notebooks of ' + repo + '.';
    else if (!state.meta) nb.note = repo + ' could not be read, so whether it is private is not known and its notebooks are not read. Press Refresh to try again.';
    else if (nbVisibility(state.meta) !== 'private') nb.note = repo + (nbVisibility(state.meta) === 'internal' ? ' is internal: every member of its enterprise can read it' : ' is public') + '. A notebook names a person\'s files, so a proposal lives only on a private repository\'s branch ' + CATALOG_BRANCH + '.';
    drawNotebooks();
    if (nb.note) return;
    Promise.all([nbRead(repo, NOTEBOOKS_FILE), nbRead(repo, CATALOG_FILE)]).then(function (got) {
      if (era !== nb.era) return;
      nb.known = got[1] ? nbKnown(nbParsed(got[1].text)) : null;
      if (!nb.known) { nb.note = repo + ' has no catalog yet: the drive organizer writes ' + CATALOG_FILE + ' to its branch ' + CATALOG_BRANCH + ' first, and notebooks are proposed from it.'; drawNotebooks(); return; }
      nb.catalogSha = got[1].sha;
      nb.sha = got[0] ? got[0].sha : null;
      // no proposal yet: the + tile makes the first
      if (!got[0]) { nb.data = { notebooks: [], left_out: Object.keys(nb.known) }; drawNotebooks(); return; }
      var proposal = nbParsed(got[0].text);
      nb.problems = nbProblems(proposal, nb.known);
      nb.data = proposal && Array.isArray(proposal.notebooks) ? proposal : { notebooks: [], left_out: [] };
      drawNotebooks();
      askMade(repo, era);
    }).catch(function (e) { if (era !== nb.era) return; nb.note = repo + ' could not be read: ' + e.message; drawNotebooks(); });
  }
  // whether each repository the notebooks name exists under the catalog repository's owner, asked
  // one at a time so a proposal of thirty costs no burst, and drawn once all are answered
  function askMade(repo, era) {
    var owner = repo.split('/')[0], names = [];
    (nb.data.notebooks || []).forEach(function (b) {
      if (isPlain(b) && typeof b.repository === 'string' && NOTEBOOK_REPO.test(b.repository) && names.indexOf(b.repository) < 0 && !nb.made[b.repository]) names.push(b.repository);
    });
    names.reduce(function (done, name) {
      return done.then(function () {
        if (era !== nb.era) return;
        return gh('GET', '/repos/' + owner + '/' + name).then(function (r) {
          // whether the person may change its visibility, where GitHub says
          if (isPlain(r.data) && isPlain(r.data.permissions) && typeof r.data.permissions.admin === 'boolean' && era === nb.era) nb.admin[name] = r.data.permissions.admin;
          var v = nbVisibility(r.data); return v === 'private' ? 'yes' : v;
        }, function (e) { return e.status === 404 ? 'no' : 'unread'; })
          .then(function (word) { if (era === nb.era) nb.made[name] = word; });
      });
    }, Promise.resolve()).then(function () { if (era === nb.era && names.length) drawNotebooks(); });
  }
  function nbBook(slug) {
    if (!slug || !nb.data) return null;
    return (nb.data.notebooks || []).filter(function (b) { return isPlain(b) && b.slug === slug; })[0] || null;
  }
  function nbTitle(book) { return typeof book.title === 'string' && book.title.trim() ? book.title : String(book.slug || ''); }
  function nbSize(it) { var n = typeof it.size === 'number' ? it.size : parseInt(it.size, 10); return n > 0 ? Math.floor(n) : 0; }
  function nbBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.max(1, Math.round(n / 1024)).toLocaleString('en-US') + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function nbDay(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10); }
  // what a card shows, counted as notebook.py show counts it: the files the catalog knows, their
  // sizes summed, their kinds most common first (ties as first met) and the newest change
  function nbSummary(book) {
    var items = [], missing = 0, bytes = 0, counts = Object.create(null), order = [], latest = '';
    (Array.isArray(book.files) ? book.files : []).forEach(function (p) {
      var it = typeof p === 'string' && nb.known ? nb.known[p] : null;
      if (!it) { missing++; return; }
      items.push(it);
      bytes += nbSize(it);
      var kind = typeof it.kind === 'string' && it.kind ? it.kind : 'other';
      if (!counts[kind]) { counts[kind] = 0; order.push(kind); }
      counts[kind]++;
      var when = typeof it.modified === 'string' ? it.modified : '';
      if (when > latest) latest = when;
    });
    order.sort(function (a, b) { return counts[b] - counts[a]; });
    return { items: items, missing: missing, bytes: bytes, kinds: order.map(function (k) { return [k, counts[k]]; }), latest: latest };
  }
  function nbKinds(kinds) {
    var box = el('span', 'nb__kinds');
    kinds.forEach(function (k) { add(box, el('span', 'nb__kind', k[0] + ' ' + k[1])); });
    return box;
  }
  function nbMadeWords(name) {
    var made = nb.made[name];
    return made === 'yes' ? ['tok__state tok__state--go', 'Repository made'] : made === 'public' ? ['tok__state tok__state--warn', 'Repository is public']
      : made === 'internal' ? ['tok__state tok__state--warn', 'Repository is internal']
      : made === 'no' ? ['tok__state tok__state--warn', 'Repository not found'] : made === 'unread' ? ['tok__state', 'Repository not read'] : null;
  }
  function nbCanWrite() { return !!(token && nb.data && nb.known && !nb.problems.length); }
  function nbTile(book, i) {
    var sum = nbSummary(book), title = nbTitle(book) || 'notebook ' + (i + 1);
    var wrap = el('div', 'tok');
    var open = el('button', 'tok__open');
    open.type = 'button';
    open.id = 'nb-tile-' + (typeof book.slug === 'string' ? book.slug : i);
    open.title = 'The files of ' + title;
    if (nb.side && nb.side === book.slug) wrap.className += ' tok--on';
    var made = nbMadeWords(book.repository);
    var first = title.replace(/^\s+/, '').charAt(0);
    add(open, el('span', 'tok__icon', first ? first.toUpperCase() : '?'), el('span', 'tok__name', title),
        el('span', 'tok__owner', typeof book.repository === 'string' ? book.repository : 'no repository named'),
        el('span', 'tok__meta', plural(sum.items.length, 'file') + (sum.bytes ? ', ' + nbBytes(sum.bytes) : '') + (sum.missing ? ', ' + sum.missing + ' not in the catalog' : '')),
        sum.kinds.length ? nbKinds(sum.kinds) : null,
        el('span', 'tok__meta', sum.latest ? 'Changed ' + nbDay(sum.latest) : 'No change date'),
        made ? el('span', made[0], made[1]) : null);
    open.addEventListener('click', function () { if (typeof book.slug === 'string') openNotebookSide(book.slug); });
    if (!nbCanWrite()) return add(wrap, open);
    var gear = el('button', 'tok__gear', '⚙');
    gear.type = 'button';
    gear.id = 'nb-gear-' + book.slug;
    gear.title = 'Change ' + title;
    gear.setAttribute('aria-label', 'Change ' + title);
    gear.addEventListener('click', function (ev) { ev.stopPropagation(); openNotebookDialog(book.slug); });
    var x = el('button', 'tok__x', '×');
    x.type = 'button';
    x.id = 'nb-remove-' + book.slug;
    x.title = 'Take ' + title + ' out of the proposal';
    x.setAttribute('aria-label', 'Take ' + title + ' out of the proposal');
    x.addEventListener('click', function (ev) { ev.stopPropagation(); removeNotebook(book.slug, x); });
    return add(wrap, open, gear, x);
  }
  function drawNotebooks() {
    var box = $('nb-tiles');
    if (!box) return;
    clear(box);
    var repo = nb.repo || foldersRepo();
    if (nb.note) { add(box, el('p', 'admin__none toks__note', nb.note)); drawNotebookSide(); return; }
    if (!nb.data) { none(box, !token ? 'Sign in to read the notebooks.' : repo ? 'Reading the notebooks of ' + repo + '...' : 'No repository is chosen: choose one in the bar.'); drawNotebookSide(); return; }
    var books = (nb.data.notebooks || []).filter(isPlain);
    if (nb.problems.length) add(box, el('p', 'admin__none admin__warn toks__note', NOTEBOOKS_FILE + ' on ' + CATALOG_BRANCH + ' does not hold together with the catalog, so it is shown as it is and changed only by hand: ' + nb.problems.join('; ') + '.'));
    books.forEach(function (b, i) { add(box, nbTile(b, i)); });
    if (nbCanWrite()) {
      if (books.length < NOTEBOOKS_MAX) {
        var plus = el('button', 'tok__open tok--add');
        plus.type = 'button';
        plus.id = 'nb-add';
        add(plus, el('span', 'tok__plus', '+'), el('span', 'tok__name', 'New notebook'));
        plus.addEventListener('click', function () { openNotebookDialog(''); });
        add(box, add(el('div', 'tok'), plus));
      } else add(box, el('p', 'admin__none toks__note', 'A proposal holds at most ' + NOTEBOOKS_MAX + ' notebooks; take one out to propose another.'));
    }
    var left = Array.isArray(nb.data.left_out) ? nb.data.left_out.length : 0;
    if (!books.length && !nb.problems.length) add(box, el('p', 'admin__none toks__note', 'No notebook is proposed yet for ' + repo + ': + makes the first from the catalog\'s ' + plural(Object.keys(nb.known).length, 'file') + '. The files stay on the drive; a notebook only points at them.'));
    else if (left) add(box, el('p', 'admin__none toks__note', plural(left, 'file') + ' of the catalog ' + (left === 1 ? 'is' : 'are') + ' in no notebook.'));
    drawNotebookSide();
  }
  // the side panel: the notebook's summary, its repository and its files, newest change first
  function openNotebookSide(slug) {
    nb.side = nb.side === slug ? '' : slug;
    drawNotebooks();
  }
  function drawNotebookSide() {
    var side = $('nb-side');
    if (!side) return;
    var book = nbBook(nb.side);
    if (!book) { nb.side = ''; side.hidden = true; clear(side); return; }
    clear(side);
    side.hidden = false;
    add(side, splitGrip('nbside', 'this panel'));
    var close = el('button', 'tkside__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { openNotebookSide(book.slug); });
    var sum = nbSummary(book), owner = nb.repo.split('/')[0], made = nb.made[book.repository];
    add(side, close, el('h3', 'console__boxh', nbTitle(book)));
    var repoLine = el('p', 'tok__owner');
    if (nbFound(book.repository)) add(repoLine, link('https://github.com/' + owner + '/' + book.repository, owner + '/' + book.repository));
    else add(repoLine, typeof book.repository === 'string' ? book.repository : 'no repository named');
    add(side, repoLine);
    if (made === 'public' || made === 'internal') {
      // a person GitHub says does not administer it is pointed at neither the button nor the
      // settings page, which GitHub shows only to an administrator
      var opened = (made === 'public' ? 'The repository is public' : 'The repository is internal, which every member of its enterprise can read') + ', and a notebook names a person\'s files';
      add(side, nb.admin[book.repository] !== false ? add(el('p', 'tok__state tok__state--warn'), opened + ': make it private here, or on GitHub under ',
        link('https://github.com/' + owner + '/' + book.repository + '/settings', 'its settings'), ' (General, Danger Zone, Change visibility).')
        : el('p', 'tok__state tok__state--warn', opened + ', so it should be private.'));
      var priv = el('button', 'console__primary', nbPrivateBusy() === owner + '/' + book.repository ? 'Making it private...' : 'Make private');
      priv.type = 'button';
      priv.id = 'nb-private';
      priv.disabled = !!nbPrivateBusy();
      priv.addEventListener('click', function () { makeNotebookPrivate(book.repository, priv); });
      if (nb.admin[book.repository] === false) add(side, el('p', 'tkdlg__fact tkdlg__faint', 'Only an administrator of ' + owner + '/' + book.repository + ' may change its visibility, and GitHub says you are not one: ask one to make it private.'));
      else add(side, add(el('p', 'admin__bar'), priv));
    }
    else if (made) add(side, el('p', 'tok__state ' + (made === 'yes' ? 'tok__state--go' : made === 'no' ? 'tok__state--warn' : ''),
      made === 'yes' ? 'The repository is made.' : made === 'no' ? 'The repository is not made yet, or this sign-in cannot reach it' + (signedInByApp() ? ' (SymphonyBoard reaches only the repositories it is installed on)' : '') + ': the notebook skill makes it from this proposal.' : 'Whether the repository is made could not be read.'));
    if (typeof book.summary === 'string' && book.summary.trim()) add(side, el('p', 'tkdlg__fact', book.summary));
    add(side, el('p', 'tkdlg__fact tkdlg__faint', plural(sum.items.length, 'file') + (sum.bytes ? ', ' + nbBytes(sum.bytes) : '') + (sum.latest ? '; the newest changed ' + nbDay(sum.latest) : '') + (sum.missing ? '; ' + plural(sum.missing, 'path') + ' not in the catalog' : '') + '.'));
    if (sum.kinds.length) add(side, nbKinds(sum.kinds));
    var list = el('ul', 'nb__files');
    list.id = 'nb-files';
    sum.items.slice().sort(function (a, b) {
      var x = typeof a.modified === 'string' ? a.modified : '', y = typeof b.modified === 'string' ? b.modified : '';
      return x < y ? 1 : x > y ? -1 : 0;
    }).forEach(function (it) {
      var li = el('li', 'nb__file');
      var name = typeof it.name === 'string' && it.name ? it.name : catLast(it.path);
      var web = exHttps(it.web), size = nbSize(it);
      add(li, web ? link(web, name) : el('span', 'nb__name', name), el('span', 'nb__kind', typeof it.kind === 'string' && it.kind ? it.kind : 'other'),
          el('span', 'nb__when', (typeof it.modified === 'string' && it.modified ? 'Changed ' + nbDay(it.modified) : 'No change date') + (size ? ', ' + nbBytes(size) : '')));
      add(list, li);
    });
    (Array.isArray(book.files) ? book.files : []).forEach(function (p) {
      if (typeof p === 'string' && nb.known && nb.known[p]) return;
      add(list, add(el('li', 'nb__file'), el('span', 'nb__name', String(p)), el('span', 'nb__kind', 'not in the catalog')));
    });
    add(side, list);
  }
  // a notebook's repository made private, as the person, once they confirm what the change costs:
  // what GitHub's own question says, and, for a public repository, what GitHub's plans give a public
  // repository alone. SymphonyBoard's Administration is what lets it, and GitHub lets only an
  // administrator of the repository do it (an organization may keep it to its owners); one change at
  // a time, and the answer, not the press, says what the repository is now. A sign-out leaves the
  // change's refusal unanswered (call), so the lock goes with the sign-in, as the write's does, and an
  // answer that comes after one frees no lock a later change holds
  var nbPrivating = '', nbPrivatingEnds = 0, nbPrivateId = 0;
  function nbPrivateBusy() { if (nbPrivating && nbPrivatingEnds !== ends) nbPrivating = ''; return nbPrivating; }
  // GitHub Free enforces rulesets and branch protection only on a public repository, and runs code
  // scanning, secret scanning and push protection on a private one only with GitHub Code Security or
  // Secret Protection, which only an organization on a paid plan buys; an internal repository is an
  // enterprise's, whose plan enforces both on a private one, and GitHub runs those products on an
  // internal repository on the same terms as on a private one, so it loses none of them
  function nbPrivateWords(full, was) {
    return 'Make ' + full + ' private? Only the people given access to it will see it. GitHub erases its stars and watchers'
      + (was === 'public' ? ', leaves its forks public and detaches them, and unpublishes its GitHub Pages site on a free plan, where its rulesets and branch protection also stop being enforced.'
        + ' Its code scanning stops unless its owner has GitHub Code Security, and its secret scanning and push protection unless its owner has GitHub Secret Protection'
        : ' and its forks become private, those of people without access removed')
      + '. The repository\'s files and history themselves stay as they are.';
  }
  function makeNotebookPrivate(name, button) {
    var owner = nb.repo.split('/')[0], full = owner + '/' + name, era = nb.era, was = nb.made[name];
    if (was !== 'public' && was !== 'internal') return;
    if (nbPrivateBusy()) { say(nbPrivating + ' is being made private; press again once GitHub has answered.'); return; }
    if (!window.confirm(nbPrivateWords(full, was))) return;
    var mine = ++nbPrivateId;
    nbPrivating = full;
    nbPrivatingEnds = ends;
    button.disabled = true;
    button.textContent = 'Making it private...';
    say('Making ' + full + ' private...');
    var answered = false;
    gh('PATCH', '/repos/' + full, { visibility: 'private' }).then(function (r) {
      var now = nbVisibility(r.data);
      answered = true;
      if (era === nb.era) nb.made[name] = now === 'private' ? 'yes' : now;
      say(now === 'private' ? full + ' is private now: only the people given access to it see it.' : 'GitHub answered, but ' + full + ' is still ' + now + '.', now !== 'private');
    }, function (e) {
      var access = e.status === 404 || e.status === 422 || (e.status === 403 && !nbRateLimited(e));
      say('GitHub did not make ' + full + ' private: ' + e.message + (access ? ' Only an administrator of ' + full + ' may change its visibility'
        + (signedInByApp() ? ', with SymphonyBoard installed on it and its Administration permission accepted' : ', with Administration: read and write on the token')
        + ', and an organization may keep the change to its owners.' : ''), true);
    }).then(function () {
      if (nbPrivateId === mine) nbPrivating = '';
      // a Refresh, another repository in the bar or a sign-in again moved the tab on meanwhile, and
      // what it read of the repository since may predate the change: where it still shows a catalog
      // of the same owner, whose notebooks may name this repository, it is read again, as a write's
      // repository is; otherwise the tab is drawn again, so no button the lock held stays held
      if (answered && era !== nb.era && nb.repo && nb.repo.split('/')[0] === owner) nbReread(nb.repo);
      else drawNotebooks();
    });
  }
  // a slug from a title, as notebook.py takes one: lowercase letters, digits and dashes, up to forty,
  // made unique among the proposal's with a number
  function nbSlugOf(title, taken) {
    var base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'notebook';
    var slug = base, n = 1;
    while (taken[slug]) { n++; var tail = '-' + n; slug = base.slice(0, 40 - tail.length).replace(/-+$/, '') + tail; }
    return slug;
  }
  // the dialog that proposes a notebook or changes one: its title, summary and repository, and the
  // catalog's files ticked; Propose or Save closes it at once and the write speaks in the note
  function openNotebookDialog(slug) {
    var d = $('nb-dialog');
    if (!d) return;
    if (!nbCanWrite()) { say('The notebooks are still being read; press again in a moment.'); return; }
    if (nbBusy()) { say('A change to ' + NOTEBOOKS_FILE + ' on ' + nbWriting + ' is on its way; press again once it has landed.'); return; }
    var book = nbBook(slug);
    if (slug && !book) return;
    if (!book && (nb.data.notebooks || []).length >= NOTEBOOKS_MAX) { say('A proposal holds at most ' + NOTEBOOKS_MAX + ' notebooks: take one out first.', true); return; }
    clear(d);
    var form = el('form', 'tkdlg__form');
    form.method = 'dialog';
    add(form, el('h3', 'console__boxh', book ? nbTitle(book) : 'New notebook'));
    var title = el('input');
    title.id = 'nb-d-title'; title.type = 'text'; title.maxLength = 120; title.autocomplete = 'off';
    title.placeholder = 'what these files are about';
    title.value = book ? nbTitle(book) : '';
    var summary = el('textarea');
    summary.id = 'nb-d-summary'; summary.maxLength = 2000; summary.rows = 3;
    summary.placeholder = 'a sentence or two on what the notebook is for';
    summary.value = book && typeof book.summary === 'string' ? book.summary : '';
    var repoName = el('input');
    repoName.id = 'nb-d-repo'; repoName.type = 'text'; repoName.maxLength = 100; repoName.autocomplete = 'off'; repoName.spellcheck = false;
    repoName.placeholder = 'the name of its private repository; blank takes the title\'s';
    repoName.value = book && typeof book.repository === 'string' ? book.repository : '';
    add(form, labelled(title, 'Title'), labelled(summary, 'Summary'), labelled(repoName, 'Repository, under ' + nb.repo.split('/')[0]));
    var filter = el('input');
    filter.id = 'nb-d-filter'; filter.type = 'search'; filter.autocomplete = 'off';
    filter.placeholder = 'find a file by its path';
    add(form, labelled(filter, 'Files'));
    var pick = el('div', 'nb__pick');
    pick.id = 'nb-d-files';
    var ticked = Object.create(null);
    (book && Array.isArray(book.files) ? book.files : []).forEach(function (p) { if (nb.known[p]) ticked[p] = true; });
    var paths = Object.keys(nb.known).sort();
    var count = el('p', 'tkdlg__fact tkdlg__faint');
    count.id = 'nb-d-count';
    var more = el('p', 'tkdlg__fact tkdlg__faint');
    more.id = 'nb-d-more';
    function recount() { count.textContent = plural(Object.keys(ticked).length, 'file') + ' ticked' + (paths.length ? ' of ' + paths.length : '') + '.'; }
    // a drive's catalog may list tens of thousands of files, so only the first few hundred that the
    // search matches are drawn, the ticked first, and a tick is kept by path, drawn or not
    function drawPick() {
      clear(pick);
      var q = filter.value.trim().toLowerCase();
      var hits = paths.filter(function (p) { return !q || p.toLowerCase().indexOf(q) >= 0; });
      hits.sort(function (a, b) { return (ticked[b] ? 1 : 0) - (ticked[a] ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0); });
      hits.slice(0, NOTEBOOK_PICK_SHOWN).forEach(function (p) {
        var c = el('input');
        c.type = 'checkbox';
        c.checked = !!ticked[p];
        c.setAttribute('data-path', p);
        c.addEventListener('change', function () { if (c.checked) ticked[p] = true; else delete ticked[p]; recount(); });
        var row = add(el('label'), c, el('span', '', p.indexOf(CATALOG_ROOT + '/') === 0 ? p.slice(CATALOG_ROOT.length + 1) : p));
        row.title = p;
        add(pick, row);
      });
      if (!paths.length) add(pick, el('span', 'tkdlg__faint', 'The catalog lists no files.'));
      else if (!hits.length) add(pick, el('span', 'tkdlg__faint', 'No file\'s path holds that.'));
      more.hidden = hits.length <= NOTEBOOK_PICK_SHOWN;
      more.textContent = more.hidden ? '' : 'Showing ' + NOTEBOOK_PICK_SHOWN + ' of ' + plural(hits.length, 'file') + '; find a file by its path to narrow them.';
    }
    drawPick();
    recount();
    filter.addEventListener('input', drawPick);
    add(form, pick, count, more);
    var problem = el('p', 'admin__warn tkdlg__problem');
    problem.id = 'nb-d-problem';
    problem.hidden = true;
    var save = el('button', 'console__primary', book ? 'Save' : 'Propose');
    save.type = 'submit';
    save.id = 'nb-d-save';
    add(form, problem, add(el('div', 'tkdlg__bar'), save, btn('Cancel', true, function () { d.close(); })));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var files = paths.filter(function (p) { return ticked[p]; });
      var t = title.value.trim(), s = summary.value.trim(), r = repoName.value.trim();
      var taken = Object.create(null);
      (nb.data.notebooks || []).forEach(function (b) { if (isPlain(b) && typeof b.slug === 'string' && b !== book) taken[b.slug] = true; });
      var newSlug = book ? book.slug : nbSlugOf(t, taken);
      if (!r) r = newSlug;
      var why = !t ? 'Give the notebook a title.' : !s ? 'Give it a summary: a sentence on what it is for.'
        : !NOTEBOOK_REPO.test(r) ? 'The repository\'s name takes letters, digits, dots, dashes and underscores, up to a hundred, and starts with a letter or a digit.'
        : r.toLowerCase() === nb.repo.split('/')[1].toLowerCase() ? 'That is the catalog\'s own repository; a notebook gets a private repository of its own.'
        : !files.length ? 'Tick at least one file.' : '';
      if (why) { problem.textContent = why; problem.hidden = false; return; }
      // a changed notebook keeps whatever else the organizer wrote on it
      var made = {};
      if (book) Object.keys(book).forEach(function (k) { made[k] = book[k]; });
      made.slug = newSlug; made.title = t; made.summary = s; made.repository = r; made.files = files;
      var books = (nb.data.notebooks || []).map(function (b) { return b === book ? made : b; });
      if (!book) books.push(made);
      d.close();
      nbWrite(books, (book ? 'Change the notebook ' : 'Propose the notebook ') + newSlug,
        (book ? 'Changed ' : 'Proposed ') + t + ' in ' + NOTEBOOKS_FILE + ' on ' + nb.repo + (book ? '.' : '. The notebook skill makes its repository from the proposal.'));
    });
    add(d, form);
    d.showModal();
    title.focus();
  }
  function removeNotebook(slug, button) {
    var book = nbBook(slug);
    if (!book || !nbCanWrite()) return;
    if (nbBusy()) { say('A change to ' + NOTEBOOKS_FILE + ' on ' + nbWriting + ' is on its way; press again once it has landed.'); return; }
    var others = (nb.data.notebooks || []).filter(function (b) { return b !== book; });
    var elsewhere = Object.create(null);
    others.forEach(function (b) { (isPlain(b) && Array.isArray(b.files) ? b.files : []).forEach(function (p) { elsewhere[p] = true; }); });
    var files = Array.isArray(book.files) ? book.files : [];
    var alone = files.filter(function (p) { return !elsewhere[p]; }).length;
    if (!window.confirm('Take ' + nbTitle(book) + ' out of the proposal? Its ' + plural(files.length, 'file') + ' stay on the drive' + (alone ? ', and ' + (alone === 1 ? 'one of them is' : alone + ' of them are') + ' then in no notebook' : '') + '.' + (nbFound(book.repository) ? ' The repository ' + book.repository + ' stays as it is.' : '') + (others.length ? '' : ' It is the last notebook, so ' + NOTEBOOKS_FILE + ' is deleted from ' + CATALOG_BRANCH + ', with whatever else the organizer wrote in it.'))) return;
    button.disabled = true;
    nbWrite(others, 'Take the notebook ' + slug + ' out of the proposal', 'Took ' + nbTitle(book) + ' out of ' + NOTEBOOKS_FILE + ' on ' + nb.repo + '. Its files stay on the drive.');
  }
  // the catalog's paths no notebook holds, in the catalog's order, as the organizer lists them
  function nbLeftOut(books) {
    var held = Object.create(null);
    books.forEach(function (b) { (isPlain(b) && Array.isArray(b.files) ? b.files : []).forEach(function (p) { held[p] = true; }); });
    return Object.keys(nb.known).filter(function (p) { return !held[p]; });
  }
  // the proposal written back on the branch drive-catalog, as the person, over the version the cards
  // were drawn from (its sha as read, none where there was no file), so a change the organizer made
  // since is never written over: GitHub refuses the write and the tab reads the file again. The
  // proposal keeps whatever else the organizer wrote beside the notebooks, and is checked against the
  // catalog first, which is asked once more, since a notebook drawn from a catalog the organizer has
  // since rewritten could name a path it no longer lists; a proposal with no notebook left is no
  // proposal, and the file goes, as notebook.py takes none, and what else it held goes with it
  function nbWrite(books, message, done) {
    var repo = nb.repo, era = nb.era, account = shownLogin, sha = nb.sha, catalogSha = nb.catalogSha;
    var data = Object.assign({}, nb.data, { notebooks: books });
    data.left_out = nbLeftOut(books);
    var wrong = books.length ? nbProblems(data, nb.known) : [];
    if (wrong.length) { say(NOTEBOOKS_FILE + ' was not written, since it would not hold together with the catalog: ' + wrong.join('; ') + '.', true); return; }
    var path = '/repos/' + repo + '/contents/' + NOTEBOOKS_FILE;
    var mine = ++nbWriteId;
    nbWriting = repo;
    nbWritingEnds = ends;
    say('Writing ' + NOTEBOOKS_FILE + ' on ' + repo + '...');
    // GitHub's refusal of the write itself, not of the read before it
    function wrote(e) { if (e && typeof e === 'object') e.wrote = true; throw e; }
    function changed(name) { var e = new Error(name + ' on ' + CATALOG_BRANCH + ' changed'); e.changed = name; return e; }
    gh('GET', '/repos/' + repo + '/contents/' + CATALOG_FILE + '?ref=' + encodeURIComponent(CATALOG_BRANCH) + '&at=' + Date.now(), undefined, OBJECT).then(function (r) {
      if (!r.data || r.data.sha !== catalogSha) throw changed(CATALOG_FILE);
    }, function (e) { if (e.status === 404) throw changed(CATALOG_FILE); throw e; }).then(function () {
      if (!books.length) return sha ? gh('DELETE', path, { message: message, sha: sha, branch: CATALOG_BRANCH }, undefined, false, account).catch(wrote) : { data: null };
      var put = { message: message, content: utf8Base64(JSON.stringify(data, null, 2) + '\n'), branch: CATALOG_BRANCH };
      if (sha) put.sha = sha;
      return gh('PUT', path, put, undefined, false, account).catch(wrote);
    }).then(function (r) {
      if (nbWriteId === mine) nbWriting = '';
      // the page went to another repository or was refreshed meanwhile: the write still says how it
      // went, and the same repository is read again, since what it drew may predate the write
      if (era !== nb.era) { say(done); if (nb.repo === repo) nbReread(repo); return; }
      nb.data = books.length ? data : { notebooks: [], left_out: Object.keys(nb.known) };
      nb.sha = books.length && r && r.data && isPlain(r.data.content) && typeof r.data.content.sha === 'string' ? r.data.content.sha : null;
      if (nb.side && !nbBook(nb.side)) nb.side = '';
      drawNotebooks();
      say(done);
      askMade(repo, era);
    }).catch(function (e) {
      // GitHub answers a write with 409 for a sha the file no longer has, 422 for a file made where
      // there was none, written with no sha, and 404 for a delete of a file already gone; but 409 for
      // a rule that covers the branch too, and 404 where the sign-in may not write: only the file's
      // sha read now, unlike the one sent, says the organizer changed it
      var ask = !e.changed && e.wrote && (e.status === 409 || e.status === 422 || e.status === 404);
      (ask ? nbShaNow(repo).then(function (now) { return now !== sha; }, function () { return false; }) : Promise.resolve(!!e.changed)).then(function (moved) {
        if (nbWriteId === mine) nbWriting = '';
        // the repository is read again where it is still the one shown or the page's own era
        var again = era === nb.era || nb.repo === repo;
        if (moved) say((e.changed || NOTEBOOKS_FILE) + ' on ' + repo + '\'s ' + CATALOG_BRANCH + ' changed since the cards were drawn, so nothing was written' + (again ? '; it is read again: look it over and press again.' : '.'), true);
        else say(NOTEBOOKS_FILE + ' on ' + repo + ' was not written: ' + e.message + (e.wrote && (e.status === 404 || e.status === 403 && !nbRateLimited(e)) ? ' Writing it needs write access to ' + repo + (signedInByApp() ? ' and Contents: read and write on SymphonyBoard.' : ', with Contents: read and write on the token.') : ''), true);
        if (era !== nb.era) { if (moved && nb.repo === repo) nbReread(repo); return; }
        if (moved) loadNotebooks(repo); else drawNotebooks();
      });
    });
  }
  // the sha notebooks.json has on drive-catalog now, null where there is none
  function nbShaNow(repo) {
    return gh('GET', '/repos/' + repo + '/contents/' + NOTEBOOKS_FILE + '?ref=' + encodeURIComponent(CATALOG_BRANCH) + '&at=' + Date.now(), undefined, OBJECT)
      .then(function (r) { return isPlain(r.data) && typeof r.data.sha === 'string' ? r.data.sha : null; }, function (e) { if (e.status === 404) return null; throw e; });
  }
  // GitHub's rate limit, which it gives as a 429 or as a 403 that says so (explain)
  function nbRateLimited(e) { return e.status === 429 || (e.status === 403 && /rate limit|secondary/i.test(e.data && e.data.message ? String(e.data.message) : '')); }
  // the repository read again where the tab shows it, else forgotten, so its next opening reads it
  function nbReread(repo) { if (consoleTab === 'notebooks') loadNotebooks(repo); else nbForget(); }
  function initNotebooksTab() {
    consoleOnOpen.notebooks = openNotebooks;
  }

  // an address that is https, or none: a link the page draws from what GitHub or a drive says
  function exHttps(url) { return typeof url === 'string' && /^https:\/\//.test(url) ? url : ''; }
  // the lines of a log, each with its time, the colour codes taken out
  function exLines(text) {
    return String(text).split(/\r?\n/).map(function (line) {
      var m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z ?(.*)$/.exec(line);
      var body = (m ? m[3] : line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      return { at: m ? Date.parse(m[1] + (m[2] ? m[2].slice(0, 4) : '') + 'Z') : NaN, text: body };
    });
  }

  /* ---------- Explore: plan an epic with Claude ---------- */
  // The owner, 2026-10-21: Explore should "have claude suggest new connections between the
  // dependency", "suggest new nodes for a graphical representation of brainstorming/code planning",
  // and "push the alterations in the dependencies to the actual tasks". One epic at a time is drawn
  // as cards from the Dependencies tab's latest draw (its sub-issues and the issues blocking them,
  // with GitHub's own blocked-by links), so the tab makes no read of its own. Claude's ideas come
  // from the assistant's answer, as `link` and `node` lines of its symphony block, and are drawn
  // dashed; the person's own cards and links join them. Nothing reaches GitHub until Push, which
  // writes as the person, in order: the new issues, their sub-issue links, then the blocked-by
  // links. Nothing is stored but on GitHub: the ideas live in the answer, and a reload draws them
  // again from it.
  var BS_CARD_W = 228, BS_CARD_H = 96, BS_GAP_X = 84, BS_GAP_Y = 22, BS_PAD = 24;
  var bs = { repo: '', epic: 0, ideas: [], answer: null, pending: [], seq: 0, from: null, connecting: false, pushing: false, last: null };

  // the repository changed: the ideas, the changes and the last push belong to the one before
  function exploreForget() {
    bs.repo = ''; bs.epic = 0; bs.ideas = []; bs.answer = null; bs.pending = []; bs.from = null; bs.last = null;
    bsConnect(false);
  }
  // a draw of the Dependencies tab ended, drawn or not; a fault here is Explore's, never the draw's
  function exploreAfterDraw() {
    if (consoleTab !== 'explore') return;
    try { openExplore(); } catch (e) { bsStatus('Explore could not be drawn: ' + e.message, true); }
  }
  function bsStatus(text, warn) {
    var p = $('bs-status');
    if (!p) return;
    p.textContent = text;
    p.classList.toggle('bs__warn', !!warn);
  }
  function bsDraw() { var s = state; return s && s.graphLast && s.graphLast.s === s ? s.graphLast : null; }
  // the open epics the draw found sub-issues for, in number order
  function bsEpics(draw) { return draw ? graphWithSubIssues(draw, 'epic') : []; }

  // a key names a card: an issue by its number, a task not yet pushed by its ref
  function bsKey(x) { return typeof x === 'number' ? 'i' + x : String(x); }
  function bsTask(ref) { return bs.pending.filter(function (p) { return p.kind === 'task' && p.ref === ref; })[0] || null; }
  function bsIdea(ref) { return bs.ideas.filter(function (p) { return p.kind === 'task' && p.ref === ref; })[0] || null; }

  // what the canvas draws for the epic: the cards and the links among them, each said by where it
  // stands (on GitHub, waiting to be pushed, or Claude's idea), an unlink waiting crossing out a
  // link on GitHub
  function bsModel(draw, epic) {
    var cards = {}, order = [], edges = [];
    function card(key, c) { if (!cards[key]) { cards[key] = c; order.push(key); } return cards[key]; }
    var chart = graphEpic(draw, epic);
    chart.nodes.forEach(function (it) { card(bsKey(it.number), { key: bsKey(it.number), issue: it, where: 'github' }); });
    graphNumbers(draw.blockedBy).forEach(function (blocked) {
      if (!cards[bsKey(blocked)]) return;
      draw.blockedBy[blocked].forEach(function (blocker) {
        var gone = bs.pending.some(function (p) { return p.kind === 'unlink' && p.blocker === blocker && p.blocked === blocked; });
        edges.push({ from: bsKey(blocker), to: bsKey(blocked), where: gone ? 'unlink' : 'github', closed: graphIssueOf(draw, blocker).closed });
      });
    });
    bs.pending.concat(bs.ideas).forEach(function (p) {
      var where = bs.pending.indexOf(p) >= 0 ? 'pending' : 'idea';
      if (p.kind === 'task' && p.epic === epic) card(p.ref, { key: p.ref, task: p, where: where });
    });
    bs.pending.concat(bs.ideas).forEach(function (p) {
      if (p.kind !== 'link') return;
      var where = bs.pending.indexOf(p) >= 0 ? 'pending' : 'idea';
      var a = bsKey(p.blocker), b = bsKey(p.blocked);
      // a link that touches a card here brings in the issue at its other end, as a blocker does; a
      // link that touches none belongs to another epic's canvas
      if (!cards[a] && !cards[b]) return;
      [p.blocker, p.blocked].forEach(function (x) {
        if (typeof x === 'number' && !cards[bsKey(x)]) card(bsKey(x), { key: bsKey(x), issue: graphIssueOf(draw, x), where: 'github' });
      });
      if (cards[a] && cards[b]) edges.push({ from: a, to: b, where: where, item: p });
    });
    return { cards: cards, order: order, edges: edges };
  }
  // columns by the longest chain of blockers before a card, so every link runs left to right; a
  // loop, which GitHub does not refuse, is cut where it closes, and rows go by key within a column
  function bsLayout(model) {
    var col = {}, incoming = {};
    model.order.forEach(function (k) { col[k] = 0; incoming[k] = []; });
    model.edges.forEach(function (e) { if (e.where !== 'unlink') incoming[e.to].push(e.from); });
    for (var round = 0; round < model.order.length; round++) {
      var moved = false;
      model.order.forEach(function (k) {
        incoming[k].forEach(function (f) { if (col[f] + 1 > col[k] && col[f] + 1 < model.order.length) { col[k] = col[f] + 1; moved = true; } });
      });
      if (!moved) break;
    }
    var rows = {}, at = {};
    model.order.forEach(function (k) { (rows[col[k]] = rows[col[k]] || []).push(k); });
    var height = 0, width = 0;
    Object.keys(rows).forEach(function (c) {
      rows[c].forEach(function (k, r) {
        at[k] = { x: BS_PAD + Number(c) * (BS_CARD_W + BS_GAP_X), y: BS_PAD + r * (BS_CARD_H + BS_GAP_Y) };
        width = Math.max(width, at[k].x + BS_CARD_W + BS_PAD);
        height = Math.max(height, at[k].y + BS_CARD_H + BS_PAD);
      });
    });
    return { at: at, width: width, height: height };
  }
  // whether a link from blocker to blocked would close a loop: blocked already comes before blocker
  // among the links on GitHub and those waiting, less the unlinks waiting
  function bsLoops(draw, blocker, blocked) {
    var next = {};
    function edge(a, b) { (next[a] = next[a] || []).push(b); }
    graphNumbers(draw.blockedBy).forEach(function (b) {
      draw.blockedBy[b].forEach(function (a) {
        if (!bs.pending.some(function (p) { return p.kind === 'unlink' && p.blocker === a && p.blocked === b; })) edge(bsKey(a), bsKey(b));
      });
    });
    bs.pending.forEach(function (p) { if (p.kind === 'link') edge(bsKey(p.blocker), bsKey(p.blocked)); });
    var seen = {}, todo = [bsKey(blocked)];
    while (todo.length) {
      var k = todo.pop();
      if (k === bsKey(blocker)) return true;
      if (seen[k]) continue;
      seen[k] = true;
      (next[k] || []).forEach(function (n) { todo.push(n); });
    }
    return false;
  }

  function openExplore() {
    var s = state, draw = bsDraw();
    if (!s || !s.repo) { bsClear(); bsStatus('Nothing to plan yet: no repository is chosen.'); return; }
    // the first visit keeps the epic a "Show it on Explore" press chose; a switch of repository forgets it
    if (bs.repo !== s.repo) { var keep = bs.repo ? 0 : bs.epic; exploreForget(); bs.repo = s.repo; bs.epic = keep; }
    bsIdeasFromAnswer();
    bsPrune(draw);
    var epics = bsEpics(draw);
    if (!draw) { bsClear(); bsStatus(s.graphFailed ? 'Nothing to draw: the Dependencies tab could not read the epics (' + s.graphFailed + ').' : 'Reading the epics and their tasks...', !!s.graphFailed); return; }
    if (!epics.length) { bsClear(); bsStatus('Nothing to plan yet: no open issue labelled epic has sub-issues. An epic the coordinator planned, or one you make with sub-issues on GitHub, is drawn here.'); return; }
    if (!epics.some(function (e) { return e.number === bs.epic; })) bs.epic = epics[0].number;
    bsEpicChips(epics);
    bsRender(draw);
  }
  function bsClear() { clear($('bs-canvas')); clear($('bs-epics')); bsTray(); }
  function bsEpicChips(epics) {
    var box = $('bs-epics');
    clear(box);
    epics.forEach(function (e) {
      var b = btn('#' + e.number + ' ' + e.title, false, function () { bs.epic = e.number; bs.from = null; openExplore(); });
      b.className = 'chip';
      b.setAttribute('aria-pressed', e.number === bs.epic ? 'true' : 'false');
      b.title = e.title;
      add(box, b);
    });
  }
  function bsRender(draw) {
    var model = bsModel(draw, bs.epic), lay = bsLayout(model);
    var box = $('bs-canvas');
    clear(box);
    var plane = el('div', 'bs__plane');
    plane.style.width = lay.width + 'px';
    plane.style.height = lay.height + 'px';
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'bs__edges');
    svg.setAttribute('width', String(lay.width));
    svg.setAttribute('height', String(lay.height));
    svg.setAttribute('aria-hidden', 'true');
    model.edges.forEach(function (e) {
      var a = lay.at[e.from], b = lay.at[e.to];
      if (!a || !b) return;
      var x1 = a.x + BS_CARD_W, y1 = a.y + BS_CARD_H / 2, x2 = b.x, y2 = b.y + BS_CARD_H / 2;
      // a link between cards of one column, which a loop leaves, bends out to the right
      var bend = x2 > x1 ? (x2 - x1) / 2 : 60;
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', x2 > x1 ? 'M' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2
        : 'M' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 + BS_CARD_W + bend) + ' ' + y2 + ', ' + (x2 + BS_CARD_W) + ' ' + y2);
      path.setAttribute('class', 'bs__edge bs__edge--' + e.where + (e.closed ? ' bs__edge--closed' : ''));
      path.setAttribute('data-from', e.from);
      path.setAttribute('data-to', e.to);
      svg.appendChild(path);
    });
    plane.appendChild(svg);
    model.order.forEach(function (k) {
      var c = bsCard(draw, model.cards[k]);
      c.style.left = lay.at[k].x + 'px';
      c.style.top = lay.at[k].y + 'px';
      plane.appendChild(c);
    });
    // the ideas of links are said in words too, beside the canvas's lines, each with its presses
    var linkIdeas = bs.ideas.filter(function (p) { return p.kind === 'link' && model.cards[bsKey(p.blocker)] && model.cards[bsKey(p.blocked)]; });
    add(box, plane);
    if (linkIdeas.length) {
      var list = el('ul', 'bs__ideas');
      add(list, el('li', 'bs__ideash', 'Claude\'s links'));
      linkIdeas.forEach(function (p) { add(list, bsLinkIdea(p)); });
      add(box, list);
    }
    bsFit();
    bsTray();
    var counts = { github: 0, pending: 0, idea: 0 };
    model.order.forEach(function (k) { counts[model.cards[k].where]++; });
    var ideas = bs.ideas.filter(function (p) { return p.kind === 'link' ? linkIdeas.indexOf(p) >= 0 : p.epic === bs.epic; }).length;
    bsStatus(bs.connecting ? bsConnectWords() : plural(counts.github, 'task') + ' on GitHub' + (counts.pending ? ', ' + plural(counts.pending, 'new task') + ' to push' : '') + (ideas ? ', ' + plural(ideas, 'idea') + ' from Claude to decide' : '') + '.');
  }
  // the plane shrinks to the canvas, never below half its size, so a small epic reads at its own
  // size and a large one fits; past half, the canvas scrolls
  function bsFit() {
    var box = $('bs-canvas'), plane = box && box.querySelector('.bs__plane');
    if (!plane) return;
    var w = parseFloat(plane.style.width) || 1, h = parseFloat(plane.style.height) || 1;
    var k = Math.max(0.5, Math.min(1, (box.clientWidth - 4) / w, (box.clientHeight - 4) / h));
    plane.style.transform = k < 1 ? 'scale(' + k + ')' : '';
    plane.style.marginBottom = k < 1 ? (h * k - h) + 'px' : '';
    plane.style.marginRight = k < 1 ? (w * k - w) + 'px' : '';
  }
  function bsCard(draw, c) {
    var card = el('div', 'ds-card bs__card bs__card--' + c.where);
    card.setAttribute('data-key', c.key);
    var head = el('div', 'bs__kind'), foot = el('div', 'bs__foot');
    add(card, head, el('div', 'bs__title', c.issue ? c.issue.title || 'Issue #' + c.issue.number : c.task.title));
    if (c.issue) {
      var it = c.issue, cls = graphClass(it, draw.claimed) || 'open';
      card.classList.add('bs__card--' + cls);
      add(head, el('span', 'bs__dot'), '#' + it.number + ' ' + bsStateWords(cls));
      if (it.blockedByTotal) add(foot, el('span', 'bs__pill', (it.blockedByTotal - it.blockedByOpen) + ' of ' + it.blockedByTotal + ' met'));
      if (it.html_url) add(foot, link(it.html_url, 'Open'));
    } else {
      add(head, el('span', 'bs__dot'), c.where === 'idea' ? '\u2726 New task, Claude\'s idea' : 'New task, to push');
      if (c.task.why) add(card, el('div', 'bs__why', c.task.why));
    }
    if (c.where === 'idea') {
      add(foot, bsPress('Accept', 'bs__ok', function () { bsAccept(c.task); }), bsPress('Edit', '', function () { bsEdit(c.task); }), bsPress('Dismiss', '', function () { bsDismiss(c.task); }));
    } else if (c.where === 'pending') {
      add(foot, bsPress('Edit', '', function () { bsEdit(c.task); }), bsPress('Remove', '', function () { bsRemove(c.task); }));
    }
    add(card, foot);
    // in Connect, the card itself is the press; a card's own buttons and links keep theirs
    card.addEventListener('click', function (e) {
      if (!bs.connecting || (e.target.closest && e.target.closest('button, a'))) return;
      bsPick(c.key);
    });
    if (bs.connecting) { card.tabIndex = 0; card.setAttribute('role', 'button'); card.addEventListener('keydown', function (e) { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); bsPick(c.key); } }); }
    if (bs.from === c.key) card.classList.add('bs__card--from');
    return card;
  }
  function bsPress(label, cls, run) { var b = btn(label, false, run); b.className = 'chip bs__press' + (cls ? ' ' + cls : ''); return b; }
  function bsStateWords(cls) { return { todo: 'to do', claimed: 'claimed', review: 'in review', blocked: 'blocked', closed: 'closed' }[cls] || 'open'; }
  function bsLinkIdea(p) {
    var li = el('li', 'bs__idea');
    add(li, el('b', '', bsName(p.blocker) + ' blocks ' + bsName(p.blocked)), p.why ? ' ' + p.why : '', ' ',
      bsPress('Accept', 'bs__ok', function () { bsAccept(p); }), bsPress('Dismiss', '', function () { bsDismiss(p); }));
    return li;
  }
  function bsName(x) {
    if (typeof x === 'number') return '#' + x;
    var t = bsTask(x) || bsIdea(x);
    return t ? '"' + t.title + '"' : 'a new task';
  }

  // the ideas of the assistant's latest answer, read again only when the answer changes, so a
  // dismissed idea stays dismissed until Claude answers anew
  function bsIdeasFromAnswer() {
    var a = assistant, ans = a && a.answer && !a.failed && a.repo === state.repo && a.login === shownLogin ? a.answer : null;
    if (!ans) { if (bs.answer) { bs.answer = null; bs.ideas = []; } return; }
    if (bs.answer && bs.answer.id === ans.id && bs.answer.body === ans.body) return;
    bs.answer = { id: ans.id, body: ans.body };
    bs.ideas = bsParse(assistantBlock(ans.body));
  }
  // what GitHub already holds is no idea any more, so an answer read again after a push or a reload
  // offers it no second time: a task of that title under its epic, or a link on GitHub; and a link
  // whose new task is neither an idea nor waiting goes with it, as a dismissed task's links do
  function bsTitleKey(x) { return String(x || '').replace(/^Task:\s*/i, '').trim().toLowerCase(); }
  function bsPrune(draw) {
    if (!draw) return;
    var have = {};
    bsEpics(draw).forEach(function (e) {
      graphEpic(draw, e.number).nodes.forEach(function (it) { have[e.number + ' ' + bsTitleKey(it.title)] = true; });
    });
    bs.ideas = bs.ideas.filter(function (x) { return !(x.kind === 'task' && have[x.epic + ' ' + bsTitleKey(x.title)]); });
    bs.ideas = bs.ideas.filter(function (x) { return x.kind !== 'link' || (!bsHasLink(x) && bsRefsLive(x)); });
    bs.pending = bs.pending.filter(function (x) { return x.kind === 'task' || bsRefsLive(x); });
  }
  function bsRefsLive(x) {
    return [x.blocker, x.blocked].every(function (y) { return typeof y === 'number' || bsTask(y) || bsIdea(y); });
  }
  // `link #A blocks #B [why TEXT]` and `node TITLE under #E [blocks #X] [after #Y] [why TEXT]`; a
  // node's blocks and after become links of the new task's own
  var BS_LINK = /^link\s+#([1-9][0-9]{0,8})\s+blocks\s+#([1-9][0-9]{0,8})(?:\s+why\s+(.{1,300}))?$/i;
  var BS_NODE = /^node:?\s+(.{1,200}?)\s+under\s+#([1-9][0-9]{0,8})((?:\s+(?:blocks|after)\s+#[1-9][0-9]{0,8})*)(?:\s+why\s+(.{1,300}))?$/i;
  function bsParse(lines) {
    var out = [];
    lines.forEach(function (line) {
      var m;
      if ((m = BS_LINK.exec(line))) {
        if (Number(m[1]) !== Number(m[2])) out.push({ kind: 'link', blocker: Number(m[1]), blocked: Number(m[2]), why: (m[3] || '').trim(), from: 'claude' });
      } else if ((m = BS_NODE.exec(line))) {
        var ref = 'c' + (++bs.seq), task = { kind: 'task', ref: ref, title: m[1].trim(), epic: Number(m[2]), why: (m[4] || '').trim(), from: 'claude' };
        out.push(task);
        var re = /(blocks|after)\s+#([1-9][0-9]{0,8})/gi, r;
        while ((r = re.exec(m[3] || ''))) {
          var n = Number(r[2]);
          out.push(r[1].toLowerCase() === 'blocks' ? { kind: 'link', blocker: ref, blocked: n, why: '', from: 'claude', with: ref } : { kind: 'link', blocker: n, blocked: ref, why: '', from: 'claude', with: ref });
        }
      }
    });
    return out;
  }
  // what the assistant's line says, beside its answer: the idea is drawn on Explore, opened by a press
  function bsOffer(line) {
    var span = el('span');
    add(span, 'An idea for the plan, drawn on the Explore tab: ' + line + ' ', btn('Show it on Explore', true, function () {
      closeDialog('dlg-claude');
      var m = BS_NODE.exec(line);
      if (m) bs.epic = Number(m[2]);
      showTab('explore');
    }));
    return span;
  }

  function bsAccept(p) {
    var draw = bsDraw();
    if (!draw) return;
    var group = p.kind === 'task' ? bs.ideas.filter(function (x) { return x === p || x.with === p.ref; }) : [p];
    // a link Claude named that would close a loop is refused here, as one drawn by hand is, the
    // links of one new task taken together
    var saved = bs.pending, loop = null;
    group.forEach(function (x) {
      if (x.kind !== 'link' || loop) return;
      if (bsLoops(draw, x.blocker, x.blocked)) loop = x; else bs.pending = bs.pending.concat([x]);
    });
    bs.pending = saved;
    if (loop) { say('Not accepted: ' + bsName(loop.blocker) + ' blocking ' + bsName(loop.blocked) + ' would close a loop, a task waiting on itself.', true, true); return; }
    // a link to a task still only an idea waits for that task to be accepted too
    if (p.kind === 'link' && [p.blocker, p.blocked].some(function (x) { return typeof x === 'string' && !bsTask(x); })) { say('Accept the new task first; its links come with it.', true); return; }
    group.forEach(function (x) {
      bs.ideas.splice(bs.ideas.indexOf(x), 1);
      if (!bsHasLink(x)) bs.pending.push(x);
    });
    openExplore();
  }
  function bsHasLink(x) {
    if (x.kind !== 'link') return false;
    var draw = bsDraw();
    if (typeof x.blocker === 'number' && typeof x.blocked === 'number' && draw && (draw.blockedBy[x.blocked] || []).indexOf(x.blocker) >= 0) return true;
    return bs.pending.some(function (q) { return q.kind === 'link' && q.blocker === x.blocker && q.blocked === x.blocked; });
  }
  function bsDismiss(p) {
    bs.ideas = bs.ideas.filter(function (x) { return x !== p && !(p.kind === 'task' && x.with === p.ref); });
    openExplore();
  }
  function bsRemove(p) {
    bs.pending = bs.pending.filter(function (x) { return x !== p && !(p.kind === 'task' && (x.blocker === p.ref || x.blocked === p.ref)); });
    openExplore();
  }
  var bsEditing = null;
  function bsEdit(task) {
    bsEditing = task;
    $('bs-node-title').value = task ? task.title : '';
    $('bs-node-why').value = task ? task.why : '';
    openDialog('dlg-bs-node');
    $('bs-node-title').focus();
  }
  function bsSaveNode() {
    var title = ($('bs-node-title').value || '').trim().replace(/\s+/g, ' '), why = ($('bs-node-why').value || '').trim();
    if (!title) { say('A task needs a title.', true); return; }
    if (bsEditing) { bsEditing.title = title; bsEditing.why = why; }
    else if (!bs.epic) { say('Choose an epic first.', true); return; }
    else bs.pending.push({ kind: 'task', ref: 'n' + (++bs.seq), title: title, epic: bs.epic, why: why, from: 'you' });
    bsEditing = null;
    closeDialog('dlg-bs-node');
    openExplore();
  }

  // Connect: the first press is the task that must be done first, the second the task it blocks
  function bsConnect(on) {
    bs.connecting = on;
    bs.from = null;
    var b = $('bs-connect');
    if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function bsConnectWords() { return bs.from ? 'Now press the task that ' + bsCardName(bs.from) + ' blocks, or Connect again to stop.' : 'Press the task that must be done first, or Connect again to stop.'; }
  function bsCardName(key) { return /^i[0-9]+$/.test(key) ? '#' + key.slice(1) : bsName(key); }
  function bsPick(key) {
    var draw = bsDraw();
    if (!draw) return;
    // a task still only Claude's idea is accepted first, so no link waits on a card that may go
    if (bsIdea(key) && !bsTask(key)) { say('Accept the new task first, then connect it.', true); return; }
    if (!bs.from) { bs.from = key; openExplore(); return; }
    var from = bs.from;
    bs.from = null;
    if (from === key) { openExplore(); return; }
    var blocker = /^i[0-9]+$/.test(from) ? Number(from.slice(1)) : from, blocked = /^i[0-9]+$/.test(key) ? Number(key.slice(1)) : key;
    var onGitHub = typeof blocker === 'number' && typeof blocked === 'number' && (draw.blockedBy[blocked] || []).indexOf(blocker) >= 0;
    var waiting = bs.pending.filter(function (p) { return (p.kind === 'link' || p.kind === 'unlink') && p.blocker === blocker && p.blocked === blocked; })[0];
    if (waiting) bs.pending.splice(bs.pending.indexOf(waiting), 1);
    else if (onGitHub) bs.pending.push({ kind: 'unlink', blocker: blocker, blocked: blocked, from: 'you' });
    else if (bsLoops(draw, blocker, blocked)) say('Not joined: ' + bsName(blocker) + ' blocking ' + bsName(blocked) + ' would close a loop, a task waiting on itself.', true, true);
    else bs.pending.push({ kind: 'link', blocker: blocker, blocked: blocked, why: '', from: 'you' });
    openExplore();
  }

  function bsItemWords(p) {
    if (p.kind === 'task') return ['New task under #' + p.epic, '"' + p.title + '"' + (p.from === 'claude' ? ', Claude\'s idea' : ', yours')];
    if (p.kind === 'link') return [bsName(p.blocker) + ' blocks ' + bsName(p.blocked), p.from === 'claude' ? 'Accepted from Claude' + (p.why ? ': ' + p.why : '') : 'Drawn by you'];
    return ['Remove: ' + bsName(p.blocker) + ' blocks ' + bsName(p.blocked), 'The link GitHub holds goes'];
  }
  function bsTray() {
    var list = $('bs-pending');
    if (!list) return;
    clear(list);
    bs.pending.forEach(function (p) {
      var w = bsItemWords(p), li = el('li', 'ds-card bs__item bs__item--' + p.kind);
      var rm = bsPress('Remove', '', function () { if (!bs.pushing) bsRemove(p); });
      rm.disabled = bs.pushing;
      add(li, el('b', '', w[0]), el('small', '', w[1]), rm);
      add(list, li);
    });
    if (!bs.pending.length) add(list, el('li', 'ds-note bs__empty', 'Nothing yet: accept an idea, add a task or connect two cards.'));
    $('bs-count').textContent = String(bs.pending.length);
    $('bs-push').disabled = bs.pushing || !bs.pending.length;
    $('bs-push').textContent = bs.pending.length ? 'Push ' + plural(bs.pending.length, 'change') + ' to GitHub' : 'Push to GitHub';
    $('bs-undo').hidden = !(bs.last && state && bs.last.repo === state.repo && bs.last.account === shownLogin && bs.last.undo.length);
    $('bs-undo').disabled = bs.pushing;
  }

  // the id GitHub's sub-issue and blocked-by calls take, which is the issue's id and not its number
  function bsIdOf(repo, n, made) {
    if (made[n]) return Promise.resolve(made[n]);
    var it = (state.issues || []).filter(function (x) { return Number(x.number) === n && !x.pull_request; })[0];
    if (it && typeof it.id === 'number') return Promise.resolve(it.id);
    return gh('GET', '/repos/' + repo + '/issues/' + n).then(function (r) { return r.data.id; });
  }
  // the push, in order, each write as the person: the issues, then each one's place under its epic,
  // then the links; it stops at the first refusal and keeps what is left to push, and records each
  // write done so Undo can take it back
  function bsPush() {
    var s = state, repo = s.repo, account = shownLogin;
    if (bs.pushing || !bs.pending.length) return;
    var draw = bsDraw();
    var loop = draw && bs.pending.filter(function (p) { return p.kind === 'link'; }).some(function (p) {
      var saved = bs.pending;
      bs.pending = saved.filter(function (q) { return q !== p; });
      var closes = bsLoops(draw, p.blocker, p.blocked);
      bs.pending = saved;
      return closes;
    });
    if (loop) { say('Not pushed: the links waiting would close a loop, a task waiting on itself. Remove one first.', true); return; }
    bs.pushing = true;
    bsTray();
    var made = {}, numbers = {}, undo = [], done = 0;
    var order = bs.pending.filter(function (p) { return p.kind === 'task'; })
      .concat(bs.pending.filter(function (p) { return p.kind === 'unlink'; }), bs.pending.filter(function (p) { return p.kind === 'link'; }));
    function num(x) { return typeof x === 'number' ? x : numbers[x]; }
    function step(p) {
      if (stale(s) || account !== shownLogin) return Promise.reject(new Error('the page moved to another repository or sign-in'));
      // a change removed while the push ran is not written
      if (bs.pending.indexOf(p) < 0) return Promise.resolve(false);
      if (p.kind === 'task') {
        // a task an earlier push opened and could not place under its epic is placed, not opened again
        if (p.number) { made[p.number] = p.id; return bsPlace(p); }
        bsStatus('Opening "' + p.title + '"...');
        return gh('POST', '/repos/' + repo + '/issues', {
          title: /^Task: /.test(p.title) ? p.title : 'Task: ' + p.title,
          body: formBody([['Goal', p.why || p.title], ['Planned', 'On the control panel\'s Explore tab, under #' + p.epic + (p.from === 'claude' ? ', from an idea of Claude\'s the person accepted' : '') + '.']]),
          labels: ['todo']
        }, undefined, false, account).then(function (r) {
          numbers[p.ref] = r.data.number;
          made[r.data.number] = r.data.id;
          p.number = r.data.number;
          p.id = r.data.id;
          // the links that named the task by its ref name it by its number from now on, so a push
          // that stops later leaves them pushable
          bs.pending.concat(bs.ideas).forEach(function (q) {
            if (q.blocker === p.ref) q.blocker = r.data.number;
            if (q.blocked === p.ref) q.blocked = r.data.number;
          });
          undo.push({ kind: 'close', number: r.data.number });
          return bsPlace(p);
        });
      }
      var blocker = num(p.blocker), blocked = num(p.blocked);
      if (!blocker || !blocked) return Promise.reject(new Error('a new task its link names was not opened'));
      bsStatus((p.kind === 'link' ? 'Linking' : 'Unlinking') + ' #' + blocker + ' and #' + blocked + '...');
      return bsIdOf(repo, blocker, made).then(function (id) {
        // a link GitHub holds already, or no longer holds for an unlink, is done, with nothing to undo
        if (p.kind === 'link') return gh('POST', '/repos/' + repo + '/issues/' + blocked + '/dependencies/blocked_by', { issue_id: id }, undefined, false, account).then(function () { undo.unshift({ kind: 'unlink', blocked: blocked, id: id }); }, function (e) { if (!(e && e.status === 422 && /already/i.test(JSON.stringify(e.data || '')))) throw e; });
        return gh('DELETE', '/repos/' + repo + '/issues/' + blocked + '/dependencies/blocked_by/' + id, undefined, undefined, false, account).then(function () { undo.unshift({ kind: 'link', blocked: blocked, id: id }); }, function (e) { if (!(e && e.status === 404)) throw e; });
      });
    }
    function bsPlace(p) {
      return gh('POST', '/repos/' + repo + '/issues/' + p.epic + '/sub_issues', { sub_issue_id: p.id }, undefined, false, account).then(function () {
        undo.unshift({ kind: 'unsub', epic: p.epic, id: p.id });
      });
    }
    order.reduce(function (pr, p) {
      return pr.then(function () { return step(p).then(function (wrote) { if (wrote !== false) done++; bs.pending = bs.pending.filter(function (x) { return x !== p; }); }); });
    }, Promise.resolve()).then(function () {
      bsPushed(s, repo, account, undo, 'Pushed ' + plural(done, 'change') + ' to GitHub as ' + account + '.', false);
    }, function (e) {
      bsPushed(s, repo, account, undo, 'Pushed ' + plural(done, 'change') + ', then stopped: ' + e.message + ' What is left waits under Changes to push.', true);
    });
  }
  // a push after one that stopped adds its writes to the same Undo, the newest first, so the part
  // written before the stop can still be taken back; Undo writes as the account that pushed
  function bsPushed(s, repo, account, undo, words, warn) {
    bs.pushing = false;
    if (undo.length) {
      var older = bs.last && bs.last.repo === repo && bs.last.account === account ? bs.last.undo : [];
      bs.last = { repo: repo, account: account, undo: undo.concat(older) };
    }
    say(words, warn);
    bsStatus(words, warn);
    bsTray();
    if (!stale(s)) loadIssues(s);
  }
  function bsUndo() {
    var s = state, last = bs.last, account = shownLogin;
    if (!last || !s || last.repo !== s.repo || last.account !== account || bs.pushing) return;
    bs.pushing = true;
    bsTray();
    var left = last.undo.slice();
    function next() {
      if (!left.length) return Promise.resolve();
      var u = left[0], r = '/repos/' + last.repo + '/issues/';
      var call = u.kind === 'close' ? gh('PATCH', r + u.number, { state: 'closed', state_reason: 'not_planned' }, undefined, false, account)
        : u.kind === 'unsub' ? gh('DELETE', r + u.epic + '/sub_issue', { sub_issue_id: u.id }, undefined, false, account)
        : u.kind === 'unlink' ? gh('DELETE', r + u.blocked + '/dependencies/blocked_by/' + u.id, undefined, undefined, false, account)
        : gh('POST', r + u.blocked + '/dependencies/blocked_by', { issue_id: u.id }, undefined, false, account);
      return call.then(function () { left.shift(); return next(); });
    }
    next().then(function () {
      bs.last = null;
      bsPushed(s, last.repo, account, [], 'The last push is undone.', false);
    }, function (e) {
      last.undo = left;
      bsPushed(s, last.repo, account, [], 'Undo stopped: ' + e.message + ' Press Undo again for the rest.', true);
      bs.last = last;
      bsTray();
    });
  }

  // the question Ask Claude for ideas puts in the Claude box, naming the epic and the words it
  // answers in; the person reads it and presses Ask
  function bsQuestion() {
    var draw = bsDraw(), epic = draw ? graphIssueOf(draw, bs.epic) : null;
    if (!epic || !bs.epic) return 'Which epic should I plan next, and which tasks are missing?';
    return 'Help me plan epic #' + bs.epic + ' (' + epic.title + '). Read its tasks and the code, then suggest what is missing: new links where one task must wait for another, as lines "link #A blocks #B why ...", and new tasks, as lines "node TITLE under #' + bs.epic + ' blocks #X why ...". Say why for each.';
  }
  function bsAskIdeas() {
    if (!$('cp-as-q')) return;
    assistant.focus = bs.epic || assistant.focus;
    $('cp-as-q').value = bsQuestion();
    pressClaude();
  }

  function initExploreTab() {
    $('bs-ideas').addEventListener('click', bsAskIdeas);
    $('bs-node').addEventListener('click', function () { if (!bs.epic) { say('Choose an epic first.', true); return; } bsEdit(null); });
    $('bs-connect').addEventListener('click', function () { bsConnect(!bs.connecting); openExplore(); });
    $('bs-push').addEventListener('click', bsPush);
    $('bs-undo').addEventListener('click', bsUndo);
    $('bs-node-save').addEventListener('click', bsSaveNode);
    // Escape stops Connect wherever the focus is, since a pick draws the cards anew and the card
    // pressed, with the focus, goes with them; a dialog open over the tab keeps its own Escape
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !bs.connecting || consoleTab !== 'explore' || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      bsConnect(false);
      openExplore();
    });
    if (window.ResizeObserver) new ResizeObserver(function () { if (consoleTab === 'explore') bsFit(); }).observe($('bs-canvas'));
    consoleOnOpen.explore = openExplore;
  }

  // the Agents tab puts one in each agent's row
  window.tokenAssignBox = tokenAssignBox;

  // the cost page carries a signed-in box of its own, so its marker is read first
  // tokens.html was a page of its own until the console took it in as a tab: it sends a visitor there
  if ($('tokens-moved')) location.replace('/symphony/control/' + location.search + '#tokens');
  else if ($('cost-app')) initCost();
  else if ($('cp-app')) { initConsole(); initPanel(); if ($('tk-tiles')) initTokensTab(); if ($('gr-tiles')) initGridTab(); if ($('sh-who')) initShareTab(); if ($('fd-connect')) initFoldersTab(); if ($('nb-tiles')) initNotebooksTab(); if ($('bs-canvas')) initExploreTab(); }
})();
