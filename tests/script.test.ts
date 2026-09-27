import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScript, analyzeInlineTags } from '../utils/script.ts';
import { DEFAULT_MULTI_SPEAKER, MODEL_PRICING } from '../constants.ts';
import { TtsSettings } from '../types.ts';

test('analyzeInlineTags correctly identifies known inline tags', () => {
  const script = `A: [excited] สวัสดีครับ [laughter] ยินดีต้อนรับ
B: สวัสดีค่ะ [giggle] วันนี้มีเรื่องสนุกๆ [whisper] แอบบอกตรงนี้`;
  
  const analysis = analyzeInlineTags(script);
  assert.equal(analysis.totalTags, 4);
  const tagNames = analysis.tags.map(t => t.tag);
  assert.ok(tagNames.includes('[excited]'));
  assert.ok(tagNames.includes('[laughter]'));
  assert.ok(tagNames.includes('[giggle]'));
  assert.ok(tagNames.includes('[whisper]'));
  assert.equal(analysis.warnings.length, 0);
});

test('analyzeInlineTags detects warnings for unclosed brackets or typos', () => {
  const script = `A: สวัสดีครับ [laugh] ขำมาก
B: จริงเหรอคะ [unclosed tag without closing bracket`;
  
  const analysis = analyzeInlineTags(script);
  assert.ok(analysis.warnings.length > 0);
  assert.ok(analysis.warnings.some(w => w.includes('[laugh]')));
});

test('splitScript handles multi-speaker dialogue with inline tags cleanly', () => {
  const settings: TtsSettings = {
    mode: 'multi',
    speakers: DEFAULT_MULTI_SPEAKER,
    model: 'gemini-2.5-flash-preview-tts',
    chunkSize: 1000,
    styleInstructions: 'Conversational podcast tone.',
    script: `A: [excited] สวัสดีครับ วันนี้เรามีเรื่องธรรมะมาคุยกันครับ [laughter]
B: [giggle] สวัสดีค่ะคุณนพ แฟนรายการรอฟังกันเยอะมากเลยนะคะ [gasp]`,
  };

  const chunks = splitScript(settings);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].includes('[excited]'));
  assert.ok(chunks[0].includes('[laughter]'));
  assert.ok(chunks[0].includes('[giggle]'));
  assert.ok(chunks[0].includes('[gasp]'));
});

test('MODEL_PRICING accurately reflects 2026 Batch promo rates', () => {
  const flashLite = MODEL_PRICING['gemini-3.8-flash-lite-tts'];
  assert.equal(flashLite.batchCostPerHour, 0.27);
  assert.equal(flashLite.costPerHour, 0.54);
  assert.equal(flashLite.batchAudioPerMillion, 3.00);
  assert.equal(flashLite.audioTokensPerMillion, 6.00);

  const flash = MODEL_PRICING['gemini-3.8-flash-tts'];
  assert.equal(flash.costPerHour, 0.81);
  assert.equal(flash.audioTokensPerMillion, 9.00);
});

test('formatDialogueParts properly splits turns and populates speechMetadata for Gemini 3.8', async () => {
  const { formatDialogueParts, buildRequest, errorMessage } = await import('../services/gemini.ts');
  
  const settings: TtsSettings = {
    mode: 'multi',
    speakers: DEFAULT_MULTI_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: 'Natural and expressive',
    script: `A: สวัสดีครับยินดีต้อนรับสู่พอดแคสต์
B: สวัสดีค่ะ [excited] วันนี้มีหัวข้อน่าสนใจมากค่ะ
A: ใช่ครับ เรื่องปรัชญาเต๋าและต้นไม้ในป่า
ผู้พูด 2: [giggle] รอฟังเลยค่ะ`,
  };

  const parts = formatDialogueParts(settings, settings.script);
  assert.equal(parts.length, 4);

  // Speaker A turn
  assert.equal(parts[0].speechMetadata?.speaker, 'A');
  assert.equal(parts[0].text, 'สวัสดีครับยินดีต้อนรับสู่พอดแคสต์');

  // Speaker B turn
  assert.equal(parts[1].speechMetadata?.speaker, 'B');
  assert.equal(parts[1].text, 'สวัสดีค่ะ [excited] วันนี้มีหัวข้อน่าสนใจมากค่ะ');

  // Speaker A turn
  assert.equal(parts[2].speechMetadata?.speaker, 'A');
  assert.equal(parts[2].text, 'ใช่ครับ เรื่องปรัชญาเต๋าและต้นไม้ในป่า');

  // Speaker B turn via Thai alias "ผู้พูด 2"
  assert.equal(parts[3].speechMetadata?.speaker, 'B');
  assert.equal(parts[3].text, '[giggle] รอฟังเลยค่ะ');

  // Test buildRequest multi-speaker config
  const req = buildRequest(settings, settings.script);
  const speakerVoiceConfigs = (req.config?.speechConfig as any)?.multiSpeakerVoiceConfig?.speakerVoiceConfigs;
  assert.ok(speakerVoiceConfigs);
  assert.equal(speakerVoiceConfigs.length, 2);
  assert.equal(speakerVoiceConfigs[0].speaker, 'A');
  assert.equal(speakerVoiceConfigs[1].speaker, 'B');

  // Test errorMessage transformation
  const invalidArgErr = errorMessage('{"error":{"code":400,"message":"Multi-speaker generation requests must specify speaker names for each part in the contents.","status":"INVALID_ARGUMENT"}}');
  assert.ok(invalidArgErr.includes('รูปแบบบทพูดไม่ถูกต้อง') || invalidArgErr.includes('ผู้พูด A: หรือ B:'));
});

test('cancelBatch and dismissBatch safely unlock pending batch sessions', async () => {
  const { cancelBatch, dismissBatch, batchActive, createSession } = await import('../services/gemini.ts');
  const session = createSession({
    mode: 'multi',
    speakers: DEFAULT_MULTI_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: '',
    script: 'A: test\nB: test',
  });

  session.batch = {
    name: 'batches/test-1234',
    displayName: 'podcast-test',
    state: 'JOB_STATE_PENDING',
    indices: [0],
  };

  assert.equal(batchActive(session), true);

  await cancelBatch(session, async () => {});
  assert.equal(session.batch?.state, 'JOB_STATE_CANCELLED');
  assert.equal(batchActive(session), false);

  await dismissBatch(session, async () => {});
  assert.equal(session.batch, undefined);
  assert.equal(batchActive(session), false);
});

test('buildRequest gracefully handles single-speaker chunks in multi mode to prevent Google INVALID_ARGUMENT', async () => {
  const { buildRequest } = await import('../services/gemini.ts');
  const settings: TtsSettings = {
    mode: 'multi',
    speakers: DEFAULT_MULTI_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: '',
    script: '**A:** สวัสดีครับ นี่คือช่วงพูดคนเดียวของพิธีกร A ยาวๆ โดยไม่มี B',
  };

  const req = buildRequest(settings, settings.script);
  // Should fallback to single voiceConfig with speaker A's voice to avoid "must specify speaker names" error
  const voiceConfig = (req.config?.speechConfig as any)?.voiceConfig;
  assert.ok(voiceConfig);
  assert.equal(voiceConfig.prebuiltVoiceConfig?.voiceName, DEFAULT_MULTI_SPEAKER[0].voice);
  // Text should be stripped of speaker prefix so voice doesn't read "A:" out loud
  assert.equal(req.contents?.[0]?.parts?.[0]?.text, 'สวัสดีครับ นี่คือช่วงพูดคนเดียวของพิธีกร A ยาวๆ โดยไม่มี B');
});

test('executeGenerateContent auto-routes multi-speaker to gemini-3.8-flash-tts and preserves speech metadata', async () => {
  const { executeGenerateContent, buildRequest } = await import('../services/gemini.ts');
  const settings: TtsSettings = {
    mode: 'multi',
    speakers: DEFAULT_MULTI_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: 'Mindful host tone',
    script: 'A: สวัสดีครับ\nB: สวัสดีค่ะ',
  };

  const req = buildRequest(settings, settings.script);

  let capturedPath = '';
  let capturedPayload: any = null;

  const mockClient: any = {
    apiClient: {
      request: async (params: { path: string; body: string }) => {
        capturedPath = params.path;
        capturedPayload = JSON.parse(params.body);
        return {
          json: async () => ({
            candidates: [{ content: { parts: [] } }],
          }),
        };
      },
    },
  };

  await executeGenerateContent(mockClient, 'gemini-3.8-flash-lite-tts', req);

  // Model should auto-route to gemini-3.8-flash-tts because flash-lite does not support multi-speaker
  assert.equal(capturedPath, 'models/gemini-3.8-flash-tts:generateContent');
  // speechConfig should have multiSpeakerVoiceConfig
  assert.ok(capturedPayload.generationConfig.speechConfig.multiSpeakerVoiceConfig);
  // Contents parts should retain speechMetadata with speaker & style
  assert.equal(capturedPayload.contents[0].parts[0].speechMetadata.speaker, 'A');
  assert.ok(capturedPayload.contents[0].parts[0].speechMetadata.style);
  // systemInstruction should NOT be passed for TTS models
  assert.equal(capturedPayload.systemInstruction, undefined);
});

test('errorMessage explains speech metadata incompatibility clearly', async () => {
  const { errorMessage } = await import('../services/gemini.ts');
  const err = errorMessage('{"error":{"code":400,"message":"Speech metadata is not supported for this model.","status":"INVALID_ARGUMENT"}}');
  assert.ok(err.includes('Gemini 3.8 Flash TTS'));
});
