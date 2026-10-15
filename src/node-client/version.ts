/**
 * The node client's own version, injected at build (`bun build --compile --define
 * MYCLAW_NODE_VERSION="x.y.z"`), "dev" when run from a checkout. It travels in the hello, and the
 * server reports it in `myclaw node ls`.
 */
declare const MYCLAW_NODE_VERSION: string | undefined;

export const CLIENT_VERSION: string = typeof MYCLAW_NODE_VERSION === "undefined" ? "dev" : MYCLAW_NODE_VERSION;
