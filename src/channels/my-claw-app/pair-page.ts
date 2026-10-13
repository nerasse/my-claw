import { randomBytes } from "node:crypto";
import { securityHeaders } from "./web.ts";

/**
 * The pairing shell served at /pair, the only public page of this port.
 *
 * Gating the bundle creates a bootstrap problem: the pairing screen cannot live inside the thing
 * it unlocks. So it does not. This page is shipped with the server, has no framework, no bundle
 * and no dependency, and it is versioned with the server rather than with the client: a bundle
 * rollback never leaves the door without a handle.
 *
 * It reads no session, lists no thread and names no model. What an attacker learns from it is
 * that a my-claw instance is here, which the TLS certificate already told them.
 */

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<title>Pair this browser</title>
<style nonce="__NONCE__">
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
    background: #0b0d10; color: #e6e8eb;
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: min(380px, 94vw);
    padding: calc(14px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
  }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
  .lede { margin: 0 0 12px; font-size: 13px; color: #9aa4b2; }
  .qr { display: grid; place-items: center; min-height: 150px; }
  .qr svg { width: 150px; height: 150px; display: block; }
  .code-row { display: flex; gap: 8px; margin-top: 10px; }
  .code {
    flex: 1; min-width: 0; font: 600 25px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 2px; text-align: center; padding: 13px 4px; color: inherit;
    background: #14181d; border: 1px solid #232a33; border-radius: 10px; cursor: pointer;
  }
  .copy {
    padding: 0 14px; border-radius: 10px; border: 1px solid #232a33; background: #1b2029;
    color: #cfd6df; font: 600 13px/1 inherit; cursor: pointer;
  }
  .meta {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
    margin: 8px 2px 0; font-size: 12.5px; color: #6b7480;
  }
  .meta b { color: #e6e8eb; font: 600 16px/1 ui-monospace, monospace; letter-spacing: 1px; }
  .state { margin-top: 10px; text-align: center; min-height: 18px; font-size: 13px; color: #9aa4b2; }
  .state.error { color: #ff8f8f; }
  .state.ok { color: #7ee08a; }
  form { display: flex; gap: 8px; margin-top: 10px; }
  input {
    flex: 1; min-width: 0; padding: 10px 11px; border-radius: 10px; border: 1px solid #232a33;
    background: #14181d; color: inherit; font: 13px/1 ui-monospace, monospace; letter-spacing: 1px;
  }
  .submit {
    padding: 10px 14px; border-radius: 10px; border: 0; background: #2f6df6; color: #fff;
    font: 600 13px/1 inherit; cursor: pointer;
  }
  .hint { margin: 12px 0 0; font-size: 11.5px; color: #6b7480; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Pair this browser</h1>
  <p class="lede">Scan with MyClaw on a paired device, or approve the code in Settings, Devices.</p>

  <div class="qr" id="qr"></div>

  <div class="code-row">
    <button class="code" id="code" type="button" title="copy the code">--------</button>
    <button class="copy" id="copy" type="button">Copy</button>
  </div>
  <p class="meta"><span id="expiry"></span><span>app shows <b id="verify">---</b></span></p>

  <div class="state" id="state">connecting</div>

  <form id="claim">
    <input id="ticket" placeholder="or type an invitation code" autocomplete="off" spellcheck="false" />
    <button class="submit" type="submit">Claim</button>
  </form>

  <p class="hint">First device? Run <code>myclaw setup</code> on the server and open the link it prints.</p>
  <p class="hint">This page never receives your device token.</p>
</main>
<script nonce="__NONCE__">
(function () {
  var codeEl = document.getElementById('code');
  var copyEl = document.getElementById('copy');
  var qrEl = document.getElementById('qr');
  var expiryEl = document.getElementById('expiry');
  var verifyEl = document.getElementById('verify');
  var stateEl = document.getElementById('state');
  var form = document.getElementById('claim');
  var ticket = document.getElementById('ticket');

  /**
   * Where the browser was heading when it was sent here. A link to a conversation must survive
   * the pairing it triggers, and the value is a path of ours or nothing: anything with a scheme,
   * a host or a backslash is an open redirect waiting to happen.
   */
  function nextPath() {
    var raw = new URLSearchParams(location.search).get('next') || '/';
    // 92 is a backslash, spelled by its code point because this page is a String.raw template.
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charCodeAt(1) === 92) return '/';
    return raw;
  }

  function say(text, kind) {
    stateEl.textContent = text;
    stateEl.className = 'state' + (kind ? ' ' + kind : '');
  }

  /**
   * The challenge, kept where a frozen tab can find it again.
   *
   * sessionStorage and not localStorage: the resume token is what authorises receiving the
   * credential, so it dies with the tab that raised the challenge and no other tab can read it.
   */
  var STORE_KEY = 'myclaw.pair';

  function remember(code, token) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ code: code, token: token })); } catch (err) {}
  }

  function forget() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (err) {}
  }

  function remembered() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      return saved && saved.code && saved.token ? saved : null;
    } catch (err) { return null; }
  }

  var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var socket = null;
  var done = false;
  var attempt = 0;
  var retryTimer = null;
  var probeTimer = null;
  var lastFrameAt = 0;
  var expiresAt = 0;
  var renewTimer = null;

  function drop() {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    try { socket.close(); } catch (err) {}
    socket = null;
  }

  function connect() {
    if (done) return;
    if (socket && socket.readyState <= 1) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    drop();
    socket = new WebSocket(scheme + '//' + location.host + '/my-claw-app/pair');
    socket.onopen = onOpen;
    socket.onmessage = onMessage;
    socket.onclose = onClose;
  }

  // Backing off matters: the server allows ten pairing sessions per minute and per address, and
  // a tight retry loop would spend that budget before the owner is back on the page.
  function retry() {
    if (done || retryTimer) return;
    var delay = Math.min(15000, 1000 * Math.pow(2, attempt++));
    say('reconnecting');
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, delay);
  }

  /** Announces this client, resuming the challenge already on screen when there is one. */
  function hello() {
    if (!socket || socket.readyState !== 1) return;
    var frame = { type: 'pair.hello', kind: 'web', userAgent: navigator.userAgent };
    var saved = remembered();
    if (saved) frame.resume = { code: saved.code, token: saved.token };
    socket.send(JSON.stringify(frame));
  }

  /** Asks for a new code, dropping the one held: this is renewal, not reconnection. */
  function askForChallenge() {
    forget();
    hello();
  }

  /**
   * Coming back to the page is the moment that matters. Approving happens in the app, so the tab
   * is in the background for the whole exchange and the system is free to freeze it and close the
   * socket. A socket that survived on paper can still be dead on the wire after a network switch,
   * so the resume doubles as the probe: no frame back within four seconds, and it is replaced.
   */
  function wake() {
    if (done) return;
    attempt = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!socket || socket.readyState > 1) { connect(); return; }
    if (socket.readyState !== 1) return;
    hello();
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () {
      probeTimer = null;
      if (done || Date.now() - lastFrameAt < 4000) return;
      drop();
      connect();
    }, 4000);
  }

  setInterval(function () {
    if (!expiresAt) return;
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;
    expiryEl.textContent = left > 0 ? 'valid ' + minutes + ':' + String(seconds).padStart(2, '0') : 'renewing';
  }, 1000);

  function onOpen() {
    attempt = 0;
    hello();
    // A code in the fragment comes from "myclaw device add": the fragment never leaves the
    // browser, and it is dropped from the URL as soon as it is read.
    var fragment = (location.hash || '').replace(/^#/, '').trim();
    if (fragment) {
      history.replaceState(null, '', location.pathname);
      socket.send(JSON.stringify({ type: 'pair.claim', code: fragment }));
      say('claiming');
    }
  }

  function onMessage(event) {
    lastFrameAt = Date.now();
    var frame;
    try { frame = JSON.parse(event.data); } catch (err) { return; }

    if (frame.type === 'pair.challenge') {
      expiresAt = frame.expiresAt;
      if (frame.resumeToken) remember(frame.code, frame.resumeToken);
      if (renewTimer) clearTimeout(renewTimer);
      // Ten seconds before the end, so the owner never reads a code the server has forgotten.
      renewTimer = setTimeout(askForChallenge, Math.max(5000, frame.expiresAt - Date.now() - 10000));
      codeEl.textContent = frame.code.slice(0, 4) + '-' + frame.code.slice(4);
      verifyEl.textContent = frame.verification;
      // The server draws the QR and sends it in a second frame; innerHTML is safe here because
      // the payload is an SVG this server generated, not anything a client sent.
      if (frame.qrSvg) qrEl.innerHTML = frame.qrSvg;
      say('waiting for approval');
      return;
    }
    if (frame.type === 'pair.pending') {
      say('a device is looking at this code');
      return;
    }
    if (frame.type === 'pair.granted') {
      done = true;
      forget();
      say('approved, opening', 'ok');
      fetch('/my-claw-app/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: frame.grant }),
      }).then(function (response) {
        // An explicit origin, because replacing with '/' alone leaves the claim code sitting in
        // the address bar as a fragment, ready to be copied out of a screenshot.
        if (response.ok) location.replace(location.origin + nextPath());
        else say('the session could not be opened', 'error');
      }).catch(function () { say('the session could not be opened', 'error'); });
      return;
    }
    if (frame.type === 'pair.denied') {
      if (frame.reason === 'expired' || frame.reason === 'unknown') {
        // The socket is still up: ask for a fresh code instead of telling the owner to reload.
        askForChallenge();
        say('code renewed');
        return;
      }
      say(frame.reason === 'denied' ? 'refused on the device' : 'code ' + frame.reason, 'error');
    }
  }

  function onClose() {
    if (done) return;
    socket = null;
    retry();
  }

  function copied() {
    copyEl.textContent = 'copied';
    setTimeout(function () { copyEl.textContent = 'Copy'; }, 1400);
  }

  /**
   * The clipboard API only exists in a secure context, and this page is opened over plain HTTP on
   * a LAN address as often as not. The textarea road is the one that works there.
   */
  function copyFallback(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) {}
    document.body.removeChild(area);
    if (ok) copied();
    else copyEl.textContent = 'copy by hand';
  }

  function copyCode() {
    var text = codeEl.textContent;
    if (text.charAt(0) === '-') return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(copied, function () { copyFallback(text); });
      return;
    }
    copyFallback(text);
  }

  copyEl.addEventListener('click', copyCode);
  codeEl.addEventListener('click', copyCode);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);

  form.onsubmit = function (event) {
    event.preventDefault();
    var code = ticket.value.trim();
    if (!code || !socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'pair.claim', code: code }));
    say('claiming');
  };

  connect();
})();
</script>
</body>
</html>
`;

/**
 * The page is deliberately one self-contained file, so its script and its style are inline and
 * the shared `default-src 'self'` policy refuses them. A per-response nonce is what allows
 * exactly these two blocks and nothing else: `unsafe-inline` would allow any injection too.
 */
export function pairPageResponse(): Response {
  const nonce = randomBytes(16).toString("base64");
  return new Response(PAGE.replaceAll("__NONCE__", nonce), {
    headers: securityHeaders({
      "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' ws: wss:; img-src 'self' data:`,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}
