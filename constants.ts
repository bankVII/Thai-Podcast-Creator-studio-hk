
import { SpeakerConfig, VoiceName } from './types';

export const AVAILABLE_VOICES = [
  { name: VoiceName.Sadaltager, gender: 'Male', style: 'New / Clear' },
  { name: VoiceName.Sulafat, gender: 'Female', style: 'New / Soft' },
  { name: VoiceName.Puck, gender: 'Male', style: 'Deep, Resonant' },
  { name: VoiceName.Charon, gender: 'Male', style: 'Professional' },
  { name: VoiceName.Kore, gender: 'Female', style: 'Calm, Soothing' },
  { name: VoiceName.Fenrir, gender: 'Male', style: 'Energetic' },
  { name: VoiceName.Zephyr, gender: 'Female', style: 'Bright, Friendly' },
  { name: VoiceName.Aoede, gender: 'Female', style: 'Melodic' },
];

export const DEFAULT_SINGLE_SPEAKER: SpeakerConfig[] = [
  { id: 's1', name: 'A', voice: VoiceName.Sadaltager, color: 'bg-indigo-500' }
];

export const DEFAULT_MULTI_SPEAKER: SpeakerConfig[] = [
  { id: 's1', name: 'A', voice: VoiceName.Sadaltager, color: 'bg-amber-500' },
  { id: 's2', name: 'B', voice: VoiceName.Sulafat, color: 'bg-purple-500' }
];

export const SAMPLE_RATE = 24000;
