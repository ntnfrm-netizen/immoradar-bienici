// netlify/functions/scan-bienici.mts
// ────────────────────────────────────────────────────────────────────
// Scheduled Function — s'exécute toutes les 15 minutes via Netlify Cron.
//
// 1. S'authentifie sur Gmail (OAuth refresh token)
// 2. Cherche les emails Bien'ici des dernières 24h
// 3. Ignore les emails DÉJÀ traités (mémorisés dans le snapshot) — c'est
//    ce qui évite de cramer le quota Gemini en re-traitant les mêmes mails
// 4. Pour chaque email NOUVEAU, appelle Gemini Flash pour extraire les annonces
// 5. Filtre sur les 4 communes cibles (Sceaux, BLR, Châtenay, Fontenay)
// 6. Merge avec le JSON existant dans Netlify Blobs (dédup par lien)
// 7. Écrit le résultat (+ la liste des emails traités) dans le store "listings"
// ────────────────────────────────────────────────────────────────────

import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { google } from "googleapis";
import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";

// ─── Constantes métier ──────────────────────────────────────────────
const TARGET_COMMUNES = [
  "Sceaux",
  "Bourg-la-Reine",
  "Châtenay-Malabry",
  "Fontenay-aux-Roses",
];

const COMMUNE_NORMALIZE: Record<string, string> = {
  "sceaux": "Sceaux",
  "bourg la reine": "Bourg-la-Reine",
  "bourg-la-reine": "Bourg-la-Reine",
  "blr": "Bourg-la-Reine",
  "chatenay malabry": "Châtenay-Malabry",
  "chatenay-malabry": "Châtenay-Malabry",
  "châtenay-malabry": "Châtenay-Malabry",
  "châtenay malabry": "Châtenay-Malabry",
  "fontenay aux roses": "Fontenay-aux-Roses",
  "fontenay-aux-roses": "Fontenay-aux-Roses",
};

// Query Gmail : emails de N'IMPORTE QUEL expéditeur Bien'ici sur les 7 derniers
// jours. Bien'ici utilise plusieurs adresses (no_reply@, alertes@, ...) selon
// le type d'email — `from:bienici.com` capture tout. Fenêtre 7j = sécurité (un
// scan manqué ne fait rien perdre) ; les emails déjà traités sont de toute
// façon ignorés via processedEmailIds.
const GMAIL_QUERY = "from:bienici.com newer_than:7d";

// Plafond d'emails traités par exécution. Gmail renvoie les emails du plus
// récent au plus ancien → on traite les nouveaux en priorité (réactivité),
// le surplus est repris au scan suivant (dans 15 min). Borne la durée
// d'exécution et lisse la charge.
const MAX_EMAILS_PER_RUN = 10;

// Lecture d'une variable d'env, nettoyée des espaces et guillemets parasites
// (évite les erreurs invalid_client dues à un copier-coller imparfait)
function env(name: string): string {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

// ID stable et unique d'une annonce, dérivé d'un hash du lien Bien'ici.
// (un simple slice du lien encodé donnait des IDs identiques car tous les
//  liens Bien'ici partagent le même préfixe https://www.bienici.com/...)
function listingId(lien: string): string {
  return `bi_${createHash("sha1").update(lien).digest("base64url").slice(0, 16)}`;
}

// ─── Types ──────────────────────────────────────────────────────────
type Listing = {
  id: string;
  type: "Appartement" | "Maison" | "Autre";
  commune: string;
  quartier: string; // quartier/secteur si l'email le mentionne, sinon ""
  adresse: string;
  indiceLocalisation: string; // indices libres : "proche parc", "rue X", métro…
  prix: number;
  surface: number;
  pieces: number;
  lien: string;
  emailDate: string; // ISO
  ingestedAt: string; // ISO
  source: "bienici-gmail";
};

type Snapshot = {
  updatedAt: string;
  listings: Listing[];
  // IDs des emails Gmail déjà passés par Gemini — pour ne jamais les retraiter
  processedEmailIds?: string[];
};

// ─── Helpers ────────────────────────────────────────────────────────
function normalizeCommune(raw: string): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (COMMUNE_NORMALIZE[k]) return COMMUNE_NORMALIZE[k];
  // Match par préfixe (gère les codes postaux genre "92330 Sceaux")
  for (const [key, val] of Object.entries(COMMUNE_NORMALIZE)) {
    if (k.includes(key)) return val;
  }
  return null;
}

function decodeBody(part: any): string {
  if (!part) return "";
  // Cas direct
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  // Cas multipart : on cherche text/html ou text/plain en priorité
  if (part.parts) {
    const html = part.parts.find((p: any) => p.mimeType === "text/html");
    if (html) return decodeBody(html);
    const plain = part.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain) return decodeBody(plain);
    // Sinon on essaye récursivement
    for (const p of part.parts) {
      const content = decodeBody(p);
      if (content) return content;
    }
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Prompt Gemini : extraction structurée ──────────────────────────
const GEMINI_PROMPT = `Tu es un extracteur d'annonces immobilières. On te donne le contenu textuel d'un email d'alerte Bien'ici reçu par un agent immobilier qui fait de la prospection.

Renvoie UNIQUEMENT un JSON valide (sans markdown, sans \`\`\`) de cette forme :

{
  "annonces": [
    {
      "type": "Appartement" | "Maison" | "Autre",
      "commune": "Sceaux" | "Bourg-la-Reine" | "Châtenay-Malabry" | "Fontenay-aux-Roses" | "<autre commune>",
      "quartier": "<nom du quartier ou secteur si mentionné quelque part dans l'email, sinon \\"\\">",
      "adresse": "<l'adresse la plus précise trouvée : si une rue est citée dans le titre ou la description, mets-la ; sinon code postal + ville>",
      "indiceLocalisation": "<TOUT indice de localisation présent dans le texte : nom de rue, point de repère ('proche du parc de Sceaux', 'à 5 min du RER'), station de métro/RER, lieu-dit. Sinon \\"\\">",
      "prix": <entier en euros, sans espaces ni symbole>,
      "surface": <entier en m², 0 si inconnu>,
      "pieces": <entier, 0 si inconnu>,
      "lien": "<URL complète vers l'annonce Bien'ici>"
    }
  ]
}

Règles :
- IMPORTANT : cherche activement les indices de localisation dans TOUT le texte (titre, description, légendes). Pour la prospection, le quartier et la rue sont l'information la plus précieuse — ne les rate pas.
- Si l'email contient plusieurs annonces, renvoie-les toutes dans le tableau.
- Si une annonce ne contient ni prix ni lien, ignore-la (ne la renvoie pas).
- Les liens doivent commencer par https://www.bienici.com/.
- N'invente jamais une localisation : si l'info n'est pas dans le texte, mets une chaîne vide.
- Si l'email ne contient AUCUNE annonce exploitable, renvoie { "annonces": [] }.
- Réponds STRICTEMENT en JSON, aucun texte avant ou après.

Contenu de l'email :
---
`;

async function extractWithGemini(emailText: string): Promise<any[]> {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY manquante");

  const ai = new GoogleGenAI({ apiKey });

  // On tronque pour rester sous la limite de tokens (les emails Bien'ici sont rarement >50k chars)
  const truncated = emailText.slice(0, 60_000);
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: GEMINI_PROMPT + truncated,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });
  const text = result.text ?? "";

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.annonces) ? parsed.annonces : [];
  } catch (e) {
    console.error("Réponse Gemini non-parsable :", text.slice(0, 200));
    return [];
  }
}

// ─── Handler principal ──────────────────────────────────────────────
export default async (req: Request) => {
  const startedAt = Date.now();
  // Mode "?reset=1" : on vide la liste des emails traités pour tout
  // re-scanner. Utile quand on change la logique d'extraction.
  let forceReset = false;
  try {
    forceReset = new URL(req.url).searchParams.get("reset") === "1";
  } catch {
    /* en mode cron, req.url peut être minimal */
  }
  console.log("[scan-bienici] Démarrage scan" + (forceReset ? " (RESET)" : ""));

  try {
    // 1. Auth Gmail OAuth
    const clientId = env("GMAIL_CLIENT_ID");
    const clientSecret = env("GMAIL_CLIENT_SECRET");
    const refreshToken = env("GMAIL_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Variables Gmail manquantes (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN)"
      );
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // 2. Charger le snapshot existant (emails déjà traités + annonces connues)
    const store = getStore("listings");
    const existing = (await store.get("data", { type: "json" })) as Snapshot | null;
    // On régénère l'ID des annonces existantes (corrige d'anciens IDs en doublon)
    // et on garantit la présence des champs récents (rétrocompat)
    const existingListings: Listing[] = (existing?.listings ?? []).map((l) => ({
      ...l,
      id: listingId(l.lien),
      quartier: l.quartier ?? "",
      indiceLocalisation: l.indiceLocalisation ?? "",
    }));
    const processedIds = forceReset
      ? new Set<string>()
      : new Set<string>(existing?.processedEmailIds ?? []);

    // 3. Liste des messages récents
    const list = await gmail.users.messages.list({
      userId: "me",
      q: GMAIL_QUERY,
      maxResults: 50,
    });

    const messages = list.data.messages ?? [];
    console.log(`[scan-bienici] ${messages.length} email(s) trouvé(s)`);

    // 4. Pour chaque email NON ENCORE TRAITÉ, extraire les annonces avec Gemini
    //    en PARALLÈLE (jusqu'à MAX_EMAILS_PER_RUN, les plus récents d'abord).
    //    Le séquentiel cumulait les latences Gemini et dépassait le timeout
    //    HTTP (30 s) de Netlify avant de pouvoir sauvegarder.
    const newListings: Listing[] = [];
    const newlyProcessed: string[] = [];
    let skipped = 0;

    // Pré-sélection des emails à traiter ce run
    const toProcess: typeof messages = [];
    for (const m of messages) {
      if (!m.id) continue;
      if (processedIds.has(m.id)) {
        skipped++;
        continue;
      }
      if (toProcess.length >= MAX_EMAILS_PER_RUN) break;
      toProcess.push(m);
    }

    // Timeout par appel Gemini : un appel lent ne bloque pas tout le run
    const PER_EMAIL_TIMEOUT_MS = 14_000;

    // Traitement parallèle
    const results = await Promise.allSettled(
      toProcess.map(async (m) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "full",
        });
        const emailDate = new Date(
          parseInt(msg.data.internalDate ?? `${Date.now()}`)
        ).toISOString();
        const rawBody = decodeBody(msg.data.payload);
        if (!rawBody) {
          console.warn(`[scan-bienici] Email ${m.id} : body vide`);
          return { annonces: [] as any[], emailDate };
        }
        const text = stripHtml(rawBody);
        // Course Gemini vs timeout : si Gemini traîne, on lève
        const annonces = (await Promise.race([
          extractWithGemini(text),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Gemini timeout (>14s)")),
              PER_EMAIL_TIMEOUT_MS
            )
          ),
        ])) as any[];
        return { annonces, emailDate };
      })
    );

    // Récolte des résultats
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const m = toProcess[i];
      if (r.status === "fulfilled") {
        const { annonces, emailDate } = r.value;
        for (const a of annonces) {
          // Validation URL : on accepte tout sous-domaine bienici.com
          // (www., link., email., m., etc.) — certains emails utilisent
          // des liens de tracking qui ne pointent pas directement sur www.
          if (!a.lien) continue;
          let host = "";
          try { host = new URL(a.lien).hostname.toLowerCase(); } catch { continue; }
          if (host !== "bienici.com" && !host.endsWith(".bienici.com")) continue;
          if (!a.prix || a.prix <= 0) continue;
          const commune = normalizeCommune(a.commune ?? "");
          if (!commune || !TARGET_COMMUNES.includes(commune)) continue;
          if (newListings.find((n) => n.lien === a.lien)) continue;
          newListings.push({
            id: listingId(a.lien),
            type:
              a.type === "Maison" || a.type === "Appartement" ? a.type : "Autre",
            commune,
            quartier: String(a.quartier ?? "").trim(),
            adresse: String(a.adresse ?? "").trim() || `${commune}`,
            indiceLocalisation: String(a.indiceLocalisation ?? "").trim(),
            prix: parseInt(`${a.prix}`) || 0,
            surface: parseInt(`${a.surface}`) || 0,
            pieces: parseInt(`${a.pieces}`) || 0,
            lien: a.lien,
            emailDate,
            ingestedAt: new Date().toISOString(),
            source: "bienici-gmail",
          });
        }
        newlyProcessed.push(m.id!);
      } else {
        console.error(`[scan-bienici] Erreur message ${m.id} :`, r.reason);
      }
    }
    const attempted = toProcess.length;

    const remaining = Math.max(0, messages.length - skipped - attempted);
    console.log(
      `[scan-bienici] ${messages.length} trouvé(s) · ${skipped} déjà fait(s) · ${newlyProcessed.length} traité(s) ce scan · ${remaining} en attente · ${newListings.length} nouvelle(s) annonce(s)`
    );

    // 5. Merge : les annonces fraîchement extraites priment sur les anciennes
    //    (une ré-extraction met à jour les données — ex : ajout du quartier)
    const freshLinks = new Set(newListings.map((n) => n.lien));
    const merged: Listing[] = [
      ...newListings,
      ...existingListings.filter((l) => !freshLinks.has(l.lien)),
    ];
    merged.sort(
      (a, b) =>
        new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime()
    );
    const trimmed = merged.slice(0, 150);

    // 6. Liste des emails traités (anciens + nouveaux), limitée aux 300 plus récents
    const allProcessed = [...processedIds, ...newlyProcessed].slice(-300);

    // 7. Écriture du snapshot
    const snapshot: Snapshot = {
      updatedAt: new Date().toISOString(),
      listings: trimmed,
      processedEmailIds: allProcessed,
    };
    await store.setJSON("data", snapshot);

    const ms = Date.now() - startedAt;
    return new Response(
      `OK · ${newlyProcessed.length} email(s) traité(s) · ${remaining} en attente · ${newListings.length} nouvelles · ${trimmed.length} au total · ${ms}ms`,
      { status: 200 }
    );
  } catch (err) {
    console.error("[scan-bienici] Erreur fatale :", err);
    return new Response(`ERROR : ${(err as Error).message}`, { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
