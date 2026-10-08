import type { KeyRecord } from "./keys.ts";
import { LABEL_MAX } from "./keys.ts";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--bg:#fff;--card:#f5f5f7;--accent:#0a66c2}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--bg:#000;--card:#1c1c1e;--accent:#4c9eff}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:32px 0 8px}
p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}
.card{background:var(--card);border-radius:12px;padding:16px;margin:12px 0}
ul{list-style:none;padding:0;margin:0}li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}li .grow{flex:1;min-width:0}li .label{overflow-wrap:anywhere}
form.inline{margin:0}input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;margin-top:10px}
button.danger{color:#d70015}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:.85rem;margin:8px 0}
.key{font-weight:600}.error{color:#d70015}
.copy{display:none;margin-top:-2px}.can-copy .copy{display:inline-block}
`;

// The clipboard only exists on a secure page: without it the buttons stay hidden.
const COPY_SCRIPT = `<script>
if (navigator.clipboard) {
  document.body.classList.add("can-copy");
  for (const b of document.querySelectorAll("button.copy")) {
    b.onclick = () => navigator.clipboard.writeText(b.previousElementSibling.textContent)
      .then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); });
  }
}
</script>`;

function layout(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-claw downloads</title><style>${STYLE}</style></head>
<body><main>${body}</main>${COPY_SCRIPT}</body></html>`;
}

function keyRow(record: KeyRecord, showUser: boolean): string {
  const who = showUser ? `<strong>${esc(record.user)}</strong> · ` : "";
  return `<li><div class="grow"><div class="label">${who}${esc(record.label)}</div>
<div class="muted">created ${day(record.created)} · id ${esc(record.id)}</div></div>
<form class="inline" method="post" action="/key/revoke" onsubmit="return confirm('Revoke this key? That machine stops receiving updates.')"><input type="hidden" name="id" value="${esc(record.id)}">
<button class="danger" type="submit">Revoke</button></form></li>`;
}

function created(key: string, label: string, publicUrl: string): string {
  return `<div class="card"><h2 style="margin-top:0">Key for “${esc(label)}”</h2>
<p>Copy it now: it is shown only once.</p>
<pre class="key">${esc(key)}</pre><button class="copy" type="button">Copy</button>
<p class="muted">New install (Debian or Ubuntu):</p>
<pre>export MY_CLAW_RELEASE_KEY='${esc(key)}'
curl -fsSL -H "Authorization: Bearer $MY_CLAW_RELEASE_KEY" ${esc(publicUrl)}/install.sh | sudo -E bash</pre><button class="copy" type="button">Copy</button>
<p class="muted">Install that already runs:</p>
<pre>myclaw release-key '${esc(key)}'</pre><button class="copy" type="button">Copy</button></div>`;
}

export function refusedPage(user: string): string {
  return layout(`<h1>my-claw downloads</h1>
<p>Signed in as ${esc(user)}, who is not a collaborator of my-claw on git.kssimi.fr.</p>
<p class="muted">Download keys are for collaborators only. Ask the owner to add you.</p>`);
}

export interface PageInput {
  user: string;
  own: KeyRecord[];
  all?: KeyRecord[];
  publicUrl: string;
  fresh?: { key: string; label: string };
  error?: string;
}

export function keysPage(input: PageInput): string {
  const own = input.own.length
    ? `<ul>${input.own.map((r) => keyRow(r, false)).join("")}</ul>`
    : `<p class="muted">No key yet.</p>`;
  const others = input.all?.filter((r) => r.user !== input.user) ?? [];
  const admin = input.all
    ? `<h2>Everyone else</h2><div class="card">${
      others.length ? `<ul>${others.map((r) => keyRow(r, true)).join("")}</ul>` : `<p class="muted">No other key.</p>`
    }</div>`
    : "";
  return layout(`<h1>my-claw downloads</h1>
<p class="muted">Signed in as ${esc(input.user)}. One key per machine: revoking it cuts that machine's updates and nothing else.</p>
${input.error ? `<p class="error">${esc(input.error)}</p>` : ""}
${input.fresh ? created(input.fresh.key, input.fresh.label, input.publicUrl) : ""}
<h2>New key</h2>
<form class="card" method="post" action="/key">
<label for="label">Machine name</label>
<input id="label" name="label" type="text" maxlength="${LABEL_MAX}" required placeholder="e.g. Living room PC">
<button class="primary" type="submit">Create key</button></form>
<h2>Your keys</h2><div class="card">${own}</div>
${admin}`);
}
