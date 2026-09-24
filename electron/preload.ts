import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AnalysisScope,
  type AppMode,
  type AppVersionStatus,
  type AudioInputDevice,
  type CapacityScanResult,
  type ChatMessage,
  type ContextLengthOptions,
  type ConversationEntry,
  type ConversationList,
  type CodeGenProgress,
  type GeneratedApp,
  type GeneratedAppSummary,
  type MyModelPicks,
  type JarisEmotion,
  type MemoryGraph,
  type MicTestDonePayload,
  type MicTestLevelPayload,
  type SttBenchmarkResult,
  type ModelOverviewResult,
  type ModelsLocationStatus,
  type OllamaVersionStatus,
  type PickedImageFile,
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
  type WidgetMode
} from '../shared/ipc'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  onEmotion: (cb: (emotion: JarisEmotion) => void) => subscribe(IPC_CHANNELS.emotion, cb),
  onTranscript: (cb: (text: string) => void) => subscribe(IPC_CHANNELS.transcript, cb),
  onReply: (cb: (payload: VoiceReplyPayload) => void) => subscribe(IPC_CHANNELS.reply, cb),
  onLog: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.log, cb),
  onChatStreamToken: (cb: (delta: string) => void) => subscribe(IPC_CHANNELS.chatStreamToken, cb),
  onSetupStatus: (cb: (status: VoiceSetupStatusPayload) => void) => subscribe(IPC_CHANNELS.setupStatus, cb),
  getSetupStatus: (): Promise<VoiceSetupStatusPayload> => ipcRenderer.invoke(IPC_CHANNELS.setupStatus),
  triggerWake: (): void => ipcRenderer.send(IPC_CHANNELS.triggerWake),
  notifyAudioEnded: (): void => ipcRenderer.send(IPC_CHANNELS.audioEnded),
  getProfile: (): Promise<Profile | null> => ipcRenderer.invoke(IPC_CHANNELS.getProfile),
  saveProfile: (profile: Profile): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.saveProfile, profile),
  openMemoryFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openMemoryFolder),
  getMemoryGraph: (): Promise<MemoryGraph> => ipcRenderer.invoke(IPC_CHANNELS.getMemoryGraph),
  getMemoryNoteContent: (title: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.getMemoryNoteContent, title),
  previewVoice: (voice: string): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC_CHANNELS.previewVoice, voice),
  notifyOnboardingFinished: (): void => ipcRenderer.send(IPC_CHANNELS.onboardingFinished),
  openSettings: (): void => ipcRenderer.send(IPC_CHANNELS.openSettings),
  getConversationHistory: (): Promise<ConversationEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.getConversationHistory),
  clearConversationHistory: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.clearConversationHistory),
  openConversationHistoryFile: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openConversationHistoryFile),
  getModelOverview: (): Promise<ModelOverviewResult> => ipcRenderer.invoke(IPC_CHANNELS.getModelOverview),
  getContextLengthOptions: (): Promise<ContextLengthOptions> => ipcRenderer.invoke(IPC_CHANNELS.getContextLengthOptions),
  setContextLength: (contextLength: number | undefined): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setContextLength, contextLength),
  getOllamaVersionStatus: (): Promise<OllamaVersionStatus | null> => ipcRenderer.invoke(IPC_CHANNELS.getOllamaVersionStatus),
  updateOllama: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.updateOllama),
  getAppVersionStatus: (): Promise<AppVersionStatus | null> => ipcRenderer.invoke(IPC_CHANNELS.getAppVersionStatus),
  updateApp: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.updateApp),
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => subscribe(IPC_CHANNELS.updateProgress, cb),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.getAppVersion),
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdate),
  getModelsLocationStatus: (): Promise<ModelsLocationStatus> => ipcRenderer.invoke(IPC_CHANNELS.getModelsLocationStatus),
  chooseModelsLocation: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.chooseModelsLocation),
  onModelsLocationProgress: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.modelsLocationProgress, cb),
  getRuntimeSetupStatus: (): Promise<RuntimeSetupStatus> => ipcRenderer.invoke(IPC_CHANNELS.getRuntimeSetupStatus),
  runRuntimeSetup: (): Promise<RuntimeSetupStatus> => ipcRenderer.invoke(IPC_CHANNELS.runRuntimeSetup),
  onRuntimeSetupProgress: (cb: (progress: RuntimeSetupProgress) => void) => subscribe(IPC_CHANNELS.runtimeSetupProgress, cb),
  runModelAnalysis: (scope?: AnalysisScope): Promise<CapacityScanResult> => ipcRenderer.invoke(IPC_CHANNELS.runModelAnalysis, scope),
  getMyModelPicks: (): Promise<MyModelPicks> => ipcRenderer.invoke(IPC_CHANNELS.getMyModelPicks),
  deleteUnusedModel: (model: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.deleteUnusedModel, model),
  getModelChoice: (mode: ModelChoiceMode): Promise<ModelChoiceInfo> => ipcRenderer.invoke(IPC_CHANNELS.getModelChoice, mode),
  setModelChoice: (mode: ModelChoiceMode, model: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setModelChoice, mode, model),
  runQuickSetup: (): Promise<CapacityScanResult> => ipcRenderer.invoke(IPC_CHANNELS.runQuickSetup),
  onModelBenchmarkLine: (cb: (line: string) => void) => subscribe(IPC_CHANNELS.modelBenchmarkLine, cb),
  getNewModels: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.getNewModels),
  acknowledgeNewModels: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.acknowledgeNewModels),
  // imageBase64 (étape 91) : image jointe, déjà réduite côté renderer (voir src/lib/imageAttachment.ts) et
  // sans le préfixe "data:image/...;base64,". Traitée par le modèle de VISION, pas par celui de conversation.
  sendChatMessage: (prompt: string, imageBase64?: string): Promise<ChatMessage> =>
    ipcRenderer.invoke(IPC_CHANNELS.sendChatMessage, prompt, imageBase64),
  getChatHistory: (): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC_CHANNELS.getChatHistory),
  // Conversations du Chat (étape 96) : les trois canaux qui modifient la liste la renvoient à jour, pour
  // éviter un second aller-retour juste pour la relire.
  listConversations: (): Promise<ConversationList> => ipcRenderer.invoke(IPC_CHANNELS.listConversations),
  createConversation: (): Promise<ConversationList> => ipcRenderer.invoke(IPC_CHANNELS.createConversation),
  selectConversation: (id: string): Promise<ConversationList> => ipcRenderer.invoke(IPC_CHANNELS.selectConversation, id),
  deleteConversation: (id: string): Promise<ConversationList> => ipcRenderer.invoke(IPC_CHANNELS.deleteConversation, id),
  // Sélecteur d'image ouvert par le MAIN process (étape 93) et pas par un <input type="file"> : seul le main
  // peut encadrer le dialogue natif du garde `dialogOpen`, sans lequel Jaris se replie en widget dès que ce
  // dialogue prend le focus. Renvoie null si l'utilisateur annule.
  pickImageFile: (): Promise<PickedImageFile | null> => ipcRenderer.invoke(IPC_CHANNELS.pickImageFile),
  generateApp: (description: string, currentHtml?: string, imageBase64?: string): Promise<GeneratedApp> =>
    ipcRenderer.invoke(IPC_CHANNELS.generateApp, description, currentHtml, imageBase64),
  onCodeGenStatus: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.codeGenStatus, cb),
  // Étape 99 : avancement en direct de l'étape en cours, et arrêt d'une génération partie.
  onCodeGenProgress: (cb: (progress: CodeGenProgress) => void) => subscribe(IPC_CHANNELS.codeGenProgress, cb),
  cancelCodeGen: (): void => ipcRenderer.send(IPC_CHANNELS.cancelCodeGen),
  openGeneratedApp: (path?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openGeneratedApp, path),
  getGeneratedApps: (): Promise<GeneratedAppSummary[]> => ipcRenderer.invoke(IPC_CHANNELS.getGeneratedApps),
  loadGeneratedApp: (path: string): Promise<GeneratedApp> => ipcRenderer.invoke(IPC_CHANNELS.loadGeneratedApp, path),
  deleteGeneratedApp: (path: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.deleteGeneratedApp, path),
  listAudioInputDevices: (): Promise<AudioInputDevice[]> => ipcRenderer.invoke(IPC_CHANNELS.listAudioInputDevices),
  setAudioInputDevice: (deviceIndex: number | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAudioInputDevice, deviceIndex),
  setWakewordEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.setWakewordEnabled, enabled),
  testMicrophone: (): void => ipcRenderer.send(IPC_CHANNELS.testMicrophone),
  runSttBenchmark: (): Promise<SttBenchmarkResult> => ipcRenderer.invoke(IPC_CHANNELS.runSttBenchmark),
  onSttBenchmarkProgress: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.sttBenchmarkProgress, cb),
  stopTestMicrophone: (): void => ipcRenderer.send(IPC_CHANNELS.stopTestMicrophone),
  setActiveMode: (mode: AppMode): void => ipcRenderer.send(IPC_CHANNELS.setActiveMode, mode),
  setOptionsOpen: (open: boolean): void => ipcRenderer.send(IPC_CHANNELS.setOptionsOpen, open),
  getWidgetMode: (): Promise<WidgetMode> => ipcRenderer.invoke(IPC_CHANNELS.getWidgetMode),
  onWidgetMode: (cb: (mode: WidgetMode) => void) => subscribe(IPC_CHANNELS.widgetMode, cb),
  setChatWidgetHeight: (height: number | null): void =>
    ipcRenderer.send(IPC_CHANNELS.setChatWidgetHeight, height),
  setChatWidgetKeepOpen: (keepOpen: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.setChatWidgetKeepOpen, keepOpen),
  armChatWidgetPointer: (): void => ipcRenderer.send(IPC_CHANNELS.armChatWidgetPointer),
  collapseChatWidget: (): void => ipcRenderer.send(IPC_CHANNELS.collapseChatWidget),
  onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => subscribe(IPC_CHANNELS.micTestLevel, cb),
  onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => subscribe(IPC_CHANNELS.micTestDone, cb),
  onSoundCue: (cb: (cue: SoundCue) => void) => subscribe(IPC_CHANNELS.soundCue, cb)
}

export type JarisApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('jaris', api)
} else {
  // @ts-expect-error (define in dts)
  window.jaris = api
}
