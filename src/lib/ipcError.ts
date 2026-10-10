/**
 * Message d'une erreur venue du main, sans le préfixe technique qu'Electron ajoute à toute erreur IPC
 * (« Error invoking remote method 'jaris:…': Error: »). Les messages du main sont déjà écrits pour Léo.
 */
export function ipcErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(err)
}
