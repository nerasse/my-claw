// Preloaded into CLI child processes that these tests spawn (`bun --preload`): the in-process
// fetch mock cannot reach another process, and a sign-in reads the account's identity before it
// stores anything. Answered here so the child never touches the network; everything else falls
// through to the real fetch, which the CLI does not use on these paths.
const real = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  if (String(input).endsWith("/api/oauth/profile")) {
    return Response.json({ account: { uuid: "cli", full_name: "Owner", email: "cli@example.com" }, organization: { name: "Org" } });
  }
  return real(input, init);
}) as typeof globalThis.fetch;
