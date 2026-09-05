import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import nodemailer from 'nodemailer'

/**
 * Configuration SMTP choisie par l'utilisateur dans Options → Connexions, chiffrée sur le disque (même
 * mécanisme que le jeton Gmail, voir googleAuth.ts) — jamais dans le profil en clair, `pass` étant un vrai
 * mot de passe (d'application).
 *
 * Alternative à la connexion Gmail (OAuth, Google Cloud Console) pour l'envoi de mails : un mot de passe
 * d'application (myaccount.google.com/apppasswords pour Gmail, équivalent chez les autres fournisseurs)
 * marche avec N'IMPORTE QUEL compte mail, sans jamais créer de projet Google Cloud ni d'identifiant OAuth.
 * Pour l'étape 16 (zéro compte à créer pour le public), c'est même préférable à Gmail OAuth : ça évite le
 * processus de vérification d'application Google (obligatoire au-delà de 100 utilisateurs, écran "app non
 * vérifiée" qui inquiète l'utilisateur) que l'étape 38 (mise sur le marché) finirait par imposer.
 */
export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  /** Adresse affichée comme expéditeur, vide = identique à `user`. */
  from?: string
}

export interface SmtpStatus {
  connected: boolean
  email: string | null
}

const smtpConfigPath = join(app.getPath('userData'), 'smtp-config.enc')

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const encrypted = await readFile(smtpConfigPath)
    return JSON.parse(safeStorage.decryptString(encrypted)) as SmtpConfig
  } catch {
    return null
  }
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  const stored = await getSmtpConfig()
  return { connected: stored !== null, email: stored?.user ?? null }
}

export async function clearSmtpConfig(): Promise<void> {
  await rm(smtpConfigPath, { force: true })
}

/**
 * Vérifie que la configuration marche VRAIMENT (connexion + authentification réelles, `transporter.verify`
 * de nodemailer) avant de l'enregistrer : sans ça, une faute de frappe dans le mot de passe ne se
 * découvrirait qu'au premier envoi de mail réel demandé par l'utilisateur, bien plus tard et sans lien
 * évident avec la configuration qu'il vient de faire.
 */
export async function saveSmtpConfig(smtpConfig: SmtpConfig): Promise<{ success: boolean; message: string }> {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass }
  })

  try {
    await transporter.verify()
  } catch (err) {
    return { success: false, message: `Connexion impossible : ${err instanceof Error ? err.message : String(err)}` }
  }

  await writeFile(smtpConfigPath, safeStorage.encryptString(JSON.stringify(smtpConfig)))
  return { success: true, message: `Compte ${smtpConfig.user} connecté.` }
}
