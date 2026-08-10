import { spawn } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from '../config'

/** Synthétise `text` en audio via Piper (binaire natif) et renvoie un WAV. */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'jaris-tts-'))
  const outFile = join(dir, 'speech.wav')

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(config.piper.binPath, ['-m', config.piper.voicePath, '-f', outFile])
      let stderr = ''
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`piper a échoué (code ${code}): ${stderr}`))
      })
      proc.stdin.write(text)
      proc.stdin.end()
    })

    return await readFile(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
