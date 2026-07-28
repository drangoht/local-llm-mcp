<#
.SYNOPSIS
    Prepare LM Studio pour le serveur MCP local-llm.

.DESCRIPTION
    Demarre le serveur LM Studio si besoin et charge le modele de travail avec un
    contexte de 32k.

    Pourquoi ce script existe : le reglage `defaultContextLength` de LM Studio vaut
    4096. Si le modele est recharge automatiquement (expiration du TTL, redemarrage
    de l'application), il repart a 4096 tokens et l'outil local_digest devient
    inutilisable sur tout fichier un peu consequent. Ce script force la bonne valeur.

    A lancer apres chaque demarrage de session de travail, ou a placer au demarrage
    de Windows.

.PARAMETER Context
    Taille du contexte en tokens. Defaut : 32768.
    65536 tient aussi mais deborde davantage en RAM (21,2 Gio estimes contre 19,5).

.PARAMETER TtlHours
    Duree avant dechargement automatique du modele. Defaut : 8 heures.

.EXAMPLE
    .\start-local.ps1
    .\start-local.ps1 -Context 65536 -TtlHours 12
#>
[CmdletBinding()]
param(
    [int]$Context = 32768,
    [int]$TtlHours = 8,
    [string]$Model = "qwen/qwen3-coder-30b"
)

# Volontairement PAS "Stop" : lms.exe ecrit sa progression sur stderr, et
# PowerShell 5.1 transforme chaque ligne de stderr d'un binaire natif en
# ErrorRecord. Avec ErrorActionPreference = "Stop", un simple message de
# succes ferait echouer le script.
$ErrorActionPreference = "Continue"
$lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"

if (-not (Test-Path $lms)) {
    Write-Error "CLI LM Studio introuvable : $lms. Installer avec : lms bootstrap"
    exit 1
}

Write-Host "Demarrage du serveur LM Studio..." -ForegroundColor Cyan
& $lms server start | Out-Null

# Le modele est-il deja charge avec le bon contexte ?
$etat = (& $lms ps | Out-String)
if ($etat -match [regex]::Escape($Model) -and $etat -match "\b$Context\b") {
    Write-Host "$Model deja charge avec un contexte de $Context. Rien a faire." -ForegroundColor Green
    & $lms ps
    return
}

Write-Host "Chargement de $Model (contexte $Context, TTL ${TtlHours}h)..." -ForegroundColor Cyan
Write-Host "Compter environ 30 s pour un modele de 18 Go." -ForegroundColor DarkGray

& $lms unload --all | Out-Null
& $lms load $Model -c $Context --parallel 1 --gpu max --ttl ($TtlHours * 3600) -y |
    Where-Object { $_ -notmatch "Loading|^\s*$" } |
    ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

Write-Host "`nEtat final :" -ForegroundColor Green
& $lms ps

# Verification de bout en bout : le serveur repond-il vraiment ?
try {
    $body = @{
        model      = $Model
        messages   = @(@{ role = "user"; content = "Reponds par le seul mot: pret" })
        max_tokens = 10
    } | ConvertTo-Json -Depth 5 -Compress

    $r = Invoke-RestMethod -Uri "http://localhost:1234/v1/chat/completions" `
        -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
    Write-Host "`nTest API : OK ($($r.choices[0].message.content.Trim()))" -ForegroundColor Green
}
catch {
    Write-Warning "Le modele est charge mais l'API ne repond pas : $($_.Exception.Message)"
}
