import type {
  AnalysisScope,
  AudioInputDevice,
  CapacityScanResult,
  ChatMessage,
  ConversationEntry,
  GeneratedApp,
  GmailStatus,
  JarisEmotion,
  MemoryGraph,
  MicTestDonePayload,
  MicTestLevelPayload,
  ModelOverviewResult,
  OllamaVersionStatus,
  Profile,
  VoiceReplyPayload,
  VoiceSetupStatusPayload
} from '../shared/ipc'

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
      notifyOnboardingFinished: () => void
      openSettings: () => void
      getConversationHistory: () => Promise<ConversationEntry[]>
      clearConversationHistory: () => Promise<void>
      openConversationHistoryFile: () => Promise<void>
      getModelOverview: () => Promise<ModelOverviewResult>
      getOllamaVersionStatus: () => Promise<OllamaVersionStatus | null>
      runModelAnalysis: (scope?: AnalysisScope) => Promise<CapacityScanResult>
      onModelBenchmarkLine: (cb: (line: string) => void) => () => void
      getNewModels: () => Promise<string[]>
      acknowledgeNewModels: () => Promise<void>
      sendChatMessage: (prompt: string) => Promise<ChatMessage>
      getChatHistory: () => Promise<ChatMessage[]>
      generateApp: (description: string, currentHtml?: string) => Promise<GeneratedApp>
      onCodeGenStatus: (cb: (message: string) => void) => () => void
      openGeneratedApp: (path?: string) => Promise<void>
      listAudioInputDevices: () => Promise<AudioInputDevice[]>
      setAudioInputDevice: (deviceIndex: number | null) => Promise<void>
      testMicrophone: () => void
      stopTestMicrophone: () => void
      onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => () => void
      onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => () => void
    }
  }
}
