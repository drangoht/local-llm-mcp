# local-llm-mcp

Serveur MCP reliant **Claude Code** à **LM Studio**, pour déléguer à un modèle local les
tâches coûteuses en tokens — sans sacrifier l'agentivité du modèle cloud.

## Le principe

Le pilotage reste sur Claude ; seul le **travail de volume** part en local.

Le levier d'économie n'est pas « utiliser un modèle moins cher ». C'est **empêcher le
contenu brut d'entrer dans le contexte cloud** : les outils lisent les fichiers eux-mêmes,
côté serveur, et ne renvoient que le résultat du traitement.

```
Claude Code  ──(appel MCP : « résume src/**/*.cs »)──►  local-llm-mcp
                                                              │
                                                              ├─ lit les fichiers sur disque
                                                              ├─ découpe si > contexte local
                                                              └─ interroge LM Studio :1234
                                                                       │
Claude Code  ◄────────(≈700 tokens de synthèse)───────────────────────┘
```

Sans cet intermédiaire, lire une arborescence de sources consomme des dizaines de milliers
de tokens de contexte. Avec, le coût se réduit à la taille de la réponse.

## Mesures

Relevées sur un projet Godot/C# réel, avec `qwen3-coder-30b` :

| Cible | Tokens lus en local | Tokens renvoyés | Durée |
|---|---:|---:|---:|
| Un fichier de 886 lignes (46 Ko) | 13 462 | 757 | 49 s |
| 8 fichiers de données JSON | 35 537 | 674 | 50 s |

Le rapport dépend entièrement de la tâche : une synthèse compresse beaucoup, une
extraction exhaustive beaucoup moins.

## Prérequis

- [LM Studio](https://lmstudio.ai/) avec son serveur local actif (port 1234 par défaut)
- Node.js 18 ou plus
- [Claude Code](https://claude.com/claude-code)
- Un modèle chargé — voir *Choix du modèle* ci-dessous

Testé sur Windows 11. `server.js` n'a pas de dépendance à Windows (le chemin de la CLI
LM Studio est résolu selon la plateforme), mais seul le script d'appoint `start-local.ps1`
est spécifique à PowerShell.

## Installation

```sh
git clone https://github.com/drangoht/local-llm-mcp.git
cd local-llm-mcp
npm ci
```

Puis enregistrer le serveur auprès de Claude Code, en donnant le **chemin absolu** vers
`server.js` :

```sh
claude mcp add local-llm --scope user -- node /chemin/absolu/vers/local-llm-mcp/server.js
```

`--scope user` le rend disponible depuis tous vos projets. Utilisez `--scope project` pour
le limiter au dépôt courant.

Vérification : `claude mcp list` doit afficher `local-llm: ✔ Connected`.

## Outils exposés

| Outil | Rôle | Économie |
|---|---|---|
| `local_digest` | Lit des fichiers (globs), applique une instruction, ne renvoie que le résultat. Map-reduce automatique au-delà du contexte local. | **Forte** — l'outil principal |
| `local_map` | Applique la même instruction à chaque fichier séparément, un résultat par fichier. Traitement par lot. | **Forte** |
| `local_ask` | Question libre, sans lecture de fichier. Boilerplate, reformulation, message de commit, regex. | Faible |
| `local_status` | Diagnostic : modèles, alias, contexte réellement chargé. | — |

## Choix du modèle

Deux alias sont exposés :

| Alias | Modèle par défaut | Remarque |
|---|---|---|
| `code` *(défaut)* | `qwen/qwen3-coder-30b` | Répond directement, sans phase de raisonnement. |
| `light` | `google/gemma-4-e4b` | Plus léger en VRAM, mais **raisonne systématiquement**. |

Le défaut retenu est le **plus gros** modèle, ce qui mérite une explication car c'est
contre-intuitif. Sur une même tâche courte, mesuré :

| | Débit brut | Tokens produits | Dont réflexion interne jetée |
|---|---:|---:|---:|
| `gemma-4-e4b` | 67 tok/s | 347 | ~85 % |
| `qwen3-coder-30b` | 13,5 tok/s | 19 | 0 |

Le petit modèle est cinq fois plus rapide *par token*, mais en produit dix-huit fois plus
pour un résultat équivalent. En **sortie utile**, le gros modèle gagne. Le paramètre
`enable_thinking: false` n'a par ailleurs aucun effet sur ce modèle, et un `max_tokens`
trop bas fait renvoyer un `content` **vide** — le serveur détecte ce cas et le signale
explicitement au lieu de retourner une chaîne vide silencieuse.

À adapter à votre matériel via `LOCAL_MODEL_CODE` / `LOCAL_MODEL_LIGHT`.

## Chargement automatique du modèle

Au démarrage, le serveur vérifie via `lms ps --json` que le modèle est chargé avec un
contexte suffisant, et le recharge sinon.

Ce contrôle existe pour une raison précise : le réglage `defaultContextLength` de LM Studio
vaut **4096 tokens**. Son chargement à la demande (`justInTimeModelLoading`) ramène donc le
modèle à 4096 dès que le TTL expire ou que l'application redémarre — et `local_digest`
casse alors **silencieusement** : réponses tronquées, aucune erreur levée. C'est le mode de
défaillance le plus pénible parce qu'il est invisible.

La vérification est **non bloquante** (le handshake MCP reste à ~0,4 s) et ne coûte rien
quand la configuration est déjà correcte. La désactiver : `LOCAL_AUTOLOAD=0`.

`start-local.ps1` (Windows) fait la même chose depuis un terminal, utile pour précharger
le modèle avant d'ouvrir Claude Code et éviter l'attente au premier appel.

## Configuration

Toutes les variables d'environnement sont optionnelles.

| Variable | Défaut | Rôle |
|---|---|---|
| `LMSTUDIO_URL` | `http://localhost:1234/v1` | Endpoint LM Studio |
| `LOCAL_MODEL_CODE` | `qwen/qwen3-coder-30b` | Modèle de l'alias `code` |
| `LOCAL_MODEL_LIGHT` | `google/gemma-4-e4b` | Modèle de l'alias `light` |
| `LOCAL_CONTEXT` | `32768` | Contexte exigé au démarrage |
| `LOCAL_AUTOLOAD` | `1` | `0` désactive le rechargement automatique |
| `LOCAL_TTL_SECONDS` | `28800` | Déchargement du modèle après 8 h d'inactivité |
| `LOCAL_TIMEOUT_MS` | `600000` | Délai max d'un appel (10 min) |
| `LOCAL_ALLOWED_ROOTS` | *(aucune)* | Racines autorisées en lecture, séparées par `;` |
| `LMS_CLI` | `~/.lmstudio/bin/lms[.exe]` | Chemin de la CLI LM Studio |

### Restreindre les lectures

Par défaut le serveur peut lire n'importe quel fichier accessible à l'utilisateur. Pour le
confiner à vos dossiers de code :

```sh
claude mcp add local-llm --scope user \
  --env LOCAL_ALLOWED_ROOTS="/chemin/vers/projets" \
  -- node /chemin/absolu/vers/local-llm-mcp/server.js
```

### Timeouts côté Claude Code

Dans `~/.claude/settings.json` :

```json
"env": {
  "MCP_TIMEOUT": "60000",
  "MCP_TOOL_TIMEOUT": "900000"
}
```

`MCP_TOOL_TIMEOUT` généreux est nécessaire : un `local_map` sur plusieurs dizaines de
fichiers prend plusieurs minutes.

## Quand déléguer au local, quand rester en cloud

| Déléguer au local | Garder en cloud |
|---|---|
| Résumer un gros fichier ou une arborescence | Décider d'une architecture |
| Extraire une liste (méthodes, TODO, dépendances) | Écrire du code qui doit être juste du premier coup |
| Classer ou trier des fichiers par critère | Déboguer un problème subtil |
| Première reconnaissance sur du code inconnu | Raisonnement multi-étapes |
| Boilerplate, messages de commit, regex | Tout ce qui engage la correction fonctionnelle |

Règle courte : **le local sert à réduire un volume, pas à trancher une question.**

## Limites

- **Le modèle local se trompe.** Il rate des cas limites et invente parfois des noms de
  méthodes. Sa sortie est un point de départ à vérifier, jamais une conclusion sur un
  point critique.
- **Débit modeste** sur un GPU qui ne loge pas le modèle entièrement en VRAM. Sur la
  configuration de référence (Radeon RX 9070, 16 Go), un modèle 30B en Q4 déborde d'environ
  3,5 Go et tourne à ~13,5 tok/s. Un `local_map` sur 40 fichiers dure plusieurs minutes.
- **Pas de streaming** : les résultats arrivent d'un bloc.
- **Un seul modèle résident** si la VRAM est limitée ; alterner entre alias impose un
  rechargement (~16 s pour un modèle de 18 Go).

## Dépannage

| Symptôme | Cause probable | Correctif |
|---|---|---|
| `LM Studio injoignable` | Application fermée ou serveur arrêté | Ouvrir LM Studio, ou `lms server start` |
| Réponses tronquées ou incohérentes | Contexte retombé à 4096 | `local_status` pour confirmer, puis redémarrer le serveur MCP |
| Réponse vide + message sur le raisonnement | Alias `light` avec `max_tokens` trop bas | Passer `model: "code"` ou augmenter `max_tokens` |
| Premier appel très lent (~20-30 s) | Chargement du modèle | Normal ; précharger avec `start-local.ps1` |
| Timeout côté Claude Code | `MCP_TOOL_TIMEOUT` trop bas | Voir *Timeouts* ci-dessus |

## Licence

MIT — voir [LICENSE](LICENSE).
