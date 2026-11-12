// Render the README teaser through the real message renderer.
//
// The screenshot in docs/images/ must never be a mock: it is this HTML, produced by
// `renderMessage` - the same function the mailer calls - with a mail-client frame around it.
// Regenerate after changing the renderer:
//
//   node --experimental-strip-types scripts/render-teaser.ts     # writes /tmp/teaser.html
//   open /tmp/teaser.html, 820 px wide, screenshot at 2x        # save as docs/images/notification.png
//
// `root` points at a scratch directory holding build.log, so the attachment line renders the
// way a real notification's does.
import { writeFileSync } from "node:fs"
import { renderMessage } from "../src/core/html.ts"

const body = `## Fix is in, one decision needed

The failing test passes now, and the migration is written. I stopped before touching
production because the rollback path is ambiguous.

**What I changed**

- \`src/auth/session.ts\` — refresh tokens are rotated instead of reused
- \`test/session.test.ts\` — two cases for the reuse window
- added \`docs/migration.md\`

**The question**

Should the migration run automatically on deploy, or wait for a manual step?

> Recommendation: wait for a manual step this week — the queue drain takes ~40 minutes,
> and a failed deploy would leave sessions signed out.

[the full log](./build.log)
`

import { mkdirSync, writeFileSync as wf } from "node:fs"
mkdirSync("/tmp/teaser-root", { recursive: true })
wf("/tmp/teaser-root/build.log", "line 1: compiling\nline 2: 412 tests, 412 pass\n")
const rendered = renderMessage(body, { root: "/tmp/teaser-root" })
const html = `<!doctype html><meta charset="utf-8">
<div style="background:#eef1f5;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #dfe3e8;border-radius:10px;overflow:hidden">
    <div style="padding:16px 22px;border-bottom:1px solid #eceff3;background:#fafbfc">
      <div style="font-size:13px;color:#5b6673">pi-mailbridge &lt;pi@example.com&gt;</div>
      <div style="font-size:17px;font-weight:600;color:#1c2530;margin-top:4px">[pi:f913c9] pi: fix-login @ dev-box-7 is waiting for you</div>
      <div style="font-size:12px;color:#7b8794;margin-top:4px">to you@example.com</div>
    </div>
    <div style="padding:20px 22px">${rendered.html}</div>
    <div style="padding:14px 22px;border-top:1px solid #eceff3;background:#fafbfc;font-size:12px;color:#5b6673">
      device: dev-box-7 &nbsp;·&nbsp; session: fix-login &nbsp;·&nbsp; turns: 3<br>
      Reply above this line to continue the session.
    </div>
  </div>
</div>`
writeFileSync("/tmp/teaser.html", html)
console.log("wrote /tmp/teaser.html with", rendered.attachments.length, "attachment(s)")
