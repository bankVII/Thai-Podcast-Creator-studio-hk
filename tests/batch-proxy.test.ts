// Separate file: the accepted field mask is cached per process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SINGLE_SPEAKER } from '../constants.ts';
import { FakeBatchApi } from './batchFake.ts';

test('a proxy that answers every field mask with 404 still gets status and audio, and a real 404 is still reported', async () => {
  const { createSession, submitBatch, collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  api.rejectMasks = /./;
  api.rejectMaskCode = 404;
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
  assert.equal(session.batch!.state, 'JOB_STATE_PENDING');

  api.finish('batches/job1');
  await collectBatch(session, save, client);
  assert.ok(session.chunks[0].pcm);
  assert.equal(batchActive(session), false);

  // A job that really is gone fails at every level and is reported as such.
  session.batch = {
    displayName: 'x',
    state: 'JOB_STATE_RUNNING',
    indices: [0],
    jobs: [{ name: 'batches/missing', displayName: 'x', indices: [0], state: 'JOB_STATE_RUNNING', submittedAt: 0 }],
  };
  session.chunks[0] = { text: session.chunks[0].text };
  await collectBatch(session, save, client);
  assert.match(session.batch!.lastError!, /404 NOT_FOUND/);
});
