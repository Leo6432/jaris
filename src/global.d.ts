import type {
  AnalysisScope,
  AppMode,
  AppVersionStatus,
  AudioInputDevice,
  CapacityScanResult,
  ChatMessage,
  ContextLengthOptions,
  ConversationEntry,
  ConversationList,
  CodeGenProgress,
  GeneratedApp,
  GeneratedAppSummary,
  ModelChoiceInfo,
  ModelChoiceMode,
  MyModelPicks,
  JarisEmotion,
  MemoryGraph,
  MicTestDonePayload,
  MicTestLevelPayload,
  SttBenchmarkResult,
  ModelOverviewResult,
  ModelsLocationStatus,
  OllamaVersionStatus,
  PickedImageFile,
  Profile,
  RuntimeSetupProgress,
  RuntimeSetupStatus,
  SoundCue,
  UpdateCheckResult,
  UpdateProgress,
  VoiceReplyPayload,
  VoiceSetupStatusPayload,
  WidgetMode
} from '../shared/ipc'

export {}

declare global {
  interface Window {
    jaris: {
      onEmotion: (cb: (emotion: JarisEmotion) => void) => () => void
      onTranscript: (cb: (text: string) => void) => () => void
      onReply: (cb: (payload: VoiceReplyPayload) => void) => () => void
      onLog: (cb: (message: string) => void) => () => void
      onChatStreamToken: (cb: (delta: string) => void) => () => void
      onSetupStatus: (cb: (status: VoiceSetupStatusPayload) => void) => () => void
      getSetupStatus: () => Promise<VoiceSetupStatusPayload>
      triggerWake: () => void
      notifyAudioEnded: () => void
      getProfile: () => Promise<Profile | null>
      saveProfile: (profile: Profile) => Promise<void>
      openMemoryFolder: () => Promise<void>
      getMemoryGraph: () => Promise<MemoryGraph>
      getMemoryNoteContent: (title: string) => Promise<string>
      previewVoice: (voice: string) => Promise<ArrayBuffer>
      notifyOnboardingFinished: () => void
      openSettings: () => void
      getConversationHistory: () => Promise<ConversationEntry[]>
      clearConversationHistory: () => Promise<void>
      openConversationHistoryFile: () => Promise<void>
      getModelOverview: () => Promise<ModelOverviewResult>
      getContextLengthOptions: () => Promise<ContextLengthOptions>
      setContextLength: (contextLength: number | undefined) => Promise<void>
      getOllamaVersionStatus: () => Promise<OllamaVersionStatus | null>
      updateOllama: () => Promise<{ success: boolean; message: string }>
      getAppVersionStatus: () => Promise<AppVersionStatus | null>
      updateApp: () => Promise<{ success: boolean; message: string }>
      // Étape 98 : avancement du téléchargement de l'installeur, sans lequel le bouton "Mettre à jour"
      // restait figé plusieurs minutes sans rien dire ("on ne sait pas quand c'est terminé", Léo).
      onUpdateProgress: (cb: (progress: UpdateProgress) => void) => () => void
      getAppVersion: () => Promise<string>
      checkForUpdate: () => Promise<UpdateCheckResult>
      getModelsLocationStatus: () => Promise<ModelsLocationStatus>
      chooseModelsLocation: () => Promise<{ success: boolean; message: string }>
      onModelsLocationProgress: (cb: (message: string) => void) => () => void
      getRuntimeSetupStatus: () => Promise<RuntimeSetupStatus>
      runRuntimeSetup: () => Promise<RuntimeSetupStatus>
      onRuntimeSetupProgress: (cb: (progress: RuntimeSetupProgress) => void) => () => void
      runModelAnalysis: (scope?: AnalysisScope) => Promise<CapacityScanResult>
      getMyModelPicks: () => Promise<MyModelPicks>
      deleteUnusedModel: (model: string) => Promise<void>
      getModelChoice: (mode: ModelChoiceMode) => Promise<ModelChoiceInfo>
      setModelChoice: (mode: ModelChoiceMode, model: string | null) => Promise<void>
      runQuickSetup: () => Promise<CapacityScanResult>
      onModelBenchmarkLine: (cb: (line: string) => void) => () => void
      getNewModels: () => Promise<string[]>
      acknowledgeNewModels: () => Promise<void>
      // imageBase64 (étape 91) : image déjà réduite et encodée par src/lib/imageAttachment.ts, sans le
      // préfixe "data:...;base64,". Lue par le modèle de vision, jamais par celui de conversation/de code.
      sendChatMessage: (prompt: string, imageBase64?: string) => Promise<ChatMessage>
      getChatHistory: () => Promise<ChatMessage[]>
      listConversations: () => Promise<ConversationList>
      createConversation: () => Promise<ConversationList>
      selectConversation: (id: string) => Promise<ConversationList>
      deleteConversation: (id: string) => Promise<ConversationList>
      // Étape 93 : sélecteur d'image ouvert par le main process (jamais un <input type="file">, qui repliait
      // Jaris en widget en prenant le focus). null si l'utilisateur annule.
      pickImageFile: () => Promise<PickedImageFile | null>
      generateApp: (description: string, currentHtml?: string, imageBase64?: string) => Promise<GeneratedApp>
      onCodeGenStatus: (cb: (message: string) => void) => () => void
      // Étape 99 : avancement en direct pendant une génération (l'étape en cours, les caractères déjà
      // écrits, le temps depuis le dernier signe de vie) et arrêt d'une génération déjà partie.
      onCodeGenProgress: (cb: (progress: CodeGenProgress) => void) => () => void
      cancelCodeGen: () => void
      openGeneratedApp: (path?: string) => Promise<void>
      getGeneratedApps: () => Promise<GeneratedAppSummary[]>
      loadGeneratedApp: (path: string) => Promise<GeneratedApp>
      deleteGeneratedApp: (path: string) => Promise<void>
      listAudioInputDevices: () => Promise<AudioInputDevice[]>
      setAudioInputDevice: (deviceIndex: number | null) => Promise<void>
      setWakewordEnabled: (enabled: boolean) => Promise<void>
      testMicrophone: () => void
      runSttBenchmark: () => Promise<SttBenchmarkResult>
      onSttBenchmarkProgress: (cb: (message: string) => void) => () => void
      stopTestMicrophone: () => void
      setActiveMode: (mode: AppMode) => void
      setOptionsOpen: (open: boolean) => void
      getWidgetMode: () => Promise<WidgetMode>
      onWidgetMode: (cb: (mode: WidgetMode) => void) => () => void
      setChatWidgetHeight: (height: number | null) => void
      setChatWidgetKeepOpen: (keepOpen: boolean) => void
      armChatWidgetPointer: () => void
      collapseChatWidget: () => void
      onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => () => void
      onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => () => void
      onSoundCue: (cb: (cue: SoundCue) => void) => () => void
    }
  }
}
