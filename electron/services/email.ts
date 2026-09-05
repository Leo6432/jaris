import { disconnectGmail, getGmailClient, getGmailStatus } from './googleAuth'

function buildRawGmailMessage(to: string, subject: string, body: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')
  return Buffer.from(message).toString('base64url')
}

/** Envoie via le compte Gmail connecté (étape 11). */
export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  if (!to.trim() || !to.includes('@')) {
    return "Envoi de mail impossible : aucune adresse mail claire n'a été donnée pour le destinataire."
  }

  const gmailClient = await getGmailClient()
  if (!gmailClient) {
    return 'Envoi de mail impossible : connecte un compte Gmail depuis Options → Connexions.'
  }

  const status = await getGmailStatus()
  if (status.email && to.trim().toLowerCase() === status.email.trim().toLowerCase()) {
    return (
      'Envoi de mail bloqué : le destinataire donné correspond au compte Gmail connecté lui-même, ce qui ' +
      "n'est probablement pas voulu. Redemande l'adresse exacte du destinataire à l'utilisateur."
    )
  }

  try {
    await gmailClient.request({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      method: 'POST',
      data: { raw: buildRawGmailMessage(to, subject, body) }
    })
    return `Mail envoyé à ${to} depuis le compte Gmail connecté.`
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Le refresh token stocké est mort côté Google (accès révoqué depuis myaccount.google.com, mot de passe
    // changé, ou expiration au bout de 7 jours propre aux apps OAuth encore en statut "Testing" sur Google
    // Cloud Console) : il ne redeviendra jamais valide tout seul, retenter ne fait que répéter la même
    // erreur (observé : 3 tentatives d'affilée vers 3 destinataires différents, toutes en invalid_grant). Le
    // supprimer tout de suite remet le menu Options en état "non connecté" au lieu de rester bloqué sur un
    // faux "connecté" qui échoue silencieusement à chaque futur envoi.
    if (message.toLowerCase().includes('invalid_grant')) {
      await disconnectGmail()
      return (
        "Échec de l'envoi : la connexion au compte Gmail a expiré ou a été révoquée, et a été déconnectée " +
        "automatiquement. Explique à l'utilisateur qu'il doit reconnecter son compte Gmail depuis Options → " +
        'Connexions avant de pouvoir renvoyer ce mail.'
      )
    }

    return `Échec de l'envoi du mail via Gmail : ${message}`
  }
}
