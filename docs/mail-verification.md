# A verification code from the mailbox, for the browser agent

## Why

An application stops at "we sent you a code": HelloWork, WTTJ, an ATS. The browser agent has a
closed toolset on purpose -- it reads untrusted pages all day -- so it had no way to read the code,
and every such flow broke into a round trip with the conversation driving it, inside a validity
window of fifteen minutes. Giving it the mailbox (the gmail skill, `bash`) would put every mail one
prompt injection away from a web page.

`browser_mail_verification` answers one question and nothing else: "the page in front of me sent a
code to the owner's mailbox; what is it?".

## The rules

- **The site is the page's, never the caller's word.** The tool takes the window, like every page
  tool, and reads the URL of the page the agent is on in it. There is no sender argument a page
  could dictate.
- **Sender and page are one site.** A mail counts when its sender and the page are the same site:
  - the same registrable domain under a plain one-label TLD (`.com`, `.fr`, `.io`...): a page on
    `careers.safran-group.com` gets codes from `safran-group.com`. A suffix like `co.uk` is not read
    at all: its last two labels are anybody's, and guessing would let one site read another's codes;
  - or one group of the site list: an ATS sends from a domain other than the one its pages live on
    (Workday: pages on `myworkdayjobs.com`, mail from `myworkday.com`). The built-in groups are in
    `DEFAULT_SITE_GROUPS`; `browser.mailVerification.sites` adds groups.
- **Never a site:** account providers and hosts of anybody's pages -- Google, Microsoft, Apple,
  Amazon, PayPal, GitHub, GitLab, social networks, Proton -- and the owner's own domain. A code from
  them unlocks everything else, and a page on `sites.google.com` must not be able to read a Google
  security code. Those stay a human's job (`needs_human`).
- **Only the code or the link leaves.** The answer is the code (4 to 8 digits, on a line that says it
  is a code, or next to one: a phone or an order number is not guessed), or a `https` link on the
  site itself whose path looks like a verification, plus the sender's domain and the time. Never a
  subject, a body, another message.
- **The newest matching mail**, in the last 15 minutes by default, 60 at most.

Every call is logged (`browser mail verification`: the page's host, the sender, whether a code or a
link was found), never the code or the link.

## The mailbox

Gmail, read through its API with the token the gmail skill set up
(`~/.my-claw/secrets/gmail-token.json`: refresh token, client id and secret). Two read-only calls,
list and get, with a query already narrowed to the site's domains and the time window
(`after:<epoch> from:(a OR b)`); the result is filtered again on the parsed sender. The access token
is kept in memory until it expires and never written back. `src/mail/gmail.ts`.

No token file: the tool says so and tells the agent to keep the window instead
(`browser_done(keep_window=true)`, `docs/browser-windows.md`), so the conversation that sent it can
fetch the code and send it back to the same page.

## Off switch

`browser.mailVerification.enabled: false` makes the tool refuse without reading anything.

## Where it lives

| What | Where |
| --- | --- |
| The rules: sites, code and link extraction | `src/mail/verification.ts` |
| Gmail, read-only | `src/mail/gmail.ts` |
| The tool | `src/tools/browser/mail.ts` |
| Tests | `tests/mail/verification.test.ts` |
