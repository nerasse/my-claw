# Dependency security maintenance

The October 11, 2026 qualification updates the Model Context Protocol SDK to 1.32.1
and compatible versions selected by `package.json` overrides. `bun.lock` remains
authoritative; use `bun install --frozen-lockfile` with CI Bun 1.3.13.

The full audit now has one moderate advisory, sprintf-js, reached through dev-only
Hugging Face/ONNX tooling. The production audit is empty. The critical proxy-addr
IPv4-mapped IPv6 trust error is fixed by 2.0.8 and has a behavior regression test
for public versus private client addresses.

For sprintf-js 1.1.3, `postinstall` bounds numeric precision to 100 before allocation.
The reviewed patch is in `scripts/dependency-patches.json`; the installer validates
pre/post SHA256 and replacement counts, is idempotent and refuses unknown bytes.
It is optional only when the whole dev package is absent in production. Package
versions/audit results are not hidden. See [the advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

Run `bun run check:dependency-patches` after installation or lock changes. CI executes
the byte checks and both behavior tests. The tarball copies installer/manifest before
production installation; that production-only packaging path was checked on Linux.

SDK/notification/protocol tests, the real local embedding pipeline, a sharp image
round trip and the full isolated Linux suite passed. This does not authorize updating
a running instance. Remove the local patch only with a compatible upstream fix and
the same behavior checks; never accept new hashes without review.
