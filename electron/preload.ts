import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AnalysisScope,
  type AppVersionStatus,
  type AudioInputDevice,
  type CapacityScanResult,
  type ChatMessage,
  type ConversationEntry,
  type GeneratedApp,
  type GmailStatus,
  type HardwareTierPreview,
  type JarisEmotion,
  type MemoryGraph,
  type MicTestDonePayload,
  type MicTestLevelPayload,
  type ModelOverviewResult,
  type ModelsLocationStatus,
  type OllamaVersionStatus,
  type Profile,
  type RuntimeSetupProgress,
  type SmtpConfig,
  type SmtpStatus,
  type RuntimeSetupStatus,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload
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
  onSetupStatus: (cb: (status: VoiceSetupStatusPayload) => void) => subscribe(IPC_CHANNELS.setupStatus, cb),
  getSetupStatus: (): Promise<VoiceSetupStatusPayload> => ipcRenderer.invoke(IPC_CHANNELS.setupStatus),
  triggerWake: (): void => ipcRenderer.send(IPC_CHANNELS.triggerWake),
  notifyAudioEnded: (): void => ipcRenderer.send(IPC_CHANNELS.audioEnded),
  getProfile: (): Promise<Profile | null> => ipcRenderer.invoke(IPC_CHANNELS.getProfile),
  saveProfile: (profile: Profile): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.saveProfile, profile),
  markGmailOnboardingDone: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.markGmailOnboardingDone),
  openMemoryFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openMemoryFolder),
  getMemoryGraph: (): Promise<MemoryGraph> => ipcRenderer.invoke(IPC_CHANNELS.getMemoryGraph),
  getMemoryNoteContent: (title: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.getMemoryNoteContent, title),
  getGmailStatus: (): Promise<GmailStatus> => ipcRenderer.invoke(IPC_CHANNELS.getGmailStatus),
  connectGmail: (): Promise<GmailStatus> => ipcRenderer.invoke(IPC_CHANNELS.connectGmail),
  disconnectGmail: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.disconnectGmail),
  previewVoice: (voice: string): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC_CHANNELS.previewVoice, voice),
  notifyOnboardingFinished: (): void => ipcRenderer.send(IPC_CHANNELS.onboardingFinished),
  openSettings: (): void => ipcRenderer.send(IPC_CHANNELS.openSettings),
  getConversationHistory: (): Promise<ConversationEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.getConversationHistory),
  clearConversationHistory: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.clearConversationHistory),
  openConversationHistoryFile: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openConversationHistoryFile),
  getModelOverview: (): Promise<ModelOverviewResult> => ipcRenderer.invoke(IPC_CHANNELS.getModelOverview),
  getOllamaVersionStatus: (): Promise<OllamaVersionStatus | null> => ipcRenderer.invoke(IPC_CHANNELS.getOllamaVersionStatus),
  updateOllama: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.updateOllama),
  importChromeProfile: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.importChromeProfile),
  getAppVersionStatus: (): Promise<AppVersionStatus | null> => ipcRenderer.invoke(IPC_CHANNELS.getAppVersionStatus),
  updateApp: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.updateApp),
  getSmtpStatus: (): Promise<SmtpStatus> => ipcRenderer.invoke(IPC_CHANNELS.getSmtpStatus),
  saveSmtpConfig: (smtpConfig: SmtpConfig): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.saveSmtpConfig, smtpConfig),
  disconnectSmtp: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.disconnectSmtp),
  getModelsLocationStatus: (): Promise<ModelsLocationStatus> => ipcRenderer.invoke(IPC_CHANNELS.getModelsLocationStatus),
  chooseModelsLocation: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.chooseModelsLocation),
  onModelsLocationProgress: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.modelsLocationProgress, cb),
  getRuntimeSetupStatus: (): Promise<RuntimeSetupStatus> => ipcRenderer.invoke(IPC_CHANNELS.getRuntimeSetupStatus),
  runRuntimeSetup: (): Promise<RuntimeSetupStatus> => ipcRenderer.invoke(IPC_CHANNELS.runRuntimeSetup),
  onRuntimeSetupProgress: (cb: (progress: RuntimeSetupProgress) => void) => subscribe(IPC_CHANNELS.runtimeSetupProgress, cb),
  runModelAnalysis: (scope?: AnalysisScope): Promise<CapacityScanResult> => ipcRenderer.invoke(IPC_CHANNELS.runModelAnalysis, scope),
  previewHardwareTiers: (): Promise<HardwareTierPreview[]> => ipcRenderer.invoke(IPC_CHANNELS.previewHardwareTiers),
  runQuickSetup: (): Promise<CapacityScanResult> => ipcRenderer.invoke(IPC_CHANNELS.runQuickSetup),
  onModelBenchmarkLine: (cb: (line: string) => void) => subscribe(IPC_CHANNELS.modelBenchmarkLine, cb),
  getNewModels: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.getNewModels),
  acknowledgeNewModels: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.acknowledgeNewModels),
  sendChatMessage: (prompt: string): Promise<ChatMessage> => ipcRenderer.invoke(IPC_CHANNELS.sendChatMessage, prompt),
  getChatHistory: (): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC_CHANNELS.getChatHistory),
  generateApp: (description: string, currentHtml?: string): Promise<GeneratedApp> =>
    ipcRenderer.invoke(IPC_CHANNELS.generateApp, description, currentHtml),
  onCodeGenStatus: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.codeGenStatus, cb),
  openGeneratedApp: (path?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openGeneratedApp, path),
  listAudioInputDevices: (): Promise<AudioInputDevice[]> => ipcRenderer.invoke(IPC_CHANNELS.listAudioInputDevices),
  setAudioInputDevice: (deviceIndex: number | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAudioInputDevice, deviceIndex),
  testMicrophone: (): void => ipcRenderer.send(IPC_CHANNELS.testMicrophone),
  stopTestMicrophone: (): void => ipcRenderer.send(IPC_CHANNELS.stopTestMicrophone),
  onMicTestLevel: (cb: (payload: MicTestLevelPayload) => void) => subscribe(IPC_CHANNELS.micTestLevel, cb),
  onMicTestDone: (cb: (payload: MicTestDonePayload) => void) => subscribe(IPC_CHANNELS.micTestDone, cb)
}

export type JarisApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('jaris', api)
} else {
  // @ts-expect-error (define in dts)
  window.jaris = api
}
