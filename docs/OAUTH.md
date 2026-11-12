# OAUTH.md — making Outlook, Microsoft 365 and Gmail work

## The short version

Bad news only for passwords. **OAuth2 works.** Microsoft retired *Basic
Authentication* for `outlook.com`/`hotmail.com` on **2024-09-16**, so an app
password no longer authenticates. The fix is a token, and this package now gets
one for you with a device-code login.

```bash
# 1. once: register an app and paste the client id into config.json
pi-mailbridge --check      # tells you what is missing
# 2. once: approve on any device
pi-mailbridge --auth
# 3. from then on it refreshes itself
```

## One-time app registration

You cannot avoid this step: Microsoft (and Google) require a client id that a
human consented to. It is free and takes about two minutes.

1. Open the [Entra admin center](https://entra.microsoft.com) → **Identity** →
   **Applications** → **App registrations** → **New registration**
2. Name it anything (`pi-mailbridge`)
3. **Supported account types**: pick the one matching your account
   - personal `@outlook.com` / `@hotmail.com` → *…and personal Microsoft accounts*
   - work `@yourcompany.com` → *Accounts in this organizational directory only*
4. **Redirect URI**: leave empty (device code needs none)
5. Register, then copy **Application (client) ID**
6. **Authentication** → *Allow public client flows* → **Yes**
   (device code is a public client flow; without this the request is rejected)
7. **API permissions** → *Add a permission* → *APIs my organization uses* is not
   needed for personal accounts; for work accounts add **Microsoft Graph →
   Delegated → `offline_access`, `IMAP.AccessAsUser.All`, `SMTP.Send`** and grant
   consent

For Gmail: [Google Cloud console](https://console.cloud.google.com) → APIs &
Services → Credentials → *Create OAuth client ID* → **TVs and Limited Input
devices** (that is Google's name for device flow) → enable the Gmail API.

## If Google is unreachable (mainland China)

Gmail is out twice over: no Google access, and phone verification you may not have.
The practical providers there authenticate with an **app-specific code**
(授权码 / authorization code) used as the password — so, like a Gmail app password,
there is no OAuth app, no tenant, and no consent screen:

| Provider | IMAP | SMTP | Notes |
| --- | --- | --- | --- |
| **QQ Mail** (`qq.com`, `foxmail.com`) | `imap.qq.com:993` | `smtp.qq.com:465` | Enable **IMAP/SMTP服务** in 设置 → 账户, then generate a 授权码 |
| **163** (`163.com`) | `imap.163.com:993` | `smtp.163.com:465` | Enable in 设置 → POP3/SMTP/IMAP; requires the IMAP `ID` command, which this client sends automatically |
| **126** (`126.com`) | `imap.126.com:993` | `smtp.126.com:465` | same as 163 |

All three are built into the discovery table, so they resolve even when the
autoconfig service is slow or blocked:

```
/mailbridge setup pi-yourname@qq.com to you@hotmail.com
```

Then paste the 授权码 into both password fields and run `/mailbridge smoke`.

**One thing to watch:** if every reply is rejected with `dmarc-missing`, the
provider is not adding an `Authentication-Results` header. Set
`security.requireDmarcPass: false` — the sender allowlist still applies, so this
loses a defence layer rather than all of them.

## Why can't I log into Entra with my new Hotmail address?

Because it is two different systems:

| | What it is | What it's for |
| --- | --- | --- |
| **Microsoft account (MSA)** | the identity behind `you@hotmail.com` | signing in to Outlook, and the **device-code flow** |
| **Microsoft Entra tenant** | a *directory* that holds app registrations | `entra.microsoft.com`, `portal.azure.com` |

A brand-new Hotmail address has **no tenant**. When you sign in to the Entra
admin centre with it, Microsoft drops you into the shared **"Microsoft Services"
tenant**, where you are not a member — hence "this account does not exist".
Microsoft's own answer says it plainly:

> Within the default tenant, there is no linked directory for administrative
> actions such as app registration.

Nothing is wrong with your mailbox. You just do not have a directory to put an app in.

### Your three options, with the friction measured

|  | Outlook (personal) | Gmail |
| --- | --- | --- |
| **App password** | ⚠️ can still be created; **IMAP rejects it** (SMTP may accept it) | ✅ 16-char passcode, works for both directions |
| **OAuth app needed** | ✅ plus an Entra **tenant** | ✅ plus a GCP project |
| **OAuth friction** | no tenant → "account does not exist" | mail scopes are **restricted**: verification **+ annual CASA** to publish; a consent screen left in **Testing** expires refresh tokens **every 7 days** (`invalid_grant`) |
| **Servers** | sometimes refuse IMAP/SMTP OAuth2 outright | reliable |

That table is the whole argument: **Gmail is easier because of app passwords, not
because of OAuth.** With an app password there is no OAuth app, no tenant, no
verification, and no token that dies weekly.

**A. Gmail + app password (recommended).**

1. Enable **2-Step Verification** on the Google account (required; app passwords
   do not exist without it)
2. <https://myaccount.google.com/apppasswords> → create one → copy the 16 characters
3. Run setup, then paste the passcode into both password fields:

```
/mailbridge setup pi-yourname@gmail.com to you@hotmail.com force
```

`--setup` picks `LOGIN` for Google automatically and attaches no OAuth block, so
there is nothing to register.

**B. Get a free Entra tenant for the Hotmail account.** Signing up for Azure with a
personal Microsoft account creates a **default directory** where you are Global
Administrator, and app registration then works there. Two routes:

*Global Azure free account* — <https://azure.microsoft.com/free/>:

1. Sign in with the pi Hotmail account (not via the Entra admin centre)
2. Complete identity verification (phone) and the profile step; a card is usually
   required as a payment-method check even for the free tier
3. On completion Azure creates the default directory. Sign in to
   <https://entra.microsoft.com> and you should now see it in the directory picker
4. **App registrations → New registration**

*Microsoft 365 Developer Program* — **does not work for a personal account.**
Joining is free, but the E5 sandbox is gated: Microsoft grants it only to

- active **Visual Studio Professional or Enterprise** subscribers
- **ISV Success** program members
- **AI Cloud Partner** program participants
- **Premier or Unified Support** plan members

A personal `@outlook.com`/`@hotmail.com` account that joins the program gets the
learning resources and a Graph tutorial, and **no dashboard option to provision a
sandbox** — eligibility is decided server-side and cannot be requested. If you
joined hoping for a tenant, that route is closed.

So the only remaining way to obtain a tenant for a personal mailbox is the **Azure
free account** above, which is why it asks for a card.

### If you do end up with a work/school tenant

A tenant mailbox is not equivalent to the personal one:

| pi mailbox | Authority | Risk |
| --- | --- | --- |
| `pi-xyz@hotmail.com` (personal) | `consumers/v2.0` | the personal-Outlook IMAP/SMTP refusals below |
| `pi@yourtenant.onmicrosoft.com` (work) | `organizations/v2.0` | tied to the tenant; a sandbox renews every 90 days |

The app must list **personal Microsoft accounts** in its supported account types for
the `consumers` row to work; for the `organizations` row, any tenant member will do.
`--setup` picks the right authority from the address suffix automatically.

> **Do not use Azure China / 21Vianet.** `azure.cn` is a physically and logically
> isolated sovereign cloud with its own identity endpoints
> (`login.partner.microsoftonline.cn`). An app registered in a 21Vianet tenant
> **cannot** authenticate against global Outlook.com — the device flow against
> `login.microsoftonline.com` will fail. You need the global cloud, i.e.
> `azure.microsoft.com` / `login.microsoftonline.com`. `--check` warns if
> `oauth.issuer` points at a sovereign-cloud domain.

> Caveat: if the Microsoft account already belongs to a tenant as a member or
> guest, Azure signup joins that tenant instead of creating a fresh directory.
> A brand-new personal account gets its own.

Whatever tenant holds the app, set **Supported account types** to include *personal Microsoft accounts* so the Hotmail identity can sign in, and
**Allow public client flows → Yes**.

**C. Use a GCP project for Gmail OAuth.** Only worth it if you object to app
passwords. You must either accept **7-day refresh tokens** in Testing status (the
daemon re-authorises weekly) or publish the app — and reading mail needs restricted
scopes, which means verification plus a recurring CASA assessment.

> Trade-off worth naming: Google calls app passwords "not recommended and
> unnecessary in most cases" and could retire them. OAuth is the durable path; this
> package supports both. For a personal mailbox today, the app password is simply
> the one that works without a week of paperwork.

### What the app registration needs, wherever it lives

- **Allow public client flows → Yes** (device code is a public-client flow;
  without it you get `AADSTS7000218: the request body must contain 'client_assertion'`)
- Supported account types including **personal Microsoft accounts**, if the pi
  mailbox is `@hotmail.com`/`@outlook.com`
- No client secret, no redirect URI

## Configuration

```json
{
  "mail": {
    "imap": { "host": "outlook.office365.com", "port": 993, "secure": true,
              "user": "you@outlook.com", "password": "", "authType": "XOAUTH2" },
    "smtp": { "host": "smtp-mail.outlook.com", "port": 587, "secure": false,
              "user": "you@outlook.com", "password": "", "authType": "XOAUTH2" },
    "to": "you@outlook.com"
  },
  "oauth": {
    "issuer": "https://login.microsoftonline.com/consumers/v2.0",
    "clientId": "<application (client) id>",
    "scope": "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
  }
}
```

Presets (`core/oauth-openid.ts`):

| Preset | `issuer` | `scope` |
| --- | --- | --- |
| **Microsoft personal** | `https://login.microsoftonline.com/consumers/v2.0` | `offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send` |
| **Microsoft 365** | `https://login.microsoftonline.com/organizations/v2.0` | same as above |
| **Google** | `https://accounts.google.com` | `https://mail.google.com/ offline_access` |

`offline_access` is not optional — without it the provider returns no refresh
token and you would re-approve every hour. `--check` warns about this.

### Scopes are not interchangeable

Two different worlds, and mixing them is the most common cause of "the token
works but the server rejects it":

- **IMAP/SMTP XOAUTH2** needs `https://outlook.office.com/IMAP.AccessAsUser.All`
  and `https://outlook.office.com/SMTP.Send`
- **Graph API** needs `https://graph.microsoft.com/Mail.Read` / `Mail.Send`

## The login flow

`pi-mailbridge --auth` prints a URL and a code, then waits:

```
Approve this login:
  https://microsoft.com/devicelogin?code=ABCD1234
Code: ABCD1234

Waiting for approval…
```

Approve from **any device** — phone, tablet, the laptop you actually have open.
That is the point of device code: no browser, no redirect listener, no port on the
daemon's machine.

The refresh token is stored in `~/.local/state/pi-mailbridge/oauth.json` at mode
`0600`. Access tokens are cached in memory and refreshed shortly before expiry;
one 401 from the mail server triggers exactly one refresh, then the daemon stops
rather than hammering the provider.

## When IMAP/SMTP OAuth2 still fails

### Enabling IMAP/SMTP in Outlook.com does not restore password login

Worth stating plainly, because it is the obvious thing to try: the toggle
(*Settings → Mail → Forwarding and IMAP → "Let devices and apps use IMAP"*) makes
the **protocols available**. It does not change **authentication**.

Microsoft's own [POP, IMAP and SMTP settings page](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com)
says both things in adjacent sentences:

> POP & IMAP access is **disabled by default**. See the section below on how to
> enable POP or IMAP access in Outlook.com.

> **Outlook.com requires the use of Modern Auth / OAuth2.**

and its settings table lists the authentication method for every protocol:

| Protocol | Server | Authentication Method |
| --- | --- | --- |
| IMAP | `outlook.office365.com:993` | **OAuth2/Modern Auth** |
| POP | `outlook.office365.com:995` | **OAuth2/Modern Auth** |
| SMTP | `smtp-mail.outlook.com:587` | **OAuth2/Modern Auth** |

So enabling the toggle is necessary and not sufficient: it opens the port, and
OAuth2 is still the only way in.

**Why the internet disagrees with itself.** That same page also carries a stale
sentence — *"if your password is not being recognized … you may need an app
password"* — left over from before the shutdown. That sentence is why forum
threads confidently report that app passwords still work. Field reports split on
SMTP specifically (some clients still succeed with an app password, Microsoft's
Q&A said in 2025 that they were disabled, n8n's docs say not to rely on them). For
IMAP there is no ambiguity: **app passwords are not a workaround**.

That is what settles it here, because IMAP is how a reply reaches you. A tool that
could only send would not be this tool.

#### What to actually do about a personal Outlook mailbox

1. **Get an Entra tenant** (free Azure signup) and register the app — the OAuth
   route. Enabling IMAP/SMTP was prerequisite one; the tenant is prerequisite two.
2. **Or use a provider that still takes a password** — Gmail app password, or
   QQ/163 with a 授权码. Both avoid OAuth entirely.

Given the tenant friction *and* the server-side refusal reports below, option 2 is
usually the shorter path.

### The server may refuse a valid token

This is the honest part, and it applies to **personal** `outlook.com` only:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `User is authenticated but not connected` after a successful OAuth2 flow | a server-side IMAP regression for personal accounts reported since Dec 2024 | use the Graph API |
| `535 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox` | SMTP AUTH disabled at the mailbox level, even though IMAP works | use the Graph API |
| Works on IMAP but not SMTP, or vice versa | per-protocol policy | use the Graph API for both |

**The reliable answer for personal Outlook is Graph** (`POST /me/sendMail`,
`GET /me/mailFolders/inbox/messages/delta`) because it never speaks SMTP. It is a
free API, the same OAuth token works, and it needs no extra package — Node 22 has
global `fetch`. It is not implemented in this package yet; see the roadmap note in
the README.

Microsoft 365 (work) accounts usually work fine on IMAP/SMTP XOAUTH2.

## Alternative: a token command

If you already have a token broker, skip the built-in flow:

```json
"authType": "XOAUTH2",
"tokenCommand": ["ortie", "token", "show", "-a", "outlook"]
```

The command is executed as argv (never a shell), its stdout is the token, and the
result is cached until near expiry. A failing command disables OAuth2 for the
session rather than spawning a failing process on every scan.

Precedence: **`oauth.*` beats `tokenCommand`**. Remove the `oauth` block to switch
back.

## Security

- The refresh token is equivalent to your password for mail. It is `0600` inside a
  `0700` directory and is never logged, printed, or included in an email.
- Revoke access at any time: Microsoft **My Account → Privacy → App permissions**
  (or Google **Security → Third-party access**). The stored token then stops
  working and `--auth` is needed again.
- Rotating `secret.key` does **not** revoke OAuth; they are separate secrets.
- Prefer a dedicated mailbox for this package, as with everything else here.
