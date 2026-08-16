import nodemailer from 'nodemailer'
import { config } from '../config'

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter(): ReturnType<typeof nodemailer.createTransport> {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass }
    })
  }
  return transporter
}

/** Envoie un mail via le compte SMTP configuré dans `.env`. */
export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    return "Envoi de mail impossible : la configuration SMTP n'est pas renseignée dans le fichier .env (voir le README)."
  }

  if (!to.trim() || !to.includes('@')) {
    return "Envoi de mail impossible : aucune adresse mail claire n'a été donnée pour le destinataire."
  }

  const senderAddress = (config.smtp.from || config.smtp.user).trim().toLowerCase()
  if (to.trim().toLowerCase() === senderAddress) {
    return "Envoi de mail bloqué : le destinataire donné correspond à l'adresse d'envoi elle-même, ce qui " +
      "n'est probablement pas voulu. Redemande l'adresse exacte du destinataire à l'utilisateur."
  }

  try {
    await getTransporter().sendMail({
      from: config.smtp.from || config.smtp.user,
      to,
      subject,
      text: body
    })
    return `Mail envoyé à ${to}.`
  } catch (err) {
    return `Échec de l'envoi du mail : ${err instanceof Error ? err.message : String(err)}`
  }
}
