import type { CapacityScanResult, GmailStatus, JarisEmotion, MemoryGraph, Profile, VoiceReplyPayload, VoiceSetupStatusPayload } from '../shared/ipc'

export {}

declare global {
  interface Window {
    jaris: {
      onEmotion: (cb: (emotion: JarisEmotion) => void) => () => void
      onTranscript: (cb: (text: string) => void) => () => void
      onReply: (cb: (payload: VoiceReplyPayload) => void) => () => void
      onLog: (cb: (message: string) => void) => () => void
      onSetupStatus: (cb: (status: VoiceSetupStatusPayload) => void) => () => void
      getSetupStatus: () => Promise<VoiceSetupStatusPayload>
      triggerWake: () => void
      notifyAudioEnded: () => void
      getProfile: () => Promise<Profile | null>
      saveProfile: (profile: Profile) => Promise<void>
      markGmailOnboardingDone: () => Promise<void>
      openMemoryFolder: () => Promise<void>
      getMemoryGraph: () => Promise<MemoryGraph>
      getMemoryNoteContent: (title: string) => Promise<string>
      getGmailStatus: () => Promise<GmailStatus>
      connectGmail: () => Promise<GmailStatus>
      disconnectGmail: () => Promise<void>
      previewVoice: (voice: string) => Promise<ArrayBuffer>
      scanCapacity: () => Promise<CapacityScanResult>
      onCapacityScanStatus: (cb: (message: string) => void) => () => void
      notifyOnboardingFinished: () => void
      openSettings: () => void
    }
  }
}
