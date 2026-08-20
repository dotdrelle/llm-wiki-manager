/**
 * Le « contexte d'artefact courant » — la boucle documentaire continue.
 *
 * Quand Donna édite ou ouvre un artefact éditable (template, build-context,
 * page wiki), on mémorise ce chemin au niveau de la session, comme la
 * conversation, pour qu'un tour suivant puisse dire « améliore cette slide »
 * sans que le modèle doive deviner quel fichier est concerné.
 *
 * Seuls les artefacts *éditables* sont suivis : templates/, build-context/ et
 * wiki/. Les livrables générés (deliverables/) ne le sont pas — on les régénère,
 * on ne les édite pas.
 */

const ARTIFACT_KIND_BY_TOOL = {
  template_write: 'template',
  template_read: 'template',
  build_context_write: 'build-context',
  wiki_write_page: 'wiki page',
};

export function artifactFromToolCall(tool, args) {
  const kind = ARTIFACT_KIND_BY_TOOL[String(tool ?? '')];
  if (!kind) return null;
  const pathValue = args && typeof args === 'object' ? args.path : null;
  if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
  return { path: pathValue.trim(), kind };
}

export function currentArtifactFor(session) {
  const artifact = session?.currentArtifact;
  if (!artifact || !artifact.path) return null;
  if (artifact.workspace && session?.workspace && artifact.workspace !== session.workspace) return null;
  return artifact;
}

export function rememberArtifact(session, { path, kind }) {
  if (!session || typeof path !== 'string' || !path.trim()) return;
  session.currentArtifact = {
    workspace: session.workspace ?? null,
    path: path.trim(),
    kind,
    at: Date.now(),
  };
}

export function currentArtifactPromptLine(artifact) {
  if (!artifact) return null;
  return `Current artifact: the user is working on ${artifact.path} (${artifact.kind}). When the user refers to "this document", "this slide", "the template", "the page", or the document without naming the file, treat ${artifact.path} as the artifact being edited: read it first, then apply the requested edit and save it with the matching write tool.`;
}
