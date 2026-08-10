/** Encode des frames PCM 16-bit mono en un buffer WAV (44 octets d'en-tête + data). */
export function framesToWav(frames: Int16Array[], sampleRate: number): Buffer {
  const sampleCount = frames.reduce((sum, frame) => sum + frame.length, 0)
  const dataSize = sampleCount * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // taille du sous-bloc fmt
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate (mono, 16-bit)
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits par échantillon
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  let offset = 44
  for (const frame of frames) {
    for (const sample of frame) {
      buffer.writeInt16LE(sample, offset)
      offset += 2
    }
  }

  return buffer
}
