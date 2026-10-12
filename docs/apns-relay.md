# iOS notifications and the team relay

The personal agent publishes notifications to a separate team-operated Bun service.
The iPhone enrolls with App Attest. The relay alone holds the Apple APNs signing key;
the personal instance receives one registration ID and its restricted sending secret.
Android UnifiedPush and browser Web Push keep their existing transport.

## Components and trust

- `src/apns-relay/main.ts`: standalone entry point, independent of `src/index.ts`.
- `storage.ts`: SQLite WAL, one-use challenges, public attestation keys, counters,
  registration origins, APNs tokens and SHA-256 sending-secret hashes.
- `integrity.ts`: Apple chain/nonce/application identity verification through
  `node-app-attest`, plus certificate dates, exact environment and distribution claims.
- `service.ts`: bounded JSON API and authorization; `provider.ts`: real HTTP/2 APNs.
- `src/notifications/apns.ts`: personal-instance capability store and publisher.
  `src/index.ts` injects the current enabled-device authorization check.

The relay stores no titles, message previews, conversation content or payload queue.
It reads these only while forwarding to Apple. APNs itself receives the preview.
Do not enable request-body/Authorization logging on its reverse proxy. SQLite and
backups contain device metadata and must remain private. There is currently no
automatic purge of historical attestation keys and inactive registrations; establish
the team's retention policy before public deployment.

## Configuration

The app's build setting `MYCLAW_RELAY_URL` and the personal instance's environment
`MYCLAW_APNS_RELAY_URL` must name the same trusted HTTPS origin, without credentials,
path or query. The app refuses a different URL advertised by a personal instance.
Missing configuration leaves conversations and media usable with an explicit push state.

| Relay variable | Meaning |
| --- | --- |
| `APNS_ENVIRONMENT` | `development` for device Debug; `production` for TestFlight/App Store |
| `APPLE_TEAM_ID` | Registered Apple team's ten-character ID |
| `APPLE_BUNDLE_ID` | The actual app's registered Bundle ID and APNs topic |
| `APNS_KEY_ID` | Ten-character ID of the team's APNs signing key |
| `APNS_KEY_FILE` | Mounted private `.p8` file; never commit it or bake it into the image |
| `APP_ATTEST_BUNDLE_VERSIONS` | Comma-separated allowed `CFBundleVersion` values |
| `APP_ATTEST_ALLOW_LEGACY` | Optional `true`/`false`, default false |
| `RELAY_DB` | SQLite path; defaults to `/data/relay.sqlite` |
| `RELAY_HOST`, `PORT` | Default `127.0.0.1:8080`; container binds `0.0.0.0:8080` |
| `RELAY_TRUSTED_PROXIES` | Exact proxy IPs allowed to provide `X-Real-IP` |

Use separate deployments, domains and durable volumes for development and production.
A database refuses to reopen under a different Apple environment. Only configured
proxy IPs may supply client IPs, otherwise throttling uses the socket address.

```sh
bun install --frozen-lockfile
bun src/apns-relay/main.ts
docker build -f packaging/apns-relay/Dockerfile -t myclaw-apns-relay:local .
```

The entry point requires the variables and key mount above. The container uses a
minimal independently locked dependency set in `packaging/apns-relay/`, runs as
`bun`, and persists `/data`. Termination stops the HTTP server and closes SQLite.
Building this image does not deploy the service. Credentials come from Bitwarden
via `agent-cli` into the infrastructure's secret mechanism.

The independently installed minimal relay dependency set passed `bun audit` on
10 October 2026 with no advisories. The subsequent October 11 dependency-security
qualification updated the personal-server SDK and compatible overrides: its
production audit was empty, with one moderate dev-only sprintf-js advisory
addressed by the reviewed local patch. See [dependency security maintenance](dependency-security.md)
for the lockfile, byte checks, behavior tests and retained audit result. Repeat
the audit before deployment; functional tests alone do not establish audit status.

## API contract

All mutations are POST, `Content-Type: application/json`. Query strings and redirects
are not part of the contract. `GET /health` returns `{ "status": "ok" }`.

| Path | Body / authentication | Success |
| --- | --- | --- |
| `/v1/challenges` | `{purpose:"attest"\|"manage",keyId}`; manage requires an attested key | 201 `{nonce}` |
| `/v1/attestations` | `{nonce,keyId,attestation}`; canonical base64 CBOR Apple attestation | 204 |
| `/v1/registrations` | `{nonce,origin,token}` + App Attest assertion headers | 201 `{id,secret}` |
| `/v1/registrations/:id/token` | `{nonce,token}` + owner's assertion | 204 |
| `/v1/registrations/:id/revoke` | `{nonce}` + owner's assertion | 204, idempotent for that owner |
| `/v1/registrations/:id/publish` | `{title,body,target,ring}` + `Authorization: Bearer <sending secret>` | 202 accepted by Apple |

`target` is `{kind:"thread",threadId}` or `{kind:"job",jobId}`. Destination IDs are
1–64 ASCII letters/digits/dot/underscore/hyphen. Tokens are 64–200 hex characters.
Origin is normalized HTTPS. A registration supersedes the previous active one for
the same attested key. Sending secrets are 32 random bytes encoded base64url; the
relay returns them once and stores only their hash.

Management headers are `x-app-attest-key` and `x-app-attest-assertion` (canonical
base64). The assertion's `clientDataHash` is SHA-256 of these exact bytes:

```text
POST\n<pathname>\n<raw JSON body bytes>
```

The nonce is inside that signed body. Initial attestation hashes the nonce's UTF-8
bytes. A challenge expires after 120 seconds, is bound to key/purpose, and is burned
before cryptographic validation. Assertion counters advance with compare-and-set;
replay and concurrent reuse fail. Even an invalid signature cannot reuse its nonce.

Limits: 96 KiB global body, 4 KiB publication and Apple payload, 120 operations/IP/min,
30 challenges/IP/min, 60 publications/registration/min, 10,000 live challenges and
rate buckets. Responses contain stable sanitized error codes. Bad auth is 401;
inactive capability with its correct secret is 410; temporary APNs failure is 503
with Retry-After; throttling is 429. A late response for an old token cannot disable
its replacement: the relay requests a retry against the new token instead.

## Personal-instance protocol

`hello.capabilities.apns` announces support. `notifications.info.apns.relayURL`
advertises the locally configured origin. The authenticated device sends
`notifications.apns.register {registrationId,secret}` or
`notifications.apns.unregister`; `notifications.apns.result {ok,registrationId?,error?}`
confirms the instance has stored its capability. The iOS UI waits for that correlated
confirmation before showing ready. Queue acceptance alone does not confirm registration.

Capabilities persist under `$MY_CLAW_DIR/push/apns.json` with mode 0600. Never include
this file in diagnostics. Publication checks the current device authorization after
the final storage read and before each HTTP attempt. Revocation/disable of device
credentials and web sessions succeeds even if APNs storage is unavailable. An HTTP
request already in flight cannot be recalled. Last socket close clears foreground
state so an iOS suspension does not suppress all subsequent notifications.

## Apple qualification before deployment

The category is an exactly four-byte little-endian CBOR byte string, decoded as
UInt32; the version is a CBOR string. This wire format was confirmed with signed
attestation and assertion objects from TonyI (iPhone 16 Pro / iOS 27) on 10 October 2026.
The development app verified against the real Apple chain, then rejected replay,
wrong nonce, app, version, environment and modified assertion body. This does not
qualify TestFlight distribution or APNs delivery.

Strict validation accepts development category 3; production categories 2 (TestFlight)
and 4 (App Store), and explicitly allowed bundle versions. The newer Apple
`apple_validation_category_01` and `apple_bundle_version_01` extensions must be
qualified on real devices, including the supported older iOS releases. With missing
extensions the default policy refuses enrollment. Enabling legacy claims is an
explicit operator decision that keeps chain/app/environment/counter checks but loses
distribution-category and bundle-version guarantees. Do not silently enable it to
make a test pass. See [Apple validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
and [environment preparation](https://developer.apple.com/documentation/devicecheck/preparing-to-use-the-app-attest-service).

```sh
bun run check
bun run check:test
bun test
APNS_RELAY_E2E=1 bun test tests-e2e/apns/provider.test.ts
```

The preloads isolate tests from the real `~/.my-claw`. Crypto fixtures exercise real
signature verification with a fixture-only historical clock. The gated HTTP/2 test
uses a real local provider endpoint and a test key; it is not evidence of Apple
delivery. Before release: validate attestation, replay, token rotation, device revoke,
background/terminated delivery, foreground suppression and cold/warm navigation on
a real iPhone, then repeat on the exact TestFlight production build.
