#!/usr/bin/env node
/**
 * One-time helper to mint a Gmail refresh token for briefing-mailer.
 *
 * This is a LOCAL DEV utility — it is not part of the MCP server and is never
 * run on the routine VM. Run it once on your own machine (with a browser) to
 * obtain GMAIL_REFRESH_TOKEN, then set that value as an environment variable.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
 *   GOOGLE_CLIENT_SECRET=... \
 *   node scripts/get-refresh-token.mjs
 *
 * Requirements:
 *   - An OAuth client of type "Desktop app" in Google Cloud Console
 *     (Desktop clients permit the http://localhost loopback redirect used here).
 *   - The Gmail API enabled on that project.
 *   - Your sender account added as a Test user on the OAuth consent screen
 *     (while the app is in "Testing").
 */

import http from "node:http";
import { OAuth2Client } from "google-auth-library";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first."
  );
  process.exit(1);
}

const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

const oauth2 = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token to be returned
  scope: [SCOPE],
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Missing authorization code.");
      return;
    }

    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Done. You can close this tab and return to the terminal.");

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token returned. Revoke the app's access at " +
          "https://myaccount.google.com/permissions and run this again."
      );
    } else {
      console.log("\nGMAIL_REFRESH_TOKEN=" + tokens.refresh_token);
      console.log(
        "\nSet that as an environment variable (do not commit it)."
      );
    }
    server.close();
    process.exit(tokens.refresh_token ? 0 : 1);
  } catch (err) {
    res.writeHead(500).end("Error exchanging code.");
    console.error("Failed to exchange code:", err?.message ?? err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and grant access:\n");
  console.log(authUrl + "\n");
  console.log(`Waiting for the redirect on ${REDIRECT_URI} ...`);
});
