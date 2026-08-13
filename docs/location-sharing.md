# Chat Location Sharing

Status: implemented for the Android app and the my-claw-app server protocol. The protocol also
accepts the browser shape; the current repository does not ship a browser client or an iOS
DeviceBridge yet.

## Configuration

The server reads secrets from `~/.my-claw/.env` at boot. Configure the Geoapify key as follows:

```dotenv
GEOAPIFY_API_KEY=...
```

The file must remain private:

```sh
chmod 600 ~/.my-claw/.env
```

The key is server-only. It must not be placed in the Android APK, an iOS bundle or browser
JavaScript. A manually edited `.env` is applied by the next server boot; edits made through the
server's env editor also update the live process.

The current implementation must not assume that the key is usable merely because the variable is
listed. The feature gate is `Boolean(process.env.GEOAPIFY_API_KEY?.trim())`.

## Provider

The server implementation uses Geoapify reverse geocoding:

```text
GET https://api.geoapify.com/v1/geocode/reverse
    ?lat=<latitude>&lon=<longitude>&lang=fr&format=json&apiKey=<server key>
```

One reverse lookup costs one credit. Geoapify documents a free geocoding quota of up to 3,000
requests per day. The response currently uses a `results` array and exposes `formatted`, `street`,
`housenumber`, `city`, `postcode`, `result_type`, `distance` and confidence values.

The provider response is convenience data, not proof of an exact address. The message must retain
the device's GPS accuracy and display the result as approximate when appropriate. If the provider
is unavailable, location sharing must still be able to send coordinates and a map link.

## Capability Gate

The client starts with location sharing disabled. The server sends a capability frame on each
WebSocket connection:

```json
{
  "type": "location.capabilities",
  "enabled": true,
  "address": true,
  "provider": "geoapify"
}
```

`enabled` is true only when the server has a non-empty `GEOAPIFY_API_KEY`. The frame carries no
secret. The app renders the `Share current location` row in the `+` sheet only when `enabled` is
true. Missing, empty or whitespace-only configuration must hide the row rather than showing an
action that will fail.

The app must also hide the row until a capability frame has been received after connecting. This
prevents a stale client state from briefly showing the action while the server capability is
unknown.

## Canonical Location

The protocol carries a structured message location rather than pretending it is a file attachment:

```json
{
  "latitude": 48.8566,
  "longitude": 2.3522,
  "accuracyMeters": 25,
  "altitudeMeters": null,
  "headingDegrees": null,
  "speedMetersPerSecond": null,
  "capturedAt": "2026-08-13T12:30:00Z",
  "address": {
    "formatted": "A proximite de 8 Place de l'Hotel de Ville, 75004 Paris",
    "street": "Place de l'Hotel de Ville",
    "houseNumber": "8",
    "city": "Paris",
    "postcode": "75004",
    "resultType": "building",
    "distanceMeters": 17,
    "confidence": 0.86,
    "provider": "geoapify"
  }
}
```

The exact coordinate remains the source of truth. The address is optional and may be absent when
reverse geocoding fails. `accuracyMeters` must be shown or used to qualify the address; a provider
building result does not make a low-accuracy GPS fix precise.

## Implementation

1. `location.capabilities` is sent immediately after the WebSocket opens and the default client
   state is false.
2. The server reverse-geocoding service uses a timeout, one-request-per-share behavior, a rounded
   coordinate cache and no coordinate logging.
3. The client sends `chat.send.location`; the server ignores any client-supplied address and sends
   back `chat.location` to enrich the optimistic user bubble.
4. The model receives a stable `[Shared location]` block with coordinates, GPS accuracy, timestamp
   and an explicitly approximate address.
5. User location data is persisted in session history and replayed in `chat.history`; it is not put
   in the media/file store.
6. Android captures a foreground fix through the native bridge:
   - `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` are requested together.
   - GPS and network providers are sampled for up to 12 seconds.
   - The best accuracy is kept, and a fix at or below 25 m ends the wait early.
   - No background location permission or service is used.
7. The `+` sheet shows `Share current location` only after the server capability is enabled. The
   captured fix is staged like an attachment, can be removed, and is sent with the next message.
8. Tapping the staged chip opens the location editor: the geocoded address (fetched through a
   `location.preview` round-trip, nothing persisted), the GPS accuracy and capture time, an
   OpenStreetMap link and a removal action. The address field is editable: an empty field sends
   coordinates only, any other text is sent as an `addressOverride` flagged `edited`.
9. The UI renders the approximate address, accuracy, timestamp and an OpenStreetMap link with
   attribution.
10. Address precision follows GPS accuracy: building for a good fix, street for a wider fix and
    city for a poor fix. The gesture-eight motion is not used as a GPS accuracy claim; it is only
    meaningful for a separate compass calibration feature.
11. Permission denial, timeout, unavailable provider, no address result and Geoapify quota errors
    leave raw coordinates sendable.
12. Server and app tests cover the gate, protocol, preview, override, enrichment, fallback,
    persistence, UI staging and history replay. The real provider check remains an opt-in smoke
    test.

## Accuracy Behavior

The capture waits for a better fix instead of asking the owner to move the phone in a figure eight.
That movement calibrates the magnetometer/compass; it does not reliably improve GNSS accuracy. The
app should instead wait briefly, request high accuracy and expose `accuracyMeters` honestly.

The app does not block forever. It stages the best fix received after the native timeout and lets the
owner send it. A future compass calibration animation must be labelled as compass calibration and
must not change the GPS accuracy value.

## Remaining Platform Work

- Android is wired in the current release path.
- iOS needs a complete native bridge or a separate `LocationBridge` target before the existing app
  can use the location method. `NSLocationWhenInUseUsageDescription` is present.
- A web client can use `navigator.geolocation.getCurrentPosition` with `enableHighAccuracy`, but no
  browser target is currently shipped by this repository.

## Test Matrix

Server tests cover a missing key, an empty key, a valid key, a successful `results` response, an
empty result, malformed JSON, HTTP errors and cache reuse. The missing-key path produces
`enabled: false` and makes no provider call.

App tests cover capability false hiding the row, capability true showing it, capture staging, send
serialization and enriched history rendering.

The real provider check is an opt-in smoke test only. It reads the local environment, redacts the
key, avoids coordinates in logs and never runs in the default CI suite.

## Privacy Decision

The implementation sends the exact one-shot coordinate together with its accuracy because the
feature is named `Share current location`. This is sensitive data and persists in chat history. The
UI and model-facing block label the address approximate; the raw coordinate remains the source of
truth.

## References

- [Geoapify reverse geocoding documentation](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)
- [Geoapify geocoding quota documentation](https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/)
- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [Nominatim reverse geocoding behavior](https://nominatim.org/release-docs/develop/api/Reverse/)
