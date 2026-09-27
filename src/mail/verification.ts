/**
 * A verification code or link from a recent e-mail, and nothing else from the mailbox -- for the
 * browser agent, which reads untrusted pages all day and must never be able to read mail.
 * docs/mail-verification.md.
 *
 * The one question this module answers: "the page in front of me sent a code to the owner's
 * mailbox; what is it?". Three rules keep a page from turning it into anything wider:
 *
 * - **The site is the page's, never the caller's word.** The tool reads the URL of the page the
 *   agent is on. A page cannot name another sender to fetch from.
 * - **Sender and page are one site.** The same registrable domain under a plain TLD, or one group
 *   of a curated list (an ATS sends from a domain other than the one its pages live on). Identity
 *   providers are never a site here: a page on sites.google.com must not be able to read a Google
 *   security code.
 * - **Only the code or the link leaves.** Never a body, a subject, another message.
 */

/** Sites that send from one domain and show pages on another, grouped. Extended by config. */
export const DEFAULT_SITE_GROUPS: readonly (readonly string[])[] = [
  ["hellowork.com"],
  ["welcometothejungle.com", "wttj.co"],
  ["myworkdayjobs.com", "myworkday.com", "workday.com"],
  ["greenhouse.io"],
  ["lever.co"],
  ["smartrecruiters.com"],
  ["ashbyhq.com"],
  ["teamtailor.com"],
  ["recruitee.com"],
  ["jobvite.com"],
  ["icims.com"],
  ["successfactors.com", "successfactors.eu", "sapsf.com", "sapsf.eu"],
  ["taleo.net"],
  ["tzportal.io"],
  ["jobteaser.com"],
  ["apec.fr"],
  ["francetravail.fr", "pole-emploi.fr"],
  ["indeed.com", "indeed.fr", "indeedemail.com"],
  ["linkedin.com"],
];

/**
 * Never a site for this tool, whatever the page: accounts whose codes open everything else, and
 * domains where anyone can host a page. A code from them is for a human to read.
 */
const NEVER_SITES = [
  "google.com", "google.fr", "gmail.com", "googlemail.com", "youtube.com",
  "microsoft.com", "microsoftonline.com", "live.com", "outlook.com", "office.com", "office365.com",
  "apple.com", "icloud.com", "amazon.com", "amazon.fr", "paypal.com", "github.com", "gitlab.com",
  "facebook.com", "instagram.com", "x.com", "twitter.com", "yahoo.com", "proton.me", "protonmail.com",
  "kssimi.fr",
];

/** Plain one-label public suffixes: under them the last two labels are the registrable domain. */
const PLAIN_TLDS = new Set([
  "com", "fr", "io", "co", "net", "org", "de", "eu", "ai", "app", "dev", "tech", "jobs", "careers", "hr", "be", "ch", "es", "it", "nl",
]);

function matches(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** The registrable domain of a host under a plain TLD, or nothing when the TLD is not one we can read safely. */
function plainSite(host: string): string | undefined {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2 || !PLAIN_TLDS.has(labels[labels.length - 1]!)) return undefined;
  return labels.slice(-2).join(".");
}

export interface SitePolicy {
  groups: readonly (readonly string[])[];
}

/** The sites a sender may be for this page, empty when the page is not one this tool serves. */
export function sitesForPage(pageHost: string, policy: SitePolicy): string[] {
  const host = pageHost.toLowerCase();
  if (NEVER_SITES.some((site) => matches(host, site))) return [];
  const sites = new Set<string>();
  for (const group of policy.groups) {
    if (group.some((site) => matches(host, site))) for (const site of group) sites.add(site);
  }
  const own = plainSite(host);
  if (own) sites.add(own);
  return [...sites];
}

export function senderAllowed(senderDomain: string, sites: readonly string[]): boolean {
  const domain = senderDomain.toLowerCase();
  if (NEVER_SITES.some((site) => matches(domain, site))) return false;
  return sites.some((site) => matches(domain, site));
}

const CODE_HINT = /\b(code|otp|pin|v[ée]rification|verification|confirm|confirmation|s[ée]curit[ée]|security|passcode|one[- ]time|usage unique|connexion|login|sign[- ]in)\b/i;
const LINK_HINT = /(verif|confirm|activat|validat|magic|token|login|signin|sign-in|auth|reset|email-link|e-mail)/i;

function stripHtml(html: string): { text: string; hrefs: string[] } {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  return { text, hrefs };
}

/**
 * The code a mail carries: a group of 4 to 8 digits (spaces or a dash inside allowed, as "123 456"
 * is often written) on a line that says it is a code, or next to one. A mail with no such line
 * yields nothing rather than a guess: a phone number or an order number is not a code.
 */
export function findCode(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const near = [lines[i - 1] ?? "", lines[i]!].join(" ");
    if (!CODE_HINT.test(near)) continue;
    for (const match of lines[i]!.matchAll(/(?<![\d.,/:+-])(\d{3,4}[ -]?\d{3,4}|\d{4,8})(?![\d.,/:-])/g)) {
      const digits = match[1]!.replace(/[ -]/g, "");
      if (digits.length < 4 || digits.length > 8) continue;
      if (/^(19|20)\d{2}$/.test(digits)) continue;
      return digits;
    }
  }
  return undefined;
}

/** The verification link a mail carries, on the site itself only. */
export function findLink(candidates: readonly string[], sites: readonly string[]): string | undefined {
  for (const raw of candidates) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    if (!senderAllowed(url.hostname, sites)) continue;
    if (LINK_HINT.test(url.pathname + url.search)) return url.toString();
  }
  return undefined;
}

export interface MailMessage {
  id: string;
  from: string;
  receivedAt: number;
  text: string;
  html?: string;
}

export interface MailSource {
  /** Messages received since `sinceMs`, from any of the domains, newest first. */
  recent(sinceMs: number, domains: readonly string[]): Promise<MailMessage[]>;
}

export interface VerificationResult {
  code?: string;
  link?: string;
  sender: string;
  receivedAt: number;
}

export function senderDomainOf(from: string): string | undefined {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf("@");
  if (at < 0) return undefined;
  return address.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, "") || undefined;
}

/** The newest code or link a mail from the page's site carries, and nothing else. */
export async function findVerification(
  source: MailSource,
  pageUrl: string,
  sinceMs: number,
  policy: SitePolicy,
): Promise<{ result?: VerificationResult; reason?: string }> {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return { reason: "The current page has no address this tool can read." };
  }
  const sites = sitesForPage(host, policy);
  if (sites.length === 0) {
    return { reason: `Codes from ${host} are not fetched automatically (an account provider, or a site not on the owner's list). Hand over to a human.` };
  }
  const messages = await source.recent(sinceMs, sites);
  for (const message of messages) {
    const domain = senderDomainOf(message.from);
    if (!domain || !senderAllowed(domain, sites)) continue;
    const { text: htmlText, hrefs } = message.html ? stripHtml(message.html) : { text: "", hrefs: [] };
    const text = `${message.text}\n${htmlText}`;
    const code = findCode(text);
    const plainLinks = [...text.matchAll(/https:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    const link = findLink([...hrefs, ...plainLinks], sites);
    if (code || link) {
      return { result: { ...(code ? { code } : {}), ...(link ? { link } : {}), sender: domain, receivedAt: message.receivedAt } };
    }
  }
  return { reason: `No code or verification link from ${sites.join(", ")} in that window yet.` };
}
