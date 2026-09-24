# Gemini Thai Podcast Creator

Thai single- and two-speaker podcasts on Google AI Studio. Defaults remain Gemini 2.5 Flash TTS, Sadaltager / Sulafat, and 3,000 characters per request.

## Current features

- Save finished audio chunks in IndexedDB and resume only missing chunks after failure.
- Preview/download individual chunks and automatically assemble a full WAV when every chunk is ready.
- Regenerate one chunk, or experimentally repair it using 1,000-character requests. Short repair saves each successful part, resumes after interruption, and keeps the original take until completion. Restore the previous take without another API call.
- Reset local job state while retaining the script and one previous-job backup.
- Animated working indicator, elapsed time, saved-part progress and pause after the current request.
- Batch submission gated by selected-model metadata and a read-only job-list check. Recover uncertain submissions by their unique display name instead of automatically submitting again.

## Google AI Studio

Use the existing **Select API key** button. Standard generation uses the original AI Studio-managed SDK integration. The experimental `services/apiServer.ts` is not registered or used; no custom server secret is required.

Keep the same browser and app address to access saved audio. Standard generation needs the page to remain open. Once a Batch job has a confirmed ID, processing occurs at Google; return to the same app to check results. Resetting the app does not cancel a remote job.

When every chunk is finished, the app provides a full-episode player and WAV download. Successful repairs replace the corresponding chunk in the assembled file. Audio is joined with 100 ms silence between chunks.

## Cost and quality limits

This version does not reduce the price or token requirement of an ordinary first-pass Standard generation. Savings can come from avoiding regeneration of previously successful chunks. More chunks repeat the style prompt; request count is not itself the audio-price multiplier.

Live checks on 11 September 2026 found that 2.5 Flash TTS did not advertise `batchGenerateContent` for the tested connection and rejected Batch submission. 3.1 Flash TTS passed the read-only capability check; successful Batch synthesis has not been verified. 3.1 Batch unit pricing equals 2.5 Standard pricing, so switching does not halve the original cost. See [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).

The reported hollow voice after several minutes remains unresolved. Short-request repair is an experiment requiring listening comparison, not a guaranteed fix. PCM validation and clipping checks cannot establish subjective voice quality. Usage totals in the UI include only metadata received by the app, not a complete billing statement.

## Local development

Requires Node.js 22 or later.

```sh
npm ci
cp .env.example .env.local
# Set GEMINI_API_KEY in .env.local for personal local development.
npm run dev
```

The restored legacy Vite configuration embeds a local key in browser JavaScript. Do not publish a standalone build containing a real local key. Local secret files are excluded from Git.

```sh
npm test
npm run typecheck
npm run build
```

The 22 automated tests use mocked API responses, not paid synthesis. They cover Thai splitting, PCM/WAV integrity, persistence/resume, repair/restore, Batch recovery, model capability checks, and the original Standard request route. The production build has a bundle-size advisory.

[Research and pricing notes](docs/google-tts-research-2026-09-11.md) are dated findings; availability must be checked against the actual connection.
