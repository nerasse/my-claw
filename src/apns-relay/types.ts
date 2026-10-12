export type AppleEnvironment = "development" | "production";
export type ChallengePurpose = "attest" | "manage";

export interface AttestedKey {
  keyId: string;
  publicKey: string;
  counter: number;
  environment: AppleEnvironment;
}

export interface RelayRegistration {
  id: string;
  keyId: string;
  origin: string;
  token: string;
  secretHash: string;
  tokenUpdatedAt: number;
  active: boolean;
}

export interface RelayMessage {
  title: string;
  body: string;
  target: NotificationTarget;
  ring: boolean;
}

export type PublishOutcome =
  | { kind: "accepted" }
  | { kind: "invalid-token"; invalidatedAt?: number }
  | { kind: "temporary"; retryAfter: number }
  | { kind: "invalid-payload" }
  | { kind: "configuration-error" };

export interface APNsPublisher {
  send(registration: RelayRegistration, message: RelayMessage): Promise<PublishOutcome>;
}
import type { NotificationTarget } from "../notifications/target";
