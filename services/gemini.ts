import { GoogleGenAI, Modality, type GenerateContentResponse, type InlinedRequest, type BatchJob } from '@google/genai';
import { PodcastSession, TtsSettings, AudioChunk } from '../types';
import { concatenateUint8Arrays, createSilence, createWavBlob, inspectPcm, validatePcm } from '../utils/audio';
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
        await client.batches.list({ config: { pageSize: 1 } });
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

export function batchActive(session?: PodcastSession | null): boolean {
  return !!session?.batch && !['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(session.batch.state);
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
  await checkBatchConnection(effectiveModel, client);
  const src = indices.map(i => ({ ...buildRequest(session.settings, session.chunks[i].text), metadata: { key: `${session.id}:${i}` } }));
  if (new TextEncoder().encode(JSON.stringify(src)).length > 19_000_000) throw new Error('บทใหญ่เกินขนาด Inline Batch กรุณาแบ่งเป็นหลายตอน');
  session.batch = {
    displayName: `podcast-${session.id}-${Date.now()}`,
    state: 'SUBMITTING',
    indices,
    lastChecked: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    checkMessage: 'กำลังส่งคำขอเข้าคิว Batch ของ Google...',
  };
  await save(session);
  let job: any;
  try {
    const anyClient = client as any;
    const apiClient = anyClient.apiClient || anyClient.batches?.apiClient;
    if (apiClient?.request) {
      const batchPayload = {
        batch: {
          displayName: session.batch.displayName,
          inputConfig: {
            requests: {
              requests: src.map(item => ({
                request: {
                  contents: item.contents,
                  generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: item.config?.speechConfig,
                  },
                },
                metadata: item.metadata,
              })),
            },
          },
        },
      };
      const response = await apiClient.request({
        path: `models/${effectiveModel}:batchGenerateContent`,
        httpMethod: 'POST',
        body: JSON.stringify(batchPayload),
        httpOptions: { headers: { 'Content-Type': 'application/json' } },
      });
      const data = await response.json();
      if (data.error) throw new Error(JSON.stringify(data));
      job = data;
    } else {
      job = await client.batches.create({ model: effectiveModel, src, config: { displayName: session.batch.displayName } });
    }
  } catch (error) {
    session.batch.state = [400, 401, 403, 404, 405, 413, 422, 429].includes(statusCode(error)!) ? 'JOB_STATE_FAILED' : 'SUBMISSION_UNKNOWN';
    session.batch.lastError = errorMessage(error);
    await save(session);
    throw error;
  }
  const jobName = job?.name || (job as any)?.metadata?.name;
  if (!jobName) throw new Error('API ไม่ส่งหมายเลขงานกลับมา กรุณากดค้นหางานที่ส่งไปแล้ว');
  session.batch.name = jobName;
  session.batch.state = (job.state as any) || (job.metadata?.state as any) || 'JOB_STATE_PENDING';
  session.batch.lastChecked = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  session.batch.checkMessage = 'งานถูกส่งเข้าคิว Google สำเร็จแล้ว (JOB_STATE_PENDING) — ระบบ Batch อาจใช้เวลา 10-30 นาทีขึ้นไปตามคิวเซิร์ฟเวอร์ หากต้องการเสียงทันทีสามารถกดยกเลิกคิวแล้วกดสร้างทันทีได้ตลอดเวลา';
  await save(session);
}

function normalizeBatchJob(raw: any): any {
  if (!raw) return null;
  const state = raw.state || raw.metadata?.state || raw.status;
  const dest =
    raw.dest ||
    (raw.metadata?.output ? { inlinedResponses: raw.metadata.output.inlinedResponses || raw.metadata.output.inlined_responses } : undefined) ||
    (raw.output ? { inlinedResponses: raw.output.inlinedResponses || raw.output.inlined_responses } : undefined) ||
    (raw.inlinedResponses ? { inlinedResponses: raw.inlinedResponses } : undefined);
  const error = raw.error || raw.metadata?.error;
  return {
    name: raw.name,
    displayName: raw.displayName || raw.metadata?.displayName,
    state,
    dest,
    error,
    createTime: raw.createTime || raw.metadata?.createTime,
    raw,
  };
}

async function fetchBatchJobWithFallback(batchName: string, client: Client): Promise<any> {
  const cleanName = batchName.replace(/^\/?/, '');
  const anyClient = client as any;
  const apiKey =
    anyClient?.apiKey ||
    anyClient?.clientOptions?.apiKey ||
    anyClient?.batches?.apiClient?.clientOptions?.apiKey ||
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY ||
    '';

  // 1. Try SDK get first
  try {
    const sdkJob = await client.batches.get({ name: batchName });
    if (sdkJob) return normalizeBatchJob(sdkJob);
  } catch (sdkErr) {
    const msg = errorMessage(sdkErr);
    // If it's not a streaming/ReadableStream bug and we have no direct API key, rethrow
    if (!/readable|close|json|stream/i.test(msg) && !apiKey) {
      throw sdkErr;
    }
  }

  // 2. Direct REST fetch with text parsing (bypasses browser stream closing issues)
  if (apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${cleanName}?key=${encodeURIComponent(apiKey)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        const text = await res.text();
        if (!text || text.trim().length === 0) {
          if (attempt < 2) continue;
          throw new Error('Google ส่งข้อมูลว่างเปล่า (การเชื่อมต่ออาจหยุดชะงักชั่วคราว)');
        }

        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          if (attempt < 2) continue;
          throw new Error('การแปลงข้อมูล JSON จาก Google ขัดข้องชั่วคราว');
        }

        if (data.error) {
          throw new Error(JSON.stringify(data));
        }

        return normalizeBatchJob(data);
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
  }

  // Fallback
  const fallbackJob = await client.batches.get({ name: batchName });
  return normalizeBatchJob(fallbackJob);
}

export async function collectBatch(session: PodcastSession, save: Save, client: Client = createClient()): Promise<string> {
  const batch = session.batch;
  if (!batch) throw new Error('ไม่มีงาน Batch');
  if (!batchActive(session)) return 'งานนี้เสร็จสิ้นหรือถูกยกเลิกแล้ว';
  const nowStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  batch.lastChecked = nowStr;

  if (!batch.name) {
    try {
      const jobs = await client.batches.list({ config: { pageSize: 100 } });
      for await (const job of jobs) {
        if (job.displayName === batch.displayName && job.name) { batch.name = job.name; break; }
      }
    } catch (e) {
      batch.lastError = errorMessage(e);
      await save(session);
      throw e;
    }
    if (!batch.name) {
      batch.checkMessage = `ตรวจเวลา ${nowStr}: ยังไม่พบงานในระบบ Google กรุณารอสักครู่`;
      await save(session);
      throw new Error('ยังไม่พบงานที่ส่งไปแล้ว รอสักครู่แล้วค้นหาอีกครั้ง หรือกดยกเลิกเพื่อสลับไปสร้างทันที');
    }
    await save(session);
  }

  let job: any;
  try {
    job = await fetchBatchJobWithFallback(batch.name, client);
    // Success: clear transient error if any was stored previously
    batch.lastError = undefined;
  } catch (error) {
    const errText = errorMessage(error);
    if (/not_found|404|entity was not found/i.test(errText)) {
      // In the first 1-2 minutes, Google Batch API may return 404 while propagating across datacenters.
      // NEVER cancel the batch automatically! Keep state and wait for next poll.
      batch.lastError = undefined;
      batch.checkMessage = `ตรวจเวลา ${nowStr}: Google กำลังเริ่มต้นจัดเตรียมงานในระบบคลาวด์ (JOB_STATE_PENDING)...`;
      await save(session);
      return batch.checkMessage;
    }

    // For transient network / stream / JSON parse glitches:
    // DO NOT fail the batch and DO NOT throw a fatal error!
    batch.lastError = undefined;
    batch.checkMessage = `ตรวจเวลา ${nowStr}: กำลังรอการเชื่อมต่อกับ Google (${errText}) — งานในคิวยังคงประมวลผลอยู่ตามปกติ`;
    await save(session);
    return batch.checkMessage;
  }

  const jobState = job?.state || batch.state;
  const terminal = ['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(jobState);
  if (terminal) {
    const rows =
      job.dest?.inlinedResponses ||
      job.dest?.inlined_responses ||
      job.output?.inlinedResponses ||
      job.output?.inlined_responses ||
      job.inlinedResponses;

    if (jobState === 'JOB_STATE_SUCCEEDED' && !rows) {
      batch.checkMessage = `ตรวจเวลา ${nowStr}: Google เรนเดอร์เสียงเสร็จแล้ว กำลังรอรับข้อมูลไฟล์เสียง...`;
      await save(session);
      return batch.checkMessage;
    }
    const results = rows ?? [];
    for (let position = 0; position < batch.indices.length; position++) {
      const index = batch.indices[position];
      if (session.chunks[index].pcm) continue;
      const key = `${session.id}:${index}`;
      const row = results.some(r => r.metadata?.key) ? results.find(r => r.metadata?.key === key) : results[position];
      try {
        const itemResp = row?.response || row?.generateContentResponse;
        if (!itemResp) throw new Error(row?.error?.message || job.error?.message || 'ไม่มีผลลัพธ์สำหรับช่วงนี้');
        charge(session, itemResp, 'batch');
        const audio = decodeResponse(itemResp);
        session.charges[session.charges.length - 1].seconds = audio.seconds;
        session.chunks[index] = { text: session.chunks[index].text, ...audio };
      } catch (error) { session.chunks[index].error = errorMessage(error); }
    }
  }

  batch.state = jobState;
  if (batch.state === 'JOB_STATE_PENDING') {
    batch.lastError = undefined;
    batch.checkMessage = `ตรวจเวลา ${nowStr}: งานกำลังรอคิวที่เซิร์ฟเวอร์ Google (JOB_STATE_PENDING) — เนื่องจาก Batch เป็นคิวประหยัด 50% อาจใช้เวลา 10-30 นาทีขึ้นไป หากรีบสามารถกดยกเลิกแล้วกดสร้างทันทีได้`;
  } else if (batch.state === 'JOB_STATE_RUNNING') {
    batch.lastError = undefined;
    batch.checkMessage = `ตรวจเวลา ${nowStr}: Google กำลังประมวลผลเสียง (JOB_STATE_RUNNING)...`;
  } else if (batch.state === 'JOB_STATE_SUCCEEDED') {
    batch.lastError = undefined;
    batch.checkMessage = `ตรวจเวลา ${nowStr}: งานเสร็จสมบูรณ์ รวมไฟล์เสียงเรียบร้อยแล้ว!`;
  } else if (batch.state === 'JOB_STATE_CANCELLED') {
    batch.checkMessage = `ตรวจเวลา ${nowStr}: งานถูกยกเลิกแล้ว`;
  } else if (batch.state === 'JOB_STATE_FAILED') {
    batch.lastError = job.error?.message || 'ข้อผิดพลาดจาก Google';
    batch.checkMessage = `ตรวจเวลา ${nowStr}: คิว Batch ล้มเหลว (${batch.lastError}) แนะนำให้ใช้ปุ่มสร้างทันที`;
  } else {
    batch.checkMessage = `ตรวจเวลา ${nowStr}: สถานะ ${batch.state}`;
  }

  await save(session);
  return batch.checkMessage;
}

export async function cancelBatch(session: PodcastSession, save: Save, client: Client = createClient()) {
  const batch = session.batch;
  if (!batch) return;
  const nowStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (batch.name) {
    try {
      const anyClient = client as any;
      if (anyClient.batches?.cancel) {
        await anyClient.batches.cancel({ name: batch.name });
      }
    } catch {
      // Best-effort cancel on Google API. Local dismissal always succeeds.
    }
  }
  batch.state = 'JOB_STATE_CANCELLED';
  batch.checkMessage = `ยกเลิกการรอคิว Batch แล้ว (${nowStr}) — ระบบปลดล็อกแล้ว สามารถกดปุ่ม "สร้างทันที (Real-time)" เพื่อสร้างเสียงได้ทันที`;
  await save(session);
}

export async function dismissBatch(session: PodcastSession, save: Save) {
  if (session.batch) {
    delete session.batch;
    await save(session);
  }
}
