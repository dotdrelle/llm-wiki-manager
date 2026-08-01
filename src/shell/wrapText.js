/**
 * Découpe un texte en lignes tenant dans la largeur d'une boîte TUI.
 *
 * Le wizard rendait chaque libellé, note ou erreur dans un `<text height={1}>` :
 * au delà de la largeur du dialogue le texte était coupé net, sans ellipse ni
 * indice. Les phrases les plus utiles — la note d'une étape, la cause d'une
 * erreur de connexion — sont les plus longues, donc les plus tronquées.
 *
 * Le module est volontairement en JavaScript pur, hors du composant : c'est ce
 * qui le rend testable sans transpiler du JSX.
 *
 * @param {string} text texte à découper ; les `\n` explicites sont respectés.
 * @param {number} width largeur utile en colonnes.
 * @param {number} maxLines nombre de lignes maximum ; la dernière est
 *   marquée d'une ellipse quand il reste du texte, pour que la troncature
 *   restante soit au moins visible.
 * @returns {string[]}
 */
export function wrapText(text, width, maxLines = 6) {
  const safeWidth = Math.max(8, Math.floor(width) || 8);
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      // Un mot plus long que la boîte — une URL, un chemin, un nom de modèle
      // qualifié — est coupé plutôt que de déborder : mieux vaut le lire en
      // deux morceaux que pas du tout.
      if (word.length > safeWidth) {
        if (current) {
          lines.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += safeWidth) {
          lines.push(word.slice(i, i + safeWidth));
        }
        current = lines.pop() ?? '';
        continue;
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= safeWidth) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = `${last.slice(0, Math.max(1, safeWidth - 1))}…`;
  return kept;
}
