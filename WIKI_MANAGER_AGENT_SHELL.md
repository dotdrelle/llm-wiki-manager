# wiki-manager Agent Shell

## Intention

`llm-wiki-manager` doit evoluer vers un cockpit agentique installable en npm,
expose par un nouveau binaire separe:

```bash
./wiki-manager
```

Ce binaire ne remplace pas `llm-wiki`. Il pilote les workspaces `llm-wiki`
existants, leurs services Docker, leurs endpoints MCP, leurs skills et leurs
pipelines. L'objectif est de fournir une interface conversationnelle terminal
capable de charger un workspace, de comprendre son contexte, puis d'orchestrer
les primitives deja presentes dans `wiki-workspace`.

`wiki-workspace` reste le CLI historique et scriptable. `wiki-manager` devient
le shell/chat interactif oriente agent.

## Principe agent-first

`wiki-manager` doit etre agentique des le demarrage. Le LLM n'est pas une
commande secondaire du shell: il est la boucle principale d'interaction.

Les commandes `/...` ne sont pas le mode principal, mais les primitives
deterministes exposees a l'utilisateur et a l'agent. Elles servent a rendre les
actions inspectables, reproductibles et debuggables.

```text
entree utilisateur
  -> agent orchestrateur
     -> interprete l'intention
     -> consulte le contexte workspace
     -> choisit les primitives /...
     -> demande confirmation si necessaire
     -> execute via manager core
     -> explique le resultat
```

Cette approche evite d'avoir un shell CLI avec un "mode ask" ajoute apres coup.
Le shell est le chat. Le chat pilote les outils.

## Ce que ce n'est pas

Ce mode n'est pas:

- un simple `docker compose run --entrypoint /bin/sh wiki`;
- une commande supplementaire `./wiki-workspace agent-shell <workspace>`;
- une reimplementation de `llm-wiki`;
- un remplacement obligatoire du `serve` web UI.

Le shell vise le meme role fonctionnel que l'UI `serve` pour certains usages:
un cockpit d'exploitation et de pilotage. Mais il doit rester branche sur le
meme backoffice `llm-wiki` et les memes workspaces.

## Experience cible

L'utilisateur lance:

```bash
./wiki-manager
```

Puis travaille dans un shell/chat:

```text
wiki-manager> /workspaces
wiki-manager> /use juno
juno> /status
juno> /start mcp
juno> /start cme
juno> /wiki doctor
juno> /wiki ingest
juno> /wiki build --plan
juno> /skills
juno> /skill run agent-cme-llm-wiki-pipeline
juno> resume l'architecture fonctionnelle du wiki JUNO
```

Le shell doit accepter deux formes d'interaction:

- commandes explicites, previsibles et scriptables, toujours prefixees par `/`;
- demandes en langage naturel sans prefixe `/`, interpretees par un agent
  orchestrateur.

Cette convention evite toute ambiguite: une entree qui commence par `/` est une
commande du shell, tout le reste est du chat agentique.

## Relation avec le backoffice llm-wiki

Le backoffice reste celui de `llm-wiki`:

- `.wikirc.yaml` est la source de verite LLM, embeddings, retrieval et modeles;
- les donnees restent dans le workspace local;
- les commandes `wiki doctor`, `wiki ingest`, `wiki build`, `wiki export`,
  `wiki query`, `wiki index` restent les primitives metier;
- le MCP `wiki mcp-http` expose le workspace aux agents;
- le `serve` web UI continue de fonctionner sur le meme workspace.

`wiki-manager` ne doit pas dupliquer la logique metier de `llm-wiki`. Il doit
orchestrer les memes services et commandes.

## Architecture cible

La logique aujourd'hui concentree dans `wiki-workspace` doit etre extraite dans
un noyau manager reutilisable.

```text
llm-wiki-manager
  core manager
    workspace registry
    env parsing
    port allocation
    Docker Compose orchestration
    service status
    MCP endpoint discovery
    skill discovery
    command execution

  interfaces
    wiki-workspace       legacy CLI scriptable
    wiki-manager         interactive agent shell
    llm-wiki serve/UI    web cockpit using the same workspace services
```

La direction long terme est:

```text
user
  -> wiki-manager shell
     -> manager core
        -> docker compose services
        -> llm-wiki CLI
        -> llm-wiki MCP
        -> agent-cme MCP
        -> agent-wiki-production MCP
        -> external MCPs: mailer, documents, atlassian
        -> workspace skills
```

## Package npm cible

Le manager doit devenir un package Node installable:

```bash
npm install -g @dotdrelle/wiki-manager
wiki-manager
```

Structure cible possible:

```text
llm-wiki-manager/
  package.json
  src/
    cli/wiki-manager.ts
    core/env.ts
    core/workspaces.ts
    core/compose.ts
    core/services.ts
    core/mcp.ts
    core/skills.ts
    core/agent.ts
    shell/repl.ts
  bin/
    wiki-manager.ts
  docker-compose.yml
  wiki-workspace
  README.md
```

Le package npm doit embarquer les assets d'orchestration:

- `docker-compose.yml`;
- `.env.example`;
- `workspaces/.env.example`;
- skills manager de base;
- templates eventuels du shell.

Les workspaces utilisateurs ne doivent pas vivre dans le dossier installe par
npm. Le manager doit supporter un repertoire utilisateur configurable, par
exemple:

```bash
WIKI_MANAGER_HOME=~/.llm-wiki-manager
WIKI_WORKSPACES_DIR=~/llm-wiki-workspaces
```

## Noyau manager a extraire

Les primitives de `wiki-workspace` a porter progressivement en TypeScript sont:

- lire un fichier `.env`;
- ecrire une valeur `.env`;
- lister les workspaces;
- resoudre le chemin d'un workspace;
- creer/configurer un workspace;
- generer les tokens MCP;
- allouer les ports;
- creer les repertoires runtime;
- construire le nom de projet Docker Compose;
- executer `docker compose` avec les bons env files;
- demarrer/arreter les services;
- lancer une commande `wiki` dans le conteneur;
- lire les statuts de services;
- exposer les URLs MCP et tokens disponibles.

Le Bash peut rester au debut. La migration doit eviter un big bang: le nouveau
core Node peut d'abord coexister avec `wiki-workspace`, puis reprendre
progressivement ses responsabilites.

## Shell interactif

L'interface terminal doit etre structuree comme un cockpit conversationnel.
La langue de l'interface shell est l'anglais; la langue d'echange avec Donna
vient du champ `language` du `.wikirc.yaml` actif.

```text
                        wiki-manager 0.1.0  juno  default  fr-FR  llm ready
██████╗  ██████╗ ███╗   ██╗...                  MCP
██╔══██╗██╔═══██╗████╗  ██║...                  ● wiki :3201
...                                             ● cme :3202
                                                ● production :3203
───────────────────────────────────────────────────────────────────────────────

Donna: retour de l'agent orchestrateur central

You: message utilisateur

Shell: retour d'une commande /...

───────────────────────────────────────────────────────────────────────────────
donna> ligne de commande/chat
```

- Le header affiche la version, le workspace courant, le profil wikirc actif, la
  langue active et l'etat LLM.
- Le banner ASCII `Donna` est affiche sous le header et peut etre colorise.
- A droite du banner, un panneau MCP affiche les endpoints connus avec `●` ou
  `○`.
- Le centre est reserve aux retours de l'agent orchestrateur et aux sorties des
  primitives `/...`.
- Les retours de Donna doivent etre affiches en streaming quand le LLM du
  `.wikirc.yaml` actif supporte le streaming.
- Les retours textuels de Donna doivent etre traites comme du Markdown et
  rendus dans le terminal avec une interpretation legere:
  - titres;
  - listes;
  - tableaux;
  - blocs de code;
  - code inline.
- La ligne de commande/chat reste toujours en bas.
- La zone centrale ajoute un saut de ligne entre chaque echange.
- Les retours sont differencies visuellement:
  - `You` pour l'utilisateur;
  - `Donna` pour l'agent;
  - `Shell` pour les commandes `/...`.
- Les etats positifs (`configured`, `ready`, `enabled`) et les etats limites
  (`missing`, `limited`, `disabled`) sont colorises.
- L'historique de saisie se parcourt avec les fleches haut/bas.
- Une entree qui commence par `/` est une commande deterministe.
- Toute autre entree est un message adresse a Donna.

Le shell doit maintenir un etat de session:

- workspace courant;
- services connus et leur statut;
- endpoints MCP disponibles;
- skills disponibles;
- historique de conversation;
- historique de saisie;
- dernier plan agent propose;
- dernieres commandes executees.

Commandes de base:

```text
/help
/workspaces
/use <workspace>
/config list
/config use <default|name>
/config status
/status
/services
/start <service|all>
/stop <service|all>
/logs <service>
/wiki <args...>
/mcp status
/mcp tools <server>
/mcp call <server> <tool> [json]
/skills
/skill show <name>
/skill run <name>
/exit
```

Les commandes explicites doivent etre fiables meme sans agent LLM pour le debug,
les scripts et les reprises manuelles. Mais dans l'experience normale,
l'utilisateur parle directement a l'agent. Toute entree sans prefixe `/` est
envoyee a l'agent orchestrateur, qui la transforme en plan d'action ou en
reponse basee sur le workspace courant.

## Agent orchestrateur

L'agent du shell doit etre l'interface principale. Il ne doit pas inventer de
capacites: il choisit parmi les primitives exposees par le manager core.

Au demarrage, `wiki-manager` doit initialiser:

- la connexion au LLM depuis la configuration du workspace charge;
- le registry des workspaces;
- le contexte du workspace courant, s'il est deja selectionne;
- la liste des primitives `/...`;
- la liste des MCP configurables;
- la liste des skills disponibles;
- les regles de confirmation.

La resolution de configuration doit respecter le fonctionnement `llm-wiki`:

1. si un workspace est selectionne, lire sa `.wikirc.yaml`;
2. sinon, demarrer en mode limite avec uniquement les commandes `/...` et
   demander a l'utilisateur de selectionner un workspace.

Le shell doit donc pouvoir demarrer sans workspace, mais l'agent devient complet
quand `/use <workspace>` donne acces a la configuration LLM et au contexte
`llm-wiki`.

Exemples d'intentions:

```text
prepare la pipeline Confluence pour juno et rebuild les livrables
```

Plan attendu:

```text
1. /use juno
2. /start cme
3. check cme status
4. run export
5. /wiki doctor
6. /wiki ingest
7. /wiki build --plan
8. demander confirmation
9. /wiki build
```

Autre exemple:

```text
verifie si le workspace est pret pour un agent externe
```

Plan attendu:

```text
1. verifier .env du workspace
2. verifier .wikirc.yaml
3. demarrer mcp-http si necessaire
4. afficher WIKI_MCP_PROXY_URL et token attendu
5. tester l'endpoint MCP
```

Les actions destructives ou couteuses doivent passer par une confirmation:

- suppression de donnees;
- reingestion forcee;
- build/export massif;
- modification de configuration;
- publication externe.

## MCP

Le shell doit savoir decouvrir et piloter les MCP du manager:

Workspace-scoped:

- `wiki mcp-http`;
- `agent-cme`;
- `agent-wiki-production`.

Externes:

- mailer;
- documents;
- atlassian.

Commandes attendues:

```text
/mcp status
/mcp start wiki
/mcp start cme
/mcp start production
/mcp endpoints
/mcp tools cme
/mcp call cme cme_sources_list
```

Le shell doit afficher clairement:

- URL locale;
- token configure ou manquant;
- service running ou stopped;
- dernier test de reachability.

## Skills

Le shell doit charger les skills depuis plusieurs niveaux:

```text
llm-wiki-manager/SKILL.md
llm-wiki-manager/skills/*
workspaces/<workspace>/SKILL.md
workspaces/<workspace>/skills/*
```

Un skill est un workflow operable par l'agent. Exemple deja present:

```text
agent-cme-llm-wiki-pipeline
```

Le shell doit permettre:

```text
/skills
/skill show agent-cme-llm-wiki-pipeline
/skill run agent-cme-llm-wiki-pipeline
```

L'execution d'un skill ne doit pas etre une execution aveugle du Markdown. Le
manager doit en extraire un plan, le presenter, puis executer les primitives
confirmees.

## Coexistence avec serve/UI

`wiki-manager` et `llm-wiki serve` doivent rester deux interfaces du meme
systeme.

Le shell ne doit pas casser:

```bash
./wiki-workspace wiki juno serve
./wiki-workspace up juno
```

Le `serve/UI` reste utile pour:

- navigation visuelle;
- chat web;
- inspection du graphe;
- usage navigateur.

Le `wiki-manager` devient utile pour:

- exploitation terminal;
- orchestration multi-services;
- lancement de pipelines;
- controle MCP;
- workflows skills;
- usage agentique sans UI web.

## Roadmap incrementale

### Etape 1: squelette npm local ✅

- `package.json` (`@dotdrelle/wiki-manager` v0.1.0, ESM, pnpm, Node ≥22).
- `bin/wiki-manager.js` avec `--version`, `--help`, `--once`.
- `wiki-workspace` intact.

### Etape 2: boucle agent-first minimale ✅

Implemente dans `src/shell/repl.js`, `src/agent/graph.js`, `src/agent/llm.js`.

- TUI Donna : header + ligne vide, banner ASCII, panneau MCP a droite, zone
  messages scrollable, ligne vide avant le divider bas, prompt avec curseur
  positionne, ligne vide sous le prompt.
- Spinner anime (braille 80 ms) pendant que Donna reflechit.
- Scrolling de la zone messages : molette souris (3 lignes/cran) et
  Page Up / Page Down (bloc). Indicateur `↑ N more` dans le divider haut.
  Scroll remis a zero a chaque soumission et a chaque reception de reponse.
  Technique : `Transform` stream qui filtre les sequences SGR souris
  (`[<btn;x;yM`) avant `emitKeypressEvents`, evitant la pollution du buffer.
- Streaming, historique saisie fleches haut/bas, Tab-completion des `/`.
- Graphe LangGraph avec noeud orchestrateur, prompt systeme, fallback mode
  limite (fr/en).
- Client LLM OpenAI-compatible : `complete` + `stream` SSE via `fetch`.
- Rendu Markdown terminal : `marked` v15 + `marked-terminal` v7.3.0.
  Bug `marked-terminal` : renderer `text` n'appelle pas `parseInline` sur les
  list items — corrige par un second `marked.use` dans `repl.js`.
- Nettoyage HTML entrant/sortant dans le shell avant interpretation des
  commandes et avant rendu Markdown des retours.
- Primitives : `/help`, `/version`, `/exit`.

### Etape 3: core workspaces ✅

Implemente dans `src/core/`, `src/commands/slash.js`.

- `src/core/env.js` — lecture `.env`.
- `src/core/workspaces.js` — `listWorkspaces`, `findWorkspace` (symlinks).
- `src/core/wikirc.js` — `listWikircProfiles`, `loadWikircProfile`,
  `summarizeWikircConfig` (profils `.wikirc.yaml.*`).
- `src/core/mcp.js` — `buildMcpStatus` depuis `.env` workspace + manager
  (wiki, cme, production, mailer, documents, atlassian).
- Commandes : `/workspaces`, `/use <workspace>`, `/config list|use|status`,
  `/status`.
- `/use <workspace>` charge le `.wikirc.yaml` par defaut, initialise le
  client LLM et la langue, reinitialise le statut MCP dans la session.

### Etape 4: core compose

- Porter l'execution `docker compose`.
- Ajouter:
  - `/services`;
  - `/start <service>`;
  - `/stop <service>`;
  - `/logs <service>`.
- Exposer ces primitives a l'agent pour l'orchestration de services.

### Etape 5: primitives wiki

- Ajouter:
  - `/wiki doctor`;
  - `/wiki ingest`;
  - `/wiki build --plan`;
  - `/wiki build`;
  - `/wiki run <args...>`.

Ces commandes appellent toujours l'image `dotdrelle/llm-wiki`.
L'agent peut alors piloter directement le backoffice `llm-wiki`.

### Etape 6: MCP cockpit

- Afficher des le step 2 un panneau MCP decoratif/fonctionnel base sur les
  variables `.env` disponibles.
- Ajouter `/mcp status`.
- Ajouter `/mcp endpoints`.
- Ajouter les checks de reachability.
- Ajouter l'appel MCP direct si necessaire.
- Exposer les endpoints, tokens disponibles et outils MCP au contexte agent.

### Etape 7: skills

- Implementer discovery.
- Implementer `/skills`.
- Implementer `/skill show`.
- Implementer une premiere execution guidee du skill Confluence pipeline.
- Exposer les skills disponibles a l'agent.

### Etape 8: publication npm

- Stabiliser les chemins runtime hors dossier npm.
- Packager les assets.
- Tester `npm pack`.
- Tester installation globale.
- Documenter Docker comme prerequis.

## Contraintes de conception

- Ne pas modifier `llm-wiki` pour ce premier chantier.
- Ne pas dupliquer la logique metier du wiki.
- Garder `wiki-workspace` fonctionnel pendant toute la migration.
- Preferer des primitives explicites et testables a un agent opaque.
- Toute action couteuse ou destructive doit etre confirmee.
- Les secrets restent dans `.env` et `.wikirc.yaml`, jamais dans l'historique du
  shell.

## Definition du premier increment utile

Le premier increment doit permettre:

```bash
./wiki-manager
```

Puis:

```text
donna> /workspaces
donna> /use juno
juno> /config list
juno> /config use openai
juno> /status
juno> /services
juno> /start mcp
juno> /wiki doctor
juno> /wiki build --plan
juno> verifie que le workspace est pret pour une pipeline Confluence
```

Ce premier increment valide:

- le binaire separe;
- la lecture du registry workspace;
- le contexte de session;
- l'orchestration Docker Compose;
- le lien direct avec le backoffice `llm-wiki`;
- la boucle agentique par defaut pour les entrees sans prefixe `/`;
- le TUI Donna et son panneau MCP;
- la langue d'echange issue du `.wikirc.yaml`.
