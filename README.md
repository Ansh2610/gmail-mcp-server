# briefing-mailer

A minimal, **send-only** [MCP](https://modelcontextprotocol.io) server with a
single tool. Built for one job: a daily Claude Code routine emails a briefing
from a dedicated Gmail account to your inbox.

- Local **stdio** MCP server (no HTTP, no remote endpoint).
- One tool: `send_email(to, subject, body)`.
- Sends via **SMTP** (`smtp.gmail.com:587`, STARTTLS) using a Gmail **App Password** —
  no OAuth, no Google API, no token storage, no inbox access.

## The tool

```
send_email(to: string, subject: string, body: string) -> success | error
```

On failure (bad credentials, network/SMTP block, rejected recipient) it throws a
clear MCP error so the routine run is marked **FAILED** rather than silently
"complete". The error states the reason (e.g. `SMTP connection refused`) but the
credentials are never logged, written to disk, or included in any output.

## Environment variables

Both are **required**. The server reads them from the environment only and exits
with a clear message at startup if either is missing.

| Variable             | What it is                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `GMAIL_ADDRESS`      | The dedicated Gmail account the briefing is sent **from**.                 |
| `GMAIL_APP_PASSWORD` | A Gmail **App Password** for that account (not the normal login password). |

Generate an App Password at <https://myaccount.google.com/apppasswords>
(the account needs 2-Step Verification enabled).

## Install & build

```bash
npm install
npm run build
```

## Quick local test

Confirm a send works before deploying — this builds, then runs a one-shot MCP
`tools/call` over stdio and sends a real test email to yourself:

```bash
GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD='your-app-password' \
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name send_email \
  --tool-arg to=you@gmail.com \
  --tool-arg subject="briefing-mailer test" \
  --tool-arg body="If you can read this, SMTP works."
```

A successful run prints `Email sent to ...`; a failure prints the sanitized
reason and exits non-zero. (Check the inbox of `to=` to confirm delivery.)

## Use in a routine

The repo ships a `.mcp.json` registering this as a stdio server named
`briefing-mailer`, passing the two env vars through from the environment:

```json
{
  "mcpServers": {
    "briefing-mailer": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "GMAIL_ADDRESS": "${GMAIL_ADDRESS}",
        "GMAIL_APP_PASSWORD": "${GMAIL_APP_PASSWORD}"
      }
    }
  }
}
```

Set `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` in the routine's environment (as
secrets) — never put real values in `.mcp.json`. Make sure `npm install && npm run build`
runs in the VM before the server is launched so `dist/index.js` exists.

## Network allow-list

Outbound **TCP to `smtp.gmail.com` on port `587`** (STARTTLS) must be permitted.
If your routine runs under a restrictive network policy (e.g. Claude Code on the
web's non-"No network access" policies), add `smtp.gmail.com:587` to the
allow-list — otherwise the send fails fast with `SMTP connection refused`/timed
out. The server makes no other outbound connections. (DNS resolution of
`smtp.gmail.com` must also be reachable.)

> **Note on egress proxies:** allow-listing the *domain* is not always enough.
> Some egress proxies (including some Claude Code on the web network policies)
> only proxy HTTPS/443 and block **all raw SMTP**, on both 587 and 465. If both
> ports time out even though `smtp.gmail.com` is allow-listed, SMTP is being
> blocked at the protocol/port level and you'll need an HTTPS-based send path
> instead (see repo discussion).
