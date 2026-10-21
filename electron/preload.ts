import type { ThinkValue } from '../shared/effort'
import type { VideoQuality } from '../shared/videoModel'
import { contextBridge, ipcRenderer } from 'electron'
import { ipcErrorMessage } from '../shared/ipcError'
import {
  IPC_CHANNELS,
  type WebActivity,
  type GithubDeviceCode,
  type GithubRepoSummary,
  type GithubStatus,
  type RepoAgentResult,
  type RepoCommitResult,
  type RepoFileContent,
  type RepoPreview,
  type RepoView,
  type AppMode,
  type AppVersionStatus,
  type LaunchAtStartupStatus,
  type PhoneAccessStatus,
  type PhonePairing,
  type AudioInputDevice,
  type CapacityScanResult,
  type ModelPullProgress,
  type ChatMessage,
  type ContextLengthOptions,
  type ConversationEntry,
  type ConversationList,
  type CodeActivity,
  type CodeGenProgress,
  type CodeLiveWrite,
  type CodeNarration,
  type GeneratedApp,
  type GeneratedAppSummary,
  type MyModelPicks,
  type JarisEmotion,
  type MemoryGraph,
  type MicTestDonePayload,
  type VoiceTestStartResult,
  type MicTestLevelPayload,
  type WakeAvailabilityPayload,
  type WakeTestHeardPayload,
  type ModelOverviewResult,
  type ModelsLocationStatus,
  type OllamaVersionStatus,
  type PickedImageFile,
  type SaveImageResult,
  type GeneratedImageSummary,
  type GeneratedVideoSummary,
  type ImageStudioStatus,
  type VideoStudioStatus,
  type ModelChoiceInfo,
  type ModelChoiceMode,
  type Profile,
  type RuntimeSetupProgress,
  type RuntimeSetupStatus,
  type SoundCue,
  type UpdateCheckResult,
  type UpdateProgress,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload,
  type StartupState,
  type WidgetMode,
  type WindowChrome,
  type LanguageState
} from '../shared/ipc'
import type { LanguageSetting } from '../shared/i18n/languages'
import type { CodeConversationsData, CodeRepoEntry } from '../shared/codeConversations'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Étape 324 : Electron fait précéder toute erreur levée dans le main de « Error invoking remote method 'jaris:…':
 * Error: », en anglais et technique. Une trentaine d'écrans affichaient ce préfixe devant le vrai message (installation
 * du dessin, d'une vidéo, essai d'une voix…), parce que seuls quelques-uns le retiraient. Il est retiré ICI, une fois
 * pour tous les appels : chaque écran reçoit directement le message écrit pour Léo.
 */
function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    throw new Error(ipcErrorMessage(err))
  })
}

const api = {
  onEmotion: (cb: (emotion: JarisEmotion) => void) => subscribe(IPC_CHANNELS.emotion, cb),
  onTranscript: (cb: (text: string) => void) => subscribe(IPC_CHANNELS.transcript, cb),
  onVoiceActivity: (cb: (text: string | null) => void) => subscribe(IPC_CHANNELS.voiceActivity, cb),
  onReply: (cb: (payload: VoiceReplyPayload) => void) => subscribe(IPC_CHANNELS.reply, cb),
  onLog: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.log, cb),
  onChatStreamToken: (cb: (delta: string) => void) => subscribe(IPC_CHANNELS.chatStreamToken, cb),
  onChatWebActivity: (cb: (activity: WebActivity) => void) => subscribe(IPC_CHANNELS.chatWebActivity, cb),
  onSetupStatus: (cb: (status: VoiceSetupStatusPayload) => void) => subscribe(IPC_CHANNELS.setupStatus, cb),
  getSetupStatus: (): Promise<VoiceSetupStatusPayload> => invoke(IPC_CHANNELS.setupStatus),
  /** Étape 294 : où en est le démarrage (écran d'accueil animé). */
  getStartupState: (): Promise<StartupState> => invoke(IPC_CHANNELS.getStartupState),
  onStartupState: (cb: (state: StartupState) => void) => subscribe(IPC_CHANNELS.startupState, cb),
  triggerWake: (): void => ipcRenderer.send(IPC_CHANNELS.triggerWake),
  /** Étape 325 : pourquoi l'écoute ne peut pas démarrer maintenant (affiché près de « Parler à Jaris »). */
  onWakeAvailability: (cb: (payload: WakeAvailabilityPayload) => void) => subscribe(IPC_CHANNELS.wakeAvailability, cb),
  notifyAudioEnded: (): void => ipcRenderer.send(IPC_CHANNELS.audioEnded),
  /**
   * Langue au chargement de la page, lue de façon SYNCHRONE : le premier rendu est déjà dans la bonne langue. `null`
   * si le processus principal ne répond pas (jamais attendu) : l'écran reste alors en français.
   */
  getLanguageState: (): LanguageState | null => {
    try {
      return ipcRenderer.sendSync(IPC_CHANNELS.languageState) as LanguageState
    } catch {
      return null
    }
  },
  setLanguage: (setting: LanguageSetting): Promise<LanguageState> => invoke(IPC_CHANNELS.setLanguage, setting),
  onLanguageChanged: (cb: (state: LanguageState) => void) => subscribe(IPC_CHANNELS.languageChanged, cb),
  getProfile: (): Promise<Profile | null> => invoke(IPC_CHANNELS.getProfile),
  saveProfile: (profile: Profile): Promise<void> => invoke(IPC_CHANNELS.saveProfile, profile),
  patchProfile: (change: Partial<Profile>): Promise<Profile | null> => invoke(IPC_CHANNELS.patchProfile, change),
  openMemoryFolder: (): Promise<void> => invoke(IPC_CHANNELS.openMemoryFolder),
  getMemoryGraph: (): Promise<MemoryGraph> => invoke(IPC_CHANNELS.getMemoryGraph),
  getMemoryNoteContent: (title: string): Promise<string | null> => invoke(IPC_CHANNELS.getMemoryNoteContent, title),
  previewVoice: (voice: string): Promise<ArrayBuffer> => invoke(IPC_CHANNELS.previewVoice, voice),
  notifyOnboardingFinished: (): void => ipcRenderer.send(IPC_CHANNELS.onboardingFinished),
  openSettings: (): void => ipcRenderer.send(IPC_CHANNELS.openSettings),
  getConversationHistory: (): Promise<ConversationEntry[]> => invoke(IPC_CHANNELS.getConversationHistory),
  clearConversationHistory: (): Promise<void> => invoke(IPC_CHANNELS.clearConversationHistory),
  openConversationHistoryFile: (): Promise<void> => invoke(IPC_CHANNELS.openConversationHistoryFile),
  openRequestJournal: (reveal: boolean): Promise<void> => invoke(IPC_CHANNELS.openRequestJournal, reveal),
  getModelOverview: (): Promise<ModelOverviewResult> => invoke(IPC_CHANNELS.getModelOverview),
  getContextLengthOptions: (): Promise<ContextLengthOptions> => invoke(IPC_CHANNELS.getContextLengthOptions),
  setContextLength: (contextLength: number | undefined): Promise<void> =>
    invoke(IPC_CHANNELS.setContextLength, contextLength),
  getOllamaVersionStatus: (): Promise<OllamaVersionStatus | null> => invoke(IPC_CHANNELS.getOllamaVersionStatus),
  updateOllama: (): Promise<{ success: boolean; message: string }> =>
    invoke(IPC_CHANNELS.updateOllama),
  onOllamaVersionStatus: (cb: (status: OllamaVersionStatus) => void) => subscribe(IPC_CHANNELS.ollamaVersionStatusChanged, cb),
  getAppVersionStatus: (): Promise<AppVersionStatus | null> => invoke(IPC_CHANNELS.getAppVersionStatus),
  updateApp: (): Promise<{ success: boolean; message: string }> => invoke(IPC_CHANNELS.updateApp),
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => subscribe(IPC_CHANNELS.updateProgress, cb),
  getAppVersion: (): Promise<string> => invoke(IPC_CHANNELS.getAppVersion),
  checkForUpdate: (): Promise<UpdateCheckResult> => invoke(IPC_CHANNELS.checkForUpdate),
  getModelsLocationStatus: (): Promise<ModelsLocationStatus> => invoke(IPC_CHANNELS.getModelsLocationStatus),
  chooseModelsLocation: (): Promise<{ success: boolean; message: string }> => invoke(IPC_CHANNELS.chooseModelsLocation),
  onModelsLocationProgress: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.modelsLocationProgress, cb),
  getRuntimeSetupStatus: (): Promise<RuntimeSetupStatus> => invoke(IPC_CHANNELS.getRuntimeSetupStatus),
  runRuntimeSetup: (): Promise<RuntimeSetupStatus> => invoke(IPC_CHANNELS.runRuntimeSetup),
  onRuntimeSetupProgress: (cb: (progress: RuntimeSetupProgress) => void) => subscribe(IPC_CHANNELS.runtimeSetupProgress, cb),
  getMyModelPicks: (): Promise<MyModelPicks> => invoke(IPC_CHANNELS.getMyModelPicks),
  deleteUnusedModel: (model: string): Promise<void> => invoke(IPC_CHANNELS.deleteUnusedModel, model),
  getModelChoice: (mode: ModelChoiceMode): Promise<ModelChoiceInfo> => invoke(IPC_CHANNELS.getModelChoice, mode),
  setThinkChoice: (mode: ModelChoiceMode, think: ThinkValue | null): Promise<void> =>
    invoke(IPC_CHANNELS.setThinkChoice, mode, think),
  setModelChoice: (mode: ModelChoiceMode, model: string | null): Promise<void> =>
    invoke(IPC_CHANNELS.setModelChoice, mode, model),
  runQuickSetup: (): Promise<CapacityScanResult> => invoke(IPC_CHANNELS.runQuickSetup),
  getUnscoredModels: (): Promise<string[]> => invoke(IPC_CHANNELS.getUnscoredModels),
  testUnscoredModels: (): Promise<{ models: string[]; resultsPath: string }> =>
    invoke(IPC_CHANNELS.testUnscoredModels),
  showUnscoredResults: (): Promise<void> => invoke(IPC_CHANNELS.showUnscoredResults),
  onModelBenchmarkLine: (cb: (line: string) => void) => subscribe(IPC_CHANNELS.modelBenchmarkLine, cb),
  onModelPullProgress: (cb: (progress: ModelPullProgress | null) => void) => subscribe(IPC_CHANNELS.modelPullProgress, cb),
  getNewModels: (): Promise<string[]> => invoke(IPC_CHANNELS.getNewModels),
  acknowledgeNewModels: (): Promise<void> => invoke(IPC_CHANNELS.acknowledgeNewModels),
  // imageBase64 (étape 91) : image jointe, déjà réduite côté renderer (voir src/lib/imageAttachment.ts) et
  // sans le préfixe "data:image/...;base64,". Traitée par le modèle de VISION, pas par celui de conversation.
  sendChatMessage: (prompt: string, imageBase64?: string): Promise<ChatMessage> =>
    invoke(IPC_CHANNELS.sendChatMessage, prompt, imageBase64),
  cancelChat: (): void => ipcRenderer.send(IPC_CHANNELS.cancelChat),
  transcribeDictation: (wav: Uint8Array): Promise<string> => invoke(IPC_CHANNELS.transcribeDictation, wav),
  getChatHistory: (): Promise<ChatMessage[]> => invoke(IPC_CHANNELS.getChatHistory),
  // Conversations du Chat (étape 96) : les trois canaux qui modifient la liste la renvoient à jour, pour
  // éviter un second aller-retour juste pour la relire.
  listConversations: (): Promise<ConversationList> => invoke(IPC_CHANNELS.listConversations),
  createConversation: (): Promise<ConversationList> => invoke(IPC_CHANNELS.createConversation),
  selectConversation: (id: string): Promise<ConversationList> => invoke(IPC_CHANNELS.selectConversation, id),
  deleteConversation: (id: string): Promise<ConversationList> => invoke(IPC_CHANNELS.deleteConversation, id),
  // Sélecteur d'image ouvert par le MAIN process (étape 93) et pas par un <input type="file"> : seul le main
  // peut encadrer le dialogue natif du garde `dialogOpen`, sans lequel Jaris se replie en widget dès que ce
  // dialogue prend le focus. Renvoie null si l'utilisateur annule.
  pickImageFile: (): Promise<PickedImageFile | null> => invoke(IPC_CHANNELS.pickImageFile),
  saveGeneratedImage: (dataUrl: string): Promise<SaveImageResult> => invoke(IPC_CHANNELS.saveGeneratedImage, dataUrl),
  // Mode Image (étape 200) : seuls des NOMS de fichiers voyagent, jamais un chemin.
  getImageStudioStatus: (): Promise<ImageStudioStatus> => invoke(IPC_CHANNELS.getImageStudioStatus),
  installImageStudio: (): Promise<void> => invoke(IPC_CHANNELS.installImageStudio),
  onImageStudioLog: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.imageStudioLog, cb),
  generateStudioImage: (prompt: string): Promise<GeneratedImageSummary> => invoke(IPC_CHANNELS.generateStudioImage, prompt),
  cancelStudioImage: (): void => ipcRenderer.send(IPC_CHANNELS.cancelStudioImage),
  listGeneratedImages: (): Promise<GeneratedImageSummary[]> => invoke(IPC_CHANNELS.listGeneratedImages),
  readGeneratedImage: (fileName: string): Promise<string | null> => invoke(IPC_CHANNELS.readGeneratedImage, fileName),
  deleteGeneratedImage: (fileName: string): Promise<void> => invoke(IPC_CHANNELS.deleteGeneratedImage, fileName),
  openGeneratedImages: (fileName?: string): Promise<void> => invoke(IPC_CHANNELS.openGeneratedImages, fileName),
  // Mode Vidéo (étape 203) : même principe, seuls des NOMS de fichiers voyagent.
  getVideoStudioStatus: (): Promise<VideoStudioStatus> => invoke(IPC_CHANNELS.getVideoStudioStatus),
  installVideoStudio: (quality: VideoQuality): Promise<void> => invoke(IPC_CHANNELS.installVideoStudio, quality),
  onVideoStudioLog: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.videoStudioLog, cb),
  generateStudioVideo: (
    prompt: string,
    image?: { base64: string; mimeType?: string } | null,
    seconds?: number,
    quality?: VideoQuality
  ): Promise<GeneratedVideoSummary> => invoke(IPC_CHANNELS.generateStudioVideo, prompt, image ?? null, seconds, quality),
  cancelStudioVideo: (): void => ipcRenderer.send(IPC_CHANNELS.cancelStudioVideo),
  listGeneratedVideos: (): Promise<GeneratedVideoSummary[]> => invoke(IPC_CHANNELS.listGeneratedVideos),
  readGeneratedVideo: (fileName: string): Promise<Uint8Array> => invoke(IPC_CHANNELS.readGeneratedVideo, fileName),
  deleteGeneratedVideo: (fileName: string): Promise<void> => invoke(IPC_CHANNELS.deleteGeneratedVideo, fileName),
  saveGeneratedVideo: (fileName: string): Promise<SaveImageResult> => invoke(IPC_CHANNELS.saveGeneratedVideo, fileName),
  openGeneratedVideos: (fileName?: string): Promise<void> => invoke(IPC_CHANNELS.openGeneratedVideos, fileName),
  generateApp: (description: string, currentHtml?: string, imageBase64?: string): Promise<GeneratedApp> =>
    invoke(IPC_CHANNELS.generateApp, description, currentHtml, imageBase64),
  onCodeGenStatus: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.codeGenStatus, cb),
  // Étape 99 : avancement en direct de l'étape en cours, et arrêt d'une génération partie.
  onCodeGenProgress: (cb: (progress: CodeGenProgress) => void) => subscribe(IPC_CHANNELS.codeGenProgress, cb),
  onCodeGenActivity: (cb: (activity: CodeActivity) => void) => subscribe(IPC_CHANNELS.codeGenActivity, cb),
  onCodeGenNarration: (cb: (narration: CodeNarration) => void) => subscribe(IPC_CHANNELS.codeGenNarration, cb),
  onCodeGenLive: (cb: (live: CodeLiveWrite | null) => void) => subscribe(IPC_CHANNELS.codeGenLive, cb),
  cancelCodeGen: (): void => ipcRenderer.send(IPC_CHANNELS.cancelCodeGen),
  // Étape 277 : GitHub dans le mode Code. L'arrêt d'un travail en cours passe par cancelCodeGen.
  githubStatus: (): Promise<GithubStatus> => invoke(IPC_CHANNELS.githubStatus),
  githubStartLogin: (): Promise<GithubDeviceCode> => invoke(IPC_CHANNELS.githubStartLogin),
  githubFinishLogin: (): Promise<GithubStatus> => invoke(IPC_CHANNELS.githubFinishLogin),
  githubCancelLogin: (): void => ipcRenderer.send(IPC_CHANNELS.githubCancelLogin),
  githubLogout: (): Promise<void> => invoke(IPC_CHANNELS.githubLogout),
  githubListRepos: (): Promise<GithubRepoSummary[]> => invoke(IPC_CHANNELS.githubListRepos),
  githubListBranches: (fullName: string): Promise<string[]> => invoke(IPC_CHANNELS.githubListBranches, fullName),
  githubOpenRepo: (fullName: string, branch?: string): Promise<RepoView> => invoke(IPC_CHANNELS.githubOpenRepo, fullName, branch),
  githubRunAgent: (fullName: string, request: string, imageBase64?: string): Promise<RepoAgentResult> =>
    invoke(IPC_CHANNELS.githubRunAgent, fullName, request, imageBase64),
  githubDiscardChanges: (fullName: string, path?: string): Promise<RepoView> =>
    invoke(IPC_CHANNELS.githubDiscardChanges, fullName, path),
  githubPreview: (fullName: string): Promise<RepoPreview> => invoke(IPC_CHANNELS.githubPreview, fullName),
  githubListFiles: (fullName: string): Promise<string[]> => invoke(IPC_CHANNELS.githubListFiles, fullName),
  githubReadFile: (fullName: string, path: string): Promise<RepoFileContent> =>
    invoke(IPC_CHANNELS.githubReadFile, fullName, path),
  githubCommit: (fullName: string, message: string): Promise<RepoCommitResult> => invoke(IPC_CHANNELS.githubCommit, fullName, message),
  openGeneratedApp: (path?: string): Promise<void> => invoke(IPC_CHANNELS.openGeneratedApp, path),
  getGeneratedApps: (): Promise<GeneratedAppSummary[]> => invoke(IPC_CHANNELS.getGeneratedApps),
  loadGeneratedApp: (path: string): Promise<GeneratedApp> => invoke(IPC_CHANNELS.loadGeneratedApp, path),
  deleteGeneratedApp: (path: string): Promise<void> => invoke(IPC_CHANNELS.deleteGeneratedApp, path),
  /**
   * Conversations du mode Code, lues de façon SYNCHRONE une seule fois (codeConversations.ts garde ensuite sa copie
   * en mémoire) : l'écran les affiche dès son premier rendu, comme avant. `null` si le main ne répond pas.
   */
  loadCodeConversations: (): CodeConversationsData | null => {
    try {
      return (ipcRenderer.sendSync(IPC_CHANNELS.loadCodeConversations) as CodeConversationsData | null) ?? null
    } catch {
      return null
    }
  },
  saveCodeConversation: (key: string, turns: unknown[] | null): Promise<void> =>
    invoke(IPC_CHANNELS.saveCodeConversation, key, turns),
  saveCodeRepos: (repos: CodeRepoEntry[]): Promise<void> => invoke(IPC_CHANNELS.saveCodeRepos, repos),
  importCodeConversations: (data: CodeConversationsData): Promise<void> => invoke(IPC_CHANNELS.importCodeConversations, data),
  listAudioInputDevices: (): Promise<AudioInputDevice[]> => invoke(IPC_CHANNELS.listAudioInputDevices),
  setAudioInputDevice: (deviceIndex: number | null): Promise<void> =>
    invoke(IPC_CHANNELS.setAudioInputDevice, deviceIndex),
  setWakewordEnabled: (enabled: boolean): Promise<void> => invoke(IPC_CHANNELS.setWakewordEnabled, enabled),
  testMicrophone: (): Promise<VoiceTestStartResult> => invoke(IPC_CHANNELS.testMicrophone),
  stopTestMicrophone: (): void => ipcRenderer.send(IPC_CHANNELS.stopTestMicrophone),
  testWakeWord: (): Promise<VoiceTestStartResult> => invoke(IPC_CHANNELS.testWakeWord),
  stopTestWakeWord: (): void => ipcRenderer.send(IPC_CHANNELS.stopTestWakeWord),
  onWakeTestHeard: (cb: (payload: WakeTestHeardPayload) => void) => subscribe(IPC_CHANNELS.wakeTestHeard, cb),
  setActiveMode: (mode: AppMode): void => ipcRenderer.send(IPC_CHANNELS.setActiveMode, mode),
  setOptionsOpen: (open: boolean): void => ipcRenderer.send(IPC_CHANNELS.setOptionsOpen, open),
  getWindowChrome: (): Promise<WindowChrome> => invoke(IPC_CHANNELS.getWindowChrome),
  getLaunchAtStartup: (): Promise<LaunchAtStartupStatus> => invoke(IPC_CHANNELS.getLaunchAtStartup),
  setLaunchAtStartup: (enabled: boolean): Promise<LaunchAtStartupStatus> =>
    invoke(IPC_CHANNELS.setLaunchAtStartup, enabled),
  getWidgetMode: (): Promise<WidgetMode> => invoke(IPC_CHANNELS.getWidgetMode),
  onWidgetMode: (cb: (mode: WidgetMode) => void) => subscribe(IPC_CHANNELS.widgetMode, cb),
  setChatWidgetHeight: (height: number | null): void =>
    ipcRenderer.send(IPC_CHANNELS.setChatWidgetHeight, height),
  setChatWidgetKeepOpen: (keepOpen: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.setChatWidgetKeepOpen, keepOpen),
  armChatWidgetPointer: (): void => ipcRenderer.send(IPC_CHANNELS.armChatWidgetPointer),
  collapseChatWidget: (): void => ipcRenderer.send(IPC_CHANNELS.collapseChatWidget),
  openChatWidget: (): void => ipcRenderer.send(IPC_CHANNELS.openChatWidget),
  onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => subscribe(IPC_CHANNELS.micTestLevel, cb),
  onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => subscribe(IPC_CHANNELS.micTestDone, cb),
  onSoundCue: (cb: (cue: SoundCue) => void) => subscribe(IPC_CHANNELS.soundCue, cb),
  // Téléphone (étape 214)
  getPhoneAccess: (): Promise<PhoneAccessStatus> => invoke(IPC_CHANNELS.getPhoneAccess),
  setPhoneAccessEnabled: (enabled: boolean): Promise<PhoneAccessStatus> => invoke(IPC_CHANNELS.setPhoneAccessEnabled, enabled),
  createPhonePairing: (): Promise<PhonePairing> => invoke(IPC_CHANNELS.createPhonePairing),
  removePhoneDevice: (id: string): Promise<PhoneAccessStatus> => invoke(IPC_CHANNELS.removePhoneDevice, id),
  logoutPhoneAccess: (): Promise<PhoneAccessStatus> => invoke(IPC_CHANNELS.logoutPhoneAccess),
  openPhoneAccessLink: (): Promise<void> => invoke(IPC_CHANNELS.openPhoneAccessLink),
  onPhoneAccessChanged: (cb: (status: PhoneAccessStatus) => void) => subscribe(IPC_CHANNELS.phoneAccessChanged, cb),
  onChatHistoryChanged: (cb: () => void) => subscribe(IPC_CHANNELS.chatHistoryChanged, cb),
  onStudioGalleryChanged: (cb: () => void) => subscribe(IPC_CHANNELS.studioGalleryChanged, cb),
  onModelChoiceChanged: (cb: () => void) => subscribe(IPC_CHANNELS.modelChoiceChanged, cb)
}

export type JarisApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('jaris', api)
} else {
  // @ts-expect-error (define in dts)
  window.jaris = api
}
