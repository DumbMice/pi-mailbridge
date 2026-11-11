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
