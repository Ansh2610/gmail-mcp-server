# briefing-mailer

A minimal, **send-only** [MCP](https://modelcontextprotocol.io) server with a
single tool. Built for one job: a daily Claude Code routine emails a briefing
from a dedicated Gmail account to your inbox.

- Local **stdio** MCP server (no inbound HTTP, no remote endpoint).
- One tool: `send_email(to, subject, body, cc?)`.
- Sends via the **Gmail API over HTTPS** (`gmail.googleapis.com`, port 443)
  using OAuth2 — no SMTP, no token storage on disk, no inbox access (the
  `gmail.send` scope only allows sending).

> **Why the Gmail API and not SMTP?** This runs in a cloud VM whose egress proxy
> blocks **all raw SMTP** (both 587 and 465 time out) while allowing HTTPS/443.
> The Gmail API send path goes over HTTPS, so it works where SMTP cannot. The
> Gmail API requires OAuth2 — it does not accept Gmail App Passwords.

## The tool

```
send_email(to: string, subject: string, body: string, cc?: string) -> success | error
```

- `cc` is optional; comma-separate multiple addresses (`"a@x.com, b@y.com"`).

On failure (bad/expired token, permission, network block, rejected recipient) it
throws a clear MCP error so the routine run is marked **FAILED** rather than
silently "complete". The error states the reason (e.g.
`OAuth refresh token is invalid, expired, or revoked`) but credentials are never
logged, written to disk, or included in any output.

## Environment variables

All four are **required**. The server reads them from the environment only and
exits non-zero with a clear message at startup if any is missing.

| Variable               | What it is                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- |
| `GMAIL_ADDRESS`        | The dedicated Gmail account the briefing is sent **from** (used as `From`).      |
| `GOOGLE_CLIENT_ID`     | OAuth2 client ID (Google Cloud Console, client type **Desktop app**).           |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret for that client.                                           |
| `GMAIL_REFRESH_TOKEN`  | Long-lived refresh token for the sender account with the `gmail.send` scope.     |

### One-time setup to get these

1. In **Google Cloud Console**: create (or pick) a project, **enable the Gmail
   API**, and on the **OAuth consent screen** add your sender account as a
   **Test user**.
2. Create an **OAuth client ID** of type **Desktop app**. Copy its client ID and
   secret → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. Mint the refresh token once, locally (opens a browser for consent):

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
   GOOGLE_CLIENT_SECRET=... \
   npm run get-token
   ```

   Grant access as the sender account; the script prints
   `GMAIL_REFRESH_TOKEN=...`. Copy that value → `GMAIL_REFRESH_TOKEN`.

Keep `GOOGLE_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` secret — never commit them.

## Install & build

```bash
npm install
npm run build
```

## Quick local test

Confirm a send works before deploying — this runs a one-shot MCP `tools/call`
over stdio and sends a real test email to yourself:

```bash
GMAIL_ADDRESS=you@gmail.com \
GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=... \
GMAIL_REFRESH_TOKEN=... \
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name send_email \
  --tool-arg to=you@gmail.com \
  --tool-arg subject="briefing-mailer test" \
  --tool-arg body="If you can read this, the Gmail API send works."
```

A successful run prints `Email sent to ...`; a failure prints the sanitized
reason and exits non-zero. (Check the inbox of `to=` to confirm delivery.)

## Use in a routine

The repo ships a `.mcp.json` registering this as a stdio server named
`briefing-mailer`, passing the env vars through from the environment:

```json
{
  "mcpServers": {
    "briefing-mailer": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "GMAIL_ADDRESS": "${GMAIL_ADDRESS}",
        "GOOGLE_CLIENT_ID": "${GOOGLE_CLIENT_ID}",
        "GOOGLE_CLIENT_SECRET": "${GOOGLE_CLIENT_SECRET}",
        "GMAIL_REFRESH_TOKEN": "${GMAIL_REFRESH_TOKEN}"
      }
    }
  }
}
```

Set the four vars in the routine's environment (as secrets) — never put real
values in `.mcp.json`. Make sure `npm install && npm run build` runs in the VM
before the server is launched so `dist/index.js` exists.

## Network allow-list

Outbound **HTTPS to `gmail.googleapis.com` on port `443`** must be permitted
(plus `oauth2.googleapis.com:443`, used to refresh the access token). No raw SMTP
is used, so SMTP ports do **not** need allow-listing. DNS resolution of those
hosts must also be reachable.
