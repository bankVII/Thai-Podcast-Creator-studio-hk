
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
  { id: 's1', name: 'A', voice: VoiceName.Sadaltager, color: 'bg-cyan-500' }
];

export const DEFAULT_MULTI_SPEAKER: SpeakerConfig[] = [
  { id: 's1', name: 'A', voice: VoiceName.Sadaltager, color: 'bg-cyan-500' },
  { id: 's2', name: 'B', voice: VoiceName.Sulafat, color: 'bg-pink-500' }
];

export const SAMPLE_RATE = 24000;

export interface VocalTagInfo {
  tag: string;
  label: string;
  desc: string;
  icon: string;
  example: string;
}

export const INLINE_VOCAL_TAGS: VocalTagInfo[] = [
  { tag: '[excited]', label: 'ตื่นเต้น (Excited)', desc: 'น้ำเสียงกระตือรือร้น ตื่นเต้น', icon: '✨', example: '[excited] สวัสดีครับยินดีต้อนรับ!' },
  { tag: '[laughter]', label: 'หัวเราะ (Laughter)', desc: 'เสียงหัวเราะเต็มเสียง', icon: '😄', example: 'เรื่องนี้ตลกมากเลยครับ [laughter]' },
  { tag: '[giggle]', label: 'หัวเราะคิกคัก (Giggle)', desc: 'เสียงหัวเราะคิกคัก / ขำในลำคอ', icon: '🤭', example: 'แหม [giggle] คุณก็พูดเกินไปค่ะ' },
  { tag: '[snicker]', label: 'หัวเราะเยาะ (Snicker)', desc: 'เสียงขำแห้งๆ / สบประมาทเบาๆ', icon: '😏', example: 'นึกว่าจะแน่ [snicker]' },
  { tag: '[sigh]', label: 'ถอนหายใจ (Sigh)', desc: 'เสียงถอนหายใจ เฮ้อ...', icon: '😮‍💨', example: '[sigh] เฮ้อ เหนื่อยมาทั้งวัน' },
  { tag: '[gasp]', label: 'ตกใจสูดลมหายใจ (Gasp)', desc: 'เสียงอุทานตกใจ สูดหายใจเข้า', icon: '😲', example: '[gasp] จริงเหรอคะ! ไม่น่าเชื่อเลย' },
  { tag: '[whisper]', label: 'กระซิบ (Whisper)', desc: 'เสียงกระซิบเบาๆ เป็นความลับ', icon: '🤫', example: '[whisper] แอบบอกตรงนี้เลยนะ' },
  { tag: '[clears throat]', label: 'กระแอม (Clears throat)', desc: 'เสียงกระแอมไอจัดเสียงในลำคอ', icon: '🗣️', example: '[clears throat] เอาล่ะครับ มาเข้าเรื่อง' },
  { tag: '[cough]', label: 'ไอสั้น (Cough)', desc: 'เสียงไอสั้นๆ', icon: '😷', example: 'ขออภัยครับ [cough] ลมมันเย็น' },
  { tag: '[yawn]', label: 'หาวนอน (Yawn)', desc: 'เสียงหาวนอน ง่วงนอน', icon: '🥱', example: '[yawn] ง่วงแล้วเหมือนกันนะเนี่ย' },
  { tag: '[hesitation]', label: 'ลังเล (Hesitation)', desc: 'เสียงลังเล เอ่อ... อืม...', icon: '🤔', example: 'เรื่องนั้น... [hesitation] ผมขอคิดดูก่อน' },
  { tag: '[hum]', label: 'ฮัมในคอ (Hum)', desc: 'เสียงฮัมตอบรับในลำคอ', icon: '🎵', example: '[hum] อืม... น่าสนใจมากครับ' },
];

export const PAUSE_TRICKS = [
  { text: '... ', label: '... พักยาว (0.3-0.5s)', desc: 'หยุดพักจังหวะหายใจอย่างเป็นธรรมชาติ' },
  { text: ', ', label: ', พักสั้น (0.1s)', desc: 'หยุดพักจังหวะหายใจสั้นๆ' },
  { text: '- ', label: '- ลากเสียง', desc: 'เน้นลากเสียงยาว เช่น ม้า-า-า-ก หรือ เจ๋ง-สุด-สุด' },
];

export const PHONETIC_EXAMPLES = [
  { original: 'LLM', respelled: 'แอล-แอล-เอ็ม', note: 'AI มักอ่านเป็นตัวย่อภาษาอังกฤษ' },
  { original: 'API', respelled: 'เอ-พี-ไอ', note: 'สะกดคำตรงตัวให้จังหวะแม่น' },
  { original: 'ChatGPT', respelled: 'แชต-จี-พี-ที', note: 'ป้องกันการออกเสียงเพี้ยน' },
  { original: 'Gemini', respelled: 'เจม-อิ-ไน หรือ เจ-มิ-ไน', note: 'ออกเสียงเป็นภาษาไทยชัดเจน' },
  { original: 'TTS', respelled: 'ที-ที-เอส', note: 'Text to speech' },
  { original: 'Batch', respelled: 'แบตช์', note: 'คำศัพท์เฉพาะ' },
];

export interface PodcastTonePreset {
  id: string;
  name: string;
  icon: string;
  desc: string;
  prompt: string;
}

export const DEFAULT_PODCAST_STYLE = 'Calm, gentle, mindful podcast host tone, peaceful pacing, soothing, compassionate, and meditative.';

export const PODCAST_TONE_PRESETS: PodcastTonePreset[] = [
  {
    id: 'mindful-podcast',
    name: 'พอดแคสต์ธรรมะ/จิตวิทยา (Mindful & Calm)',
    icon: '🧘',
    desc: 'โทนสงบ นุ่มนวล มีสติ อ่อนโยน จังหวะหายใจผ่อนคลาย สบายใจ (ค่าเริ่มต้น)',
    prompt: 'Calm, gentle, mindful podcast host tone, peaceful pacing, soothing, compassionate, and meditative.',
  },
  {
    id: 'conversational-podcast',
    name: 'พอดแคสต์สนทนาทั่วไป (Conversational)',
    icon: '🎙️',
    desc: 'โทนผู้จัดพอดแคสต์ สนทนาเป็นธรรมชาติ มีจังหวะรับส่งสดใส อารมณ์เป็นกันเอง',
    prompt: 'Natural, engaging conversational podcast host tone with lively banter, friendly laughter, and organic reactions.',
  },
  {
    id: 'storytelling-podcast',
    name: 'พอดแคสต์เล่าเรื่อง/สารคดี (Storytelling)',
    icon: '📖',
    desc: 'โทนเล่าเรื่อง น่าติดตาม อบอุ่น ชัดถ้อยชัดคำ พาผู้ฟังจมดิ่งไปกับเรื่องเล่า',
    prompt: 'Captivating narrative podcast host tone, warm, articulate, immersive pacing, and emotive emphasis.',
  },
  {
    id: 'tech-news-podcast',
    name: 'พอดแคสต์ข่าวสาร/เทค (Tech & News)',
    icon: '⚡',
    desc: 'โทนกระชับ มั่นใจ ฉะฉาน สไตล์ผู้ดำเนินรายการพอดแคสต์ยุคใหม่',
    prompt: 'Dynamic, crisp, articulate modern tech podcast host tone, confident pacing, and sharp delivery.',
  },
];

export interface ModelPricing {
  inputPerMillion: number;
  audioTokensPerMillion: number;
  costPerHour: number;
  costPerMinute: number;
  batchSupported: boolean;
  batchInputPerMillion: number;
  batchAudioPerMillion: number;
  batchCostPerHour: number;
  batchCostPerMinute: number;
  label: string;
  badge: string;
  description: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-3.8-flash-lite-tts': {
    inputPerMillion: 0.50,
    audioTokensPerMillion: 6.00,
    costPerHour: 0.54, // 90k tokens * $6 / 1M + input ~= $0.54
    costPerMinute: 0.009,
    batchSupported: true,
    batchInputPerMillion: 0.25,
    batchAudioPerMillion: 3.00,
    batchCostPerHour: 0.27, // 90k tokens * $3 / 1M ~= $0.27 (50% off)
    batchCostPerMinute: 0.0045,
    label: 'Gemini 3.8 Flash-Lite TTS (เสียงเดี่ยว Single Speaker · ประหยัดสุด)',
    badge: 'เสียงเดี่ยว · คุ้มค่าสุด · $0.27/ชม.',
    description: 'ประหยัดต้นทุนสูงสุด เหมาะสำหรับเสียงเดี่ยว (Single Speaker) อ่านบทความ/สคริปต์เดี่ยว พร้อมระบบ Batch API ลด 50%',
  },
  'gemini-3.8-flash-tts': {
    inputPerMillion: 0.50,
    audioTokensPerMillion: 9.00,
    costPerHour: 0.81, // 90k tokens * $9 / 1M ~= $0.81
    costPerMinute: 0.0135,
    batchSupported: true,
    batchInputPerMillion: 0.25,
    batchAudioPerMillion: 4.50,
    batchCostPerHour: 0.405,
    batchCostPerMinute: 0.00675,
    label: 'Gemini 3.8 Flash TTS (พอดแคสต์ 2 ผู้พูด & Inline Tags · แนะนำ)',
    badge: 'พอดแคสต์ 2 ผู้พูด · Flagship',
    description: 'รุ่นเรือธง คุณภาพเสียงสูงสุด รองรับพอดแคสต์ 2 ผู้พูด (A / B) และ Inline Vocal Expressions ([laughter], [sigh], [whisper], [gasp])',
  },
  'gemini-2.5-flash-preview-tts': {
    inputPerMillion: 0.50,
    audioTokensPerMillion: 10.00,
    costPerHour: 0.90,
    costPerMinute: 0.015,
    batchSupported: false,
    batchInputPerMillion: 0.50,
    batchAudioPerMillion: 10.00,
    batchCostPerHour: 0.90,
    batchCostPerMinute: 0.015,
    label: 'Gemini 2.5 Flash TTS (ดั้งเดิม · สำหรับเสียงบทความเดี่ยว)',
    badge: 'ดั้งเดิม (ไม่มี Batch)',
    description: 'โมเดลหลักต้นฉบับ รองรับบทสนทนา (สร้างทันทีเท่านั้น โมเดลนี้ไม่รองรับ Batch API)',
  },
  'gemini-3.1-flash-tts-preview': {
    inputPerMillion: 1.00,
    audioTokensPerMillion: 20.00,
    costPerHour: 1.80,
    costPerMinute: 0.03,
    batchSupported: true,
    batchInputPerMillion: 0.50,
    batchAudioPerMillion: 10.00,
    batchCostPerHour: 0.90,
    batchCostPerMinute: 0.015,
    label: 'Gemini 3.1 Flash TTS Preview (ทดลอง)',
    badge: 'Preview 3.1',
    description: 'รุ่นทดลอง 3.1 Preview',
  },
};
