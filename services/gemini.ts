import { GoogleGenAI, Modality, type GenerateContentResponse, type InlinedRequest, type BatchJob } from '@google/genai';
import { PodcastSession, TtsSettings, AudioChunk } from '../types';
import { concatenateUint8Arrays, createSilence, createWavBlob, inspectPcm, validatePcm } from '../utils/audio';
import { splitScript } from '../utils/script';

export function createClient() {
  // Restore the original AI Studio integration: the host handles its selected
  // key. Do not redirect Standard generation through our experimental server.
  // No retryOptions: SDK 1.52 otherwise discards error status/body.
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
}

export function createSession(settings: TtsSettings): PodcastSession {
  return { version: 1, id: crypto.randomUUID(), settings: structuredClone(settings), chunks: splitScript(settings).map(text => ({ text })), charges: [] };
}

export function buildRequest(settings: TtsSettings, text: string): InlinedRequest & { contents: NonNullable<InlinedRequest['contents']> } {
  // Preserve original style/voices. Batch changes scheduling, not direction.
  const prompt = settings.styleInstructions.trim() ? `(Speaking Style: ${settings.styleInstructions.trim()}) \n\n${text}` : text;
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: settings.mode === 'multi' ? {
        multiSpeakerVoiceConfig: { speakerVoiceConfigs: settings.speakers.map(s => ({ speaker: s.name.trim(), voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } })) }
      } : { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.speakers[0].voice } } },
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
  try {
    const detail = JSON.parse(message)?.error;
    if (detail?.message) return `Google API ${detail.code ?? ''}: ${detail.message}`;
  } catch { /* Plain text errors are already readable. */ }
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
      const response = await withRetry(() => client.models.generateContent({ model: session.settings.model, ...buildRequest(session.settings, session.chunks[index].text) }), status);
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
  const indices = session.chunks.map((_, i) => i).filter(i => !session.chunks[i].pcm);
  if (!indices.length) return;
  await checkBatchConnection(session.settings.model, client);
  const src = indices.map(i => ({ ...buildRequest(session.settings, session.chunks[i].text), metadata: { key: `${session.id}:${i}` } }));
  if (new TextEncoder().encode(JSON.stringify(src)).length > 19_000_000) throw new Error('บทใหญ่เกินขนาด Inline Batch กรุณาแบ่งเป็นหลายตอน');
  session.batch = { displayName: `podcast-${session.id}-${Date.now()}`, state: 'SUBMITTING', indices };
  await save(session);
  let job: BatchJob;
  try {
    job = await client.batches.create({ model: session.settings.model, src, config: { displayName: session.batch.displayName } });
  } catch (error) {
    session.batch.state = [400, 401, 403, 404, 405, 413, 422, 429].includes(statusCode(error)!) ? 'JOB_STATE_FAILED' : 'SUBMISSION_UNKNOWN';
    session.batch.lastError = errorMessage(error);
    await save(session);
    throw error;
  }
  if (!job.name) throw new Error('API ไม่ส่งหมายเลขงานกลับมา กรุณากดค้นหางานที่ส่งไปแล้ว');
  session.batch.name = job.name;
  // Mark terminal only after importing results, including immediate completion.
  session.batch.state = 'JOB_STATE_PENDING';
  await save(session);
}

export async function collectBatch(session: PodcastSession, save: Save, client: Client = createClient()) {
  const batch = session.batch;
  if (!batch) throw new Error('ไม่มีงาน Batch');
  if (!batchActive(session)) return;
  if (!batch.name) {
    const jobs = await client.batches.list({ config: { pageSize: 100 } });
    for await (const job of jobs) {
      if (job.displayName === batch.displayName && job.name) { batch.name = job.name; break; }
    }
    if (!batch.name) throw new Error('ยังไม่พบงานที่ส่งไปแล้ว รอสักครู่แล้วค้นหาอีกครั้ง ห้ามส่งซ้ำจนยืนยันสถานะจาก Google ได้');
    await save(session);
  }
  const job = await client.batches.get({ name: batch.name });
  const terminal = ['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(job.state ?? '');
  if (terminal) {
    const rows = job.dest?.inlinedResponses;
    if (job.state === 'JOB_STATE_SUCCEEDED' && !rows) throw new Error('งานสำเร็จแต่ยังไม่พบ Inline results กรุณาตรวจอีกครั้ง');
    const results = rows ?? [];
    for (let position = 0; position < batch.indices.length; position++) {
      const index = batch.indices[position];
      if (session.chunks[index].pcm) continue;
      const key = `${session.id}:${index}`;
      const row = results.some(r => r.metadata?.key) ? results.find(r => r.metadata?.key === key) : results[position];
      try {
        if (!row?.response) throw new Error(row?.error?.message || job.error?.message || 'ไม่มีผลลัพธ์สำหรับช่วงนี้');
        charge(session, row.response, 'batch');
        const audio = decodeResponse(row.response);
        session.charges[session.charges.length - 1].seconds = audio.seconds;
        session.chunks[index] = { text: session.chunks[index].text, ...audio };
      } catch (error) { session.chunks[index].error = errorMessage(error); }
    }
  }
  batch.state = job.state ?? batch.state;
  await save(session);
}
