#!/usr/bin/env node
/**
 * briefing-mailer — a minimal, send-only MCP server.
 *
 * Exposes exactly one tool, `send_email`, which delivers a message from a
 * dedicated Gmail account using the Gmail REST API over HTTPS (port 443).
 * Intended to be launched as a local stdio MCP server (see .mcp.json) inside a
 * Claude Code routine's cloud VM whose egress proxy blocks raw SMTP but allows
 * HTTPS.
 *
 * No SMTP, no inbound HTTP server, no token storage on disk. Credentials come
 * from the environment only and are never logged or surfaced.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Credentials — read from the environment ONLY, validated at startup.
// ---------------------------------------------------------------------------

const GMAIL_ADDRESS = process.env.GMAIL_ADDRESS;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

const missing: string[] = [];
if (!GMAIL_ADDRESS) missing.push("GMAIL_ADDRESS");
if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
if (!GMAIL_REFRESH_TOKEN) missing.push("GMAIL_REFRESH_TOKEN");

if (missing.length > 0) {
  // Fail fast so a misconfigured routine run shows FAILED, not a silent no-op.
  // We name the missing vars but never echo any value.
  console.error(
    `[briefing-mailer] Missing required environment variable(s): ${missing.join(
      ", "
    )}. Set them before starting the server.`
  );
  process.exit(1);
}

// Narrowed to string after the guard above.
const FROM_ADDRESS: string = GMAIL_ADDRESS!;
const CLIENT_ID: string = GOOGLE_CLIENT_ID!;
const CLIENT_SECRET: string = GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN: string = GMAIL_REFRESH_TOKEN!;

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// ---------------------------------------------------------------------------
// Error helpers — never leak credentials in any output.
// ---------------------------------------------------------------------------

/**
 * Strip any accidental occurrence of secrets from a string. Defense in depth:
 * even sanitized reasons run through this before they leave the process.
 */
function redact(text: string): string {
  let out = text;
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  // Belt-and-braces: scrub anything that looks like a bearer/access token.
  out = out.replace(/ya29\.[A-Za-z0-9_\-.]+/g, "[REDACTED]");
  out = out.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  return out;
}

/**
 * Map an OAuth / Gmail API failure to a clear, credential-free reason. We read
 * the structured error rather than passing raw library output through.
 */
function describeSendError(err: unknown): string {
  const e = err as
    | {
        code?: string;
        response?: { status?: number; data?: { error?: unknown } };
      }
    | undefined;

  const apiError = e?.response?.data?.error;

  // OAuth token-endpoint errors return error as a string ("invalid_grant" etc.)
  if (typeof apiError === "string") {
    switch (apiError) {
      case "invalid_grant":
        return "OAuth refresh token is invalid, expired, or revoked (re-mint GMAIL_REFRESH_TOKEN)";
      case "invalid_client":
        return "OAuth client credentials are invalid (check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)";
      case "invalid_scope":
        return "OAuth token is missing the gmail.send scope (re-mint GMAIL_REFRESH_TOKEN with that scope)";
      default:
        return `OAuth error: ${apiError}`;
    }
  }

  // Gmail API errors return error as an object with code/status.
  if (apiError && typeof apiError === "object") {
    const status = (apiError as { code?: number }).code ?? e?.response?.status;
    switch (status) {
      case 401:
        return "Gmail API authorization failed (access token rejected)";
      case 403:
        return "Gmail API permission denied (ensure the Gmail API is enabled and the gmail.send scope was granted)";
      case 400:
        return "Gmail API rejected the request (check the recipient address and message)";
      case 429:
        return "Gmail API rate limit exceeded";
      default:
        return status
          ? `Gmail API send failed with HTTP ${status}`
          : "Gmail API send failed";
    }
  }

  // Transport-level failures.
  switch (e?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Could not resolve gmail.googleapis.com (DNS lookup failed)";
    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "ECONNRESET":
      return "Could not reach gmail.googleapis.com over HTTPS (check network allow-list for port 443)";
    default:
      return "Gmail API send failed for an unknown reason";
  }
}

// ---------------------------------------------------------------------------
// OAuth2 client — exchanges the stored refresh token for access tokens and
// signs Gmail API requests. The access token is refreshed automatically.
// ---------------------------------------------------------------------------

const oauth2 = new OAuth2Client(CLIENT_ID, CLIENT_SECRET);
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

/**
 * Build an RFC 5322 message and base64url-encode it for the Gmail API.
 * Non-ASCII subjects are RFC 2047 encoded; the body is sent as UTF-8.
 */
function buildRawMessage(opts: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}): string {
  const encodeHeader = (value: string): string =>
    // eslint-disable-next-line no-control-regex
    /^[\x00-\x7F]*$/.test(value)
      ? value
      : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;

  const headers = [
    `From: ${FROM_ADDRESS}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];

  const encodedBody = Buffer.from(opts.body, "utf-8").toString("base64");
  const mime = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;

  return Buffer.from(mime, "utf-8").toString("base64url");
}

// ---------------------------------------------------------------------------
// MCP server — exactly one tool.
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "briefing-mailer",
  version: "1.0.0",
});

server.tool(
  "send_email",
  "Send a single email from the configured Gmail account via the Gmail API (HTTPS). Returns success, or throws an error (with credentials redacted) if delivery fails.",
  {
    to: z.string().email().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain-text email body"),
    cc: z
      .string()
      .optional()
      .describe(
        "Optional CC recipient(s). Comma-separate multiple addresses (e.g. 'a@x.com, b@y.com')."
      ),
  },
  async ({ to, subject, body, cc }) => {
    try {
      const raw = buildRawMessage({ to, cc, subject, body });

      const res = await oauth2.request<{ id?: string }>({
        url: GMAIL_SEND_URL,
        method: "POST",
        data: { raw },
      });

      const id = res.data?.id ?? "unknown";
      return {
        content: [
          {
            type: "text" as const,
            text: `Email sent to ${to}${cc ? ` (cc: ${cc})` : ""} (messageId: ${id}).`,
          },
        ],
      };
    } catch (err) {
      // Throw an MCP error so the routine run is marked FAILED. The reason is
      // sanitized and run through redact() so no credential can ever leak.
      throw new McpError(
        ErrorCode.InternalError,
        redact(describeSendError(err))
      );
    }
  }
);

// ---------------------------------------------------------------------------
// Start over stdio.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the MCP protocol stream.
  console.error("[briefing-mailer] stdio MCP server ready (Gmail API/HTTPS).");
}

main().catch((err) => {
  console.error(
    `[briefing-mailer] Fatal error: ${redact(
      err instanceof Error ? err.message : String(err)
    )}`
  );
  process.exit(1);
});
