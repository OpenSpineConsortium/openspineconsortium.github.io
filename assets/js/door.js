/* ============================================================
   door.js: the reader at /symphony/door/ (tools/pages/symphony/door/index/body.html).

   It shows one GitHub repository, live, as the person signed in: its folders, its Markdown
   documents rendered, its pictures, its text files as text and its HTML pages sealed in a frame.
   It holds no token and makes no request of its own: symphony-panel.js signs the person in and
   hands start() a small client (api.get for JSON, api.raw for a file's bytes, api.repo for the
   repository, api.say for a word on the page), so every read goes to GitHub's REST API with the
   person's own token and comes back with only what their own account may read. Nothing is kept:
   a file is read again at the next open of the page, and the client asks GitHub again each time
   rather than taking the browser's copy of up to a minute ago.

   Every path that comes from outside this script (the address's hash, a link inside a document,
   the repository's .github/symphony/door.json, every message a sealed page sends) is split into
   its parts, each decoded once and refused when it is empty, "." or "..", or holds a slash, a
   backslash or a control character, and each part is encoded again on its way into an address,
   so no address built here leaves the repository's contents. A sealed page runs in a frame with
   sandbox="allow-scripts" alone (no origin, no popups, no forms, no navigation of this page),
   under a Content-Security-Policy that lets it load scripts and styles from the public CDNs
   exported pages are written for and gives it no other way out (SEALED_CSP says what still
   leaves, and sealedPrelude takes WebRTC away, which no policy closes); the files it refers to are read here and put inline, and its fetches of files beside
   it are answered by message.

   At load it defines window.SymphonyDoor and does nothing else, so the page shows nothing of a
   repository until the person is signed in and the panel calls start().
   ============================================================ */
(function () {
  'use strict';

  // A file larger than this is named with its GitHub link and never read: the raw media type would
  // hand back up to 100 MB, which a browser tab holds badly and a reader never needs.
  var LIMIT = 10 * 1024 * 1024;
  var MOST_TEXT = 1500000;   // the characters of a text file shown as text; a longer one is cut and said so
  var LIST_CAP = 1000;       // the contents API lists at most this many entries of one folder
  var SEALED = 'allow-scripts';   // scripts and nothing else: no origin, no popup, no form, no top navigation
  // The policy every sealed document carries as the first child of its head. The CDN hosts are the
  // ones claude.ai lets an artifact load from, the hosts the exported pages were written for; the
  // page may run their scripts, and connect-src, img-src, media-src, the sandbox and the frame-src
  // of this page stop every other way out a policy can govern (WebRTC is none: sealedPrelude). What still leaves the browser is a request to one of
  // the listed hosts, whose address the page writes and so could fill with what it read; no
  // listed host hands that address to anyone but its operator. A DNS lookup is outside any
  // policy, so the sealed document also carries x-dns-prefetch-control off, which no later meta
  // turns back on, and its link hints that would ask for one are taken out (sealedDoc).
  var SEALED_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: https://cdnjs.cloudflare.com " +
    "https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com; " +
    "style-src 'unsafe-inline' data: https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; " +
    "img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src data: blob:; worker-src blob: data:; " +
    "form-action 'none'; base-uri 'none'";
  // A sandboxed frame may still navigate itself, and a page that read the repository could carry
  // what it read out in the address it navigates to. A frame's navigations are held to the
  // frame-src of the page that holds it. The built page carries this directive in its own head
  // (the csp line of tools/pages/symphony/door/index/body.html), where every browser reads it; the
  // copy bind() adds by script stands behind it should the page ever be served without it.
  // Nothing else on the page uses a frame.
  var PAGE_CSP = 'frame-src data: blob:';
  var DOOR_FILE = '.github/symphony/door.json';
  var MOST_DOORS = 24;
  var REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var REF_CHARS = /^[A-Za-z0-9._\/-]{1,200}$/;
  var TEXT_MATCH = 'application/vnd.github.text-match+json';
  var ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  var CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  var MEDIA = [['img', 'src'], ['source', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'],
               ['input', 'src'], ['track', 'src']];
  var TYPES = {html: 'text/html', htm: 'text/html', md: 'text/markdown', css: 'text/css', js: 'text/javascript',
               mjs: 'text/javascript', json: 'application/json', ipynb: 'application/json', svg: 'image/svg+xml',
               png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
               ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
               py: 'text/x-python', sh: 'text/x-shellscript', bash: 'text/x-shellscript', yml: 'text/yaml', yaml: 'text/yaml',
               toml: 'text/plain', xml: 'text/xml', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'};
  var BINARY = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|whl|sqlite|bin|pt|pth|onnx|npy|npz|woff2?|ttf|otf|docx|pptx|xlsx|mp4|webm|mp3|wav)$/i;
  var IMAGE = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i;
  var REFUSED = {refused: true};   // a reference into the repository that this page will not follow

  var api = null;        // the client symphony-panel.js handed over, for the repository in view
  var FULL = '';         // OWNER/NAME of that repository
  var GITHUB = '';       // its address on github.com
  var MAIN = '';         // its default branch, as GitHub names it
  var gen = 0;           // counts the starts, so what an earlier start asked for never lands in a later one
  var bound = false;     // the page's own buttons and listeners, bound at the first start only
  var view, content, note, busy, where, side;
  var reads = {};        // ref + path -> the promise of the file: {type, bytes}
  var folders = {};      // ref + path -> the promise of a folder's entries
  var doors = [];        // the starting points of the pane: {label, ref, path}
  var blobs = [];        // the object URLs made for pictures, let go when the view changes
  var shown = null;      // the target in view: {kind, ref, path, hash, q}
  var opening = null;    // the open under way, so a slower earlier one never replaces it
  var trail = [];        // the targets before this one, for Back
  var watch = null;      // the observer that fills a document's pictures as they come near
  var sealed = null;     // {frame, ref, path} of the sealed page in view, whose messages are answered

  var $ = function (id) { return document.getElementById(id); };
  function code(e) { return (e && e.code) || 'failed'; }
  function wait(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function key(ref, path) { return ref + '\n' + path; }
  function ext(path) { var m = /\.([A-Za-z0-9]+)$/.exec(path); return m ? m[1].toLowerCase() : ''; }
  function typeOf(path) { return TYPES[ext(path)] || 'application/octet-stream'; }
  function parent(path) { return path.indexOf('/') < 0 ? '' : path.slice(0, path.lastIndexOf('/')); }
  function name(path) { return path.split('/').pop(); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function outLink(href, text) { return el('a', {href: href, target: '_blank', rel: 'noopener noreferrer', text: text}); }

  // What the reader reads where nothing is in view, or where something could not be read. One of
  // the two places this script writes HTML: every value in more is escaped by its caller.
  function say(words, more, actions) {
    $('door-note-text').textContent = words;
    $('door-note-more').hidden = !more;
    $('door-note-more').innerHTML = more || '';
    var row = $('door-note-do');
    row.textContent = '';
    (actions || []).forEach(function (a) { row.appendChild(el('button', {type: 'button', text: a[0], onclick: a[1]})); });
    note.hidden = false;
  }

  // Paths

  // One part of a path as a repository names it: never empty, never . or .., with no slash,
  // backslash or control character, so no address built from it can climb out of the contents.
  function goodPart(s) {
    return typeof s === 'string' && s !== '' && s !== '.' && s !== '..' && !/[\/\\\u0000-\u001f\u007f]/.test(s);
  }
  // decoded once; a malformed escape is refused rather than passed on as it stands
  function decodeOnce(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
  // A path from outside this script, split on the separators given, each part decoded once and
  // checked: the clean path, '' for the top folder, or null when any part is refused.
  function cleanFrom(raw, separators) {
    raw = String(raw == null ? '' : raw);
    if (raw === '') return '';
    var parts = raw.split(separators || '/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var d = decodeOnce(parts[i]);
      if (!goodPart(d)) return null;
      out.push(d);
    }
    return out.join('/');
  }
  // A branch from outside this script, held to the same parts and to the characters branch names
  // are written in, with nothing git itself refuses in a name.
  function cleanRef(raw) {
    var r = cleanFrom(raw);
    return r && goodRef(r) ? r : null;
  }
  function goodRef(r) {
    return typeof r === 'string' && REF_CHARS.test(r) && !/\.\.|@\{|^\/|\/$|\.lock(?:\/|$)|\.$/.test(r) &&
      r.split('/').every(goodPart);
  }
  // The parts of a path this script holds, already plain, checked again before any address is
  // built from them; a path that fails is never sent.
  function partsOf(path) {
    if (path === '') return [];
    var parts = String(path).split('/');
    for (var i = 0; i < parts.length; i++) if (!goodPart(parts[i])) throw {code: 'bad_path', message: path};
    return parts;
  }
  function contentsUrl(ref, path) {
    if (!goodRef(ref)) throw {code: 'bad_path', message: ref};
    return '/repos/' + FULL + '/contents/' + partsOf(path).map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(ref);
  }
  function blobUrl(ref, path) {
    return GITHUB + '/blob/' + encodeURIComponent(ref) + '/' + partsOf(path).map(encodeURIComponent).join('/');
  }
  // an address GitHub handed back, used as a link only where it is GitHub's own
  function githubAddress(u) { return typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : ''; }

  // GitHub

  function header(h, n) { try { return (h && h.get && h.get(n)) || ''; } catch (e) { return ''; } }
  // How long GitHub asks to be left alone: retry-after when it names one, else the reset of a rate
  // limit used up (x-ratelimit-remaining 0); GitHub sends the reset on every answer, so the reset
  // alone says nothing about a 403.
  function retryWait(h) {
    var after = header(h, 'retry-after');
    if (/^\d{1,6}$/.test(after)) return Math.max(1000, +after * 1000);
    var reset = header(h, 'x-ratelimit-reset');
    if (header(h, 'x-ratelimit-remaining') === '0' && /^\d{1,12}$/.test(reset)) return Math.max(1000, +reset * 1000 - Date.now() + 1000);
    return null;
  }
  // the page GitHub names for authorizing a token with an organization's single sign-on
  function ssoAddress(v) { var m = /url=(https:\/\/github\.com\/[^\s;,]+)/.exec(v || ''); return m ? m[1] : ''; }

  // A read through the page's own client. A rate limit is waited out once when GitHub's wait is a
  // minute or less, and a passing failure (GitHub's 5xx, or no answer at all) is tried once more
  // after a moment; every other failure becomes a code the reader puts into words, with GitHub's
  // own reason where it gave one (a search's 422 says why in its errors).
  function request(kind, url, accept, tries) {
    var g = gen;
    var asked;
    try { asked = kind === 'raw' ? api.raw(url) : api.get(url, accept); } catch (e) { asked = Promise.reject(e); }
    return Promise.resolve(asked).catch(function (e) {
      var status = e && e.status, h = e && e.headers;
      if (status === 404) throw {code: 'not_found'};
      if (status === 401) throw {code: 'signed_out'};
      if (status === 403 && header(h, 'x-github-sso')) throw {code: 'sso', url: ssoAddress(header(h, 'x-github-sso'))};
      if (status === 403 || status === 429) {
        var ms = retryWait(h);
        if (ms !== null && ms <= 60000 && !tries) {
          return wait(ms).then(function () {
            if (g !== gen) throw {code: 'stale'};
            return request(kind, url, accept, 1);
          });
        }
        if (ms !== null || status === 429) throw {code: 'rate_limited', until: ms === null ? null : Date.now() + ms};
        throw {code: 'forbidden', message: (e && e.message) || ''};
      }
      if (!tries && !(e && e.refused) && (!status || status >= 500)) {
        return wait(1500).then(function () {
          if (g !== gen) throw {code: 'stale'};
          return request(kind, url, accept, 1);
        });
      }
      throw {code: (e && e.code) || 'failed', status: status, message: ((e && e.message) || String(e || '')) + reasonOf(e)};
    });
  }
  function reasonOf(e) {
    var first = e && e.data && Array.isArray(e.data.errors) ? e.data.errors[0] : null;
    return first && typeof first.message === 'string' ? ' ' + first.message.slice(0, 300) : '';
  }
  function bytesFrom(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof x === 'string') return new TextEncoder().encode(x);
    throw {code: 'unreadable', message: 'GitHub answered with no file'};
  }

  // A folder's entries, files and folders, read once per start. An entry is kept only where its
  // name is one part and its path is the folder's path and that name, as GitHub always gives them.
  function folder(ref, path) {
    var k = key(ref, path);
    if (!folders[k]) {
      folders[k] = Promise.resolve().then(function () { return request('get', contentsUrl(ref, path)); }).then(function (r) {
        if (!Array.isArray(r.data)) throw {code: 'is_file', message: path};
        var list = [];
        r.data.forEach(function (en) {
          if (!en || !goodPart(en.name)) return;
          var p = path ? path + '/' + en.name : en.name;
          if (String(en.path) !== p) return;
          list.push({type: en.type === 'dir' ? 'dir' : 'file', name: en.name, path: p,
                     size: typeof en.size === 'number' ? en.size : null, url: githubAddress(en.html_url)});
        });
        list.sort(function (a, b) { return a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name); });
        list.capped = r.data.length >= LIST_CAP;
        return list;
      }).catch(function (e) { delete folders[k]; throw e; });
    }
    return folders[k];
  }

  // What a path is, by its folder's listing: a file, a folder, or nothing. In a folder longer than
  // GitHub lists, a name not listed may still be there, so it is read and GitHub says.
  function entryOf(ref, path) {
    if (!path) return Promise.resolve({type: 'dir', name: '', path: '', size: 0});
    return folder(ref, parent(path)).then(function (entries) {
      for (var i = 0; i < entries.length; i++) if (entries[i].path === path) return entries[i];
      return entries.capped ? {type: 'file', name: name(path), path: path, size: null, url: ''} : null;
    }, function (e) { if (code(e) === 'not_found' || code(e) === 'is_file') return null; throw e; });
  }

  // A file's bytes, read once per start; one GitHub's listing says is larger than the limit is
  // refused before a byte of it is asked for.
  function read(ref, path) {
    var k = key(ref, path);
    if (!reads[k]) {
      reads[k] = entryOf(ref, path).then(function (en) {
        if (!en) throw {code: 'not_found', message: path};
        if (en.type === 'dir') throw {code: 'is_folder', message: path};
        if (en.size !== null && en.size > LIMIT) throw {code: 'too_large', entry: en, ref: ref};
        return request('raw', contentsUrl(ref, path));
      }).then(function (got) {
        var bytes = bytesFrom(got);
        if (bytes.length > LIMIT) throw {code: 'too_large', entry: {path: path, size: bytes.length, url: ''}, ref: ref};
        return {type: typeOf(path), bytes: bytes};
      }).catch(function (e) { delete reads[k]; throw e; });
    }
    return reads[k];
  }
  function textOf(f) { return new TextDecoder().decode(f.bytes); }

  // A file a page or a stylesheet refers to, read where its folder lists it, null otherwise, so a
  // reference to nothing costs no read; a folder that cannot be listed leaves the file out.
  function loadIfKnown(ref, path) {
    return entryOf(ref, path).then(function (en) {
      return en && en.type === 'file' ? read(ref, path).catch(function () { return null; }) : null;
    }, function () { return null; });
  }

  // References

  function regexOf(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  // A link into this repository on github.com, by blob, raw or tree: the file it names, with its
  // branch; another page of the repository on GitHub is an outside link.
  function githubRef(href) {
    var m = new RegExp('^' + regexOf(GITHUB) + '/(blob|raw|tree)/([^/#?]+)(?:/([^#?]*))?', 'i').exec(href);
    if (!m) return null;
    var ref = cleanRef(m[2]), path = cleanFrom(String(m[3] || '').replace(/\/$/, ''));
    return ref === null || path === null ? REFUSED : {ref: ref, path: path};
  }
  // A reference a page makes, resolved against the page's own path. One that names another site, a
  // data or blob address or a place in the same page is none of the repository's (null). A literal
  // . or .. step is a relative address's own syntax and is resolved here, never sent; a step that
  // is only . or .. or holds a slash once decoded, an empty step inside the address, and a .. above
  // the top folder are refused, and the reference is followed nowhere.
  function resolve(base, href) {
    href = String(href == null ? '' : href).trim();
    var gh = githubRef(href);
    if (gh) return gh;
    if (!href || ELSEWHERE.test(href) || href.charAt(0) === '#' || href.charAt(0) === '?') return null;
    href = href.split('#')[0].split('?')[0];
    var parts = href.charAt(0) === '/' || !parent(base) ? [] : parent(base).split('/');
    var steps = href.split('/');
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (step === '') {
        // the slash a root-relative address starts with, or the one a folder's address ends with
        if (i === 0 || i === steps.length - 1) continue;
        return REFUSED;
      }
      if (step === '.') continue;
      if (step === '..') { if (!parts.length) return REFUSED; parts.pop(); continue; }
      var d = decodeOnce(step);
      if (!goodPart(d)) return REFUSED;
      parts.push(d);
    }
    return {ref: null, path: parts.join('/')};
  }
  function fragment(href) { var at = String(href).indexOf('#'); return at < 0 ? '' : String(href).slice(at + 1); }
  function slug(s) {
    // as GitHub writes a heading's anchor: one hyphen for each space, so a link written for GitHub finds it here
    return String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/ /g, '-');
  }

  // Markdown, as repositories write it: headings, paragraphs, lists, fenced code, quotes, rules and
  // tables, with code spans, emphasis, links, images and bare addresses inline. Raw HTML is shown
  // as text, never run, since every line is escaped before any tag is written. A relative link or
  // image names a file of the repository.
  function markdown(src) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n'), out = [], i = 0, m;
    function blockStart(l) {
      return /^\s*$/.test(l) || /^(?:`{3,}|~{3,})/.test(l) || /^#{1,6}\s/.test(l) || /^ {0,3}>/.test(l) ||
             /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*\|/.test(l) || /^\s*<!--/.test(l);
    }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if ((m = /^\s*(`{3,}|~{3,})\s*([^`\s]*)/.exec(line))) {
        var fence = m[1], lang = m[2], buf = [];
        i++;
        while (i < lines.length && !(lines[i].trim().slice(0, fence.length) === fence && /^\s*$/.test(lines[i].trim().slice(fence.length)))) buf.push(lines[i++]);
        i++;
        out.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        out.push('<h' + m[1].length + ' id="doc-' + esc(slug(m[2])) + '">' + inline(m[2]) + '</h' + m[1].length + '>');
        i++;
        continue;
      }
      if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*<!--/.test(line)) {
        while (i < lines.length && lines[i].indexOf('-->') < 0) i++;
        i++;
        continue;
      }
      if (/^ {0,3}>/.test(line)) {
        var q = [];
        while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (!/^\s*$/.test(lines[i]) && q.length && !blockStart(lines[i])))) q.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        out.push('<blockquote>' + markdown(q.join('\n')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var head = cells(line), aligns = cells(lines[i + 1]).map(function (c) {
          return /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : '';
        }), rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        var t = '<div class="table"><table><thead><tr>' + head.map(function (c, n) {
          return '<th' + (aligns[n] ? ' style="text-align:' + aligns[n] + '"' : '') + '>' + inline(c) + '</th>';
        }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) {
          t += '<tr>' + head.map(function (c, n) {
            return '<td' + (aligns[n] ? ' style="text-align:' + aligns[n] + '"' : '') + '>' + inline(r[n] || '') + '</td>';
          }).join('') + '</tr>';
        });
        out.push(t + '</tbody></table></div>');
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
        var ordered = /\d/.test(m[2]), indent = m[1].length, items = [], start = ordered ? parseInt(m[2], 10) : 1;
        while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])) && m[1].length === indent && /\d/.test(m[2]) === ordered) {
          var body = [m[3]], inner = m[0].length - m[3].length;
          i++;
          while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s/.test(lines[i]) && leading(lines[i]) > indent)) {
            if (/^\s*$/.test(lines[i]) && (i + 1 >= lines.length || leading(lines[i + 1]) <= indent || /^\s*$/.test(lines[i + 1]))) break;
            body.push(lines[i].slice(Math.min(inner, leading(lines[i]))));
            i++;
          }
          var first = body.shift(), rest = body.join('\n').trim();
          items.push('<li>' + inline(first) + (rest ? (rest.indexOf('\n') < 0 && !blockStart(rest) ? ' ' + inline(rest) : markdown(rest)) : '') + '</li>');
        }
        out.push((ordered ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      var para = [line];
      i++;
      while (i < lines.length && (underline(lines[i]) || !blockStart(lines[i]))) {
        if (underline(lines[i])) {
          var level = /=/.test(lines[i]) ? 1 : 2, title = para.join(' ');
          out.push('<h' + level + ' id="doc-' + esc(slug(title)) + '">' + inline(title) + '</h' + level + '>');
          para = null;
          i++;
          break;
        }
        para.push(lines[i++]);
      }
      if (para) out.push('<p>' + inline(para.join('\n')) + '</p>');
    }
    return out.join('\n');
  }
  function leading(l) { return /^\s*/.exec(l)[0].length; }
  function underline(l) { return /^ {0,3}=+\s*$/.test(l) || /^ {0,3}-+\s*$/.test(l); }
  function cells(row) {
    var r = row.trim();
    if (r.charAt(0) === '|') r = r.slice(1);
    if (r.charAt(r.length - 1) === '|' && r.charAt(r.length - 2) !== '\\') r = r.slice(0, -1);
    return r.replace(/\\\|/g, '\u0002').split('|').map(function (c) { return c.replace(/\u0002/g, '|').trim(); });
  }
  function inline(s) {
    var parts = String(s).split(/(`+)([\s\S]*?[^`])\1(?!`)/), out = '';
    for (var i = 0; i < parts.length; i += 3) {
      out += spans(parts[i]);
      if (i + 2 < parts.length) out += '<code>' + esc(parts[i + 2].trim()) + '</code>';
    }
    return out;
  }
  function emphasis(s) {
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }
  // Images and links are rendered first and held aside behind markers, so the passes after them
  // never read the HTML they emitted: an address with underscores, or an alt text that holds an
  // address, stays whole. A link's address may hold one level of parentheses, as a Wikipedia
  // address does. The text is escaped before anything else, so what is held is built from escaped
  // text alone.
  function spans(s) {
    var held = [];
    function hold(html) { held.push(html); return '\u0001' + (held.length - 1) + '\u0001'; }
    s = esc(String(s).replace(/[\u0001\u0002]/g, ''));
    s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (all, alt, src) { return hold(image(src, alt)); });
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (all, t, href) { return hold(link(href, emphasis(t))); });
    s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, function (all, u) { return hold(link(u, u)); });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?&])/g, function (all, before, u) { return before + hold(link(u, u)); });
    s = emphasis(s).replace(/ {2,}\n/g, '<br>\n');
    return s.replace(/\u0001(\d+)\u0001/g, function (all, n) { return held[+n]; });
  }
  // the escaped text of an address, as it was written
  function unescaped(s) { return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
  var docBase = {ref: '', path: ''};   // the document being rendered, for its relative links
  function link(href, label) {
    var raw = unescaped(href);
    var w = resolve(docBase.path, raw);
    if (w === REFUSED) return '<span class="gone" title="This link names no path the reader opens">' + label + '</span>';
    if (!w && raw.charAt(0) === '#') return '<a href="#' + esc(raw.slice(1)) + '" data-door-hash="' + esc(raw.slice(1)) + '">' + label + '</a>';
    if (!w) return /^(?:https?:|mailto:)/i.test(raw) ? '<a href="' + esc(raw) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    return '<a href="#" data-door-ref="' + esc(w.ref || docBase.ref) + '" data-door-path="' + esc(w.path) +
           '" data-door-hash="' + esc(fragment(raw)) + '">' + label + '</a>';
  }
  function image(src, alt) {
    var raw = unescaped(src), w = resolve(docBase.path, raw);
    if (!w || w === REFUSED) return '<span class="muted">[image elsewhere: ' + (alt || esc(raw)) + ']</span>';
    return '<img alt="' + alt + '" data-door-ref="' + esc(w.ref || docBase.ref) + '" data-door-src="' + esc(w.path) + '">';
  }

  // Sealed pages: a page of HTML of the repository, whole in one document with what it refers to
  // inline, shown in a frame with no origin.

  function parse(html) { return new DOMParser().parseFromString(html, 'text/html'); }
  function serialize(doc) { return '<!doctype html>\n' + doc.documentElement.outerHTML; }
  function scriptSafe(js) { return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }
  function styleSafe(css) { return css.replace(/<\/(style)/gi, '<\\/$1'); }
  function toBase64(bytes) {
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    return btoa(chunks.join(''));
  }
  function dataUrl(f) { return 'data:' + f.type + ';base64,' + toBase64(f.bytes); }

  function refsIn(doc, selector, attr, base) {
    var found = [];
    doc.querySelectorAll(selector).forEach(function (e) {
      var w = resolve(base, e.getAttribute(attr));
      if (w && w !== REFUSED && !w.ref) found.push({el: e, attr: attr, path: w.path});
    });
    return found;
  }
  function sheetsOf(doc, base) { return refsIn(doc, 'link[rel~="stylesheet"][href]', 'href', base); }
  function scriptsOf(doc, base) { return refsIn(doc, 'script[src]', 'src', base); }
  function framesOf(doc, base) { return refsIn(doc, 'iframe[src]', 'src', base); }
  function mediaOf(doc, base) {
    var found = [];
    MEDIA.forEach(function (m) { found = found.concat(refsIn(doc, m[0] + '[' + m[1] + ']', m[1], base)); });
    return found;
  }
  function cssRefs(css, base) {
    var found = [], m;
    CSS_URL.lastIndex = 0;
    while ((m = CSS_URL.exec(css))) {
      var w = resolve(base, m[2]);
      if (w && w !== REFUSED && !w.ref) found.push(w.path);
    }
    return found;
  }

  // A sealed document: every file it refers to that the repository has, read and put inline, its
  // own frames sealed the same way two levels down, and the policy put first in its head.
  function sealedDoc(ref, path, hash, depth) {
    var doc, got = {};
    function have(p) { return Object.prototype.hasOwnProperty.call(got, p) ? got[p] : null; }
    function fetchAll(paths) {
      var wanted = paths.filter(function (p) { return !Object.prototype.hasOwnProperty.call(got, p); });
      return Promise.all(wanted.map(function (p) { return loadIfKnown(ref, p).then(function (f) { got[p] = f; }); }));
    }
    function cssInline(css, base) {
      return styleSafe(css.replace(CSS_URL, function (all, quote, r) {
        var w = resolve(base, r), f = w && w !== REFUSED && !w.ref ? have(w.path) : null;
        return f ? 'url("' + dataUrl(f) + '")' : all;
      }));
    }
    return read(ref, path).then(function (f) {
      doc = parse(textOf(f));
      return fetchAll(sheetsOf(doc, path).concat(scriptsOf(doc, path), mediaOf(doc, path)).map(function (r) { return r.path; }));
    }).then(function () {
      var more = [];
      doc.querySelectorAll('style').forEach(function (s) { more = more.concat(cssRefs(s.textContent, path)); });
      doc.querySelectorAll('[style]').forEach(function (e) { more = more.concat(cssRefs(e.getAttribute('style'), path)); });
      sheetsOf(doc, path).forEach(function (s) { var f = have(s.path); if (f) more = more.concat(cssRefs(textOf(f), s.path)); });
      return fetchAll(more);
    }).then(function () {
      sheetsOf(doc, path).forEach(function (s) {
        var f = have(s.path);
        if (!f) return;
        var style = doc.createElement('style');
        if (s.el.getAttribute('media')) style.setAttribute('media', s.el.getAttribute('media'));
        style.textContent = cssInline(textOf(f), s.path);
        s.el.replaceWith(style);
      });
      doc.querySelectorAll('[style]').forEach(function (e) { e.setAttribute('style', cssInline(e.getAttribute('style'), path)); });
      doc.querySelectorAll('style').forEach(function (s) { s.textContent = cssInline(s.textContent, path); });
      var late = [];
      scriptsOf(doc, path).forEach(function (s) {
        var f = have(s.path);
        if (!f) return;
        var js = doc.createElement('script');
        if (s.el.getAttribute('type')) js.setAttribute('type', s.el.getAttribute('type'));
        js.textContent = scriptSafe(textOf(f));
        if (s.el.hasAttribute('defer') || s.el.hasAttribute('async') || s.el.getAttribute('type') === 'module') { late.push(js); s.el.remove(); }
        else s.el.replaceWith(js);
      });
      late.forEach(function (js) { doc.body.appendChild(js); });
      mediaOf(doc, path).forEach(function (m) { var f = have(m.path); if (f) m.el.setAttribute(m.attr, dataUrl(f)); });
      doc.querySelectorAll('[srcset]').forEach(function (e) { e.removeAttribute('srcset'); });
      // a link hint asks for a DNS lookup or a connection no policy governs; a stylesheet link is
      // inline by now, and a page's own word on DNS prefetching gives way to the one put first below
      doc.querySelectorAll('link').forEach(function (l) {
        if (/(?:^|\s)(?:dns-prefetch|preconnect|prefetch|preload|modulepreload|prerender)(?:\s|$)/i.test(l.getAttribute('rel') || '')) l.remove();
      });
      doc.querySelectorAll('meta[http-equiv]').forEach(function (m) { if (/^\s*x-dns-prefetch-control\s*$/i.test(m.getAttribute('http-equiv'))) m.remove(); });
      // a refresh would navigate the frame, which the page's frame-src stops; it is taken out too
      doc.querySelectorAll('meta[http-equiv]').forEach(function (m) { if (/^\s*refresh\s*$/i.test(m.getAttribute('http-equiv'))) m.remove(); });
      // every frame of the page is sealed as the page is, whatever sandbox it asked for
      doc.querySelectorAll('iframe').forEach(function (fr) { fr.setAttribute('sandbox', SEALED); });
      return Promise.all((depth < 2 ? framesOf(doc, path) : []).map(function (fr) {
        return sealedDoc(ref, fr.path, '', depth + 1).then(function (html) {
          fr.el.removeAttribute('src');
          fr.el.setAttribute('srcdoc', html);
        }, function () { /* a frame the repository lacks stays empty */ });
      }));
    }).then(function () {
      var root = doc.documentElement;
      root.setAttribute('data-page', path);
      if (hash) root.setAttribute('data-hash', hash);
      var head = doc.head;
      if (!head) { head = doc.createElement('head'); root.insertBefore(head, root.firstChild); }
      var s = doc.createElement('script');
      s.textContent = '(' + sealedPrelude.toString() + ')(' + JSON.stringify(hash) + ');';
      head.insertBefore(s, head.firstChild);
      var lookups = doc.createElement('meta');
      lookups.setAttribute('http-equiv', 'x-dns-prefetch-control');
      lookups.setAttribute('content', 'off');
      head.insertBefore(lookups, head.firstChild);
      var policy = doc.createElement('meta');
      policy.setAttribute('http-equiv', 'Content-Security-Policy');
      policy.setAttribute('content', SEALED_CSP);
      head.insertBefore(policy, head.firstChild);
      return serialize(doc);
    });
  }

  // The first script of a sealed page, run inside its frame: a link to a file of the repository is
  // asked for by message, and a fetch of a file beside the page is answered by message with the
  // file's bytes, since a frame with no origin can fetch nothing itself.
  // WebRTC is the one way out no policy closes in Chromium (a TURN server's username is the
  // page's to write, and no CSP directive governs it), so the prelude takes its constructors away
  // before the page's own scripts run, here and in each child frame it can reach. It narrows the
  // channel rather than closing it: a page that writes a child frame of its own (srcdoc or blob:)
  // runs scripts there that the prelude never reaches. What such a page could send is what it was
  // given to show, which only someone who may write the repository can put there, and never the
  // reader's token, which an origin-less frame cannot read.
  function sealedPrelude(hash) {
    var RTC = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceGatherer', 'RTCIceTransport', 'RTCSctpTransport'];
    function cut(w) {
      if (!w) return;
      RTC.forEach(function (k) {
        try { Object.defineProperty(w, k, {value: undefined, writable: false, configurable: false}); } catch (e) { try { w[k] = undefined; } catch (e2) { /* nothing */ } }
      });
    }
    cut(window);
    try {
      var frameWin = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {configurable: false, get: function () { var w = frameWin.get.call(this); cut(w); return w; }});
      var ownDoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {configurable: false, get: function () { cut(frameWin.get.call(this)); return ownDoc.get.call(this); }});
    } catch (e) { /* the frame's own scripts meet the constructors gone from this window alone */ }
    try {
      new MutationObserver(function (list) {
        list.forEach(function (m) { m.addedNodes.forEach(function (node) { if (node.tagName === 'IFRAME') { try { cut(node.contentWindow); } catch (e) { /* nothing */ } } }); });
      }).observe(document, {childList: true, subtree: true});
    } catch (e) { /* nothing */ }
    var pending = {}, n = 0, own = window.fetch;
    function away(h) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(h); }
    window.fetch = function (input, init) {
      var href = typeof input === 'string' ? input : (input && input.url) || '';
      if (!href || away(href) || href.charAt(0) === '#') return own.apply(window, arguments);
      return new Promise(function (done, fail) {
        var id = ++n;
        pending[id] = done;
        parent.postMessage({type: 'front-door.fetch', id: id, href: href}, '*');
        setTimeout(function () { if (pending[id]) { delete pending[id]; fail(new TypeError('no answer for ' + href)); } }, 60000);
      }).then(function (r) {
        if (!r.ok) throw new TypeError('not in the repository: ' + href);
        var bytes = Uint8Array.from(atob(r.base64), function (c) { return c.charCodeAt(0); });
        return new Response(new Blob([bytes], {type: r.mime}), {status: 200, headers: {'Content-Type': r.mime}});
      });
    };
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'front-door.fetch.result' || e.source !== window.parent) return;
      var done = pending[d.id];
      if (!done) return;
      delete pending[d.id];
      done(d);
    });
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented) return;
      var href = a.getAttribute('href') || '';
      e.preventDefault();
      if (href.charAt(0) === '#') {
        var t = document.getElementById(href.slice(1));
        if (t) t.scrollIntoView();
        return;
      }
      parent.postMessage({type: 'front-door.open', href: href}, '*');
    });
    if (hash) addEventListener('load', function () { var t = document.getElementById(hash); if (t) t.scrollIntoView(); });
  }

  // Answering the sealed page in view: its links, its fetches, and the messages exported pages
  // send. A read is answered as the person, at the page's own branch only; a dispatch is answered
  // "not available here", since this reader writes nothing; a link out of the repository is shown
  // where the person can click it. A message from anything but the sealed frame in view is ignored.
  function onMessage(e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || !sealed || e.source !== sealed.frame.contentWindow) return;
    var from = sealed;
    var id = typeof d.id === 'string' || typeof d.id === 'number' ? d.id : null;
    var reply = function (msg) { if (sealed === from) e.source.postMessage(msg, '*'); };
    if (d.type === 'front-door.open') {
      var w = resolve(from.path, d.href);
      if (w === REFUSED) say('The page asks to open a path the reader does not open.', esc(String(d.href).slice(0, 300)), [['Close', function () { note.hidden = true; }]]);
      else if (w) open({kind: 'path', ref: w.ref || from.ref, path: w.path, hash: fragment(d.href)});
      else if (/^https?:\/\//i.test(String(d.href))) elsewhere(String(d.href), '');
    } else if (d.type === 'front-door.fetch') {
      var w2 = resolve(from.path, d.href);
      (w2 && w2 !== REFUSED && !w2.ref ? loadIfKnown(from.ref, w2.path) : Promise.resolve(null)).then(function (f) {
        reply(f ? {type: 'front-door.fetch.result', id: id, ok: true, base64: toBase64(f.bytes), mime: f.type}
                : {type: 'front-door.fetch.result', id: id, ok: false});
      });
    } else if (d.type === 'schwingnet.open') {
      if (typeof d.href === 'string' && /^https?:\/\//i.test(d.href)) elsewhere(d.href, typeof d.label === 'string' ? d.label : '');
    } else if (d.type === 'schwingnet.read') {
      // A page reads only at its own branch, what the person sees beside it, never another branch.
      var ref = (typeof d.ref === 'string' && d.ref ? d.ref : MAIN).replace(/^refs\/heads\//, '');
      if (String(d.repo || '').toLowerCase() !== FULL.toLowerCase()) { reply({type: 'schwingnet.read.result', id: id, ok: false, error: 'repository not allowed'}); return; }
      if (ref !== from.ref) { reply({type: 'schwingnet.read.result', id: id, ok: false, error: 'ref not allowed'}); return; }
      var p = typeof d.path === 'string' ? cleanFrom(d.path.replace(/^\/+/, '')) : null;
      if (!p) { reply({type: 'schwingnet.read.result', id: id, ok: false, error: 'path not allowed'}); return; }
      read(ref, p).then(function (f) {
        reply({type: 'schwingnet.read.result', id: id, ok: true, text: textOf(f)});
      }, function (err) { reply({type: 'schwingnet.read.result', id: id, ok: false, error: code(err)}); });
    } else if (d.type === 'schwingnet.dispatch') {
      reply({type: 'schwingnet.dispatch.result', label: typeof d.label === 'string' ? d.label.slice(0, 200) : '', ok: false, error: 'not available here'});
    }
  }

  // A link out of the repository that a sealed page asks for: shown with its whole address, for the
  // person to open or not; the sealed frame itself can open nothing.
  function elsewhere(href, label) {
    say('The page asks to open a link outside the repository.',
        (label ? esc(label.slice(0, 200)) + ': ' : '') + '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(href) + '</a>',
        [['Close', function () { note.hidden = true; }]]);
  }

  // Showing

  function clear() {
    if (watch) { watch.disconnect(); watch = null; }
    blobs.forEach(function (u) { URL.revokeObjectURL(u); });
    blobs = [];
    sealed = null;
    content.textContent = '';
    view.className = '';
    view.scrollTop = 0;
  }

  function crumbs(ref, path) {
    where.textContent = '';
    if (ref !== MAIN) where.appendChild(el('span', {text: ref + ' '}));
    where.appendChild(el('button', {type: 'button', 'class': 'plain', text: FULL, onclick: function () { open({kind: 'path', ref: ref, path: ''}); }}));
    var sofar = '';
    (path ? path.split('/') : []).forEach(function (step) {
      sofar = sofar ? sofar + '/' + step : step;
      var p = sofar;
      where.appendChild(el('span', {text: ' / '}));
      where.appendChild(el('button', {type: 'button', 'class': 'plain', text: step, onclick: function () { open({kind: 'path', ref: ref, path: p}); }}));
    });
  }

  function entriesList(ref, path, entries) {
    var ul = el('ul', {'class': 'entries'});
    if (path) {
      ul.appendChild(el('li', {}, [el('span', {'class': 'kind', text: '^'}),
        el('button', {type: 'button', 'class': 'plain', text: '..', onclick: function () { open({kind: 'path', ref: ref, path: parent(path)}); }})]));
    }
    entries.forEach(function (en) {
      var li = el('li', {}, [el('span', {'class': 'kind', text: en.type === 'dir' ? '/' : '-'}),
        el('button', {type: 'button', 'class': 'plain', text: en.name, onclick: function () { open({kind: 'path', ref: ref, path: en.path}); }})]);
      if (en.type === 'file' && en.size !== null) li.appendChild(el('span', {'class': 'size', text: size(en.size)}));
      ul.appendChild(li);
    });
    return ul;
  }
  function size(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  // The folder pane: the starting points, then the folder in view.
  function pane(ref, path, entries) {
    side.textContent = '';
    side.appendChild(el('h2', {text: 'Start here'}));
    var list = el('ul');
    doors.forEach(function (d) {
      list.appendChild(el('li', {}, [el('span', {'class': 'kind', text: '>'}),
        el('button', {type: 'button', 'class': 'plain', text: d.label, onclick: function () { open({kind: 'path', ref: d.ref, path: d.path}); }})]));
    });
    if (GITHUB) list.appendChild(el('li', {}, [el('span', {'class': 'kind', text: '>'}), outLink(GITHUB, 'On GitHub')]));
    side.appendChild(list);
    if (entries) {
      side.appendChild(el('h2', {text: path ? name(path) : 'Top folder'}));
      var ul = entriesList(ref, path, entries);
      ul.className = '';
      side.appendChild(ul);
    }
  }

  function showFolder(ref, path, entries) {
    clear();
    crumbs(ref, path);
    pane(ref, path, entries);
    content.appendChild(entriesList(ref, path, entries));
    var readme = null;
    entries.forEach(function (en) { if (!readme && en.type === 'file' && /^readme\.md$/i.test(en.name)) readme = en; });
    note.hidden = true;
    if (!readme) return Promise.resolve();
    return read(ref, readme.path).then(function (f) { content.appendChild(docOf(ref, readme.path, textOf(f))); }, function () { /* the listing stands without it */ });
  }

  // A document rendered from Markdown, its relative links opening here and its images read in
  // view. The other place this script writes HTML: markdown() escapes every line first.
  function docOf(ref, path, md) {
    docBase = {ref: ref, path: path};
    var doc = el('div', {'class': 'doc'});
    doc.innerHTML = markdown(md);
    doc.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[data-door-path], a[data-door-hash]') : null;
      if (!a) return;
      e.preventDefault();
      if (!a.hasAttribute('data-door-path')) { reveal(a.getAttribute('data-door-hash')); return; }
      open({kind: 'path', ref: a.getAttribute('data-door-ref'), path: a.getAttribute('data-door-path'), hash: a.getAttribute('data-door-hash')});
    });
    var held = doc.querySelectorAll('img[data-door-src]');
    if (held.length) {
      watch = new IntersectionObserver(function (seen) {
        seen.forEach(function (s) {
          if (!s.isIntersecting) return;
          watch.unobserve(s.target);
          picture(s.target);
        });
      }, {root: view, rootMargin: '1200px 0px'});
      held.forEach(function (img) { watch.observe(img); });
    }
    return doc;
  }
  // A picture's address: an SVG as data, which an img never runs scripts from, and any other
  // picture as an object URL let go when the view changes.
  function pictureUrl(f) {
    if (f.type === 'image/svg+xml') return dataUrl(f);
    var url = URL.createObjectURL(new Blob([f.bytes], {type: f.type}));
    blobs.push(url);
    return url;
  }
  function picture(img) {
    var ref = img.getAttribute('data-door-ref'), p = img.getAttribute('data-door-src');
    img.removeAttribute('data-door-src');
    read(ref, p).then(function (f) { if (img.isConnected) img.src = pictureUrl(f); },
                      function () { img.alt = (img.alt ? img.alt + ' ' : '') + '(not in the repository: ' + p + ')'; });
  }
  // A document's headings carry ids prefixed doc-, so a heading named like one of the page's own
  // elements never takes its place; an anchor is looked up by that id, and by itself only inside
  // the document, for an id a document gives in its own HTML.
  function reveal(hash) {
    if (!hash) { view.scrollTop = 0; return; }
    var h = decodeOnce(hash);
    if (h === null) return;
    var t = content.querySelector('#doc-' + cssEscape(h)) || document.getElementById(h);
    if (t && content.contains(t)) t.scrollIntoView();
  }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }

  // A file too large to read, named with its link on GitHub.
  function showTooLarge(ref, en) {
    clear();
    crumbs(ref, en.path);
    content.appendChild(el('p', {text: name(en.path) + ' is ' + size(en.size) + ', more than this reader opens (' + size(LIMIT) + ').'}));
    content.appendChild(el('p', {}, [outLink(en.url || blobUrl(ref, en.path), 'Open it on GitHub')]));
    note.hidden = true;
  }

  // Each view is drawn by the open that asked for it and by no other: a read that comes back after
  // the reader has opened something else is dropped, so the view, the address and Back agree.
  function showFile(ref, path, en, hash) {
    var e = ext(path), mine = opening;
    if (en.size !== null && en.size > LIMIT) { showTooLarge(ref, en); return Promise.resolve(); }
    if (e === 'html' || e === 'htm') return showSealed(ref, path, hash);
    if (IMAGE.test(path)) return read(ref, path).then(function (f) {
      if (opening !== mine) return;
      clear();
      crumbs(ref, path);
      content.appendChild(el('img', {'class': 'picture', src: pictureUrl(f), alt: name(path)}));
      note.hidden = true;
    });
    if (BINARY.test(path)) {
      clear();
      crumbs(ref, path);
      content.appendChild(el('p', {text: name(path) + ' is a binary file' + (en.size !== null ? ' of ' + size(en.size) : '') + '.'}));
      content.appendChild(el('p', {}, [outLink(en.url || blobUrl(ref, path), 'Open it on GitHub')]));
      note.hidden = true;
      return Promise.resolve();
    }
    return read(ref, path).then(function (f) {
      if (opening !== mine) return;
      clear();
      crumbs(ref, path);
      var t = textOf(f);
      if (e === 'md') {
        // a document is cut where a text file is, since markdown() renders on the page's own thread
        var long = t.length > MOST_TEXT;
        content.appendChild(docOf(ref, path, long ? t.slice(0, MOST_TEXT) : t));
        if (long) content.appendChild(el('p', {'class': 'muted', text: 'Cut after ' + MOST_TEXT.toLocaleString() + ' characters; the whole document is on GitHub.'}));
        if (hash) setTimeout(function () { reveal(hash); }, 0);
      } else {
        var cut = t.length > MOST_TEXT;
        content.appendChild(el('pre', {}, [el('code', {text: cut ? t.slice(0, MOST_TEXT) : t})]));
        if (cut) content.appendChild(el('p', {'class': 'muted', text: 'Cut after ' + MOST_TEXT.toLocaleString() + ' characters; the whole file is on GitHub.'}));
      }
      note.hidden = true;
    });
  }
  function showSealed(ref, path, hash) {
    var mine = opening;
    return sealedDoc(ref, path, hash, 0).then(function (html) {
      if (opening !== mine) return;
      clear();
      crumbs(ref, path);
      view.className = 'framed';
      var frame = el('iframe', {title: name(path), sandbox: SEALED});
      frame.setAttribute('srcdoc', html);
      content.appendChild(frame);
      sealed = {frame: frame, ref: ref, path: path};
      note.hidden = true;
    });
  }

  function commitsUrl(n) { return '/repos/' + FULL + '/commits?sha=' + encodeURIComponent(MAIN) + '&per_page=' + n; }
  function when(c) {
    var t = c && c.commit && c.commit.committer && c.commit.committer.date;
    return t ? String(t).slice(0, 16).replace('T', ' ') + ' UTC' : '';
  }

  function showChanges() {
    var mine = opening;
    return request('get', commitsUrl(30)).then(function (r) {
      if (opening !== mine) return;
      var commits = r.data;
      if (!Array.isArray(commits)) throw {code: 'unreadable', message: 'GitHub answered with no list of commits'};
      clear();
      where.textContent = 'The newest commits of ' + MAIN;
      var ul = el('ul', {'class': 'commits'});
      commits.forEach(function (c) {
        if (!c || typeof c !== 'object') return;
        var m = (c.commit && c.commit.message) || '', sha = String(c.sha || '');
        var who = (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || '';
        var href = githubAddress(c.html_url) || (/^[0-9a-f]{7,64}$/.test(sha) ? GITHUB + '/commit/' + sha : GITHUB);
        ul.appendChild(el('li', {}, [
          el('a', {'class': 'sha', href: href, target: '_blank', rel: 'noopener noreferrer', text: sha.slice(0, 7)}),
          el('span', {text: String(m).split('\n')[0]}),
          el('span', {'class': 'when', text: when(c) + (who ? ', ' + who : '')})]));
      });
      content.appendChild(ul);
      note.hidden = true;
    });
  }

  // The search is held to this repository: a qualifier typed into the box that names another place
  // is refused, since GitHub would search both, and the words are cut to what fits in GitHub's 256
  // characters beside the repository's own qualifier.
  function showSearch(q) {
    if (/(?:^|\s)-?(?:repo|user|org):/i.test(q)) return Promise.reject({code: 'bad_search', message: q});
    var scope = 'repo:' + FULL + ' ', mine = opening;
    q = q.slice(0, Math.max(0, 256 - scope.length));
    var url = '/search/code?q=' + encodeURIComponent(scope + q) + '&per_page=30';
    return request('get', url, TEXT_MATCH).then(function (r) {
      if (opening !== mine) return;
      var items = r.data && Array.isArray(r.data.items) ? r.data.items : [];
      clear();
      where.textContent = 'Search: ' + q;
      if (!items.length) { content.appendChild(el('p', {'class': 'muted', text: 'Nothing in the default branch matches, as GitHub indexes it.'})); note.hidden = true; return; }
      var ul = el('ul', {'class': 'hits'});
      items.forEach(function (it) {
        if (!it || typeof it.path !== 'string') return;
        var li = el('li', {}, [el('button', {type: 'button', 'class': 'plain', text: it.path, onclick: function () { open({kind: 'path', ref: MAIN, path: it.path}); }})]);
        (Array.isArray(it.text_matches) ? it.text_matches : []).slice(0, 3).forEach(function (tm) {
          if (tm && typeof tm.fragment === 'string') li.appendChild(el('pre', {text: tm.fragment}));
        });
        ul.appendChild(li);
      });
      content.appendChild(ul);
      note.hidden = true;
    });
  }

  // The address

  // The deep link: a path with its slashes written as ~ (or as slashes, one at either end let go,
  // as a folder is often written), or one of the words board and changes. #main, the site's skip
  // link, is the page's own; any other word names a path, whatever the page's elements are called.
  function pageOwn(h) { return h === 'main'; }
  function targetOfHash() {
    var h = location.hash.slice(1);
    if (!h || pageOwn(h)) return {kind: 'path', ref: MAIN, path: ''};
    if (h === 'board') return {kind: 'path', ref: 'board', path: 'STATE.md'};
    if (h === 'changes') return {kind: 'changes'};
    var p = cleanFrom(h.replace(/^[\/~]|[\/~]$/g, ''), /[\/~]/);
    return p === null ? {kind: 'refused', raw: h} : {kind: 'path', ref: MAIN, path: p};
  }
  function hashOf(target) {
    if (target.kind === 'changes') return 'changes';
    if (target.kind !== 'path') return '';
    if (target.ref === 'board' && target.path === 'STATE.md') return 'board';
    if (target.ref !== MAIN) return '';
    return target.path.split('/').map(function (s) { return encodeURIComponent(s).replace(/~/g, '%7E'); }).join('~');
  }
  // The address follows what is in view, so it can be copied and sent; the history is left alone,
  // since Back is the reader's own.
  function writeHash(target) {
    var h = hashOf(target);
    try { history.replaceState(history.state, '', location.pathname + location.search + (h ? '#' + h : '')); } catch (e) { /* the address stays */ }
  }

  // Opening a target

  function open(target, remember) {
    var me = {}, was = shown, g = gen;
    opening = me;
    busy.hidden = false;
    var shows;
    if (target.kind === 'changes') shows = showChanges();
    else if (target.kind === 'search') shows = showSearch(target.q);
    else if (target.kind === 'refused') shows = Promise.reject({code: 'bad_path', message: target.raw});
    else {
      target.ref = target.ref || MAIN;
      target.path = String(target.path || '');
      shows = Promise.resolve().then(function () {
        partsOf(target.path);
        if (!goodRef(target.ref)) throw {code: 'bad_path', message: target.ref};
        return entryOf(target.ref, target.path);
      }).then(function (en) {
        if (opening !== me) return;
        if (!en) throw {code: 'not_found', message: target.path};
        if (shown && shown.kind === 'path' && shown.ref === target.ref && shown.path === target.path && en.type === 'file') {
          shown.hash = target.hash || '';
          if (ext(target.path) === 'md') { reveal(shown.hash); return 'same'; }
        }
        if (en.type === 'dir') return folder(target.ref, target.path).then(function (es) { return opening === me ? showFolder(target.ref, target.path, es) : null; });
        return showFile(target.ref, target.path, en, target.hash || '');
      });
    }
    shows.then(function (r) {
      if (opening !== me || g !== gen || r === 'same') return;
      if (remember !== false && was) trail.push(was);
      shown = target;
      writeHash(target);
      $('door-back').disabled = !trail.length;
      side.classList.remove('open');
      $('door-files').setAttribute('aria-expanded', 'false');
    }).catch(function (e) {
      if (opening !== me || g !== gen) return;
      failed(e, target);
      // the address goes back to what is still in view, so a copied address opens what it shows
      if (shown && code(e) !== 'too_large') writeHash(shown);
    }).then(function () { if (opening === me) busy.hidden = true; });
  }

  // A failure put into words: what GitHub said, in the reader's terms, with what to do next.
  function failed(e, target) {
    var c = code(e);
    if (c === 'stale') return;
    var close = ['Close', function () { note.hidden = Boolean(shown); }];
    var again = ['Try again', function () { open(target, false); }];
    var what = target.kind === 'path' ? (target.ref || MAIN) + ': ' + (target.path || '(top folder)') : '';
    if (c === 'not_found') say('That is not in the repository, or your account no longer reads it.', esc(what), [close]);
    else if (c === 'bad_path') say('That address names no path this reader opens.', 'A part of it is empty, . or .., or holds a slash or backslash once decoded: ' + esc(String(e.message || '').slice(0, 300)), [close]);
    else if (c === 'too_large') { showTooLarge(e.ref || MAIN, e.entry); }
    else if (c === 'is_folder') say('That is a folder, not a file.', esc(what), [close]);
    else if (c === 'bad_search') say('The search looks in this repository only, so it takes words and no repo:, user: or org:.', esc(String(e.message || '').slice(0, 300)), [close]);
    else common(e, again, close);
  }
  // the failures a start and an open share
  function common(e, again, close) {
    var c = code(e);
    if (c === 'signed_out') say('GitHub refused the sign-in, so nothing more can be read.', 'Sign in again above to go on.', []);
    else if (c === 'sso') {
      say('This repository\'s organization asks for single sign-on before your token reads it.',
          e.url ? 'Authorize your sign-in for the organization at <a href="' + esc(e.url) + '" target="_blank" rel="noopener noreferrer">GitHub\'s single sign-on page</a>, then try again.'
                : 'Authorize your sign-in for the organization in your GitHub settings, then try again.', [close, again]);
    } else if (c === 'rate_limited') {
      say('GitHub\'s rate limit for your account is reached for the moment.',
          e.until ? esc('It resets at ' + new Date(e.until).toISOString().slice(11, 16) + ' UTC; try again then.') : 'Wait a minute, then try again.', [close, again]);
    } else if (c === 'forbidden') say('GitHub refused the read (403).', esc(e.message || ''), [close, again]);
    else say('This could not be opened (' + c + ').', esc((e && e.message) || ''), [close, again]);
  }

  // Starting

  // The starting points: the repository's own .github/symphony/door.json where it has one, held
  // strictly to {"doors": [{"label", "path", "ref"?}]}, anything else in it ignored and an entry
  // that does not hold together left out; else its README and, where a branch named board exists,
  // the board's STATE.md.
  function doorsFrom(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.doors)) return null;
    var out = [];
    data.doors.slice(0, MOST_DOORS).forEach(function (d) {
      if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.label !== 'string' || typeof d.path !== 'string') return;
      var label = d.label.trim();
      if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) return;
      var path = cleanFrom(d.path.replace(/^\/|\/$/g, ''));
      if (path === null) return;
      var ref = MAIN;
      if (d.ref !== undefined && (typeof d.ref !== 'string' || (ref = cleanRef(d.ref)) === null)) return;
      out.push({label: label, path: path, ref: ref});
    });
    return out;
  }
  function loadDoors() {
    return read(MAIN, DOOR_FILE).then(function (f) { return doorsFrom(textOf(f)); }, function () { return null; }).then(function (given) {
      if (given && given.length) return given;
      var found = [];
      return folder(MAIN, '').then(function (top) {
        var readme = null;
        top.forEach(function (en) { if (!readme && en.type === 'file' && /^readme(?:\.md)?$/i.test(en.name)) readme = en; });
        if (readme) found.push({label: 'README', ref: MAIN, path: readme.path});
      }, function () { /* the top folder says so when it opens */ }).then(function () {
        return MAIN === 'board' ? null : entryOf('board', 'STATE.md').catch(function () { return null; });
      }).then(function (board) {
        if (board && board.type === 'file') found.push({label: 'Board', ref: 'board', path: 'STATE.md'});
        return found;
      });
    });
  }

  function showHead(g) {
    $('door-head').textContent = '';
    request('get', commitsUrl(1)).then(function (r) {
      var c = Array.isArray(r.data) ? r.data[0] : null;
      if (!c || g !== gen) return;
      $('door-head').textContent = MAIN + ' ' + String(c.sha || '').slice(0, 7) + (when(c) ? ', ' + when(c) : '') +
        (c.commit && c.commit.message ? ': ' + String(c.commit.message).split('\n')[0] : '');
    }, function () { /* the head line is a courtesy */ });
  }

  function failedStart(e) {
    var again = ['Try again', function () { start(api); }];
    if (code(e) === 'not_found') {
      say('Your GitHub account cannot read this repository, or the path is not there.',
          esc(FULL + ': GitHub answered 404, as it does for a repository your account may not see. Signed in with GitHub, the ' +
              'SymphonyBoard App must be installed on the repository\'s account too; a fine-grained token reaches the repositories it was made for.'),
          [again]);
    } else common(e, again, ['Close', function () { note.hidden = true; }]);
  }

  // The page's buttons and listeners, bound once whatever the number of starts.
  function bind() {
    if (bound) return;
    bound = true;
    view = $('door-view'); content = $('door-content'); note = $('door-note'); busy = $('door-busy'); where = $('door-where'); side = $('door-side');
    $('door-back').addEventListener('click', function () {
      var t = trail.pop();
      $('door-back').disabled = !trail.length;
      if (t) open(t, false);
    });
    $('door-home').addEventListener('click', function () { if (MAIN) open({kind: 'path', ref: MAIN, path: ''}); });
    $('door-changes').addEventListener('click', function () { if (MAIN) open({kind: 'changes'}); });
    $('door-find').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('door-q').value.trim().slice(0, 200);
      if (q && MAIN) open({kind: 'search', q: q});
    });
    $('door-files').addEventListener('click', function () {
      var on = !side.classList.contains('open');
      side.classList.toggle('open', on);
      $('door-files').setAttribute('aria-expanded', String(on));
    });
    window.addEventListener('message', onMessage);
    window.addEventListener('hashchange', function () {
      if (api && MAIN && !pageOwn(location.hash.slice(1))) open(targetOfHash());
    });
    if (!document.querySelector('meta[http-equiv="Content-Security-Policy"][content="' + PAGE_CSP + '"]')) {
      var policy = document.createElement('meta');
      policy.setAttribute('http-equiv', 'Content-Security-Policy');
      policy.setAttribute('content', PAGE_CSP);
      document.head.appendChild(policy);
    }
  }

  // Opens the repository the client names, from its top or from the address's hash; a second
  // start, for another repository or after a new sign-in, begins again from nothing.
  function start(given) {
    if (!$('door-view')) return;
    if (!given || typeof given.get !== 'function' || typeof given.raw !== 'function' || !REPOSITORY.test(String(given.repo || ''))) {
      if (given && typeof given.say === 'function') given.say('The reader was given no repository to read.', true);
      return;
    }
    bind();
    gen++;
    var g = gen;
    api = given;
    FULL = given.repo;
    GITHUB = 'https://github.com/' + FULL;
    MAIN = '';
    reads = {};
    folders = {};
    doors = [];
    trail = [];
    shown = null;
    opening = null;
    clear();
    where.textContent = '';
    $('door-head').textContent = '';
    $('door-back').disabled = true;
    pane('', '', null);
    say('Opening ' + FULL + '...', '', []);
    busy.hidden = false;
    request('get', '/repos/' + FULL).then(function (r) {
      if (g !== gen) return null;
      var branch = r.data && typeof r.data.default_branch === 'string' ? r.data.default_branch : '';
      MAIN = goodRef(branch) ? branch : 'main';
      return loadDoors().then(function (list) {
        if (g !== gen) return;
        doors = list;
        pane(MAIN, '', null);
        showHead(g);
        open(targetOfHash(), false);
      });
    }).catch(function (e) {
      if (g !== gen) return;
      busy.hidden = true;
      failedStart(e);
    });
  }

  window.SymphonyDoor = { start: start };
})();
