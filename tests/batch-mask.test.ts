// Separate file: the accepted field mask is cached per process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SINGLE_SPEAKER } from '../constants.ts';
import { FakeBatchApi } from './batchFake.ts';

test('when Google rejects a field mask, polling falls back to a simpler one and still collects audio', async () => {
  const { createSession, submitBatch, collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  api.rejectMasks = /metadata\.|^response$/;
  const client = api.client();
  const session = createSession({
    mode: 'single',
    speakers: DEFAULT_SINGLE_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: '',
    script: 'สวัสดีครับ วันนี้เรามาฝึกหายใจอย่างมีสติกัน',
  });
  const save = async () => {};
  await submitBatch(session, save, client);

  await collectBatch(session, save, client);
  assert.equal(session.batch!.lastError, undefined);
  assert.ok(api.calls.some(c => c.queryParams?.fields === 'name,done,error'));

  api.finish('batches/job1');
  await collectBatch(session, save, client);
  assert.ok(session.chunks[0].pcm);
  assert.equal(batchActive(session), false);
});
