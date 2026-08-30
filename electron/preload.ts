import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AnalysisScope,
  type CapacityScanResult,
  type ChatMessage,
  type ConversationEntry,
  type GeneratedApp,
  type GmailStatus,
  type JarisEmotion,
  type MemoryGraph,
  type ModelOverviewResult,
  type Profile,
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
  runModelAnalysis: (scope?: AnalysisScope): Promise<CapacityScanResult> => ipcRenderer.invoke(IPC_CHANNELS.runModelAnalysis, scope),
  onModelBenchmarkLine: (cb: (line: string) => void) => subscribe(IPC_CHANNELS.modelBenchmarkLine, cb),
  getNewModels: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.getNewModels),
  acknowledgeNewModels: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.acknowledgeNewModels),
  sendChatMessage: (prompt: string): Promise<ChatMessage> => ipcRenderer.invoke(IPC_CHANNELS.sendChatMessage, prompt),
  getChatHistory: (): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC_CHANNELS.getChatHistory),
  generateApp: (description: string, currentHtml?: string): Promise<GeneratedApp> =>
    ipcRenderer.invoke(IPC_CHANNELS.generateApp, description, currentHtml),
  onCodeGenStatus: (cb: (message: string) => void) => subscribe(IPC_CHANNELS.codeGenStatus, cb),
  openGeneratedApp: (path?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openGeneratedApp, path)
}

export type JarisApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('jaris', api)
} else {
  // @ts-expect-error (define in dts)
  window.jaris = api
}
