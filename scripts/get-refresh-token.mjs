#!/usr/bin/env node
// scripts/get-refresh-token.mjs
// ─────────────────────────────────────────────────────────
// Script utilitaire à exécuter UNE seule fois en local pour
// obtenir le GMAIL_REFRESH_TOKEN qui sera ensuite copié dans
// les variables d'environnement Netlify.
//
// Usage :
//   1. Renseigner GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET dans .env
//   2. node scripts/get-refresh-token.mjs
//   3. Ouvrir l'URL affichée dans le navigateur, autoriser
//   4. Copier le code "4/..." dans la console
//   5. Le refresh_token s'affiche : à coller dans Netlify
// ─────────────────────────────────────────────────────────

import { google } from "googleapis";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";

// Lecture simple du .env (sans dotenv pour éviter une dep)
try {
  const env = readFileSync(".env", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* pas grave, peut-être qu'on est en CI */
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ GMAIL_CLIENT_ID et GMAIL_CLIENT_SECRET requis dans .env");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob" // Flow OOB (manuel, pour Desktop)
);

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force la génération du refresh_token
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
});

console.log("\n🔑  Autorise l'accès Gmail en ouvrant cette URL :\n");
console.log(url);
console.log("");

const rl = readline.createInterface({ input, output });
const code = await rl.question("Colle ici le code obtenu : ");
rl.close();

try {
  const { tokens } = await oauth2.getToken(code.trim());
  console.log("\n✅ Tokens obtenus :\n");
  console.log("GMAIL_REFRESH_TOKEN=" + tokens.refresh_token);
  console.log("\n→ Copie cette ligne dans Netlify : Site settings → Environment variables");
} catch (err) {
  console.error("\n❌ Erreur :", err.message);
  process.exit(1);
}
