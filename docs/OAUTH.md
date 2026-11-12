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

### Your three options

**A. Switch the pi mailbox to Gmail (recommended).** Google Cloud has no tenant
concept — any Google account can create an OAuth client, free, in about two
minutes:

```
/mailbridge setup pi-yourname@gmail.com to you@hotmail.com force
```

`--setup` discovers `imap.gmail.com` / `smtp.gmail.com` and attaches the Google
preset automatically. This also dodges a second, independent problem: personal
`outlook.com` mailboxes frequently refuse IMAP/SMTP OAuth2 at the server (see the
caveat below). Two obstacles replaced by zero.

**B. Get a free Entra tenant for the Hotmail account.** Sign up for a free Azure
account with that MSA; Microsoft creates a default directory where you are global
admin, and app registration then works there. Honest caveats: signup usually asks
for a card or phone verification, and some new personal accounts are refused
outright — it is the step people most often get stuck on.

**C. Use a tenant you already have.** If you have a work/school account with an
Entra tenant, register the app there instead. Set *Supported account types* to
include **personal Microsoft accounts**, and the device flow will still accept the
Hotmail identity. Remember **Allow public client flows → Yes**.

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
