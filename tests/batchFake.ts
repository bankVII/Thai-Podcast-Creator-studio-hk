// A minimal stand-in for the Gemini REST Batch API, shaped like the real
// responses: states are BATCH_STATE_*, results are nested under
// `inlinedResponses.inlinedResponses`, and a plain GET of a finished job
// carries the audio twice (metadata.output and response).

export interface FakeJob {
  name: string;
  displayName: string;
  state: string;
  keys: string[];
  requests: any[];
  rows?: any[];
  file?: string;
}

export interface FakeCall {
  path: string;
  httpMethod: string;
  queryParams?: Record<string, string>;
  body?: string;
  bytes: number;
}

export function apiError(code: number, status: string, message: string) {
  return Object.assign(new Error(JSON.stringify({ error: { code, message, status } })), { status: code });
}

export function pcmBase64(sampleValue = 1000, samples = 2400) {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, i % 2 ? sampleValue : -sampleValue, true);
  return Buffer.from(bytes).toString('base64');
}

export function audioRow(key: string, sampleValue = 1000) {
  return {
    metadata: { key },
    response: {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmBase64(sampleValue) } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 },
    },
  };
}

function streamed(text: string, pieceSize: number, truncateAt?: number) {
  const bytes = new TextEncoder().encode(text);
  const end = truncateAt ?? bytes.length;
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= end) return controller.close();
        controller.enqueue(bytes.slice(offset, Math.min(end, offset + pieceSize)));
        offset += pieceSize;
      },
    }),
  );
}

export class FakeBatchApi {
  jobs = new Map<string, FakeJob>();
  calls: FakeCall[] = [];
  pieceSize = 7;
  truncateNextResult = false;
  rejectMasks: RegExp | null = null;
  rejectMaskCode = 400;
  failCreateAt: number | null = null;
  notFound = new Set<string>();
  files = new Map<string, string>();
  private created = 0;

  finish(name: string, rows?: any[]) {
    const job = this.jobs.get(name)!;
    job.state = 'BATCH_STATE_SUCCEEDED';
    job.rows = rows ?? job.keys.map((key, k) => audioRow(key, 1000 + k));
  }

  // Google may also return results as a JSONL file instead of inline rows.
  finishToFile(name: string) {
    const job = this.jobs.get(name)!;
    job.state = 'BATCH_STATE_SUCCEEDED';
    job.file = `files/result-${name.split('/')[1]}`;
    this.files.set(job.file, job.keys.map(key => JSON.stringify({ key, response: audioRow(key).response })).join('\n') + '\n');
  }

  private operation(job: FakeJob, fields?: string) {
    const done = ['BATCH_STATE_SUCCEEDED', 'BATCH_STATE_FAILED', 'BATCH_STATE_CANCELLED', 'BATCH_STATE_EXPIRED'].includes(job.state);
    const output = job.file ? { responsesFile: job.file } : job.rows ? { '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatchOutput', inlinedResponses: { inlinedResponses: job.rows } } : undefined;
    const full: any = {
      name: job.name,
      metadata: {
        '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch',
        model: 'models/test',
        displayName: job.displayName,
        state: job.state,
        batchStats: { requestCount: String(job.keys.length), successfulRequestCount: String(job.rows ? job.keys.length : 0) },
        ...(output ? { output } : {}),
      },
      done,
      ...(output ? { response: output } : {}),
    };
    if (!fields) return full;
    // Minimal partial-response support for the masks the app uses.
    const pick: any = {};
    for (const path of fields.split(',')) {
      const [top, sub] = path.split('.');
      if (full[top] === undefined) continue;
      if (!sub) pick[top] = full[top];
      else if (full[top][sub] !== undefined) (pick[top] ??= {})[sub] = full[top][sub];
    }
    return pick;
  }

  apiClient = {
    getBaseUrl: () => 'https://generativelanguage.googleapis.com/',
    request: async (req: { path: string; httpMethod: string; queryParams?: Record<string, string>; body?: string }) => {
      const call: FakeCall = { ...req, bytes: 0 };
      this.calls.push(call);
      const fields = req.queryParams?.fields;
      if (fields && this.rejectMasks?.test(fields)) throw apiError(this.rejectMaskCode, this.rejectMaskCode === 400 ? 'INVALID_ARGUMENT' : 'NOT_FOUND', `Rejected field selector: ${fields}`);
      const reply = (data: unknown, truncate = false) => {
        const text = JSON.stringify(data);
        call.bytes = text.length;
        return { json: async () => JSON.parse(text), responseInternal: streamed(text, this.pieceSize, truncate ? Math.floor(text.length / 2) : undefined) };
      };

      const download = req.path.match(/^(files\/[^:]+):download$/);
      if (download && req.queryParams?.alt === 'media') {
        const text = this.files.get(download[1]);
        if (!text) throw apiError(404, 'NOT_FOUND', 'File not found.');
        call.bytes = text.length;
        return { json: async () => { throw new Error('not JSON'); }, responseInternal: streamed(text, this.pieceSize) };
      }
      const create = req.path.match(/^models\/([^:]+):batchGenerateContent$/);
      if (create && req.httpMethod === 'POST') {
        this.created++;
        if (this.failCreateAt === this.created) throw apiError(429, 'RESOURCE_EXHAUSTED', 'Enqueued token limit reached');
        const body = JSON.parse(req.body!);
        const requests = body.batch.inputConfig.requests.requests;
        const job: FakeJob = {
          name: `batches/job${this.created}`,
          displayName: body.batch.displayName,
          state: 'BATCH_STATE_PENDING',
          keys: requests.map((r: any) => r.metadata.key),
          requests,
        };
        this.jobs.set(job.name, job);
        return reply(this.operation(job));
      }
      if (req.path === 'batches' && req.httpMethod === 'GET') {
        return reply({ operations: [...this.jobs.values()].reverse().map(job => this.operation(job, fields?.replace(/operations\./g, ''))) });
      }
      const cancel = req.path.match(/^(batches\/[^:]+):cancel$/);
      if (cancel) {
        const job = this.jobs.get(cancel[1]);
        if (job) job.state = 'BATCH_STATE_CANCELLED';
        return reply({});
      }
      const job = this.jobs.get(req.path);
      if (!job || this.notFound.has(req.path)) throw apiError(404, 'NOT_FOUND', 'Requested entity was not found.');
      const truncate = this.truncateNextResult && !!job.rows && (fields === 'response' || !fields);
      if (truncate) this.truncateNextResult = false;
      return reply(this.operation(job, fields), truncate);
    },
  };

  client() {
    return {
      apiClient: this.apiClient,
      models: { get: async () => ({ supportedActions: ['generateContent', 'batchGenerateContent'] }) },
      batches: {},
    } as any;
  }
}
