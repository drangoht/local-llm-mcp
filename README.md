# local-llm-mcp

Passerelle MCP entre **Claude Code** et **LM Studio**. Permet à Claude Code de déléguer
à un modèle local les tâches coûteuses en tokens, sans perdre son agentivité.

## Le principe

Le pilotage reste sur Claude (cloud) ; seul le **travail de volume** part en local.

Le levier d'économie n'est pas « faire tourner un modèle moins cher », c'est **empêcher
le contenu brut d'entrer dans le contexte cloud** : les outils lisent les fichiers
eux-mêmes, côté serveur, et ne renvoient que le résultat du traitement.

```
Claude Code  ──(appel MCP : "résume src/**/*.cs")──►  local-llm-mcp
                                                            │
                                                            ├─ lit les fichiers sur disque
                                                            ├─ découpe si > contexte local
                                                            └─ interroge LM Studio :1234
                                                                     │
Claude Code  ◄──────(300 tokens de synthèse)────────────────────────┘
```

Mesure réelle sur `GraftManager.cs` (886 lignes) : **13 462 tokens lus localement,
757 renvoyés** — soit ~12 700 tokens de contexte économisés, en 49 s.

## Prérequis

- LM Studio avec le serveur local actif sur le port 1234
- Node.js 18+
- Le modèle `qwen/qwen3-coder-30b` chargé **avec un contexte de 32k** (voir plus bas)

## Installation

```powershell
cd C:\CODE\SANDBOX\ia\local-llm-mcp
npm install
claude mcp add local-llm --scope user -- node C:\CODE\SANDBOX\ia\local-llm-mcp\server.js
```

Vérifier : `claude mcp list` doit afficher `local-llm: ✔ Connected`.

## Démarrage — entièrement automatique

Aucune action manuelle n'est requise. La chaîne complète se monte seule :

| Maillon | Mécanisme |
|---|---|
| LM Studio au démarrage de Windows | entrée `HKCU\...\Run` |
| Serveur HTTP `:1234` | `autoStartOnLaunch: true` (`.lmstudio/.internal/http-server-config.json`) |
| Serveur MCP `local-llm` | lancé par Claude Code à chaque session (transport stdio) |
| Modèle chargé en 32k | `ensureModelLoaded()` au démarrage du serveur MCP |

Le dernier maillon existe parce que le réglage `defaultContextLength` de LM Studio vaut
**4096**. Son chargement à la demande ramène donc le modèle à 4096 dès que le TTL expire
ou que l'application redémarre — et `local_digest` casse alors **silencieusement** :
réponses tronquées, aucune erreur levée.

Au démarrage, le serveur lit `lms ps --json`, compare `contextLength` au seuil requis et
recharge si nécessaire. Le contrôle est **non bloquant** (le handshake MCP reste à ~0,4 s)
et ne coûte rien quand la configuration est déjà bonne.

### start-local.ps1

Devenu optionnel — utile seulement pour précharger le modèle *avant* d'ouvrir Claude Code
(évite d'attendre ~20 s au premier appel d'outil), ou pour diagnostiquer à la main.

```powershell
.\start-local.ps1 -Context 65536 -TtlHours 12
```

## Outils exposés

| Outil | Usage | Économie |
|---|---|---|
| `local_digest` | Lit des fichiers (globs), applique une instruction, ne renvoie que le résultat. Map-reduce automatique si le volume dépasse le contexte local. | **Forte** — c'est l'outil principal |
| `local_map` | Applique la même instruction à chaque fichier séparément, renvoie un résultat par fichier. Traitement par lot. | **Forte** |
| `local_ask` | Question libre, sans lecture de fichier. Boilerplate, reformulation, message de commit, regex. | Faible (économise un aller-retour cloud) |
| `local_status` | État de LM Studio : modèles, alias, restrictions. À appeler en cas d'erreur ou de lenteur. | — |

### Alias de modèles

| Alias | Modèle | Remarque |
|---|---|---|
| `code` *(défaut)* | `qwen/qwen3-coder-30b` | Répond directement, sans raisonnement. **Recommandé partout.** |
| `light` | `google/gemma-4-e4b` | Plus léger en VRAM (~8 Gio) mais **raisonne systématiquement** : prévoir `max_tokens >= 800`, sinon la réponse revient vide. |

Le choix du 30B par défaut est contre-intuitif mais mesuré : sur une même tâche,
gemma produit 347 tokens (dont ~85 % de réflexion interne jetée) là où qwen en produit
19. Malgré un débit brut inférieur (13,5 contre 67 tok/s), qwen est plus rapide **en
sortie utile** — et le garder résident évite un swap VRAM de ~16 s à chaque bascule.

## Configuration

Variables d'environnement, toutes optionnelles :

| Variable | Défaut | Rôle |
|---|---|---|
| `LMSTUDIO_URL` | `http://localhost:1234/v1` | Endpoint LM Studio |
| `LOCAL_MODEL_CODE` | `qwen/qwen3-coder-30b` | Modèle de l'alias `code` |
| `LOCAL_MODEL_LIGHT` | `google/gemma-4-e4b` | Modèle de l'alias `light` |
| `LOCAL_TIMEOUT_MS` | `600000` | Délai max d'un appel (10 min) |
| `LOCAL_ALLOWED_ROOTS` | *(aucune)* | Racines autorisées en lecture, séparées par `;`. Si vide, aucune restriction. |
| `LOCAL_CONTEXT` | `32768` | Contexte exigé au démarrage. 65536 tient aussi (21,2 Gio estimés contre 19,5). |
| `LOCAL_AUTOLOAD` | `1` | Mettre à `0` pour désactiver le rechargement automatique. |
| `LOCAL_TTL_SECONDS` | `28800` | Délai avant déchargement du modèle (8 h). |
| `LMS_CLI` | `%USERPROFILE%\.lmstudio\bin\lms.exe` | Chemin de la CLI LM Studio. |

Pour restreindre les lectures à tes dossiers de code :

```powershell
claude mcp remove local-llm --scope user
claude mcp add local-llm --scope user --env LOCAL_ALLOWED_ROOTS="C:\CODE" -- node C:\CODE\SANDBOX\ia\local-llm-mcp\server.js
```

### Timeouts côté Claude Code

Définis dans `~/.claude/settings.json` :

```json
"env": {
  "MCP_TIMEOUT": "60000",
  "MCP_TOOL_TIMEOUT": "900000"
}
```

`MCP_TOOL_TIMEOUT` à 15 min est nécessaire : un `local_map` sur 40 fichiers prend
plusieurs minutes à ~13 tok/s.

## Quand déléguer au local, quand rester en cloud

| Déléguer au local | Garder en cloud |
|---|---|
| Résumer un gros fichier ou une arborescence | Décider d'une architecture |
| Extraire une liste (méthodes, TODO, dépendances) | Écrire du code qui doit être juste du premier coup |
| Classer / trier des fichiers par critère | Déboguer un problème subtil |
| Première passe de reconnaissance sur du code inconnu | Raisonnement multi-étapes |
| Boilerplate, messages de commit, regex | Tout ce qui touche à la correction fonctionnelle |

Règle simple : **le local sert à réduire un volume, pas à trancher une question.**
Sa sortie est un point de départ à vérifier, pas une conclusion.

## Limites connues

- **~13 tok/s** sur le 30B : le modèle (18,6 Go) déborde des 16 Go de VRAM de la
  RX 9070. Un `local_map` sur 40 fichiers dure plusieurs minutes.
- **Pas de streaming** : les résultats arrivent d'un bloc.
- **Le modèle local se trompe.** Il rate des cas limites et invente parfois des noms
  de méthodes. Ne jamais accepter une sortie `local_*` comme vérité sur un point
  critique sans vérification.
- **Un seul modèle résident** : `code` et `light` ne tiennent pas simultanément en
  VRAM (19,5 + 7,9 Gio). Alterner coûte ~16 s de rechargement.

## Dépannage

| Symptôme | Cause probable | Correctif |
|---|---|---|
| `LM Studio injoignable` | LM Studio fermé | Ouvrir LM Studio, ou `.\start-local.ps1` |
| Réponses tronquées ou absurdes | Contexte retombé à 4096 | `local_status` pour confirmer, puis redémarrer Claude Code (rechargement auto) ou `.\start-local.ps1` |
| Réponse vide + message sur le raisonnement | `light` avec `max_tokens` trop bas | Passer `model: "code"` ou monter `max_tokens` |
| Premier appel très lent (~30 s) | Chargement JIT du modèle | Normal ; `start-local.ps1` le précharge |
| Timeout côté Claude Code | `MCP_TOOL_TIMEOUT` trop bas | Voir section Timeouts |
