
export enum VoiceName {
  Puck = 'Puck',
  Charon = 'Charon',
  Kore = 'Kore',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr',
  Aoede = 'Aoede',
  Eos = 'Eos',
  Orpheus = 'Orpheus',
  Sadaltager = 'Sadaltager',
  Sulafat = 'Sulafat',
}

export interface SpeakerConfig {
  id: string;
  name: string;
  voice: VoiceName;
  color: string;
}

export type TtsModel =
  | 'gemini-3.8-flash-lite-tts'
  | 'gemini-3.8-flash-tts'
  | 'gemini-2.5-flash-preview-tts'
  | 'gemini-3.1-flash-tts-preview';

export interface TtsSettings {
  mode: 'single' | 'multi';
  speakers: SpeakerConfig[];
  styleInstructions: string;
  script: string;
  model: TtsModel;
  chunkSize: number;
}

export interface AudioChunk {
  text: string;
  pcm?: Uint8Array;
  seconds?: number;
  warnings?: string[];
  error?: string;
  shortRepair?: { chunks: AudioChunk[] };
  previousTake?: { pcm: Uint8Array; seconds: number; warnings?: string[] };
}

export interface PodcastSession {
  version: 1;
  id: string;
  settings: TtsSettings;
  revision?: number;
  chunks: AudioChunk[];
  charges: { mode: 'standard' | 'batch'; inputTokens?: number; audioTokens?: number; seconds?: number }[];
  batch?: {
    name?: string;
    displayName: string;
    lastError?: string;
    state: string;
    indices: number[];
    lastChecked?: string;
    checkMessage?: string;
  };
}

declare global {
  interface Window {
    aistudio?: { openSelectKey: () => Promise<void> };
  }
}

export interface AudioGenerationResult {
  audioUrl: string | null;
  duration: number;
}
