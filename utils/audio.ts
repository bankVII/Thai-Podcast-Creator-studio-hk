
/**
 * Decodes a base64 string into a Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Creates a silent PCM buffer for the specified duration in milliseconds.
 * 24kHz, 16-bit, Mono = 48 bytes per millisecond.
 */
export function createSilence(durationMs: number, sampleRate: number = 24000): Uint8Array {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const totalBytes = Math.floor((sampleRate * durationMs) / 1000) * numChannels * bytesPerSample;
  
  // Create a zero-filled buffer (silence)
  return new Uint8Array(totalBytes);
}

/**
 * Concatenates multiple Uint8Arrays into a single Uint8Array.
 */
export function concatenateUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Creates a WAV file header for PCM data.
 * The Gemini API returns raw PCM (Linear 16-bit Little Endian) at 24kHz.
 */
export function createWavBlob(pcmData: Uint8Array, sampleRate: number = 24000): Blob {
  if (!pcmData.length || pcmData.length % 2) throw new Error('PCM ต้องมีตัวอย่างเสียง 16-bit ครบคู่');
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2; // 2 bytes per sample (16-bit)
  const blockAlign = numChannels * 2;
  const dataSize = pcmData.length;
  
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM samples
  const pcmBytes = new Uint8Array(buffer, 44);
  pcmBytes.set(pcmData);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export function validatePcm(data: string, mimeType: string): Uint8Array {
  const mime = mimeType.toLowerCase().replace(/\s/g, '');
  const bytes = base64ToUint8Array(data);
  if (!bytes.length) throw new Error('ข้อมูลเสียงไม่สมบูรณ์ (empty)');

  // Handle WAV container (e.g. from Gemini 3.8 models returning audio/wav)
  if (mime.includes('wav') || (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let pcmChunk: Uint8Array | null = null;
    while (offset <= bytes.length - 8) {
      const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === 'data') {
        pcmChunk = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + chunkSize));
        break;
      }
      offset += 8 + chunkSize;
    }
    if (!pcmChunk || !pcmChunk.length) throw new Error('ไม่พบข้อมูลเสียง PCM ในไฟล์ WAV');
    if (pcmChunk.length % 2) throw new Error('ข้อมูลเสียง PCM ไม่ครบตัวอย่าง');
    return pcmChunk;
  }

  // Handle Raw Linear PCM (e.g. from Gemini 2.5)
  if (!/^audio\/(l16|pcm)(;|$)/.test(mime) || !/(?:^|;)rate=24000(?:;|$)/.test(mime)) {
    throw new Error(`รูปแบบเสียงไม่ใช่ PCM 24kHz ที่รองรับ: ${mimeType}`);
  }
  const channels = mime.match(/(?:^|;)channels=(\d+)/)?.[1];
  const bits = mime.match(/(?:^|;)bits=(\d+)/)?.[1];
  if ((channels && channels !== '1') || (bits && bits !== '16')) throw new Error('รองรับเฉพาะ PCM mono 16-bit');
  if (bytes.length % 2) throw new Error('ข้อมูลเสียง PCM ไม่ครบตัวอย่าง');
  return bytes;
}

// Screening only: cannot identify hollow voices, pronunciation, or omissions.
export function inspectPcm(pcm: Uint8Array): string[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let clipping = 0;
  let nonSilent = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = Math.abs(view.getInt16(i, true));
    if (sample >= 32760) clipping++;
    if (sample > 100) nonSilent++;
  }
  const warnings: string[] = [];
  if (clipping / (pcm.length / 2) > 0.01) warnings.push('พบสัญญาณชนเพดานเกิน 1% ควรฟังตรวจ');
  if (!nonSilent) warnings.push('เสียงเงียบหรือเบามาก ควรฟังตรวจ');
  if (pcm.length / 48000 > 180) warnings.push('ช่วงนี้ยาวเกิน 3 นาที ควรตรวจช่วงกลางและท้าย');
  return warnings;
}

/**
 * Plays a pleasant synthesis chime when audio generation or batch completes.
 */
export function playCompletionChime() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);
      gain.gain.setValueAtTime(0, now + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.18, now + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.4);
    });
  } catch {
    // Best-effort chime
  }
}

/**
 * Requests browser desktop notification permissions.
 */
export function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof window !== 'undefined' && 'Notification' in window) {
    return Notification.requestPermission();
  }
  return Promise.resolve(null);
}

/**
 * Shows desktop notification when audio batch or rendering completes.
 */
export function showCompletionNotification(title: string, body: string) {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body });
    } catch {
      // Ignored
    }
  }
}

