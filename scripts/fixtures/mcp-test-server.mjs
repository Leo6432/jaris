// Étape 418 : un VRAI petit serveur MCP (kit officiel), lancé par Jaris dans test-mcp-hub.mjs comme n'importe quel
// serveur de Léo : `node mcp-test-server.mjs [mode]`. Mode « broken » : écrit une erreur et s'arrête au démarrage.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mode = process.argv[2] ?? 'ok'
if (mode === 'broken') {
  process.stderr.write('Erreur : la variable API_KEY est manquante.\n')
  process.exit(2)
}

const server = new McpServer({ name: 'test', version: '1.0.0' })
server.registerTool(
  'list_files',
  { description: 'List the files of a folder', inputSchema: { folder: z.string() }, annotations: { readOnlyHint: true } },
  async ({ folder }) => ({ content: [{ type: 'text', text: `${folder}: notes.txt, photo.jpg` }] })
)
server.registerTool(
  'add_numbers',
  { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
)
server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'Jeton GitHub refusé (401).' }], isError: true }))
server.registerTool('secret', { description: 'Reads the SECRET environment variable' }, async () => ({
  content: [{ type: 'text', text: `secret=${process.env.SECRET ?? 'absent'}` }]
}))
server.registerTool('crash', { description: 'Stops the server' }, async () => {
  process.stderr.write('Plantage volontaire du serveur de test.\n')
  setTimeout(() => process.exit(3), 10)
  return { content: [{ type: 'text', text: 'bye' }] }
})
await server.connect(new StdioServerTransport())
