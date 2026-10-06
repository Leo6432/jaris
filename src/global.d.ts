import type { ThinkValue } from '../shared/effort'
import type { VideoQuality } from '../shared/videoModel'
import type {
  AppMode,
  AppVersionStatus,
  LaunchAtStartupStatus,
  PhoneAccessStatus,
  PhonePairing,
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
  VoiceTestStartResult,
  MicTestLevelPayload,
  WakeTestHeardPayload,
  ModelOverviewResult,
  ModelsLocationStatus,
  OllamaVersionStatus,
  PickedImageFile,
  SaveImageResult,
  GeneratedImageSummary,
  GeneratedVideoSummary,
  ImageStudioStatus,
  VideoStudioStatus,
  Profile,
  RuntimeSetupProgress,
  RuntimeSetupStatus,
  SoundCue,
  UpdateCheckResult,
  UpdateProgress,
  VoiceReplyPayload,
  VoiceSetupStatusPayload,
  WidgetMode,
  PilotDuelCaptureInfo,
  PilotDuelOutcome
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
      openRequestJournal: (reveal: boolean) => Promise<void>
      pilotDuelCapture: () => Promise<PilotDuelCaptureInfo>
      pilotDuelReset: () => Promise<PilotDuelCaptureInfo>
      pilotDuelRun: () => Promise<PilotDuelOutcome>
      pilotDuelOpenReport: () => Promise<void>
      onPilotDuelProgress: (callback: (message: string) => void) => () => void
      getModelOverview: () => Promise<ModelOverviewResult>
      getContextLengthOptions: () => Promise<ContextLengthOptions>
      setContextLength: (contextLength: number | undefined) => Promise<void>
      getOllamaVersionStatus: () => Promise<OllamaVersionStatus | null>
      updateOllama: () => Promise<{ success: boolean; message: string; installerPending?: boolean }>
      onOllamaVersionStatus: (cb: (status: OllamaVersionStatus) => void) => () => void
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
      getMyModelPicks: () => Promise<MyModelPicks>
      deleteUnusedModel: (model: string) => Promise<void>
      getModelChoice: (mode: ModelChoiceMode) => Promise<ModelChoiceInfo>
      setThinkChoice: (mode: ModelChoiceMode, think: ThinkValue | null) => Promise<void>
      setModelChoice: (mode: ModelChoiceMode, model: string | null) => Promise<void>
      runQuickSetup: () => Promise<CapacityScanResult>
      getUnscoredModels: () => Promise<string[]>
      testUnscoredModels: () => Promise<{ models: string[]; resultsPath: string }>
      showUnscoredResults: () => Promise<void>
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
      saveGeneratedImage: (dataUrl: string) => Promise<SaveImageResult>
      getImageStudioStatus: () => Promise<ImageStudioStatus>
      installImageStudio: () => Promise<void>
      onImageStudioLog: (cb: (message: string) => void) => () => void
      generateStudioImage: (prompt: string) => Promise<GeneratedImageSummary>
      cancelStudioImage: () => void
      listGeneratedImages: () => Promise<GeneratedImageSummary[]>
      readGeneratedImage: (fileName: string) => Promise<string | null>
      deleteGeneratedImage: (fileName: string) => Promise<void>
      openGeneratedImages: (fileName?: string) => Promise<void>
      getVideoStudioStatus: () => Promise<VideoStudioStatus>
      installVideoStudio: (quality: VideoQuality) => Promise<void>
      onVideoStudioLog: (cb: (message: string) => void) => () => void
      generateStudioVideo: (
        prompt: string,
        image?: { base64: string; mimeType?: string } | null,
        seconds?: number,
        quality?: VideoQuality
      ) => Promise<GeneratedVideoSummary>
      cancelStudioVideo: () => void
      listGeneratedVideos: () => Promise<GeneratedVideoSummary[]>
      readGeneratedVideo: (fileName: string) => Promise<Uint8Array>
      deleteGeneratedVideo: (fileName: string) => Promise<void>
      saveGeneratedVideo: (fileName: string) => Promise<SaveImageResult>
      openGeneratedVideos: (fileName?: string) => Promise<void>
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
      testMicrophone: () => Promise<VoiceTestStartResult>
      stopTestMicrophone: () => void
      testWakeWord: () => Promise<VoiceTestStartResult>
      stopTestWakeWord: () => void
      onWakeTestHeard: (cb: (payload: WakeTestHeardPayload) => void) => () => void
      setActiveMode: (mode: AppMode) => void
      setOptionsOpen: (open: boolean) => void
      getLaunchAtStartup: () => Promise<LaunchAtStartupStatus>
      setLaunchAtStartup: (enabled: boolean) => Promise<LaunchAtStartupStatus>
      getWidgetMode: () => Promise<WidgetMode>
      onWidgetMode: (cb: (mode: WidgetMode) => void) => () => void
      setChatWidgetHeight: (height: number | null) => void
      setChatWidgetKeepOpen: (keepOpen: boolean) => void
      armChatWidgetPointer: () => void
      collapseChatWidget: () => void
      onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => () => void
      onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => () => void
      onSoundCue: (cb: (cue: SoundCue) => void) => () => void
      getPhoneAccess: () => Promise<PhoneAccessStatus>
      setPhoneAccessEnabled: (enabled: boolean) => Promise<PhoneAccessStatus>
      createPhonePairing: () => Promise<PhonePairing>
      removePhoneDevice: (id: string) => Promise<PhoneAccessStatus>
      logoutPhoneAccess: () => Promise<PhoneAccessStatus>
      /** Ouvre dans le navigateur la page Tailscale à visiter (connexion ou autorisation), jamais une autre. */
      openPhoneAccessLink: () => Promise<void>
      onPhoneAccessChanged: (cb: (status: PhoneAccessStatus) => void) => () => void
      onChatHistoryChanged: (cb: () => void) => () => void
      onStudioGalleryChanged?: (cb: () => void) => () => void
      onModelChoiceChanged?: (cb: () => void) => () => void
    }
  }
}
