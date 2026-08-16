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
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d10; color: #e6e8eb;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { width: min(420px, 92vw); padding: 28px 24px 32px; }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 20px; color: #9aa4b2; }
  .qr { display: grid; place-items: center; padding: 14px 0 4px; }
  .qr svg { width: 190px; height: 190px; }
  .code {
    font: 600 30px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 3px; text-align: center; padding: 18px 0;
    background: #14181d; border: 1px solid #232a33; border-radius: 12px;
  }
  .expiry { text-align: center; margin: 8px 0 0; font-size: 13px; color: #6b7480; }
  .verify { text-align: center; margin: 16px 0 0; color: #9aa4b2; }
  .verify b { color: #e6e8eb; font: 600 22px/1 ui-monospace, monospace; letter-spacing: 2px; }
  .state { margin-top: 22px; text-align: center; min-height: 22px; color: #9aa4b2; }
  .state.error { color: #ff8f8f; }
  .state.ok { color: #7ee08a; }
  form { display: flex; gap: 8px; margin-top: 22px; }
  input {
    flex: 1; padding: 11px 12px; border-radius: 10px; border: 1px solid #232a33;
    background: #14181d; color: inherit; font: 15px/1 ui-monospace, monospace; letter-spacing: 2px;
  }
  button {
    padding: 11px 16px; border-radius: 10px; border: 0; background: #2f6df6; color: #fff;
    font: 600 14px/1 inherit; cursor: pointer;
  }
  .hint { margin-top: 26px; font-size: 13px; color: #6b7480; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Pair this browser</h1>
  <p>Scan this with MyClaw on a paired device, or approve the code from Settings, Devices.</p>

  <div class="qr" id="qr"></div>
  <div class="code" id="code">--------</div>
  <p class="expiry" id="expiry"></p>
  <p class="verify">Check that the app shows <b id="verify">---</b></p>
  <div class="state" id="state">connecting</div>

  <form id="claim">
    <input id="ticket" placeholder="or paste a myclaw device add code" autocomplete="off" spellcheck="false" />
    <button type="submit">Claim</button>
  </form>

  <p class="hint">This page never receives your device token.</p>
</main>
<script nonce="__NONCE__">
(function () {
  var codeEl = document.getElementById('code');
  var qrEl = document.getElementById('qr');
  var expiryEl = document.getElementById('expiry');
  var verifyEl = document.getElementById('verify');
  var stateEl = document.getElementById('state');
  var form = document.getElementById('claim');
  var ticket = document.getElementById('ticket');

  function say(text, kind) {
    stateEl.textContent = text;
    stateEl.className = 'state' + (kind ? ' ' + kind : '');
  }

  var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var socket = new WebSocket(scheme + '//' + location.host + '/my-claw-app/pair');
  var expiresAt = 0;
  var renewTimer = null;

  // A code that dies while the owner is walking to their phone is the failure this whole page
  // exists to avoid: the countdown says how long is left, and a new challenge is asked for
  // before the current one expires, so what is on screen is always live.
  function askForChallenge() {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'pair.hello', kind: 'web', userAgent: navigator.userAgent }));
  }

  setInterval(function () {
    if (!expiresAt) return;
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;
    expiryEl.textContent = left > 0 ? 'valid for ' + minutes + ':' + String(seconds).padStart(2, '0') : 'renewing';
  }, 1000);

  socket.onopen = function () {
    socket.send(JSON.stringify({ type: 'pair.hello', kind: 'web', userAgent: navigator.userAgent }));
    // A code in the fragment comes from "myclaw device add": the fragment never leaves the
    // browser, and it is dropped from the URL as soon as it is read.
    var fragment = (location.hash || '').replace(/^#/, '').trim();
    if (fragment) {
      history.replaceState(null, '', location.pathname);
      socket.send(JSON.stringify({ type: 'pair.claim', code: fragment }));
      say('claiming');
    }
  };

  socket.onmessage = function (event) {
    var frame;
    try { frame = JSON.parse(event.data); } catch (err) { return; }

    if (frame.type === 'pair.challenge') {
      expiresAt = frame.expiresAt;
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
      say('approved, opening', 'ok');
      fetch('/my-claw-app/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: frame.grant }),
      }).then(function (response) {
        // An explicit origin, because replacing with '/' alone leaves the claim code sitting in
        // the address bar as a fragment, ready to be copied out of a screenshot.
        if (response.ok) location.replace(location.origin + '/');
        else say('the session could not be opened', 'error');
      }).catch(function () { say('the session could not be opened', 'error'); });
      return;
    }
    if (frame.type === 'pair.denied') {
      if (frame.reason === 'expired') {
        // The socket is still up: ask for a fresh code instead of telling the owner to reload.
        askForChallenge();
        say('code renewed');
        return;
      }
      say(frame.reason === 'denied' ? 'refused on the device' : 'code ' + frame.reason, 'error');
    }
  };

  socket.onclose = function () { say('disconnected, reload to try again', 'error'); };

  form.onsubmit = function (event) {
    event.preventDefault();
    var code = ticket.value.trim();
    if (!code || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'pair.claim', code: code }));
    say('claiming');
  };
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
