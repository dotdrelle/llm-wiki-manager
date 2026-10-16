refresh_project() {
  verify_project_configuration

  printf 'Stopping shared runtime...\n'
  runtime_command down

  local entry workspace
  for entry in "$WORKSPACES_DIR"/*; do
    [[ -f "$entry/.env" ]] || continue
    workspace="$(basename "$entry")"
    printf 'Removing workspace stack and images: %s\n' "$workspace"
    compose_for_workspace "$workspace" down --rmi all --remove-orphans
  done

  printf 'Removing external-agent stack and images...\n'
  agents_compose purge

  # `refresh` promet un état propre : le vérifier plutôt que l'affirmer. Un
  # port encore tenu ici signifie qu'il l'est par un processus étranger, que
  # `runtime down` refuse de tuer à raison — mais le taire ferait échouer le
  # prochain démarrage sans que personne ne fasse le lien.
  local leftover
  leftover="$(runtime_port_pids "$(runtime_port)")"
  if [[ -n "$leftover" ]]; then
    printf 'Refresh incomplete: port %s is still held by pid(s) %s.\n' \
      "$(runtime_port)" "$(printf '%s' "$leftover" | tr '\n' ' ')" >&2
    printf 'It is not a wiki-manager runtime, so it was left running. Free the port, or set WIKI_MANAGER_RUNTIME_PORT to another one.\n' >&2
    return 1
  fi
  printf 'Refresh complete. Persistent workspace and agent data were preserved.\n'
  printf 'Configuration changes above take effect when the runtime and agent stacks are started again.\n'
}

verify_project_configuration() {
  command -v node >/dev/null 2>&1 || die "refresh configuration checks require Node.js 22"
  printf 'Checking manager configuration and applying safe compatibility migrations...\n'
  WIKI_MANAGER_ENV_FILE="$MANAGER_ENV_FILE" \
  WIKI_MANAGER_ENDPOINTS_FILE="$MANAGER_ENDPOINTS_FILE" \
    node "$ROOT_DIR/bin/check-project-config.js"

  printf 'Checking external-agent Compose configuration...\n'
  if ! agents_compose config; then
    printf 'Refresh aborted before teardown: external-agent Compose configuration is invalid.\n' >&2
    return 1
  fi

  local entry workspace checked=0
  for entry in "$WORKSPACES_DIR"/*; do
    [[ -f "$entry/.env" ]] || continue
    workspace="$(basename "$entry")"
    printf 'Checking workspace Compose configuration: %s\n' "$workspace"
    if ! compose_for_workspace "$workspace" config >/dev/null; then
      printf 'Refresh aborted before teardown: Compose configuration is invalid for workspace %s.\n' "$workspace" >&2
      return 1
    fi
    checked=$((checked + 1))
  done
  printf 'Compose configuration check passed (%s workspace(s)).\n' "$checked"
}
