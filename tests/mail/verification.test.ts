/**
 * The browser agent reads a verification code from the mailbox and nothing else
 * (docs/mail-verification.md). Every test below is one way a page could try to widen that.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SITE_GROUPS,
  findCode,
  findLink,
  findVerification,
  senderDomainOf,
  sitesForPage,
  type MailMessage,
  type MailSource,
} from "../../src/mail/verification.ts";
import { GmailSource } from "../../src/mail/gmail.ts";
import { createBrowserMailVerificationTool } from "../../src/tools/browser/mail.ts";
import type { BrowserWindows } from "../../src/tools/browser/windows.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const policy = { groups: DEFAULT_SITE_GROUPS };
const NOW = Date.UTC(2026, 8, 27, 18, 0);

function source(messages: MailMessage[]): MailSource & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    recent: async (_since, domains) => {
      asked.push([...domains]);
      return messages;
    },
  };
}

const hwCode: MailMessage = {
  id: "m1",
  from: "HelloWork <noreply@hellowork.com>",
  receivedAt: NOW - 60_000,
  text: "Bonjour Yassir,\nVotre code de vérification : 482913\nIl expire dans 15 minutes.\nSalaire souhaité : confidentiel",
};

describe("finding the code", () => {
  test("a code on the line that says so, with or without a space inside", () => {
    expect(findCode("Votre code de vérification : 482913")).toBe("482913");
    expect(findCode("Your verification code is\n123 456")).toBe("123456");
    expect(findCode("Code OTP: 88-4211")).toBeUndefined();
    expect(findCode("Utilisez le code 7391 pour vous connecter")).toBe("7391");
  });

  test("numbers that are not codes are not guessed", () => {
    expect(findCode("Appelez-nous au 01 23 45 67 89")).toBeUndefined();
    expect(findCode("Commande 48291374 expédiée")).toBeUndefined();
    expect(findCode("Code de conduite 2026")).toBeUndefined();
  });

  test("a link is kept only on the site itself, and only if it looks like a verification", () => {
    const sites = ["hellowork.com"];
    expect(findLink(["https://evil.example/verify?t=1", "https://www.hellowork.com/confirm?token=abc"], sites)).toBe(
      "https://www.hellowork.com/confirm?token=abc",
    );
    expect(findLink(["https://www.hellowork.com/offres"], sites)).toBeUndefined();
    expect(findLink(["http://www.hellowork.com/confirm?token=abc"], sites)).toBeUndefined();
  });

  test("the sender's domain is read from the address", () => {
    expect(senderDomainOf("HelloWork <noreply@mail.hellowork.com>")).toBe("mail.hellowork.com");
    expect(senderDomainOf("noreply@myworkday.com")).toBe("myworkday.com");
  });
});

describe("the site is the page's", () => {
  test("a page's own site, plus its group", () => {
    expect(sitesForPage("www.hellowork.com", policy)).toEqual(["hellowork.com"]);
    expect(sitesForPage("safran.wd3.myworkdayjobs.com", policy).sort()).toEqual(["myworkday.com", "myworkdayjobs.com", "workday.com"]);
    expect(sitesForPage("careers.safran-group.com", policy)).toEqual(["safran-group.com"]);
  });

  test("account providers and the owner's own domain are never a site", () => {
    expect(sitesForPage("sites.google.com", policy)).toEqual([]);
    expect(sitesForPage("login.microsoftonline.com", policy)).toEqual([]);
    expect(sitesForPage("yassir.kssimi.fr", policy)).toEqual([]);
  });

  test("a suffix this module cannot read as a site is refused rather than guessed", () => {
    // co.uk is a public suffix: its last two labels are anybody's.
    expect(sitesForPage("jobs.example.co.uk", policy)).toEqual([]);
  });

  test("a page on another site cannot read HelloWork's code, even if the mail is in the box", async () => {
    const box = source([hwCode]);
    const { result, reason } = await findVerification(box, "https://evil-jobs.com/apply", NOW - 15 * 60_000, policy);
    expect(result).toBeUndefined();
    expect(reason).toContain("evil-jobs.com");
    expect(box.asked).toEqual([["evil-jobs.com"]]);
  });

  test("the page that sent it gets the code, and only the code", async () => {
    const { result } = await findVerification(source([hwCode]), "https://www.hellowork.com/fr-fr/candidature", NOW - 15 * 60_000, policy);
    expect(result).toEqual({ code: "482913", sender: "hellowork.com", receivedAt: NOW - 60_000 });
    expect(JSON.stringify(result)).not.toContain("Salaire");
  });

  test("a Google security code never reaches a page, whatever it claims to be", async () => {
    const google: MailMessage = { id: "g", from: "Google <no-reply@accounts.google.com>", receivedAt: NOW, text: "Votre code de validation Google : 551902" };
    const { result } = await findVerification(source([google]), "https://sites.google.com/view/apply", NOW - 60_000, policy);
    expect(result).toBeUndefined();
  });
});

describe("Gmail, read-only", () => {
  test("one token refresh, then the list and the messages; the token is reused until it expires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gmail-"));
    const tokenPath = join(dir, "gmail-token.json");
    await writeFile(tokenPath, JSON.stringify({ refresh_token: "r", client_id: "c", client_secret: "s", token_uri: "https://oauth.test/token" }));
    const calls: string[] = [];
    const body = Buffer.from("Votre code de vérification : 482913").toString("base64url");
    const mock = mockFetch(async (input) => {
      const url = String(input);
      calls.push(url.split("?")[0]!);
      if (url.startsWith("https://oauth.test/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }));
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "m1" }] }));
      return new Response(JSON.stringify({
        id: "m1",
        internalDate: String(NOW),
        payload: { headers: [{ name: "From", value: "noreply@hellowork.com" }], mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: body } }] },
      }));
    });
    try {
      const gmail = new GmailSource(tokenPath, () => NOW);
      expect(await gmail.configured()).toBe(true);
      const first = await gmail.recent(NOW - 60_000, ["hellowork.com"]);
      await gmail.recent(NOW - 60_000, ["hellowork.com"]);
      expect(first[0]!.text).toContain("482913");
      expect(calls.filter((c) => c === "https://oauth.test/token")).toHaveLength(1);
      expect(calls.every((c) => c === "https://oauth.test/token" || c.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("no token file: not configured, and the tool says what to do instead", async () => {
    const gmail = new GmailSource(join(tmpdir(), "no-such-token.json"));
    expect(await gmail.configured()).toBe(false);
    const windows = { currentUrl: async () => "https://www.hellowork.com/x" } as unknown as BrowserWindows;
    const tool = createBrowserMailVerificationTool(windows, gmail, {} as MyClawConfig);
    const result = await tool.execute({ window: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("keep_window");
  });
});

describe("the tool", () => {
  const windows = (url: string) => ({ currentUrl: async () => url }) as unknown as BrowserWindows;
  const configured = (messages: MailMessage[]) => ({ ...source(messages), configured: async () => true });

  test("answers with the code, the sender and the time, never the mail", async () => {
    const recent: MailMessage = { ...hwCode, receivedAt: Date.now() - 30_000 };
    const tool = createBrowserMailVerificationTool(windows("https://www.hellowork.com/candidature"), configured([recent]), {} as MyClawConfig);
    const result = await tool.execute({ window: 1 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Code: 482913");
    expect(result.output).toContain("From hellowork.com");
    expect(result.output).not.toContain("Salaire");
  });

  test("turned off in config, it reads nothing", async () => {
    const box = configured([hwCode]);
    const tool = createBrowserMailVerificationTool(windows("https://www.hellowork.com/"), box, { browser: { mailVerification: { enabled: false } } } as MyClawConfig);
    expect((await tool.execute({ window: 1 })).success).toBe(false);
    expect(box.asked).toEqual([]);
  });

  test("a group the owner adds makes a new sender count for its pages", async () => {
    const mail: MailMessage = { id: "x", from: "no-reply@talent-mail.io", receivedAt: Date.now() - 1000, text: "Your confirmation code: 20481" };
    const config = { browser: { mailVerification: { sites: [["careers.acme.com", "talent-mail.io"]] } } } as unknown as MyClawConfig;
    const tool = createBrowserMailVerificationTool(windows("https://careers.acme.com/apply"), configured([mail]), config);
    expect((await tool.execute({ window: 1 })).output).toContain("Code: 20481");
  });
});
