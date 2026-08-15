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
  .code {
    font: 600 30px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 3px; text-align: center; padding: 18px 0;
    background: #14181d; border: 1px solid #232a33; border-radius: 12px;
  }
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
  <p>Open MyClaw on a paired device, then Settings, Devices, and approve this code.</p>

  <div class="code" id="code">--------</div>
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
      codeEl.textContent = frame.code.slice(0, 4) + '-' + frame.code.slice(4);
      verifyEl.textContent = frame.verification;
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
        if (response.ok) location.replace('/');
        else say('the session could not be opened', 'error');
      }).catch(function () { say('the session could not be opened', 'error'); });
      return;
    }
    if (frame.type === 'pair.denied') {
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
