// One frame to a running server, the first answer of a given type back: what the app does, without
// the app. Run with bun inside a test machine (docs/install-test.md):
//   bun ws-probe.ts <device> <token> '<frame json>' <answer type> [port]
// Prints the answer as JSON; exits 1 on a refusal ("error" frame) or no answer in 20 s.
const [device, token, frame, want, port = "8080"] = process.argv.slice(2);
if (!device || !token || !frame || !want) {
  console.error("usage: ws-probe.ts <device> <token> <frame json> <answer type> [port]");
  process.exit(2);
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/my-claw-app?device=${encodeURIComponent(device)}&token=${encodeURIComponent(token)}`);
const timer = setTimeout(() => {
  console.error(`no ${want} within 20 s`);
  process.exit(1);
}, 20_000);
ws.onopen = () => ws.send(frame);
ws.onmessage = (event) => {
  const parsed = JSON.parse(String(event.data)) as { type?: string };
  if (parsed.type === want || parsed.type === "error") {
    clearTimeout(timer);
    console.log(JSON.stringify(parsed));
    ws.close();
    process.exit(parsed.type === "error" ? 1 : 0);
  }
};
ws.onerror = () => {
  console.error("socket error");
  process.exit(1);
};
