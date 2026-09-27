import { GoogleGenAI, Modality, type GenerateContentResponse, type InlinedRequest } from '@google/genai';
import { PodcastSession, TtsSettings, AudioChunk, BatchJobRecord } from '../types';
import { concatenateUint8Arrays, createSilence, createWavBlob, inspectPcm, validatePcm } from '../utils/audio';
import { JsonArrayStreamer, LineStreamer } from '../utils/jsonStream';
import { splitScript } from '../utils/script';

export function createClient() {
  // Restore the original AI Studio integration: the host handles its selected
  // key. Do not redirect Standard generation through our experimental server.
  // No retryOptions: SDK 1.52 otherwise discards error status/body.
  return new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
}

export function createSession(settings: TtsSettings): PodcastSession {
  return { version: 1, id: crypto.randomUUID(), settings: structuredClone(settings), chunks: splitScript(settings).map(text => ({ text })), charges: [] };
}

export function lockPodcastTone(userStyle?: string): string {
  const trimmed = userStyle?.trim() || '';
  if (!trimmed) {
    return 'Calm, gentle, mindful podcast host tone, peaceful pacing, soothing, compassionate, and meditative.';
  }
  if (!/podcast/i.test(trimmed)) {
    return `Podcast host style: ${trimmed}`;
  }
  return trimmed;
}

export function formatDialogueParts(
  settings: TtsSettings,
  text: string
): Array<{ text: string; speechMetadata?: { speaker?: string; style?: string }; speech_metadata?: { speaker?: string; style?: string } }> {
  const isGemini3 = settings.model.startsWith('gemini-3');
  const style = lockPodcastTone(settings.styleInstructions);

  if (settings.mode !== 'multi') {
    if (isGemini3) {
      const meta = { style };
      return [{
        text: text.trim() || '...',
        speechMetadata: meta,
        speech_metadata: meta,
      }];
    }
    const prompt = `(Speaking Style: ${style}) \n\n${text}`;
    return [{ text: prompt }];
  }

  // Gemini 3.8 / 3.x multi-speaker requires each turn to be structured as a separate part
  // with speech_metadata / speechMetadata containing the configured speaker name.
  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const speakers = settings.speakers;
  const primarySpeaker = speakers[0]?.name?.trim() || 'A';
  const secondarySpeaker = speakers[1]?.name?.trim() || 'B';

  const parts: Array<{ text: string; speechMetadata: { speaker: string; style?: string }; speech_metadata: { speaker: string; style?: string } }> = [];
  let currentSpeaker = primarySpeaker;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length > 0) {
      const turnText = currentLines.join('\n').trim();
      if (turnText) {
        const meta = {
          speaker: currentSpeaker,
          style,
        };
        parts.push({
          text: turnText,
          speechMetadata: meta,
          speech_metadata: meta,
        });
      }
      currentLines = [];
    }
  };

  const isSpeaker1 = (p: string) => /^(a|1|host\s*[a1]|speaker\s*[a1]|ผู้พูด\s*[a1ก]|พิธีกร\s*[a1ก]|คนที่\s*1|ก|นาย\s*ก|person\s*[a1]|user\s*[a1])$/i.test(p);
  const isSpeaker2 = (p: string) => /^(b|2|host\s*[b2]|speaker\s*[b2]|ผู้พูด\s*[b2ข]|พิธีกร\s*[b2ข]|คนที่\s*2|ข|นางสาว\s*ข|person\s*[b2]|user\s*[b2])$/i.test(p);

  for (const rawLine of rawLines) {
    // Strip markdown formatting if it wraps the speaker label (e.g. **A:** or **A**:) and list markers
    const line = rawLine.replace(/^[-*•]\s+/, '').replace(/^(\*{1,2})([^*]+?)\1/, '$2');

    // Extract speaker prefix using standard ':' or Thai fullwidth '：'
    const colonIdx = line.search(/[:：]/);
    let matchedSpeaker: string | null = null;
    let turnContent = line;

    if (colonIdx >= 0) {
      const prefix = line.slice(0, colonIdx).replace(/[\[\]\(\)\*]/g, '').trim();
      const content = line.slice(colonIdx + 1).trim();

      const exact = speakers.find(s => s.name.trim().toLowerCase() === prefix.toLowerCase());
      if (exact) {
        matchedSpeaker = exact.name.trim();
      } else if (isSpeaker1(prefix)) {
        matchedSpeaker = primarySpeaker;
      } else if (isSpeaker2(prefix)) {
        matchedSpeaker = secondarySpeaker;
      }
      if (matchedSpeaker) {
        turnContent = content;
      }
    } else {
      // Bracketed without colon like [A] สวัสดีครับ or (A) สวัสดีครับ or [Speaker A]
      const bracketMatch = line.match(/^[\[\(]([a-zA-Z0-9_\u0E00-\u0E7F\s]+)[\]\)]\s*(.*)$/);
      if (bracketMatch) {
        const prefix = bracketMatch[1].trim();
        const content = bracketMatch[2].trim();
        const exact = speakers.find(s => s.name.trim().toLowerCase() === prefix.toLowerCase());
        if (exact) {
          matchedSpeaker = exact.name.trim();
        } else if (isSpeaker1(prefix)) {
          matchedSpeaker = primarySpeaker;
        } else if (isSpeaker2(prefix)) {
          matchedSpeaker = secondarySpeaker;
        }
        if (matchedSpeaker) {
          turnContent = content;
        }
      } else {
        // Dot or dash prefix: A. สวัสดีครับ or 1. สวัสดีครับ or A - สวัสดีครับ
        const dotMatch = line.match(/^([a-zA-Z0-9_\u0E00-\u0E7F\s]{1,15})[\.\-]\s+(.+)$/);
        if (dotMatch) {
          const prefix = dotMatch[1].trim();
          const content = dotMatch[2].trim();
          const exact = speakers.find(s => s.name.trim().toLowerCase() === prefix.toLowerCase());
          if (exact) {
            matchedSpeaker = exact.name.trim();
          } else if (isSpeaker1(prefix)) {
            matchedSpeaker = primarySpeaker;
          } else if (isSpeaker2(prefix)) {
            matchedSpeaker = secondarySpeaker;
          }
          if (matchedSpeaker) {
            turnContent = content;
          }
        }
      }
    }

    if (matchedSpeaker) {
      if (matchedSpeaker !== currentSpeaker) {
        flush();
        currentSpeaker = matchedSpeaker;
      }
      if (turnContent) {
        currentLines.push(turnContent);
      }
    } else {
      currentLines.push(line);
    }
  }

  flush();

  if (!parts.length) {
    const meta = {
      speaker: primarySpeaker,
      style,
    };
    parts.push({
      text: text.trim() || '...',
      speechMetadata: meta,
      speech_metadata: meta,
    });
  }

  return parts;
}

export function buildRequest(settings: TtsSettings, text: string): InlinedRequest & { contents: NonNullable<InlinedRequest['contents']> } {
  const parts = formatDialogueParts(settings, text);
  const primarySpeaker = settings.speakers[0]?.name?.trim() || 'A';
  const secondarySpeaker = settings.speakers[1]?.name?.trim() || 'B';

  const isMulti = settings.mode === 'multi';
  const speakersInChunk = new Set(parts.map(p => p.speechMetadata?.speaker).filter(Boolean));

  let speechConfig: any;
  let requestParts: Array<{
    text: string;
    speechMetadata?: { speaker?: string; style?: string };
    speech_metadata?: { speaker?: string; style?: string };
  }>;

  // When in multi mode AND at least 2 distinct speakers are present in this chunk:
  if (isMulti && speakersInChunk.size >= 2) {
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          {
            speaker: primarySpeaker,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.speakers[0]?.voice || 'Sadaltager' } },
          },
          {
            speaker: secondarySpeaker,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.speakers[1]?.voice || 'Sulafat' } },
          },
        ],
      },
    };

    // Google multi-speaker API requirement:
    // Multi-speaker generation requests must specify speaker for each text part in the contents.
    const podcastStyle = lockPodcastTone(settings.styleInstructions);
    requestParts = parts.map(p => {
      const spk = p.speechMetadata?.speaker || primarySpeaker;
      const cleanText = p.text.replace(/^[A-Za-z0-9_\u0E00-\u0E7F\s]+[:：\.\-]\s*/, '').trim();
      const textContent = cleanText || p.text.trim() || '...';
      const meta = {
        speaker: spk,
        style: p.speechMetadata?.style || podcastStyle,
      };
      return {
        text: `${spk}: ${textContent}`,
        speechMetadata: meta,
        speech_metadata: meta,
      };
    });
  } else {
    // Single speaker chunk (either settings.mode === 'single' or chunk contains only 1 speaker):
    // Using single-voice voiceConfig guarantees Google will NEVER throw "must specify speaker names"
    const activeSpeaker = [...speakersInChunk][0] || primarySpeaker;
    const speakerConfig =
      settings.speakers.find(s => s.name.trim().toLowerCase() === activeSpeaker.toLowerCase()) ||
      settings.speakers[0];
    const voiceName = speakerConfig?.voice || settings.speakers[0]?.voice || 'Sadaltager';

    speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    };

    const podcastStyle = lockPodcastTone(settings.styleInstructions);
    const meta = {
      style: podcastStyle,
    };
    requestParts = parts.map(p => {
      const cleanText = p.text.replace(/^[A-Za-z0-9_\u0E00-\u0E7F\s]+[:：\.\-]\s*/, '').trim();
      return {
        text: cleanText || p.text.trim() || '...',
        speechMetadata: meta,
        speech_metadata: meta,
      };
    });
  }

  // NOTE: Gemini TTS models (gemini-3.8-flash-tts and gemini-3.8-flash-lite-tts) do NOT accept
  // systemInstruction. Passing systemInstruction causes Google to return 400 INVALID_ARGUMENT.
  // Turn-level tone/style belongs in speechMetadata.style / speech_metadata.style.
  return {
    contents: [{ role: 'user', parts: requestParts as any }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig,
    },
  };
}

export function decodeResponse(response: GenerateContentResponse): Pick<AudioChunk, 'pcm' | 'seconds' | 'warnings'> {
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error(`เสียงจบไม่สมบูรณ์ (${candidate.finishReason}) — ลองแบ่งช่วงสั้นลง`);
  const parts = candidate?.content?.parts?.filter(p => p.inlineData?.mimeType?.startsWith('audio/')) ?? [];
  if (!parts.length) throw new Error(`ไม่พบเสียงจากโมเดล${response.promptFeedback?.blockReason ? ` (${response.promptFeedback.blockReason})` : ''}`);
  const pcm = concatenateUint8Arrays(parts.map(p => validatePcm(p.inlineData!.data ?? '', p.inlineData!.mimeType!)));
  return { pcm, seconds: pcm.length / 48000, warnings: inspectPcm(pcm) };
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'เกิดข้อผิดพลาดจาก API';
  if (message.startsWith('ช่วง ') && message.includes(': ')) {
    return message;
  }
  try {
    const parsed = JSON.parse(message);
    const detail = parsed?.error || parsed;
    if (detail?.message) {
      if (detail.status === 'INVALID_ARGUMENT' || detail.code === 400) {
        if (/Speech metadata is not supported/i.test(detail.message)) {
          return 'โมเดลนี้ไม่รองรับระบบ 2 ผู้พูด: กรุณาสลับโมเดลเป็น Gemini 3.8 Flash TTS (Flagship Audio) สำหรับบทสนทนา 2 ผู้พูด';
        }
        if (/must specify.*speaker/i.test(detail.message) || /speaker_voice_configs/i.test(detail.message) || /speaker names/i.test(detail.message) || /speech_metadata/i.test(detail.message)) {
          return 'รูปแบบบทพูดไม่ถูกต้อง: ต้องระบุผู้พูด A: หรือ B: ให้ชัดเจนในแต่ละท่อน หรือสลับเป็นโมเดล Gemini 3.8 Flash TTS';
        }
        if (/Request contains an invalid argument/i.test(detail.message)) {
          return 'รูปแบบคำขอไม่ถูกต้อง: ตรวจสอบการระบุผู้พูด A: และ B: ในบทสนทนา หรือสลับเป็นโหมดเสียงเดี่ยว / สลับโมเดลเป็น Gemini 3.8 Flash TTS';
        }
        return `รูปแบบคำขอไม่ถูกต้อง (Invalid Argument): ${detail.message}`;
      }
      if (detail.status === 'FAILED_PRECONDITION' || /precondition/i.test(detail.message)) {
        return 'ฟังก์ชัน Batch API ยังไม่เปิดให้บริการในบัญชี/ภูมิภาคนี้ — แนะนำให้ใช้ปุ่ม "สร้างเสียงทันที" แทนครับ';
      }
      if (detail.status === 'RESOURCE_EXHAUSTED' || detail.code === 429) {
        return 'โควตาคำขอฟรีชั่วคราวเต็ม (กรุณารอประมาณ 30-60 วินาที หรือสลับคีย์ API)';
      }
      return `Google API ${detail.code ?? ''}: ${detail.message}`;
    }
  } catch { /* Plain text errors are already readable. */ }

  if (/Speech metadata is not supported/i.test(message)) {
    return 'โมเดลนี้ไม่รองรับระบบ 2 ผู้พูด: กรุณาสลับโมเดลเป็น Gemini 3.8 Flash TTS (Flagship Audio) สำหรับบทสนทนา 2 ผู้พูด';
  }
  if (/must specify.*speaker/i.test(message) || /speaker_voice_configs/i.test(message) || /speaker names/i.test(message) || /speech_metadata/i.test(message)) {
    return 'รูปแบบบทพูดไม่ถูกต้อง: ต้องระบุผู้พูด A: หรือ B: ให้ชัดเจนในแต่ละท่อน หรือสลับเป็นโมเดล Gemini 3.8 Flash TTS';
  }
  if (/Precondition check failed/i.test(message)) {
    return 'ฟังก์ชัน Batch API ยังไม่เปิดให้บริการในบัญชีนี้ — แนะนำให้ใช้ปุ่ม "สร้างเสียงทันที" แทนครับ';
  }
  if (/quota|resource_exhausted|429/i.test(message)) {
    return 'โควตาคำขอฟรีชั่วคราวเต็ม (กรุณารอประมาณ 30-60 วินาที แล้วลองใหม่อีกครั้ง)';
  }
  if (/Request contains an invalid argument/i.test(message)) {
    return 'รูปแบบคำขอไม่ถูกต้อง: ตรวจสอบการระบุผู้พูด A: และ B: ในบทสนทนา หรือสลับเป็นโหมดเสียงเดี่ยว / สลับโมเดลเป็น Gemini 3.8 Flash TTS';
  }
  return message;
}

export async function checkBatchConnection(model: TtsSettings['model'], client: Client = createClient()) {
  // Read-only capability check. Never submits audio or creates a paid job.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        // Listing jobs only proves access to the job collection, not whether
        // the selected model accepts batchGenerateContent. The SDK maps the
        // REST supportedGenerationMethods field to supportedActions.
        const info = await client.models.get({ model });
        const actions = info.supportedActions ?? [];
        if (!actions.includes('batchGenerateContent')) {
          throw new Error(`${model}: Google ไม่ระบุว่ารองรับ batchGenerateContent (รองรับ: ${actions.join(', ') || 'ไม่ส่งข้อมูลกลับมา'}) กรุณาใช้ปุ่มสร้างทันที`);
        }
        // Do not list existing jobs here. A list response embeds the inline
        // audio of every finished job, so one earlier long episode made this
        // "quick" check download hundreds of MB and hit the timeout.
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ตรวจ Batch เกิน 30 วินาที กรุณาลองตรวจใหม่')), 30_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}


function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || !error) return undefined;
  const e = error as { status?: number; code?: number };
  return e.status ?? e.code;
}

export async function withRetry<T>(operation: () => Promise<T>, status: (message: string) => void, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // Never blindly retry auth, bad requests, daily quota, or uncertain timeouts.
      const code = statusCode(error);
      if (attempt >= 2 || ![429, 503].includes(code!) || /per.?day|daily|billing|insufficient|quota.*exhaust/i.test(errorMessage(error))) throw error;
      const wait = 5000 * 2 ** attempt;
      status(`เซิร์ฟเวอร์ไม่ว่าง รอ ${wait / 1000} วินาที (ลองใหม่ ${attempt + 1}/2)`);
      await sleep(wait);
    }
  }
}

function charge(session: PodcastSession, response: GenerateContentResponse, mode: 'standard' | 'batch') {
  const usage = response.usageMetadata;
  session.charges.push({ mode, inputTokens: usage?.promptTokenCount, audioTokens: usage?.candidatesTokensDetails?.find(d => d.modality === 'AUDIO')?.tokenCount ?? usage?.candidatesTokenCount });
}

export function assembleSession(session: PodcastSession): Blob | null {
  if (!session.chunks.length || session.chunks.some(c => !c.pcm)) return null;
  return createWavBlob(concatenateUint8Arrays(session.chunks.flatMap((c, i) => i ? [createSilence(100), c.pcm!] : [c.pcm!])));
}

const TERMINAL_JOB_STATES = ['JOB_STATE_SUCCEEDED', 'JOB_STATE_PARTIALLY_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'];
const RESULT_JOB_STATES = ['JOB_STATE_SUCCEEDED', 'JOB_STATE_PARTIALLY_SUCCEEDED'];

// The REST API reports BATCH_STATE_*; the SDK converts them to JOB_STATE_*.
// Older sessions stored either form, so compare only the JOB_STATE_* form.
export function normalizeJobState(state: string): string {
  return state.replace(/^BATCH_STATE_/, 'JOB_STATE_');
}

// A job is finished locally once Google reached a final state and, when it
// produced audio, that audio has been downloaded into the session.
function jobFinished(job: BatchJobRecord): boolean {
  const state = normalizeJobState(job.state);
  if (!TERMINAL_JOB_STATES.includes(state)) return false;
  return !RESULT_JOB_STATES.includes(state) || !!job.collected;
}

export function batchJobs(batch: NonNullable<PodcastSession['batch']>): BatchJobRecord[] {
  if (batch.jobs) return batch.jobs;
  // Legacy single-job session. The old code set SUCCEEDED only after storing audio.
  return [{
    name: batch.name,
    displayName: batch.displayName,
    indices: batch.indices,
    state: normalizeJobState(batch.state),
    collected: batch.state === 'JOB_STATE_SUCCEEDED',
  }];
}

export function batchActive(session?: PodcastSession | null): boolean {
  return !!session?.batch && batchJobs(session.batch).some(job => !jobFinished(job));
}

type Save = (session: PodcastSession) => Promise<void>;
type Client = Pick<GoogleGenAI, 'models' | 'batches'>;

export async function executeGenerateContent(
  client: GoogleGenAI | Client,
  model: string,
  request: InlinedRequest & { contents: NonNullable<InlinedRequest['contents']> }
): Promise<GenerateContentResponse> {
  let effectiveModel = model;
  // gemini-3.8-flash-lite-tts is strictly for single-speaker TTS.
  // When multi-speaker voice configuration is present, automatically route to the flagship multi-speaker model gemini-3.8-flash-tts.
  const speechConfig = request.config?.speechConfig as any;
  if (speechConfig?.multiSpeakerVoiceConfig && effectiveModel === 'gemini-3.8-flash-lite-tts') {
    effectiveModel = 'gemini-3.8-flash-tts';
  }

  const anyClient = client as any;
  const apiClient = anyClient.apiClient || anyClient.models?.apiClient;
  // Always prefer apiClient.request when available because @google/genai's partToMldev serializer
  // strips speechMetadata/speech_metadata from contents parts.
  if (apiClient?.request) {
    const payload: any = {
      contents: request.contents,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: request.config?.speechConfig,
      },
    };
    const response = await apiClient.request({
      path: `models/${effectiveModel}:generateContent`,
      httpMethod: 'POST',
      body: JSON.stringify(payload),
      httpOptions: { headers: { 'Content-Type': 'application/json' } },
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(JSON.stringify(data));
    }
    return data as GenerateContentResponse;
  }
  return await client.models.generateContent({ model: effectiveModel, ...request });
}

export async function generateStandard(session: PodcastSession, save: Save, status: (s: string) => void, options: { replaceIndex?: number; shouldStop?: () => boolean; client?: Client } = {}) {
  if (batchActive(session)) throw new Error('มีงาน Batch ค้างอยู่ กรุณาตรวจสถานะก่อน');
  if (options.replaceIndex !== undefined && session.chunks[options.replaceIndex]?.shortRepair) throw new Error('มีการซ่อมช่วงสั้นค้างอยู่ กรุณากดซ่อมแบบช่วงสั้นต่อ');
  const client = options.client ?? createClient();
  const indices = options.replaceIndex === undefined ? session.chunks.map((_, i) => i).filter(i => !session.chunks[i].pcm) : [options.replaceIndex];
  if (indices.some(i => !session.chunks[i])) throw new Error('ไม่พบช่วงที่ต้องการ');
  for (const index of indices) {
    if (options.shouldStop?.()) break;
    status(`กำลังสร้างช่วง ${index + 1}/${session.chunks.length}`);
    try {
      const response = await withRetry(() => executeGenerateContent(client, session.settings.model, buildRequest(session.settings, session.chunks[index].text)), status);
      charge(session, response, 'standard');
      const audio = decodeResponse(response);
      session.charges[session.charges.length - 1].seconds = audio.seconds;
      const old = session.chunks[index];
      session.chunks[index] = { text: old.text, ...audio, previousTake: old.pcm ? { pcm: old.pcm, seconds: old.seconds!, warnings: old.warnings } : undefined };
    } catch (error) {
      // A failed repair retains the old audio. No successful chunks are discarded.
      session.chunks[index].error = errorMessage(error);
      await save(session);
      throw new Error(`ช่วง ${index + 1}: ${errorMessage(error)}`);
    }
    await save(session);
  }
}

// Keep the current take until every short request succeeds. Persist each child
// independently so a failure/reload never pays again for successful children.
export async function repairWithShortRequests(session: PodcastSession, index: number, save: Save, status: (s: string) => void, options: { client?: Client; shouldStop?: () => boolean } = {}) {
  if (batchActive(session)) throw new Error('มีงาน Batch ค้างอยู่ กรุณาตรวจสถานะก่อน');
  const original = session.chunks[index];
  if (!original?.pcm) throw new Error('ต้องมีเสียงเดิมก่อนซ่อมแบบช่วงสั้น');
  if (!original.shortRepair) {
    const texts = splitScript({ ...session.settings, script: original.text, chunkSize: 1000 });
    if (texts.length < 2) throw new Error('ช่วงนี้สั้นอยู่แล้ว ใช้ปุ่มสร้างใหม่เฉพาะช่วง');
    original.shortRepair = { chunks: texts.map(text => ({ text })) };
    await save(session);
  }
  const draft: PodcastSession = { version: 1, id: session.id, settings: session.settings, chunks: original.shortRepair.chunks, charges: session.charges };
  const persist = async () => {
    original.shortRepair!.chunks = draft.chunks;
    await save(session);
  };
  await generateStandard(draft, persist, message => status(`ซ่อมช่วง ${index + 1}: ${message}`), options);
  if (draft.chunks.some(c => !c.pcm)) return;
  const pcm = concatenateUint8Arrays(draft.chunks.flatMap((c, i) => i ? [createSilence(100), c.pcm!] : [c.pcm!]));
  session.chunks[index] = {
    text: original.text, pcm, seconds: pcm.length / 48000,
    warnings: [...new Set(draft.chunks.flatMap(c => c.warnings ?? [])), 'ซ่อมด้วยคำขอสั้นแล้ว กรุณาฟังตรวจคุณภาพและรอยต่อ'],
    previousTake: { pcm: original.pcm, seconds: original.seconds ?? original.pcm.length / 48000, warnings: original.warnings },
  };
  await save(session);
}

export function restorePreviousTake(session: PodcastSession, index: number) {
  const chunk = session.chunks[index];
  if (chunk?.shortRepair) throw new Error('กรุณาทำการซ่อมช่วงสั้นที่ค้างอยู่ให้เสร็จก่อน');
  if (!chunk?.previousTake || !chunk.pcm) throw new Error('ไม่มีเสียงก่อนซ่อม');
  const current = { pcm: chunk.pcm, seconds: chunk.seconds!, warnings: chunk.warnings };
  Object.assign(chunk, chunk.previousTake, { previousTake: current, error: undefined });
}


// ---------------------------------------------------------------------------
// Batch API
//
// A finished Batch job returns the audio for every request inline, as base64,
// inside the job resource itself. Polling the job with a plain GET therefore
// re-downloads the whole episode's audio on every check once it has finished
// (twice over, since the REST resource carries it in both `metadata.output`
// and `response`). For a long episode that is hundreds of MB in one JSON
// document, which the browser cannot fetch and parse reliably, so the job
// looked "stuck" forever. To avoid that:
//  - status polls request only small fields (partial response `fields=`),
//  - a long episode is split into several jobs of about one chunk each, so a
//    job's result is no larger than one Standard response,
//  - results are read as a stream and stored chunk by chunk.
// ---------------------------------------------------------------------------

type RawResponse = { json(): Promise<any>; responseInternal?: Response };
type RawApi = {
  request(request: {
    path: string;
    httpMethod: 'GET' | 'POST';
    body?: string;
    queryParams?: Record<string, string>;
    httpOptions?: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<RawResponse>;
  getBaseUrl?(): string;
};

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };
// About one Standard request's worth of audio: the largest chunk size offered.
const BATCH_JOB_CHAR_BUDGET = 3000;
const MAX_BATCH_JOBS = 50;
// Grace periods before a missing job is reported as a real problem.
const NEW_JOB_NOT_FOUND_GRACE_MS = 5 * 60_000;
const UNCONFIRMED_SUBMIT_GRACE_MS = 10 * 60_000;
// Tried in order; a mask Google rejects falls back to the next one.
const STATUS_MASKS = ['name,done,error,metadata.state,metadata.batchStats', 'name,done,error', ''];
const RESULT_MASKS = ['response', ''];
let statusMaskLevel = 0;
const IDLE_TIMEOUT_MS = 60_000;

// Aborts a read when Google sends nothing for a minute, so a stalled connection
// cannot leave a check "in progress" forever. Each received piece resets it.
function idleWatchdog() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  touch();
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) };
}

function rawApi(client: Client): RawApi | undefined {
  const anyClient = client as any;
  const api = anyClient.apiClient || anyClient.batches?.apiClient;
  return api?.request ? api : undefined;
}

async function requestJson(api: RawApi, request: Parameters<RawApi['request']>[0]): Promise<any> {
  // No timeout on POST: an aborted create may still have created a paid job.
  const watchdog = request.httpMethod === 'GET' ? idleWatchdog() : undefined;
  try {
    const response = await api.request({ httpOptions: JSON_HEADERS, ...request, ...(watchdog ? { abortSignal: watchdog.signal } : {}) });
    const data = await response.json();
    if (data?.error) throw new Error(JSON.stringify(data));
    return data;
  } finally {
    watchdog?.stop();
  }
}

function httpStatus(error: unknown): number | undefined {
  const direct = statusCode(error);
  if (typeof direct === 'number') return direct;
  try {
    const code = JSON.parse(error instanceof Error ? error.message : String(error))?.error?.code;
    return typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

// Google answers an unsupported mask with 400, but a proxy in front of the API
// (for example the AI Studio host) may answer differently, so any client error
// except rate limiting or a bad key moves on to the next, simpler request.
function maskRejected(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const code = httpStatus(error);
  return code !== undefined && code >= 400 && code < 500 && code !== 429 && !/api.?key/i.test(raw);
}

function timeText() {
  return new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface BatchJobSnapshot {
  name?: string;
  state?: string;
  error?: { code?: number; message?: string };
  stats?: BatchJobRecord['stats'];
}

// Accepts a raw REST operation or an SDK BatchJob.
export function parseBatchOperation(raw: any): BatchJobSnapshot {
  if (!raw) return {};
  const meta = raw.metadata ?? {};
  const error = raw.error ?? meta.error;
  let state: string | undefined = raw.state ?? meta.state;
  state = state ? normalizeJobState(state) : undefined;
  if (state === 'JOB_STATE_UNSPECIFIED') state = undefined;
  if (!state && raw.done === true) {
    state = !error ? 'JOB_STATE_SUCCEEDED' : error.code === 1 ? 'JOB_STATE_CANCELLED' : 'JOB_STATE_FAILED';
  }
  const s = meta.batchStats ?? raw.batchStats;
  // int64 counters arrive as JSON strings.
  const stats = s
    ? {
        total: Number(s.requestCount ?? 0),
        succeeded: Number(s.successfulRequestCount ?? 0),
        failed: Number(s.failedRequestCount ?? 0),
        pending: Number(s.pendingRequestCount ?? 0),
      }
    : undefined;
  return { name: raw.name ?? meta.name, state, error, stats };
}

// REST nests the rows as `inlinedResponses.inlinedResponses`; the SDK flattens them.
export function inlinedRows(raw: any): any[] | undefined {
  for (const holder of [raw?.response, raw?.metadata?.output, raw?.dest, raw?.output, raw]) {
    const value = holder?.inlinedResponses;
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.inlinedResponses)) return value.inlinedResponses;
  }
  return undefined;
}

function responsesFileOf(raw: any): string | undefined {
  return raw?.response?.responsesFile ?? raw?.metadata?.output?.responsesFile ?? raw?.dest?.fileName ?? raw?.output?.responsesFile;
}

async function fetchJobStatus(client: Client, name: string): Promise<any> {
  const api = rawApi(client);
  if (!api) return client.batches.get({ name });
  for (let level = statusMaskLevel; ; level++) {
    const fields = STATUS_MASKS[level];
    try {
      const data = await requestJson(api, { path: name, httpMethod: 'GET', ...(fields ? { queryParams: { fields } } : {}) });
      // Remember a simpler mask only once it has worked; a real 404 fails at every level.
      statusMaskLevel = level;
      return data;
    } catch (error) {
      if (!fields || !maskRejected(error)) throw error;
    }
  }
}

type RowHandler = (row: any, position: number) => Promise<void>;
type ByteProgress = (bytes: number) => void;

async function streamText(response: Response, onText: (text: string) => Promise<void>, shouldStop: () => boolean, progress?: ByteProgress, keepAlive?: () => void) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let finished = false;
  try {
    while (!shouldStop()) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      keepAlive?.();
      bytes += value.byteLength;
      progress?.(bytes);
      await onText(decoder.decode(value, { stream: true }));
      keepAlive?.();
    }
    if (finished) await onText(decoder.decode());
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

async function readInlineResults(response: RawResponse, onRow: RowHandler, progress?: ByteProgress, keepAlive?: () => void): Promise<{ count: number; file?: string }> {
  let count = 0;
  const raw = response.responseInternal;
  if (!raw?.body?.getReader) {
    const data = await response.json();
    if (data?.error) throw new Error(JSON.stringify(data));
    for (const row of inlinedRows(data) ?? []) await onRow(row, count++);
    return { count, file: responsesFileOf(data) };
  }
  let file: string | undefined;
  const queue: string[] = [];
  const scanner = new JsonArrayStreamer('inlinedResponses', json => queue.push(json), (key, value) => {
    if (key === 'responsesFile') file ??= value;
  });
  await streamText(raw, async text => {
    scanner.push(text);
    while (queue.length) await onRow(JSON.parse(queue.shift()!), count++);
  }, () => scanner.targetDone, progress, keepAlive);
  if (!scanner.targetDone && !scanner.complete) {
    throw new Error('ดาวน์โหลดผลลัพธ์ Batch ไม่ครบ (การเชื่อมต่อถูกตัดกลางทาง)');
  }
  return { count, file };
}

// Results written to a JSONL file: one `{"key", "response" | "error"}` per line.
async function readResultFile(api: RawApi, file: string, onRow: RowHandler, progress?: ByteProgress): Promise<number> {
  const base = (api.getBaseUrl?.() || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const watchdog = idleWatchdog();
  try {
    const response = await api.request({
      path: `${file}:download`,
      httpMethod: 'GET',
      queryParams: { alt: 'media' },
      httpOptions: { baseUrl: `${base}/download` },
      abortSignal: watchdog.signal,
    });
    const raw = response.responseInternal;
    if (!raw) throw new Error('ดาวน์โหลดไฟล์ผลลัพธ์ Batch ไม่ได้');
    let count = 0;
    const queue: string[] = [];
    const lines = new LineStreamer(line => queue.push(line));
    const drain = async () => {
      while (queue.length) await onRow(JSON.parse(queue.shift()!), count++);
    };
    if (raw.body?.getReader) {
      await streamText(raw, async text => {
        lines.push(text);
        await drain();
      }, () => false, progress, watchdog.touch);
    } else {
      lines.push(await raw.text());
    }
    lines.finish();
    await drain();
    return count;
  } finally {
    watchdog.stop();
  }
}

async function downloadJobResults(client: Client, name: string, onRow: RowHandler, progress?: ByteProgress): Promise<number> {
  const api = rawApi(client);
  if (!api) {
    let count = 0;
    for (const row of inlinedRows(await client.batches.get({ name })) ?? []) await onRow(row, count++);
    return count;
  }
  let file: string | undefined;
  for (const fields of RESULT_MASKS) {
    const watchdog = idleWatchdog();
    try {
      let response: RawResponse;
      try {
        response = await api.request({ path: name, httpMethod: 'GET', abortSignal: watchdog.signal, ...(fields ? { queryParams: { fields } } : {}) });
      } catch (error) {
        if (fields && maskRejected(error)) continue;
        throw error;
      }
      const result = await readInlineResults(response, onRow, progress, watchdog.touch);
      if (result.count) return result.count;
      file ??= result.file;
      if (file) break;
    } finally {
      watchdog.stop();
    }
  }
  return file ? readResultFile(api, file, onRow, progress) : 0;
}

async function findJobByDisplayName(client: Client, displayName: string): Promise<string | undefined> {
  const api = rawApi(client);
  if (!api) {
    const jobs = await client.batches.list({ config: { pageSize: 20 } });
    for await (const job of jobs) if (job.displayName === displayName && job.name) return job.name;
    return undefined;
  }
  let fields: string | undefined = 'operations.name,operations.metadata.displayName,nextPageToken';
  let pageToken: string | undefined;
  for (let page = 0; page < 5; ) {
    let data: any;
    try {
      // Without a mask, list responses embed finished jobs' audio: keep the page tiny.
      data = await requestJson(api, {
        path: 'batches',
        httpMethod: 'GET',
        queryParams: { pageSize: fields ? '100' : '5', ...(fields ? { fields } : {}), ...(pageToken ? { pageToken } : {}) },
      });
    } catch (error) {
      if (!fields || !maskRejected(error)) throw error;
      fields = undefined;
      continue;
    }
    const found = (data?.operations ?? []).find((op: any) => (op?.metadata?.displayName ?? op?.displayName) === displayName);
    if (found?.name) return found.name;
    pageToken = data?.nextPageToken;
    if (!pageToken || !fields) return undefined;
    page++;
  }
  return undefined;
}

async function createBatchJob(client: Client, model: string, displayName: string, src: (InlinedRequest & { metadata: { key: string } })[]): Promise<any> {
  const api = rawApi(client);
  if (!api) return client.batches.create({ model, src, config: { displayName } });
  // The SDK serializer drops speechMetadata from parts, so post the REST body directly.
  return requestJson(api, {
    path: `models/${model}:batchGenerateContent`,
    httpMethod: 'POST',
    body: JSON.stringify({
      batch: {
        displayName,
        inputConfig: {
          requests: {
            requests: src.map(item => ({
              request: {
                contents: item.contents,
                generationConfig: { responseModalities: ['AUDIO'], speechConfig: item.config?.speechConfig },
              },
              metadata: item.metadata,
            })),
          },
        },
      },
    }),
  });
}

function aggregateState(jobs: BatchJobRecord[]): string {
  const states = jobs.map(job => normalizeJobState(job.state));
  if (states.includes('SUBMITTING')) return 'SUBMITTING';
  if (jobs.every(jobFinished)) {
    if (states.every(s => s === 'JOB_STATE_SUCCEEDED')) return 'JOB_STATE_SUCCEEDED';
    if (states.every(s => s === 'JOB_STATE_CANCELLED')) return 'JOB_STATE_CANCELLED';
    if (states.some(s => RESULT_JOB_STATES.includes(s))) return 'JOB_STATE_PARTIALLY_SUCCEEDED';
    return states.find(s => s !== 'JOB_STATE_CANCELLED') ?? 'JOB_STATE_FAILED';
  }
  if (states.includes('SUBMISSION_UNKNOWN')) return 'SUBMISSION_UNKNOWN';
  if (states.some(s => s === 'JOB_STATE_RUNNING' || TERMINAL_JOB_STATES.includes(s))) return 'JOB_STATE_RUNNING';
  return 'JOB_STATE_PENDING';
}

function describePollError(error: unknown, job: BatchJobRecord): string {
  const code = httpStatus(error);
  const text = errorMessage(error);
  if ((error as Error)?.name === 'AbortError') return 'Google ไม่ส่งข้อมูลกลับมาเกิน 60 วินาที — ระบบจะลองใหม่รอบถัดไป';
  if (code === 404 || /NOT_FOUND|entity was not found/i.test(text)) {
    if (job.submittedAt && Date.now() - job.submittedAt < NEW_JOB_NOT_FOUND_GRACE_MS) {
      return `Google ยังไม่พบงาน ${job.name} (404) ซึ่งอาจเกิดได้ในไม่กี่นาทีแรกหลังส่ง — ระบบจะตรวจใหม่อัตโนมัติ`;
    }
    return `Google ไม่พบงาน ${job.name} (404 NOT_FOUND) — งาน Batch ผูกกับโปรเจกต์ของ API key ที่ใช้ตอนส่ง ถ้าเปลี่ยน/เลือก API key ใหม่หลังส่งงาน ให้เลือกคีย์เดิมกลับมาแล้วกดตรวจอีกครั้ง ถ้าไม่ได้เปลี่ยนคีย์ แปลว่างานนี้ไม่มีอยู่แล้ว ให้กดยกเลิกการรอคิวแล้วสร้างใหม่`;
  }
  if (code === 401 || code === 403) return `Google ปฏิเสธสิทธิ์เข้าถึงงาน (${code}): ${text} — ตรวจว่ายังใช้ API key เดียวกับตอนส่งงาน`;
  if (code === 429) return 'Google จำกัดความถี่การตรวจชั่วคราว (429) — ระบบจะลองใหม่รอบถัดไป';
  if (code && code >= 500) return `เซิร์ฟเวอร์ Google ขัดข้องชั่วคราว (${code}) — ระบบจะลองใหม่รอบถัดไป`;
  return `ตรวจหรือดาวน์โหลดผลไม่สำเร็จ: ${text} — ระบบจะลองใหม่รอบถัดไป`;
}

function batchSummary(session: PodcastSession, now: string): string {
  const batch = session.batch!;
  const jobs = batch.jobs ?? [];
  const total = batch.indices.length;
  const received = batch.indices.filter(i => session.chunks[i]?.pcm).length;
  const finished = jobs.filter(jobFinished).length;
  const progress = `ได้รับเสียง ${received}/${total} ช่วง${jobs.length > 1 ? ` · งานเสร็จ ${finished}/${jobs.length}` : ''}`;
  const withStats = jobs.filter(job => job.stats && !jobFinished(job));
  const rendered = withStats.length
    ? ` · Google เรนเดอร์แล้ว ${withStats.reduce((n, job) => n + job.stats!.succeeded, 0)}/${withStats.reduce((n, job) => n + job.stats!.total, 0)} คำขอในงานที่ยังไม่เสร็จ`
    : '';
  // Never present a failed check as progress: the state shown is only the last one known.
  const unfinished = jobs.filter(job => !jobFinished(job));
  const failing = unfinished.filter(job => job.lastError).length;
  if (failing && failing === unfinished.length) {
    return `ตรวจเวลา ${now}: ตรวจสถานะกับ Google ไม่สำเร็จ (ดูรายละเอียดสีแดงด้านล่าง) · สถานะล่าสุดที่ทราบ ${batch.state} · ${progress}`;
  }
  if (failing) return `ตรวจเวลา ${now}: สถานะรวม ${batch.state} · ${progress} · ตรวจไม่สำเร็จ ${failing} งาน (ดูรายละเอียดสีแดงด้านล่าง)`;
  switch (batch.state) {
    case 'JOB_STATE_SUCCEEDED':
      return `ตรวจเวลา ${now}: งานเสร็จสมบูรณ์ ${progress} รวมไฟล์เสียงเรียบร้อยแล้ว!`;
    case 'JOB_STATE_PARTIALLY_SUCCEEDED':
      return `ตรวจเวลา ${now}: งาน Batch จบแล้ว ${progress} — ช่วงที่ยังไม่มีเสียงกด "สร้างทันที / ทำช่วงที่เหลือต่อ" ได้`;
    case 'JOB_STATE_FAILED':
      return `ตรวจเวลา ${now}: คิว Batch ล้มเหลว (${progress}) แนะนำให้ใช้ปุ่มสร้างทันที`;
    case 'JOB_STATE_EXPIRED':
      return `ตรวจเวลา ${now}: งาน Batch หมดอายุ เพราะ Google ประมวลผลไม่เสร็จภายใน 48 ชั่วโมง (${progress}) แนะนำให้ใช้ปุ่มสร้างทันที`;
    case 'JOB_STATE_CANCELLED':
      return `ตรวจเวลา ${now}: งานถูกยกเลิกแล้ว`;
    case 'JOB_STATE_RUNNING':
      return `ตรวจเวลา ${now}: Google กำลังประมวลผลเสียง (JOB_STATE_RUNNING) · ${progress}${rendered}`;
    case 'JOB_STATE_PENDING':
      return `ตรวจเวลา ${now}: งานรอคิวที่เซิร์ฟเวอร์ Google (JOB_STATE_PENDING) · ${progress}`;
    case 'SUBMITTING':
    case 'SUBMISSION_UNKNOWN':
      return `ตรวจเวลา ${now}: กำลังยืนยันการส่งงานกับ Google · ${progress}`;
    default:
      return `ตรวจเวลา ${now}: สถานะ ${batch.state} · ${progress}`;
  }
}

async function applyBatchRow(session: PodcastSession, job: BatchJobRecord, row: any, position: number, save: Save) {
  const prefix = `${session.id}:`;
  const key: unknown = row?.metadata?.key ?? row?.key;
  const index = typeof key === 'string' ? (key.startsWith(prefix) ? Number(key.slice(prefix.length)) : NaN) : job.indices[position];
  if (!Number.isInteger(index) || !job.indices.includes(index) || session.chunks[index]?.pcm) return;
  const response = row?.response ?? row?.generateContentResponse;
  try {
    if (!response) throw new Error(row?.error?.message || 'ไม่มีผลลัพธ์สำหรับช่วงนี้');
    charge(session, response, 'batch');
    const audio = decodeResponse(response);
    session.charges[session.charges.length - 1].seconds = audio.seconds;
    session.chunks[index] = { text: session.chunks[index].text, ...audio };
  } catch (error) {
    // Replace rather than mutate: the caller may share chunk objects with UI state.
    session.chunks[index] = { ...session.chunks[index], error: errorMessage(error) };
    return;
  }
  // Persist each paid chunk at once so an interrupted download never loses it.
  await save(session);
}

export function planBatchJobs(session: PodcastSession, indices: number[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  for (const index of indices) {
    const length = session.chunks[index].text.length;
    if (current.length && chars + length > BATCH_JOB_CHAR_BUDGET) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += length;
  }
  if (current.length) groups.push(current);
  return groups;
}

export async function submitBatch(session: PodcastSession, save: Save, client: Client = createClient()) {
  if (batchActive(session)) throw new Error('มี Batch ค้างอยู่แล้ว');
  // Clear any stale batch record
  delete session.batch;

  let effectiveModel = session.settings.model;
  if (effectiveModel === 'gemini-3.8-flash-lite-tts' && session.settings.mode === 'multi') {
    effectiveModel = 'gemini-3.8-flash-tts';
  }

  const indices = session.chunks.map((_, i) => i).filter(i => !session.chunks[i].pcm);
  if (!indices.length) throw new Error('ทุกช่วงเสียงถูกสร้างเสร็จหมดแล้ว หากต้องการสร้างใหม่กรุณากดปุ่มล้างไฟล์เสียงก่อน');
  const groups = planBatchJobs(session, indices);
  if (groups.length > MAX_BATCH_JOBS) {
    throw new Error(`บทยาวเกินไปสำหรับการส่ง Batch ครั้งเดียว (${groups.length} งาน สูงสุด ${MAX_BATCH_JOBS}) กรุณาแบ่งเป็นหลายตอน`);
  }
  await checkBatchConnection(effectiveModel, client);

  const base = `podcast-${session.id}-${Date.now()}`;
  const batch: NonNullable<PodcastSession['batch']> = {
    displayName: base,
    state: 'SUBMITTING',
    indices,
    jobs: groups.map((group, k) => ({
      displayName: groups.length > 1 ? `${base}-${k + 1}of${groups.length}` : base,
      indices: group,
      state: 'SUBMITTING',
      submittedAt: Date.now(),
    })),
    lastChecked: timeText(),
    checkMessage: `กำลังส่งคำขอเข้าคิว Batch ของ Google (${groups.length} งาน)…`,
  };
  session.batch = batch;
  await save(session);

  let failure: unknown;
  let confirmed = 0;
  for (const job of batch.jobs!) {
    const src = job.indices.map(i => ({ ...buildRequest(session.settings, session.chunks[i].text), metadata: { key: `${session.id}:${i}` } }));
    try {
      if (new TextEncoder().encode(JSON.stringify(src)).length > 19_000_000) throw new Error('บทใหญ่เกินขนาด Inline Batch กรุณาแบ่งเป็นหลายตอน');
      const snapshot = parseBatchOperation(await createBatchJob(client, effectiveModel, job.displayName, src));
      if (!snapshot.name) throw new Error('API ไม่ส่งหมายเลขงานกลับมา ระบบจะค้นหางานที่ส่งไปแล้วให้อัตโนมัติ');
      job.name = snapshot.name;
      job.state = snapshot.state ?? 'JOB_STATE_PENDING';
      confirmed++;
    } catch (error) {
      failure = error;
      // A definite rejection created no job; anything else may have, so look it up later.
      job.state = [400, 401, 403, 404, 405, 413, 422, 429].includes(httpStatus(error) ?? 0) ? 'JOB_STATE_FAILED' : 'SUBMISSION_UNKNOWN';
      job.lastError = errorMessage(error);
    }
    job.submittedAt = Date.now();
    // Store each confirmed job id immediately: it is a paid job.
    await save(session);
    if (failure) break;
  }

  // Jobs after a failure were never sent; their chunks stay available to generate later.
  batch.jobs = batch.jobs!.filter(job => job.state !== 'SUBMITTING');
  batch.indices = batch.jobs.flatMap(job => job.indices);
  batch.state = aggregateState(batch.jobs);
  batch.lastChecked = timeText();
  if (failure) {
    const message = errorMessage(failure);
    batch.lastError = groups.length > 1 ? `ส่งงานสำเร็จ ${confirmed}/${groups.length} งาน — งานถัดไปส่งไม่สำเร็จ: ${message} ช่วงที่ยังไม่ได้ส่งสร้างต่อได้ด้วยปุ่ม "สร้างทันที / ทำช่วงที่เหลือต่อ" หลังงาน Batch นี้จบ` : message;
    batch.checkMessage = `ส่งงานเข้าคิวได้ ${confirmed}/${groups.length} งาน`;
  } else {
    batch.checkMessage = `ส่งงานเข้าคิว Google สำเร็จ ${groups.length} งาน (${indices.length} ช่วง) — Google ตั้งเป้าทำ Batch ให้เสร็จภายใน 24 ชั่วโมง ส่วนใหญ่เร็วกว่านั้นมาก ระบบจะตรวจและดึงเสียงของแต่ละงานอัตโนมัติทันทีที่เสร็จ`;
  }
  await save(session);
  if (failure && !confirmed) throw failure;
}

// Everything about a batch that is worth persisting (not the check time/message).
function batchSignature(session: PodcastSession): string {
  const batch = session.batch;
  return JSON.stringify([
    batch?.state,
    batch?.lastError,
    batch?.jobs?.map(job => [job.name, job.state, job.collected, job.lastError, job.stats]),
    batch?.indices.map(i => [!!session.chunks[i]?.pcm, session.chunks[i]?.error]),
  ]);
}

export async function collectBatch(
  session: PodcastSession,
  save: Save,
  client: Client = createClient(),
  options: {
    progress?: (message: string) => void;
    // Called instead of `save` when a check changed nothing but the check time and
    // message, so a long wait does not rewrite every stored chunk to disk each poll.
    refresh?: (session: PodcastSession) => void;
  } = {},
): Promise<string> {
  const progress = options.progress ?? (() => {});
  const batch = session.batch;
  if (!batch) throw new Error('ไม่มีงาน Batch');
  const before = batchSignature(session);
  const jobs = (batch.jobs = batchJobs(batch));
  delete batch.name;
  if (!batchActive(session)) return 'งานนี้เสร็จสิ้นหรือถูกยกเลิกแล้ว';
  const now = timeText();
  batch.lastChecked = now;

  for (const [position, job] of jobs.entries()) {
    if (jobFinished(job)) continue;
    const label = jobs.length > 1 ? `งาน ${position + 1}/${jobs.length}` : 'งาน Batch';
    try {
      if (!job.name) {
        progress(`${label}: กำลังค้นหางานที่ส่งไปแล้วใน Google…`);
        job.name = await findJobByDisplayName(client, job.displayName);
        if (!job.name) {
          if (Date.now() - (job.submittedAt ?? 0) > UNCONFIRMED_SUBMIT_GRACE_MS) {
            job.state = 'JOB_STATE_FAILED';
            job.lastError = 'ไม่พบงานนี้ใน Google จึงถือว่าส่งไม่สำเร็จ — ช่วงของงานนี้สร้างต่อได้ด้วยปุ่ม "สร้างทันที / ทำช่วงที่เหลือต่อ"';
          } else {
            job.lastError = 'ยังไม่พบงานที่ส่งไปใน Google — จะค้นหาอีกครั้งในรอบถัดไป';
          }
          continue;
        }
        job.state = 'JOB_STATE_PENDING';
      }

      let rows: any[] | undefined;
      if (!TERMINAL_JOB_STATES.includes(normalizeJobState(job.state))) {
        progress(`${label}: กำลังตรวจสถานะ…`);
        const raw = await fetchJobStatus(client, job.name);
        const snapshot = parseBatchOperation(raw);
        if (snapshot.state) job.state = snapshot.state;
        if (snapshot.stats) job.stats = snapshot.stats;
        job.lastError = snapshot.error && !RESULT_JOB_STATES.includes(job.state) ? snapshot.error.message || `Google error ${snapshot.error.code}` : undefined;
        // Only an unmasked status response carries results; reuse them if so.
        rows = inlinedRows(raw);
      }
      if (RESULT_JOB_STATES.includes(normalizeJobState(job.state)) && !job.collected) {
        const handle: RowHandler = (row, rowPosition) => applyBatchRow(session, job, row, rowPosition, save);
        let count = 0;
        if (rows?.length) {
          for (const row of rows) await handle(row, count++);
        } else {
          progress(`${label}: Google สร้างเสียงเสร็จแล้ว กำลังดาวน์โหลดไฟล์เสียง…`);
          let reported = 0;
          count = await downloadJobResults(client, job.name, handle, bytes => {
            if (bytes - reported < 1_000_000) return;
            reported = bytes;
            progress(`${label}: กำลังดาวน์โหลดไฟล์เสียง ${(bytes / 1_000_000).toFixed(0)} MB…`);
          });
        }
        for (const index of job.indices) {
          const chunk = session.chunks[index];
          if (!chunk.pcm && !chunk.error) session.chunks[index] = { ...chunk, error: 'Google ไม่ส่งผลลัพธ์ของช่วงนี้มา — กดสร้างทันทีเพื่อทำช่วงนี้' };
        }
        job.collected = true;
        job.lastError = count ? undefined : 'Google รายงานว่างานเสร็จ แต่ไม่พบข้อมูลเสียงในผลลัพธ์';
      }
    } catch (error) {
      job.lastError = describePollError(error, job);
    }
  }

  batch.state = aggregateState(jobs);
  if (batch.state === 'JOB_STATE_SUCCEEDED' && batch.indices.some(i => !session.chunks[i].pcm)) {
    batch.state = 'JOB_STATE_PARTIALLY_SUCCEEDED';
  }
  const jobsByError = new Map<string, number[]>();
  jobs.forEach((job, k) => {
    if (job.lastError) jobsByError.set(job.lastError, [...(jobsByError.get(job.lastError) ?? []), k + 1]);
  });
  batch.lastError = jobsByError.size
    ? [...jobsByError].map(([message, numbers]) => (jobs.length > 1 ? `งาน ${numbers.join(', ')}/${jobs.length}: ${message}` : message)).join(' • ')
    : undefined;
  batch.checkMessage = batchSummary(session, now);
  if (options.refresh && batchSignature(session) === before) options.refresh(session);
  else await save(session);
  return batch.checkMessage;
}

export async function cancelBatch(session: PodcastSession, save: Save, client: Client = createClient()) {
  const batch = session.batch;
  if (!batch) return;
  const jobs = (batch.jobs = batchJobs(batch));
  delete batch.name;
  const api = rawApi(client);
  for (const job of jobs) {
    if (jobFinished(job)) continue;
    if (job.name && !TERMINAL_JOB_STATES.includes(normalizeJobState(job.state))) {
      try {
        if (api) await api.request({ path: `${job.name}:cancel`, httpMethod: 'POST', body: '{}', httpOptions: JSON_HEADERS });
        else await client.batches.cancel({ name: job.name });
      } catch {
        // Best-effort cancel on Google API. Local dismissal always succeeds.
      }
    }
    job.state = 'JOB_STATE_CANCELLED';
  }
  batch.state = 'JOB_STATE_CANCELLED';
  batch.lastError = undefined;
  batch.checkMessage = `ยกเลิกการรอคิว Batch แล้ว (${timeText()}) — ระบบปลดล็อกแล้ว เสียงที่ดาวน์โหลดมาแล้วยังอยู่ครบ สามารถกดปุ่ม "สร้างทันที (Real-time)" เพื่อทำช่วงที่เหลือได้ทันที`;
  await save(session);
}

export async function dismissBatch(session: PodcastSession, save: Save) {
  if (session.batch) {
    delete session.batch;
    await save(session);
  }
}
