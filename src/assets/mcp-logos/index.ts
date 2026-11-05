/**
 * Étape 424 (Léo : « les logos des entreprises, pas des lettres ») : le logo de chaque service de « Découvrir », pris
 * sur le site de l'entreprise (son icône d'application), réduit à 64 px et livré avec Jaris — rien n'est téléchargé
 * pendant l'usage. Des imports écrits un par un (et non import.meta.glob) : le test de l'écran construit avec esbuild.
 * test-mcp.mjs vérifie que chaque entrée du catalogue a son logo ici.
 */
import adobe from './adobe.png'
import adspirer from './adspirer.png'
import airtable from './airtable.png'
import airwallex from './airwallex.png'
import atlassian from './atlassian.png'
import canva from './canva.png'
import cloudflare from './cloudflare.png'
import cloudinary from './cloudinary.png'
import codewords from './codewords.png'
import cpln from './cpln.png'
import datarails from './datarails.png'
import dropbox from './dropbox.png'
import fastmail from './fastmail.png'
import figma from './figma.png'
import fourthwall from './fourthwall.png'
import higgsfield from './higgsfield.png'
import huggingface from './huggingface.png'
import linear from './linear.png'
import macaly from './macaly.png'
import metricool from './metricool.png'
import miro from './miro.png'
import moda from './moda.png'
import monday from './monday.png'
import morningstar from './morningstar.png'
import motion from './motion.png'
import mychatbot from './mychatbot.png'
import notion from './notion.png'
import nutshell from './nutshell.png'
import omni from './omni.png'
import orshot from './orshot.png'
import paperoffice from './paperoffice.png'
import pinelabs from './pinelabs.png'
import plaid from './plaid.png'
import polar from './polar.png'
import ringcentral from './ringcentral.png'
import salesflare from './salesflare.png'
import salesloft from './salesloft.png'
import supabase from './supabase.png'
import superhuman from './superhuman.png'
import supermetrics from './supermetrics.png'
import todoist from './todoist.png'
import typefully from './typefully.png'
import windsor from './windsor.png'
import zapier from './zapier.png'

export const MCP_LOGOS: Readonly<Record<string, string>> = {
  'adobe': adobe,
  'adspirer': adspirer,
  'airtable': airtable,
  'airwallex': airwallex,
  'atlassian': atlassian,
  'canva': canva,
  'cloudflare': cloudflare,
  'cloudinary': cloudinary,
  'codewords': codewords,
  'cpln': cpln,
  'datarails': datarails,
  'dropbox': dropbox,
  'fastmail': fastmail,
  'figma': figma,
  'fourthwall': fourthwall,
  'higgsfield': higgsfield,
  'huggingface': huggingface,
  'linear': linear,
  'macaly': macaly,
  'metricool': metricool,
  'miro': miro,
  'moda': moda,
  'monday': monday,
  'morningstar': morningstar,
  'motion': motion,
  'mychatbot': mychatbot,
  'notion': notion,
  'nutshell': nutshell,
  'omni': omni,
  'orshot': orshot,
  'paperoffice': paperoffice,
  'pinelabs': pinelabs,
  'plaid': plaid,
  'polar': polar,
  'ringcentral': ringcentral,
  'salesflare': salesflare,
  'salesloft': salesloft,
  'supabase': supabase,
  'superhuman': superhuman,
  'supermetrics': supermetrics,
  'todoist': todoist,
  'typefully': typefully,
  'windsor': windsor,
  'zapier': zapier
}
