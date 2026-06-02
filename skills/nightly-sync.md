---
name: nightly-sync
description: Sync complet du soir — export Confluence (toutes sources), puis pipeline ingest → build → export+polish sur tous les livrables. Envoie un rapport mail à la fin.
params: []
---

# Nightly Sync

Terminologie :
- "Export Confluence / CME / sources" = `cme_export_run` sur le MCP **cme**. Jamais `production_start_job type=export` pour ça.
- "Pipeline production" = `production_start_job` sur le MCP **production**.

Exécute les étapes dans l'ordre. En cas d'échec sur une étape, note l'erreur et continue jusqu'à l'étape rapport — ne jamais terminer silencieusement.

---

## Étape 1 — Vérifier les services

1. Appelle `cme_status`.
   - `configured` → continuer.
   - `not_configured` → arrêter, passer directement à l'étape rapport avec statut `FAILED: CME non configuré`.
2. Appelle `production_status`.
   - Si un verrou actif existe (`workspace_busy`) → arrêter, passer à l'étape rapport avec statut `FAILED: job production déjà actif (jobId: <id>)`.

---

## Étape 2 — Export Confluence (toutes sources)

1. Appelle `cme_sources_list`. Si la liste est vide → note `WARNING: aucune source CME configurée`, sauter à l'étape 3.
2. Appelle `cme_export_run()` sans `source_name` (toutes les sources d'un coup).
3. Note le `job_id` retourné.
4. Toutes les 30 secondes, appelle `cme_export_status(job_id=...)` jusqu'à `status = success` ou `failed`.
   - Rapporte la progression à chaque poll (sources traitées / total).
   - `failed` → note l'erreur, continue à l'étape 3 (l'export partiel peut être utile).

---

## Étape 3 — Ingest + Build

1. Appelle `production_start_job` avec :
   ```json
   { "type": "pipeline", "steps": ["ingest", "build"] }
   ```
   Pas de `deliverables` nécessaires pour ingest+build.
2. Note le `jobId`.
3. Toutes les 30 secondes, appelle `production_job_status(jobId=...)` jusqu'à `status = done`, `failed`, ou `cancelled`.
   - Rapporte la progression à chaque poll.
   - Si le job échoue, appelle `production_job_logs(jobId=..., tail=80)` pour capturer la cause.
   - `failed` / `cancelled` → note l'erreur, sauter l'étape 4, aller à l'étape rapport.

---

## Étape 4 — Export + Polish de tous les livrables

1. Appelle `production_list_templates` pour récupérer la liste des templates et leurs livrables attendus.
2. Collecte tous les `deliverablePath` (champ `deliverablePath` de chaque entrée `templates`).
   - Si la liste est vide → note `WARNING: aucun template trouvé`, sauter à l'étape rapport.
3. Appelle `production_start_job` avec :
   ```json
   {
     "type": "pipeline",
     "steps": ["export", "polish"],
     "deliverables": ["<deliverablePath1>", "<deliverablePath2>", ...]
   }
   ```
4. Note le `jobId`.
5. Toutes les 30 secondes, appelle `production_job_status(jobId=...)` jusqu'à `done`, `failed`, ou `cancelled`.
   - Rapporte la progression (template en cours, batch, pourcentage).
   - Si le job échoue, appelle `production_job_logs(jobId=..., tail=80)`.

---

## Étape 5 — Rapport final

Construis un résumé avec :
- Statut global : `OK`, `PARTIAL` (au moins une étape a échoué), ou `FAILED`
- CME export : sources exportées / total, erreurs éventuelles
- Ingest + Build : durée, erreurs éventuelles
- Export + Polish : livrables produits, durée, erreurs éventuelles
- Timestamp de fin

Si le MCP **mailer** est connecté :
- Appelle `mailer_send_email` avec :
  - `subject`: `[wiki-manager] Nightly sync — <workspace> — <YYYY-MM-DD> — <statut global>`
  - `to`: `pascal.poindrelle@gmail.com`
  - `body`: le résumé complet en texte.

Si le mailer n'est pas connecté, affiche le résumé complet dans le shell.
