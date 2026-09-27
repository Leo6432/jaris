import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'

export const durationInSeconds = 2

const Title = ({ text }: { text: string }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const scale = spring({ frame, fps, config: { damping: 200 } })
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ color: 'white', fontSize: 160, fontFamily: 'Segoe UI, Arial, sans-serif', transform: `scale(${scale})`, opacity }}>{text}</h1>
    </AbsoluteFill>
  )
}

export const Video = () => (
  <AbsoluteFill style={{ background: 'linear-gradient(135deg, #031b3a, #0a4d8c)' }}>
    <Sequence durationInFrames={30}><Title text="JARIS" /></Sequence>
    <Sequence from={30}><Title text="Montage" /></Sequence>
  </AbsoluteFill>
)
