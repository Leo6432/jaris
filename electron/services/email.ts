import nodemailer from 'nodemailer'
import { config } from '../config'
import { disconnectGmail, getGmailClient, getGmailStatus } from './googleAuth'
import { getSmtpConfig, type SmtpConfig } from './smtpStore'

function buildRawGmailMessage(to: string, subject: string, body: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')
  return Buffer.from(message).toString('base64url')
}

/**
 * La configuration choisie dans Options → Connexions (smtpStore.ts, chiffrée) est toujours prioritaire sur
 * celle du `.env` : c'est la seule que l'application installée (sans .env, voir étape 16) peut jamais
 * avoir, et rien n'empêche un développeur d'avoir les deux — celle des Options doit gagner puisqu'elle a
 * été choisie explicitement par l'utilisateur, plus récemment qu'un .env jamais retouché depuis.
 */
async function resolveSmtpConfig(): Promise<SmtpConfig | null> {
  const stored = await getSmtpConfig()
  if (stored) return stored
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) return null
  return { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, user: config.smtp.user, pass: config.smtp.pass, from: config.smtp.from }
}

async function sendViaSmtp(to: string, subject: string, body: string): Promise<string> {
  const smtpConfig = await resolveSmtpConfig()
  if (!smtpConfig) {
    return "Envoi de mail impossible : connecte un compte mail depuis Options → Connexions (Gmail, ou un autre compte via mot de passe d'application)."
  }

  const senderAddress = (smtpConfig.from || smtpConfig.user).trim().toLowerCase()
  if (to.trim().toLowerCase() === senderAddress) {
    return (
      "Envoi de mail bloqué : le destinataire donné correspond à l'adresse d'envoi elle-même, ce qui " +
      "n'est probablement pas voulu. Redemande l'adresse exacte du destinataire à l'utilisateur."
    )
  }

  // Un nouveau transporter à chaque envoi plutôt qu'un mis en cache : la configuration peut changer d'un
  // envoi à l'autre (compte reconnecté depuis Options entre-temps), et l'envoi de mail reste bien assez
  // rare pour que le coût de recréer un transporter à chaque fois soit négligeable.
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass }
  })

  try {
    await transporter.sendMail({ from: smtpConfig.from || smtpConfig.user, to, subject, text: body })
    return `Mail envoyé à ${to}.`
  } catch (err) {
    return `Échec de l'envoi du mail : ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Envoie via le compte Gmail connecté (étape 11) si disponible, sinon via la configuration SMTP de secours. */
export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  if (!to.trim() || !to.includes('@')) {
    return "Envoi de mail impossible : aucune adresse mail claire n'a été donnée pour le destinataire."
  }

  const gmailClient = await getGmailClient()
  if (!gmailClient) return sendViaSmtp(to, subject, body)

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
