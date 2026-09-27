import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonArrayStreamer } from '../utils/jsonStream.ts';
import { DEFAULT_SINGLE_SPEAKER } from '../constants.ts';
import { PodcastSession } from '../types.ts';
import { FakeBatchApi, audioRow } from './batchFake.ts';

const sentence = 'วันนี้เรามาคุยกันเรื่องการฝึกสติในชีวิตประจำวัน ลมหายใจเข้าออกช้าๆ อย่างสงบ ';

async function longSession() {
  const { createSession } = await import('../services/gemini.ts');
  // Splits into three chunks of about 3000, 3000 and 850 characters.
  return createSession({
    mode: 'single',
    speakers: DEFAULT_SINGLE_SPEAKER,
    model: 'gemini-3.8-flash-lite-tts',
    chunkSize: 3000,
    styleInstructions: '',
    script: sentence.repeat(90),
  });
}

function recorder() {
  const saved: PodcastSession[] = [];
  return { saved, save: async (s: PodcastSession) => { saved.push(structuredClone(s)); } };
}

test('JsonArrayStreamer extracts the first inlinedResponses array at every chunk boundary', () => {
  const rows = [
    { metadata: { key: 'a' }, text: 'quote " backslash \\ brace } bracket ] inlinedResponses: [', nested: [1, { inlinedResponses: [9] }] },
    { metadata: { key: 'b' }, n: -1.5e3, ok: true, none: null },
  ];
  const doc = JSON.stringify({
    name: 'batches/x',
    metadata: { state: 'BATCH_STATE_SUCCEEDED', output: { inlinedResponses: { inlinedResponses: rows } } },
    done: true,
    response: { inlinedResponses: { inlinedResponses: [{ duplicate: true }] }, responsesFile: 'files/out' },
  });
  for (let size = 1; size <= 17; size++) {
    const items: unknown[] = [];
    const strings: [string, string][] = [];
    const scanner = new JsonArrayStreamer('inlinedResponses', json => items.push(JSON.parse(json)), (k, v) => strings.push([k, v]));
    for (let i = 0; i < doc.length; i += size) scanner.push(doc.slice(i, i + size));
    assert.deepEqual(items, rows, `piece size ${size}`);
    assert.equal(scanner.targetDone, true);
    assert.equal(scanner.complete, true);
    assert.ok(strings.some(([k, v]) => k === 'responsesFile' && v === 'files/out'));
    assert.ok(strings.some(([k, v]) => k === 'state' && v === 'BATCH_STATE_SUCCEEDED'));
  }
  const truncated = new JsonArrayStreamer('inlinedResponses', () => {});
  truncated.push(doc.slice(0, 40));
  assert.equal(truncated.complete, false);
  assert.equal(truncated.targetDone, false);
});

test('parseBatchOperation maps REST BATCH_STATE_* and nested rows', async () => {
  const { parseBatchOperation, inlinedRows, normalizeJobState } = await import('../services/gemini.ts');
  assert.equal(normalizeJobState('BATCH_STATE_RUNNING'), 'JOB_STATE_RUNNING');
  assert.equal(normalizeJobState('JOB_STATE_RUNNING'), 'JOB_STATE_RUNNING');

  const snap = parseBatchOperation({
    name: 'batches/1',
    metadata: { state: 'BATCH_STATE_SUCCEEDED', batchStats: { requestCount: '3', successfulRequestCount: '2', failedRequestCount: '1' } },
    done: true,
  });
  assert.equal(snap.state, 'JOB_STATE_SUCCEEDED');
  assert.deepEqual(snap.stats, { total: 3, succeeded: 2, failed: 1, pending: 0 });

  // Masks without metadata still give a final state from `done` / `error`.
  assert.equal(parseBatchOperation({ name: 'batches/1', done: true }).state, 'JOB_STATE_SUCCEEDED');
  assert.equal(parseBatchOperation({ name: 'batches/1', done: true, error: { code: 1 } }).state, 'JOB_STATE_CANCELLED');
  assert.equal(parseBatchOperation({ name: 'batches/1', done: true, error: { code: 13, message: 'x' } }).state, 'JOB_STATE_FAILED');
  assert.equal(parseBatchOperation({ name: 'batches/1' }).state, undefined);

  const rows = [{ metadata: { key: 'k' } }];
  assert.deepEqual(inlinedRows({ response: { inlinedResponses: { inlinedResponses: rows } } }), rows);
  assert.deepEqual(inlinedRows({ metadata: { output: { inlinedResponses: { inlinedResponses: rows } } } }), rows);
  assert.deepEqual(inlinedRows({ dest: { inlinedResponses: rows } }), rows);
  assert.equal(inlinedRows({ name: 'batches/1', done: false }), undefined);
});

test('a long episode is split into small jobs, polled without audio, and collected job by job', async () => {
  const { submitBatch, collectBatch, batchActive, assembleSession } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const client = api.client();
  const session = await longSession();
  assert.equal(session.chunks.length, 3);
  const { save } = recorder();

  await submitBatch(session, save, client);
  const creates = api.calls.filter(c => c.path.endsWith(':batchGenerateContent'));
  assert.equal(creates.length, 3, 'one job per chunk');
  for (const create of creates) {
    const body = JSON.parse(create.body!);
    assert.equal(body.batch.inputConfig.requests.requests.length, 1);
    // speechMetadata must survive (the SDK serializer would drop it).
    assert.ok(body.batch.inputConfig.requests.requests[0].request.contents[0].parts[0].speechMetadata);
  }
  assert.deepEqual(session.batch!.jobs!.map(j => j.name), ['batches/job1', 'batches/job2', 'batches/job3']);
  assert.equal(session.batch!.state, 'JOB_STATE_PENDING');
  assert.equal(batchActive(session), true);

  // Pending: status checks use a field mask and never carry audio.
  api.calls = [];
  await collectBatch(session, save, client);
  assert.equal(api.calls.length, 3);
  for (const call of api.calls) {
    assert.match(call.queryParams?.fields ?? '', /metadata\.state/);
    assert.ok(call.bytes < 1000, 'status poll stays small');
  }

  // One job done: only that job's audio is downloaded.
  api.finish('batches/job1');
  api.jobs.get('batches/job2')!.state = 'BATCH_STATE_RUNNING';
  api.calls = [];
  const message = await collectBatch(session, save, client);
  const downloads = api.calls.filter(c => c.queryParams?.fields === 'response');
  assert.deepEqual(downloads.map(c => c.path), ['batches/job1']);
  assert.ok(session.chunks[0].pcm);
  assert.equal(session.chunks[1].pcm, undefined);
  assert.equal(session.batch!.state, 'JOB_STATE_RUNNING');
  assert.match(message, /ได้รับเสียง 1\/3 ช่วง/);
  assert.equal(batchActive(session), true);

  // A collected job is not downloaded again.
  api.finish('batches/job2');
  api.finish('batches/job3');
  api.calls = [];
  await collectBatch(session, save, client);
  assert.ok(!api.calls.some(c => c.path === 'batches/job1'));
  assert.ok(session.chunks.every(c => c.pcm));
  assert.equal(session.batch!.state, 'JOB_STATE_SUCCEEDED');
  assert.equal(batchActive(session), false);
  assert.ok(assembleSession(session));
  assert.equal(session.charges.filter(c => c.mode === 'batch').length, 3);
});

test('a legacy single-job session stuck at RUNNING is collected when Google reports BATCH_STATE_SUCCEEDED', async () => {
  const { collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const session = await longSession();
  const keys = [0, 1, 2].map(i => `${session.id}:${i}`);
  api.jobs.set('batches/legacy', { name: 'batches/legacy', displayName: 'podcast-old', state: 'BATCH_STATE_RUNNING', keys, requests: [] });
  // Shape written by the previous version of the app.
  session.batch = { name: 'batches/legacy', displayName: 'podcast-old', state: 'JOB_STATE_RUNNING', indices: [0, 1, 2] };
  const { save } = recorder();

  await collectBatch(session, save, api.client());
  assert.equal(batchActive(session), true);

  // Rows out of order and streamed one byte at a time.
  api.pieceSize = 1;
  api.finish('batches/legacy', [audioRow(keys[2]), audioRow(keys[0]), audioRow(keys[1])]);
  await collectBatch(session, save, api.client());
  assert.ok(session.chunks.every(c => c.pcm));
  assert.equal(session.batch!.state, 'JOB_STATE_SUCCEEDED');
  assert.equal(batchActive(session), false);
});

test('a missing job is reported as NOT_FOUND instead of being shown as still pending', async () => {
  const { collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const session = await longSession();
  session.batch = {
    displayName: 'podcast-x',
    state: 'JOB_STATE_RUNNING',
    indices: [0],
    jobs: [{ name: 'batches/gone', displayName: 'podcast-x', indices: [0], state: 'JOB_STATE_RUNNING', submittedAt: Date.now() - 60 * 60_000 }],
  };
  const { save } = recorder();
  const message = await collectBatch(session, save, api.client());
  assert.match(session.batch!.lastError!, /404 NOT_FOUND/);
  assert.match(session.batch!.lastError!, /API key/);
  assert.doesNotMatch(message, /กำลังเริ่มต้นจัดเตรียมงาน|กำลังประมวลผล/);
  assert.match(message, /ตรวจสถานะกับ Google ไม่สำเร็จ/);
  // Still active: selecting the original key again lets the next check succeed.
  assert.equal(batchActive(session), true);

  // Just after submission a 404 gets a softer, temporary message.
  session.batch!.jobs![0].submittedAt = Date.now();
  await collectBatch(session, save, api.client());
  assert.match(session.batch!.lastError!, /ไม่กี่นาทีแรก/);
});

test('an interrupted result download keeps the job pending and retries without losing stored chunks', async () => {
  const { submitBatch, collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const client = api.client();
  const session = await longSession();
  const { save } = recorder();
  await submitBatch(session, save, client);
  api.finish('batches/job1');
  api.truncateNextResult = true;
  await collectBatch(session, save, client);
  assert.equal(session.chunks[0].pcm, undefined);
  assert.equal(session.batch!.jobs![0].collected, undefined);
  assert.match(session.batch!.lastError!, /ไม่ครบ/);
  assert.equal(batchActive(session), true);

  await collectBatch(session, save, client);
  assert.ok(session.chunks[0].pcm);
  assert.equal(session.batch!.jobs![0].collected, true);
});

test('a failed submission keeps confirmed jobs and leaves unsent chunks for later', async () => {
  const { submitBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  api.failCreateAt = 2;
  const session = await longSession();
  const { save } = recorder();
  await submitBatch(session, save, api.client());
  const jobs = session.batch!.jobs!;
  assert.deepEqual(jobs.map(j => j.state), ['JOB_STATE_PENDING', 'JOB_STATE_FAILED']);
  assert.deepEqual(session.batch!.indices, [0, 1]);
  assert.match(session.batch!.lastError!, /1\/3/);
  assert.equal(batchActive(session), true);
});

test('a rejected first submission unlocks the session and reports the error', async () => {
  const { submitBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  api.failCreateAt = 1;
  const session = await longSession();
  const { save } = recorder();
  await assert.rejects(submitBatch(session, save, api.client()));
  assert.equal(session.batch!.state, 'JOB_STATE_FAILED');
  assert.equal(batchActive(session), false);
});

test('an unchanged check refreshes the message without rewriting the stored session', async () => {
  const { submitBatch, collectBatch } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const client = api.client();
  const session = await longSession();
  const { saved, save } = recorder();
  await submitBatch(session, save, client);
  await collectBatch(session, save, client);
  const before = saved.length;
  let refreshed = 0;
  await collectBatch(session, save, client, { refresh: () => refreshed++ });
  assert.equal(saved.length, before);
  assert.equal(refreshed, 1);

  api.finish('batches/job1');
  await collectBatch(session, save, client, { refresh: () => refreshed++ });
  assert.ok(saved.length > before, 'new audio is persisted');
});

test('cancelBatch cancels every unfinished job and unlocks the session', async () => {
  const { submitBatch, collectBatch, cancelBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const client = api.client();
  const session = await longSession();
  const { save } = recorder();
  await submitBatch(session, save, client);
  api.finish('batches/job1');
  await collectBatch(session, save, client);
  await cancelBatch(session, save, client);
  const cancels = api.calls.filter(c => c.path.endsWith(':cancel')).map(c => c.path);
  assert.deepEqual(cancels, ['batches/job2:cancel', 'batches/job3:cancel']);
  assert.equal(session.batch!.state, 'JOB_STATE_CANCELLED');
  assert.equal(batchActive(session), false);
  assert.ok(session.chunks[0].pcm, 'downloaded audio is kept');
});

test('results delivered as a JSONL responses file are downloaded and stored', async () => {
  const { submitBatch, collectBatch, batchActive } = await import('../services/gemini.ts');
  const api = new FakeBatchApi();
  const client = api.client();
  const session = await longSession();
  const { save } = recorder();
  await submitBatch(session, save, client);
  for (const name of api.jobs.keys()) api.finishToFile(name);
  await collectBatch(session, save, client);
  assert.ok(api.calls.some(c => c.path === 'files/result-job1:download'));
  assert.ok(session.chunks.every(c => c.pcm));
  assert.equal(batchActive(session), false);
});
