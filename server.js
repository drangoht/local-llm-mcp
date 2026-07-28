#!/usr/bin/env node
/**
 * local-llm-mcp — passerelle MCP entre Claude Code et LM Studio.
 *
 * Principe : les outils lisent les fichiers *cote serveur* et n'renvoient que le
 * resultat du traitement. Le contenu brut ne transite jamais par le contexte cloud,
 * ce qui est l'essentiel de l'economie de quota.
 *
 * Protocole stdio : stdout est reserve au JSON-RPC. Tout log va sur stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fg from "fast-glob";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1";
/**
 * Modele par defaut. Contre-intuitif : le 30B est prefere au petit modele parce
 * que gemma-4-e4b raisonne systematiquement (~85 % de sa production part en
 * reflexion interne, et `content` revient vide si le budget est court), la ou
 * qwen3-coder-30b repond directement. En sortie utile, le 30B est plus rapide.
 * Le garder resident evite aussi un swap VRAM d'environ 16 s a chaque bascule.
 */
const MODEL_CODE = process.env.LOCAL_MODEL_CODE ?? "qwen/qwen3-coder-30b";
/** Modele leger : environ 8 Gio en VRAM. Raisonne toujours — prevoir max_tokens genereux. */
const MODEL_LIGHT = process.env.LOCAL_MODEL_LIGHT ?? "google/gemma-4-e4b";

/** Budget de caracteres par requete. ~3,5 car/token => ~17k tokens, tient dans 32k. */
const CHUNK_CHARS = 60_000;
/** Un fichier plus gros que ca est probablement binaire ou genere. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Le chargement JIT d'un 30B peut prendre ~20 s ; large marge. */
const REQUEST_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS ?? 600_000);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tga",
  ".mp3", ".ogg", ".wav", ".flac", ".mp4", ".mov", ".webm",
  ".zip", ".7z", ".rar", ".gz", ".tar", ".exe", ".dll", ".pdb", ".so", ".dylib",
  ".ttf", ".otf", ".woff", ".woff2", ".pdf", ".blend", ".import", ".gguf",
]);

/**
 * Auto-chargement du modele au demarrage.
 *
 * Necessaire parce que le reglage `defaultContextLength` de LM Studio vaut 4096 :
 * son chargement a la demande (justInTimeModelLoading) ramene donc le modele a
 * 4096 tokens des que le TTL expire ou que l'application redemarre. local_digest
 * casse alors *silencieusement* — reponses tronquees, aucune erreur.
 *
 * Le controle tourne en tache de fond apres la connexion MCP : s'il n'y a rien a
 * faire il ne coute rien, sinon il recharge pendant que la session demarre.
 */
const LMS_CLI =
  process.env.LMS_CLI ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".lmstudio", "bin", "lms.exe");
const REQUIRED_CONTEXT = Number(process.env.LOCAL_CONTEXT ?? 32768);
const AUTOLOAD = process.env.LOCAL_AUTOLOAD !== "0";
const TTL_SECONDS = Number(process.env.LOCAL_TTL_SECONDS ?? 8 * 3600);

/** Racines autorisees, si LOCAL_ALLOWED_ROOTS est defini (separateur `;`). */
const ALLOWED_ROOTS = (process.env.LOCAL_ALLOWED_ROOTS ?? "")
  .split(";")
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => path.resolve(r));

function log(...args) {
  console.error("[local-llm-mcp]", ...args);
}

function resolveModel(alias) {
  if (!alias || alias === "code") return MODEL_CODE;
  if (alias === "light") return MODEL_LIGHT;
  return alias; // identifiant LM Studio explicite
}

/** Modeles actuellement en memoire, via `lms ps --json`. */
async function loadedModels() {
  const { stdout } = await execFileAsync(LMS_CLI, ["ps", "--json"], {
    timeout: 30_000,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

/**
 * Garantit que MODEL_CODE est charge avec au moins REQUIRED_CONTEXT tokens.
 * Ne leve jamais : en cas d'echec on log et on laisse le chargement a la demande
 * de LM Studio faire ce qu'il peut — un serveur MCP degrade vaut mieux qu'un
 * serveur qui refuse de demarrer.
 */
async function ensureModelLoaded() {
  if (!AUTOLOAD) {
    log("auto-chargement desactive (LOCAL_AUTOLOAD=0)");
    return;
  }

  try {
    const models = await loadedModels();
    const current = models.find((m) => m.identifier === MODEL_CODE || m.modelKey === MODEL_CODE);

    if (current && current.contextLength >= REQUIRED_CONTEXT) {
      log(`modele pret : ${MODEL_CODE} @ ${current.contextLength} tokens`);
      return;
    }

    if (current) {
      log(
        `contexte insuffisant (${current.contextLength} < ${REQUIRED_CONTEXT}) — rechargement...`,
      );
    } else {
      log(`${MODEL_CODE} non charge — chargement a ${REQUIRED_CONTEXT} tokens...`);
    }

    // Un seul modele tient en VRAM : liberer avant de recharger.
    await execFileAsync(LMS_CLI, ["unload", "--all"], { timeout: 60_000, windowsHide: true })
      .catch((err) => log("unload : " + err.message));

    const started = Date.now();
    await execFileAsync(
      LMS_CLI,
      ["load", MODEL_CODE, "-c", String(REQUIRED_CONTEXT),
       "--parallel", "1", "--gpu", "max", "--ttl", String(TTL_SECONDS), "-y"],
      { timeout: 300_000, windowsHide: true },
    );
    log(`modele charge en ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    log(
      `auto-chargement impossible (${err.message.split("\n")[0]}). ` +
      `Les outils restent utilisables mais le contexte peut retomber a 4096 : ` +
      `lancer start-local.ps1 manuellement.`,
    );
  }
}

function assertAllowed(absPath) {
  if (ALLOWED_ROOTS.length === 0) return;
  const ok = ALLOWED_ROOTS.some(
    (root) => absPath === root || absPath.startsWith(root + path.sep),
  );
  if (!ok) {
    throw new Error(
      `Chemin hors des racines autorisees (LOCAL_ALLOWED_ROOTS) : ${absPath}`,
    );
  }
}

/** Appel chat/completions sur LM Studio. */
async function chat({ model, system, user, maxTokens = 1200, temperature = 0.2 }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LM Studio ${res.status} : ${detail.slice(0, 500)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0] ?? {};
    const content = (choice.message?.content ?? "").trim();
    const reasoning = (choice.message?.reasoning_content ?? "").trim();
    const finish = choice.finish_reason;

    // Les modeles a raisonnement (gemma-4) peuvent epuiser tout le budget en
    // reflexion interne et renvoyer un `content` vide. Plutot que de remonter
    // une chaine vide silencieuse, on le dit explicitement.
    let text = content;
    if (!text && reasoning) {
      text =
        `[Le modele ${model} a consomme son budget de tokens en raisonnement interne ` +
        `sans produire de reponse finale. Relancer avec un max_tokens plus eleve, ` +
        `ou utiliser model="code" qui ne raisonne pas.]\n\n` +
        `Raisonnement partiel :\n${reasoning.slice(0, 1500)}`;
    }

    return {
      text,
      truncated: finish === "length",
      reasoningChars: reasoning.length,
      usage: json.usage ?? {},
      seconds: (Date.now() - started) / 1000,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Delai depasse (${REQUEST_TIMEOUT_MS / 1000}s). Le modele est-il en cours de chargement ? Verifier : lms ps`,
      );
    }
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `LM Studio injoignable sur ${BASE_URL}. Demarrer le serveur : lms server start`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Resout des patterns (globs ou chemins) en fichiers texte lisibles. */
async function collectFiles(patterns, cwd) {
  const base = path.resolve(cwd ?? process.cwd());
  assertAllowed(base);

  const matches = await fg(patterns, {
    cwd: base,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: [
      "**/node_modules/**", "**/.git/**", "**/bin/**", "**/obj/**",
      "**/dist/**", "**/build/**", "**/.godot/**", "**/__pycache__/**",
    ],
  });

  const files = [];
  const skipped = [];

  for (const abs of matches) {
    try {
      assertAllowed(abs);
      if (BINARY_EXT.has(path.extname(abs).toLowerCase())) {
        skipped.push({ file: abs, reason: "extension binaire" });
        continue;
      }
      const info = await stat(abs);
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ file: abs, reason: `trop volumineux (${Math.round(info.size / 1024)} Ko)` });
        continue;
      }
      const content = await readFile(abs, "utf8");
      if (content.includes("\u0000")) {
        skipped.push({ file: abs, reason: "contenu binaire" });
        continue;
      }
      files.push({ path: path.relative(base, abs) || path.basename(abs), abs, content });
    } catch (err) {
      skipped.push({ file: abs, reason: err.message });
    }
  }

  return { files, skipped, base };
}

/** Decoupe un texte en blocs respectant le budget, sans couper au milieu d'une ligne. */
function chunkText(text, limit = CHUNK_CHARS) {
  if (text.length <= limit) return [text];
  const chunks = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > limit && current.length > 0) {
      chunks.push(current);
      current = "";
    }
    // Une ligne unique depassant le budget est coupee brutalement.
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function economyFooter({ charsRead, charsReturned, seconds, model, calls, truncated }) {
  const tokIn = Math.round(charsRead / 3.5);
  const tokOut = Math.round(charsReturned / 3.5);
  const saved = Math.max(0, tokIn - tokOut);
  const lines = [
    "",
    "---",
    `traite en local par ${model} — ${calls} appel(s), ${seconds.toFixed(1)}s`,
    `~${tokIn.toLocaleString("fr-FR")} tokens lus localement, ~${tokOut.toLocaleString("fr-FR")} tokens renvoyes`,
    `→ ~${saved.toLocaleString("fr-FR")} tokens de contexte cloud economises`,
  ];
  if (truncated) {
    lines.push("ATTENTION : reponse tronquee (budget max_tokens atteint) — relancer avec un max_tokens plus eleve.");
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "local_digest",
    description:
      "Lit un ou plusieurs fichiers EN LOCAL et applique une instruction dessus (resumer, extraire, analyser, repondre a une question), puis ne renvoie QUE le resultat. " +
      "Le contenu brut des fichiers n'entre jamais dans le contexte de Claude — c'est le principal levier d'economie de tokens. " +
      "A privilegier avant de lire soi-meme un gros fichier ou un ensemble de fichiers. Fait automatiquement du map-reduce si le volume depasse le contexte local.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description: "Chemins ou globs relatifs a `cwd` (ex: [\"src/**/*.cs\", \"docs/GDD.md\"]).",
        },
        instruction: {
          type: "string",
          description: "Ce que le modele local doit faire du contenu (ex: \"Liste les methodes publiques et leur role en une ligne chacune\").",
        },
        cwd: { type: "string", description: "Repertoire de base. Defaut : repertoire courant du serveur." },
        model: {
          type: "string",
          description:
            "\"code\" (qwen3-coder-30b, defaut, repond directement, recommande partout) ou " +
            "\"light\" (gemma-4-e4b, plus leger en VRAM mais raisonne toujours : prevoir max_tokens >= 800).",
          enum: ["code", "light"],
        },
        max_tokens: { type: "number", description: "Longueur max de la reponse. Defaut : 1200." },
      },
      required: ["patterns", "instruction"],
    },
  },
  {
    name: "local_map",
    description:
      "Applique la MEME instruction a chaque fichier separement et renvoie un resultat par fichier. " +
      "Pour le traitement par lot : classer des fichiers, extraire un champ de chacun, detecter un motif dans une arborescence. " +
      "Traitement sequentiel (le GPU ne parallelise pas utilement) — compter quelques secondes par fichier.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: { type: "array", items: { type: "string" }, description: "Globs des fichiers a traiter." },
        instruction: { type: "string", description: "Instruction appliquee a chaque fichier individuellement." },
        cwd: { type: "string", description: "Repertoire de base." },
        model: { type: "string", enum: ["code", "light"], description: "Defaut : code." },
        max_tokens: { type: "number", description: "Longueur max par fichier. Defaut : 400." },
        max_files: { type: "number", description: "Garde-fou. Defaut : 40." },
      },
      required: ["patterns", "instruction"],
    },
  },
  {
    name: "local_ask",
    description:
      "Pose une question libre au modele local, sans lecture de fichier. " +
      "Utile pour du boilerplate, une reformulation, une traduction, un message de commit, une regex — tout ce qui ne merite pas le modele cloud.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "La demande." },
        system: { type: "string", description: "Consigne systeme optionnelle." },
        model: { type: "string", enum: ["code", "light"], description: "Defaut : code." },
        max_tokens: { type: "number", description: "Defaut : 1200." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "local_status",
    description: "Etat de LM Studio : modeles disponibles, modele charge, contexte configure. A appeler en cas d'erreur ou de lenteur inattendue.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "local-llm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "local_status":
        return await handleStatus();
      case "local_ask":
        return await handleAsk(args);
      case "local_digest":
        return await handleDigest(args);
      case "local_map":
        return await handleMap(args);
      default:
        throw new Error(`Outil inconnu : ${name}`);
    }
  } catch (err) {
    log("erreur", name, err.message);
    return { content: [{ type: "text", text: `Erreur ${name} : ${err.message}` }], isError: true };
  }
});

async function handleStatus() {
  const res = await fetch(`${BASE_URL}/models`).catch((err) => {
    throw new Error(`LM Studio injoignable sur ${BASE_URL} (${err.cause?.code ?? err.message}). Demarrer : lms server start`);
  });
  const json = await res.json();
  const ids = (json.data ?? []).map((m) => m.id);
  const lines = [
    `Serveur : ${BASE_URL} — OK`,
    `Modeles exposes : ${ids.length ? ids.join(", ") : "aucun"}`,
    "",
    `alias "code"  (defaut) → ${MODEL_CODE}${ids.includes(MODEL_CODE) ? "" : "  (ABSENT)"}`,
    `alias "light"          → ${MODEL_LIGHT}${ids.includes(MODEL_LIGHT) ? "" : "  (ABSENT)"}`,
    "",
  ];

  // Le contexte reellement charge est le point de defaillance le plus courant :
  // a 4096 les digests sont tronques sans qu'aucune erreur ne soit levee.
  try {
    const loaded = await loadedModels();
    if (loaded.length === 0) {
      lines.push("En memoire : aucun modele (le premier appel declenchera un chargement).");
    } else {
      lines.push("En memoire :");
      for (const m of loaded) {
        const ok = m.contextLength >= REQUIRED_CONTEXT ? "OK" : `INSUFFISANT, attendu ${REQUIRED_CONTEXT}`;
        lines.push(
          `  ${m.identifier} — contexte ${m.contextLength} (${ok}), ` +
          `max ${m.maxContextLength}, statut ${m.status}`,
        );
      }
    }
  } catch (err) {
    lines.push(`Etat memoire indisponible (CLI lms : ${err.message.split("\n")[0]})`);
  }

  lines.push(
    "",
    `Auto-chargement au demarrage : ${AUTOLOAD ? `actif (${REQUIRED_CONTEXT} tokens)` : "desactive"}`,
    ALLOWED_ROOTS.length
      ? `Racines autorisees : ${ALLOWED_ROOTS.join(" ; ")}`
      : "Racines autorisees : aucune restriction (definir LOCAL_ALLOWED_ROOTS pour restreindre)",
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleAsk({ prompt, system, model, max_tokens }) {
  const resolved = resolveModel(model);
  const out = await chat({ model: resolved, system, user: prompt, maxTokens: max_tokens ?? 1200 });
  return {
    content: [{
      type: "text",
      text: out.text + economyFooter({
        charsRead: prompt.length,
        charsReturned: out.text.length,
        seconds: out.seconds,
        model: resolved,
        calls: 1,
        truncated: out.truncated,
      }),
    }],
  };
}

async function handleDigest({ patterns, instruction, cwd, model, max_tokens }) {
  const resolved = resolveModel(model);
  const { files, skipped, base } = await collectFiles(patterns, cwd);

  if (files.length === 0) {
    const detail = skipped.length ? `\nIgnores : ${skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}` : "";
    throw new Error(`Aucun fichier texte trouve pour ${JSON.stringify(patterns)} depuis ${base}.${detail}`);
  }

  const bundle = files
    .map((f) => `===== FICHIER : ${f.path} =====\n${f.content}`)
    .join("\n\n");

  const chunks = chunkText(bundle);
  const system =
    "Tu es un assistant d'analyse de code et de documents. Tu reponds de facon factuelle, dense et structuree, " +
    "sans preambule ni formule de politesse. Tu ne recopies pas le contenu source, tu produis le resultat demande.";

  let started = Date.now();
  let calls = 0;
  let answer;
  let truncated = false;

  if (chunks.length === 1) {
    const out = await chat({
      model: resolved,
      system,
      user: `${instruction}\n\n---\n\n${chunks[0]}`,
      maxTokens: max_tokens ?? 1200,
    });
    calls = 1;
    answer = out.text;
    truncated = out.truncated;
  } else {
    // Map-reduce : une passe par bloc, puis une synthese finale.
    log(`digest : ${chunks.length} blocs, map-reduce`);
    const partials = [];
    for (const [i, chunk] of chunks.entries()) {
      const out = await chat({
        model: resolved,
        system,
        user: `${instruction}\n\n(Partie ${i + 1}/${chunks.length} du corpus — traite uniquement cette partie.)\n\n---\n\n${chunk}`,
        maxTokens: max_tokens ?? 1200,
      });
      calls++;
      partials.push(`--- Partie ${i + 1} ---\n${out.text}`);
    }
    const out = await chat({
      model: resolved,
      system,
      user:
        `${instruction}\n\nVoici les analyses partielles de chaque portion du corpus. ` +
        `Fusionne-les en une seule reponse coherente, sans repetition et sans mentionner le decoupage.\n\n${partials.join("\n\n")}`,
      maxTokens: max_tokens ?? 1500,
    });
    calls++;
    answer = out.text;
    truncated = out.truncated;
  }

  const header = `Analyse de ${files.length} fichier(s) : ${files.map((f) => f.path).join(", ")}\n\n`;
  const warn = skipped.length ? `\n\n(Ignores : ${skipped.length} fichier(s) binaire(s) ou trop volumineux.)` : "";

  return {
    content: [{
      type: "text",
      text: header + answer + warn + economyFooter({
        charsRead: bundle.length,
        charsReturned: answer.length,
        seconds: (Date.now() - started) / 1000,
        model: resolved,
        calls,
        truncated,
      }),
    }],
  };
}

async function handleMap({ patterns, instruction, cwd, model, max_tokens, max_files }) {
  const resolved = resolveModel(model);
  const limit = max_files ?? 40;
  const { files, base } = await collectFiles(patterns, cwd);

  if (files.length === 0) throw new Error(`Aucun fichier texte trouve pour ${JSON.stringify(patterns)} depuis ${base}.`);
  if (files.length > limit) {
    throw new Error(
      `${files.length} fichiers correspondent, au-dela de la limite de ${limit}. ` +
      `Restreindre le glob ou augmenter max_files (attention au temps : ~3-10 s par fichier).`,
    );
  }

  const system =
    "Tu analyses un fichier a la fois. Reponse breve, factuelle, sans preambule ni repetition de l'enonce.";
  const started = Date.now();
  const results = [];
  let charsRead = 0;
  let truncated = false;

  for (const file of files) {
    const chunks = chunkText(file.content);
    const body = chunks[0] + (chunks.length > 1 ? `\n\n[... fichier tronque : ${chunks.length - 1} bloc(s) omis ...]` : "");
    charsRead += file.content.length;
    const out = await chat({
      model: resolved,
      system,
      user: `${instruction}\n\n===== ${file.path} =====\n${body}`,
      maxTokens: max_tokens ?? 400,
    });
    if (out.truncated) truncated = true;
    results.push(`### ${file.path}\n${out.text.trim()}`);
  }

  const answer = results.join("\n\n");
  return {
    content: [{
      type: "text",
      text: answer + economyFooter({
        charsRead,
        charsReturned: answer.length,
        seconds: (Date.now() - started) / 1000,
        model: resolved,
        calls: files.length,
        truncated,
      }),
    }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`pret — LM Studio ${BASE_URL} | code=${MODEL_CODE} | light=${MODEL_LIGHT}`);

// Volontairement non attendu : Claude Code impose un delai au demarrage d'un
// serveur MCP, et un chargement de modele peut prendre 30 s. Le controle se fait
// en arriere-plan pendant que la session s'ouvre.
ensureModelLoaded();
