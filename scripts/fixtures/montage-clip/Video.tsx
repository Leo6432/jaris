import { AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig } from 'remotion'

export const durationInSeconds = 1.5

export const Video = () => {
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile('clip1.mp4')} trimBefore={Math.round(0.5 * fps)} trimAfter={Math.round(2 * fps)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 80 }}>
        <h1 style={{ color: 'white', fontSize: 120, fontFamily: 'Segoe UI, Arial, sans-serif' }}>VACANCES</h1>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
