#!/usr/bin/env node
/**
 * briefing-mailer — a minimal, send-only MCP server.
 *
 * Exposes exactly one tool, `send_email`, which delivers a message over SMTP
 * from a dedicated Gmail account. Intended to be launched as a local stdio
 * MCP server (see .mcp.json) inside a Claude Code routine's cloud VM.
 *
 * No Gmail API, no OAuth, no inbound HTTP server, no token storage.
 * Credentials come from the environment only and are never logged or surfaced.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Credentials — read from the environment ONLY, validated at startup.
// ---------------------------------------------------------------------------

const GMAIL_ADDRESS = process.env.GMAIL_ADDRESS;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const missing: string[] = [];
if (!GMAIL_ADDRESS) missing.push("GMAIL_ADDRESS");
if (!GMAIL_APP_PASSWORD) missing.push("GMAIL_APP_PASSWORD");

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
const APP_PASSWORD: string = GMAIL_APP_PASSWORD!;

// ---------------------------------------------------------------------------
// Error helpers — never leak credentials in any output.
// ---------------------------------------------------------------------------

/**
 * Strip any accidental occurrence of the credentials from a string. Defense in
 * depth: even sanitized reasons run through this before they leave the process.
 */
function redact(text: string): string {
  let out = text;
  if (FROM_ADDRESS) out = out.split(FROM_ADDRESS).join("[REDACTED]");
  if (APP_PASSWORD) out = out.split(APP_PASSWORD).join("[REDACTED]");
  return out;
}

/**
 * Map a nodemailer/SMTP failure to a clear, credential-free reason. We use the
 * structured error code rather than passing the raw library message through.
 */
function describeSendError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number } | undefined;
  const code = e?.code;

  switch (code) {
    case "EAUTH":
      return "SMTP authentication failed (check GMAIL_ADDRESS and GMAIL_APP_PASSWORD)";
    case "ECONNECTION":
    case "ESOCKET":
      return "SMTP connection refused or blocked (smtp.gmail.com:587 unreachable — the egress proxy may block SMTP; check network allow-list)";
    case "ETIMEDOUT":
    case "ETIME":
      return "SMTP connection timed out (smtp.gmail.com:587 unreachable — the egress proxy may block SMTP; check network allow-list)";
    case "EDNS":
      return "SMTP host could not be resolved (DNS lookup for smtp.gmail.com failed)";
    case "EENVELOPE":
      return "SMTP rejected the message envelope (check the recipient address)";
    case "EMESSAGE":
      return "SMTP rejected the message content";
    default:
      if (typeof e?.responseCode === "number") {
        return `SMTP send failed with response code ${e.responseCode}`;
      }
      return "SMTP send failed for an unknown reason";
  }
}

// ---------------------------------------------------------------------------
// SMTP transport — Gmail over SSL on port 465.
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // upgrade to TLS via STARTTLS
  requireTLS: true, // never send credentials in the clear
  auth: {
    user: FROM_ADDRESS,
    pass: APP_PASSWORD,
  },
  // Fail fast instead of hanging ~60s when the egress proxy blocks SMTP.
  connectionTimeout: 15000, // TCP establish
  greetingTimeout: 10000, // wait for server greeting
  socketTimeout: 20000, // inactivity
});

// ---------------------------------------------------------------------------
// MCP server — exactly one tool.
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "briefing-mailer",
  version: "1.0.0",
});

server.tool(
  "send_email",
  "Send a single email from the configured Gmail account over SMTP. Returns success, or throws an error (with the credentials redacted) if delivery fails.",
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
      const info = await transporter.sendMail({
        from: FROM_ADDRESS,
        to,
        ...(cc ? { cc } : {}),
        subject,
        text: body,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Email sent to ${to}${cc ? ` (cc: ${cc})` : ""} (messageId: ${info.messageId}).`,
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
  console.error("[briefing-mailer] stdio MCP server ready.");
}

main().catch((err) => {
  console.error(
    `[briefing-mailer] Fatal error: ${redact(
      err instanceof Error ? err.message : String(err)
    )}`
  );
  process.exit(1);
});
