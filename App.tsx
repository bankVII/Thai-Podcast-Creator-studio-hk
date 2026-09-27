import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wand2,
  BrainCircuit,
  Key,
  RefreshCw,
  Download,
  LoaderCircle,
  Sparkles,
  Info,
  BookOpen,
  Volume2,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Zap,
  Clock,
  XCircle,
  HelpCircle,
  Lock,
  Bell,
  BellRing,
  Trash2,
} from 'lucide-react';
import { TtsSettings, PodcastSession, AudioChunk, TtsModel } from './types';
import {
  DEFAULT_MULTI_SPEAKER,
  DEFAULT_SINGLE_SPEAKER,
  INLINE_VOCAL_TAGS,
  PAUSE_TRICKS,
  PHONETIC_EXAMPLES,
  MODEL_PRICING,
  PODCAST_TONE_PRESETS,
  DEFAULT_PODCAST_STYLE,
} from './constants';
import { VoiceSelector } from './components/VoiceSelector';
import { AudioPlayer } from './components/AudioPlayer';
import {
  assembleSession,
  batchActive,
  checkBatchConnection,
  collectBatch,
  cancelBatch,
  dismissBatch,
  createSession,
  errorMessage,
  generateStandard,
  repairWithShortRequests,
  restorePreviousTake,
  submitBatch,
} from './services/gemini';
import { sessionStore } from './services/storage';
import { splitScript, analyzeInlineTags } from './utils/script';
import {
  createWavBlob,
  playCompletionChime,
  requestNotificationPermission,
  showCompletionNotification,
} from './utils/audio';

const ORIGINAL_DHARMA_SCRIPT = `A: เคยสังเกตไหมครับว่า ยิ่งเราพยายามอ่านหนังสือธรรมะให้เยอะขึ้นเท่าไหร่ ยิ่งเราฟังพอดแคสต์พัฒนาจิตวิญญาณมากแค่ไหน ความทุกข์จริงๆ ในใจเรากลับไม่ได้ลดลงเลย
B: เปิดรายการมาก็แทงใจดำเลยนะคะเนี่ย มิ้นนี่แหละตัวดีเลยค่ะ หนังสือธรรมะกองเต็มหัวเตียง ซื้อมาดองไว้เพียบ แต่พอเจอเรื่องกระทบใจจริงๆ ก็ยังวีนแตกเหมือนเดิม`;

const SAMPLE_AI_SCRIPT = `A: [excited] ยินดีต้อนรับทุกท่านเข้าสู่รายการ AI Unboxed ครับ วันนี้อยู่กับผม นพ และคุณ เมย์ ครับ
B: สวัสดีค่ะนพ [giggle] วันนี้เรามีเรื่องเทคโนโลยี TTS มาคุยกันใช่ไหมคะ?
A: ใช่ครับ! [clears throat] ตอนนี้เราสามารถส่งบทสนทนา 2 คนในคำขอเดียวได้เลย ไม่ต้องตัดต่อแบ่งไฟล์ให้เหนื่อยแล้ว
B: [gasp] จริงเหรอคะ! [excited] แบบนี้ก็ประหยัดเวลาตัดต่อลงไปได้เยอะมากเลยสิคะเนี่ย
A: ถูกต้องเลยครับ... แถมถ้าประมวลผลผ่าน Batch API ยังลดค่าบริการลงทันที 50% ตกแค่ชั่วโมงละ $0.27 หรือประมาณเก้าบาทกว่าๆ เท่านั้นครับ [laughter]
B: [whisper] แอบบอกตรงนี้เลยนะ จังหวะหายใจและเสียงหัวเราะเป็นธรรมชาติมากจริงๆ ค่ะ [laughter]`;

const defaults: TtsSettings = {
  mode: 'multi',
  speakers: DEFAULT_MULTI_SPEAKER,
  model: 'gemini-3.8-flash-tts',
  chunkSize: 3000,
  styleInstructions: DEFAULT_PODCAST_STYLE,
  script: ORIGINAL_DHARMA_SCRIPT,
};

const field = 'w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-sm focus:border-cyan-500 focus:outline-none transition-colors';
const button = 'rounded-xl px-4 py-3 text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed';

function WorkingIndicator({
  message,
  completed,
  total,
  canPause,
  onPause,
}: {
  message: string;
  completed: number;
  total: number;
  canPause: boolean;
  onPause: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const progress = total ? Math.min(100, (completed / total) * 100) : 0;
  return (
    <aside
      aria-label="สถานะการทำงาน"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:w-[440px] z-50 rounded-2xl border border-cyan-500/40 bg-zinc-950/95 p-5 shadow-2xl shadow-black/80 backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <div aria-hidden="true" className="grid place-items-center rounded-xl bg-cyan-500/10 w-12 h-12 shrink-0">
          <LoaderCircle size={28} className="animate-spin motion-reduce:animate-none text-cyan-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            <p className="font-semibold text-cyan-200 text-sm">กำลังสร้างเสียง (Gemini TTS)</p>
          </div>
          <p role="status" aria-live="polite" className="text-xs text-zinc-300 mt-1 break-words">
            {message || 'กำลังบันทึก…'}
          </p>
        </div>
        <div aria-hidden="true" className="flex h-8 items-center gap-1">
          {[0, 1, 2, 3, 4].map(i => (
            <span
              key={i}
              className="podcast-working-bar bg-cyan-400 rounded-full w-1"
              style={{ height: `${12 + (i % 3) * 6}px`, animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-between gap-3 text-xs text-zinc-400">
        <span>เวลารอบนี้ {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
        {total > 0 && <span>สำเร็จแล้ว {completed}/{total} ส่วน</span>}
      </div>
      {total > 0 && (
        <>
          <div
            role="progressbar"
            aria-label="ส่วนที่บันทึกสำเร็จ"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={completed}
            className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-500 mt-2">
            ระบบจะอัปเดตแถบความคืบหน้าเมื่อแต่ละช่วงของเสียงบันทึกเสร็จสมบูรณ์
          </p>
        </>
      )}
      {canPause && (
        <button
          className="mt-3 w-full rounded-lg border border-zinc-700 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
          onClick={onPause}
        >
          พักหลังจบช่วงนี้
        </button>
      )}
    </aside>
  );
}

function ChunkPreview({
  chunk,
  index,
  disabled,
  repair,
  shortRepair,
  restore,
  start,
}: {
  chunk: AudioChunk;
  index: number;
  disabled: boolean;
  repair: () => void;
  shortRepair: () => void;
  restore: () => void;
  start?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!chunk.pcm) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(createWavBlob(chunk.pcm));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [chunk.pcm]);

  return (
    <details className="bg-zinc-900/60 rounded-xl p-4 border border-zinc-800 transition-colors hover:border-zinc-700">
      <summary className="cursor-pointer text-sm font-medium flex items-center justify-between text-zinc-200">
        <span>
          ช่วง {index + 1} · {chunk.pcm ? `${chunk.seconds?.toFixed(1)} วินาที` : 'ยังไม่มีเสียง'}
          {start !== undefined ? ` · เริ่ม ${Math.floor(start / 60)}:${Math.floor(start % 60).toString().padStart(2, '0')}` : ''}
          {chunk.error ? ' · ⚠️ มีข้อผิดพลาด' : ''}
        </span>
        <span className="text-xs text-zinc-500">คลิกดูรายละเอียด</span>
      </summary>
      <p className="whitespace-pre-wrap text-sm text-zinc-400 my-3 bg-zinc-950/60 p-3 rounded-lg border border-zinc-800/80 font-mono text-xs">
        {chunk.text}
      </p>
      {url ? (
        <div className="space-y-2 my-3">
          <audio controls src={url} className="w-full" />
          <a className="text-cyan-400 text-xs hover:underline inline-flex items-center gap-1" href={url} download={`part-${index + 1}.wav`}>
            <Download size={13} /> ดาวน์โหลดเสียงช่วงที่ {index + 1} (.wav)
          </a>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-zinc-800/60">
        <button
          disabled={disabled || !!chunk.shortRepair}
          onClick={repair}
          className={`${button} bg-zinc-800 hover:bg-zinc-700 text-xs py-2`}
        >
          สร้างใหม่เฉพาะช่วงนี้ (ราคาปกติ)
        </button>
        {chunk.pcm && (chunk.text.length > 1000 || chunk.shortRepair) && (
          <button
            disabled={disabled}
            onClick={shortRepair}
            className={`${button} bg-cyan-950 text-cyan-200 hover:bg-cyan-900 text-xs py-2 border border-cyan-800/50`}
          >
            {chunk.shortRepair ? 'ทำการซ่อมช่วงสั้นต่อ' : 'ทดลองซ่อมด้วยช่วงสั้น 1,000 ตัวอักษร'}
          </button>
        )}
        {chunk.previousTake && (
          <button
            disabled={disabled || !!chunk.shortRepair}
            onClick={restore}
            className={`${button} text-cyan-400 hover:bg-cyan-950/40 text-xs py-2`}
          >
            <RotateCcw size={13} className="inline mr-1" /> สลับกลับเสียงก่อนซ่อม
          </button>
        )}
      </div>
      {chunk.shortRepair && (
        <p className="text-xs text-cyan-300 mt-2">
          ซ่อมแล้ว {chunk.shortRepair.chunks.filter(c => c.pcm).length}/{chunk.shortRepair.chunks.length} ส่วน (เสียงที่ฟังอยู่ยังเป็นเสียงก่อนซ่อม)
        </p>
      )}
      {chunk.error && <p className="text-red-400 text-xs mt-2 bg-red-950/40 p-2 rounded border border-red-900/60">{chunk.error}</p>}
      {chunk.warnings?.map(w => (
        <p key={w} className="text-amber-400 text-xs mt-2 bg-amber-950/30 p-2 rounded border border-amber-900/50">
          ⚠️ {w}
        </p>
      ))}
    </details>
  );
}

export default function App() {
  const [settings, setSettings] = useState<TtsSettings>(defaults);
  const [session, setSession] = useState<PodcastSession | null>(null);
  const [hasPrevious, setHasPrevious] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [batchReady, setBatchReady] = useState(false);
  const [batchConnection, setBatchConnection] = useState('');
  const [testAudio, setTestAudio] = useState<Blob | null>(null);
  const [minutes, setMinutes] = useState('10');
  const [showGuide, setShowGuide] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [pollCountdown, setPollCountdown] = useState(20);
  const [notificationsAllowed, setNotificationsAllowed] = useState(
    typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted'
  );

  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const stop = useRef(false);
  const running = useRef(false);
  const prevAllDoneRef = useRef(false);

  const plan = useMemo(() => {
    try {
      return { chunks: splitScript(settings), error: '' };
    } catch (e) {
      return { chunks: [], error: errorMessage(e) };
    }
  }, [settings]);

  const tagAnalysis = useMemo(() => analyzeInlineTags(settings.script), [settings.script]);
  const currentPricing = MODEL_PRICING[settings.model] ?? MODEL_PRICING['gemini-3.8-flash-lite-tts'];

  const audio = useMemo(() => (session ? assembleSession(session) : null), [session]);
  const activeBatch = batchActive(session);
  const locked = busy || activeBatch || !ready;
  const sameSettings = session && JSON.stringify(settings) === JSON.stringify(session.settings);
  const completed = session?.chunks.filter(c => c.pcm).length ?? 0;
  const allDone = !!session && completed === session.chunks.length;
  const repairing = session?.chunks.find(c => c.shortRepair)?.shortRepair;
  const workingTotal = /สร้าง|ซ่อม|จะหยุด/.test(status) ? repairing?.chunks.length ?? session?.chunks.length ?? 0 : 0;
  const workingCompleted = repairing ? repairing.chunks.filter(c => c.pcm).length : completed;

  useEffect(() => {
    if (allDone && !prevAllDoneRef.current && session && session.chunks.length > 0) {
      playCompletionChime();
      showCompletionNotification('🎙️ พอดแคสต์สร้างเสร็จแล้ว!', 'รวมไฟล์เสียงพอดแคสต์สมบูรณ์เรียบร้อยแล้ว กดเปิดฟังได้ทันที');
    }
    prevAllDoneRef.current = allDone;
  }, [allDone, session]);

  // Background auto-polling for active Batch jobs: polls every 20 seconds and fetches audio automatically
  useEffect(() => {
    if (!activeBatch || !autoPoll) return;
    const interval = window.setInterval(() => {
      setPollCountdown(prev => {
        if (prev <= 1) {
          if (!running.current && session) {
            collectBatch(structuredClone(session), save)
              .then(() => {
                setError(current => (current && /readablestream|unexpected end of json|close/i.test(current) ? '' : current));
              })
              .catch(() => {});
          }
          return 20;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [activeBatch, autoPoll, session]);

  const enableNotifications = async () => {
    const res = await requestNotificationPermission();
    if (res === 'granted') {
      setNotificationsAllowed(true);
      showCompletionNotification('🔔 เปิดการแจ้งเตือนแล้ว', 'ระบบจะส่งเสียงและแจ้งเตือนทันทีที่รวมไฟล์เสียงพอดแคสต์เสร็จสิ้น');
    }
  };

  useEffect(() => {
    let mounted = true;
    sessionStore('previous')
      .then(saved => {
        if (mounted) setHasPrevious(!!saved);
      })
      .catch(() => {});
    sessionStore('read')
      .then(saved => {
        if (mounted && saved?.version === 1) {
          const loadedSettings = { ...saved.settings };
          if (!loadedSettings.model || loadedSettings.model === 'gemini-2.5-flash-preview-tts') {
            loadedSettings.model = 'gemini-3.8-flash-lite-tts';
          }
          if (
            !loadedSettings.styleInstructions ||
            loadedSettings.styleInstructions.includes('Natural, conversational tone') ||
            loadedSettings.styleInstructions.includes('lively banter')
          ) {
            loadedSettings.styleInstructions = DEFAULT_PODCAST_STYLE;
          }
          const cleanSession = { ...saved, settings: loadedSettings };
          if (cleanSession.batch?.lastError && /readablestream|unexpected end of json|close/i.test(cleanSession.batch.lastError)) {
            cleanSession.batch.lastError = undefined;
          }
          setSession(cleanSession);
          setSettings(loadedSettings);
        }
      })
      .catch(e => {
        if (mounted) setError(errorMessage(e));
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setBatchReady(false);
    setBatchConnection('');
  }, [settings.model]);

  const change = (patch: Partial<TtsSettings>) => setSettings(s => ({ ...s, ...patch }));

  const insertTagAtCursor = (textToInsert: string) => {
    const textarea = scriptTextareaRef.current;
    if (!textarea) {
      change({ script: settings.script + (settings.script.endsWith(' ') ? '' : ' ') + textToInsert + ' ' });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const current = settings.script;
    const before = current.substring(0, start);
    const after = current.substring(end);
    const needsSpaceBefore = before.length > 0 && !/[\s\n]$/.test(before);
    const inserted = (needsSpaceBefore ? ' ' : '') + textToInsert + ' ';
    const newScript = before + inserted + after;
    change({ script: newScript });
    setTimeout(() => {
      textarea.focus();
      const newPos = start + inserted.length;
      textarea.setSelectionRange(newPos, newPos);
    }, 20);
  };

  const restoreOriginalDharmaScript = () => {
    change({
      mode: 'multi',
      speakers: DEFAULT_MULTI_SPEAKER,
      model: 'gemini-3.8-flash-tts',
      chunkSize: 3000,
      script: ORIGINAL_DHARMA_SCRIPT,
      styleInstructions: DEFAULT_PODCAST_STYLE,
    });
  };

  const loadSampleAiScript = () => {
    change({
      mode: 'multi',
      speakers: [
        { id: 's1', name: 'A', voice: DEFAULT_MULTI_SPEAKER[0].voice, color: 'bg-cyan-500' },
        { id: 's2', name: 'B', voice: DEFAULT_MULTI_SPEAKER[1].voice, color: 'bg-pink-500' }
      ],
      model: 'gemini-3.8-flash-tts',
      script: SAMPLE_AI_SCRIPT,
      styleInstructions: 'Natural, expressive conversational podcast tone with lively emotional reactions.',
    });
  };

  const save = async (next: PodcastSession) => {
    next.revision = (next.revision ?? 0) + 1;
    setSession(structuredClone(next));
    await sessionStore('write', next);
  };

  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    stop.current = false;
    const execute = async () => {
      try {
        await operation();
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request('podcast-generation', { ifAvailable: true }, async lock => {
          if (!lock) {
            setError('มีหน้าต่างอื่นกำลังทำงาน กรุณาใช้ทีละหน้าต่าง');
            return;
          }
          const latest = await sessionStore('read');
          if (latest?.id !== session?.id || latest?.revision !== session?.revision) {
            setError('มีงานเปลี่ยนจากอีกหน้าต่าง กรุณารีโหลดเพื่อรับงานล่าสุด');
            return;
          }
          await execute();
        });
      } else {
        await execute();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
      setStatus('');
    }
  };

  const generate = (kind: 'standard' | 'batch') =>
    run(async () => {
      if (kind === 'batch' && !currentPricing.batchSupported) {
        throw new Error('โมเดลนี้ไม่รองรับ Batch API กรุณาสลับเป็น Gemini 3.8 Flash-Lite TTS');
      }
      if (activeBatch) throw new Error('กรุณาตรวจงาน Batch ที่ค้างอยู่ก่อน');
      const next = sameSettings ? structuredClone(session!) : createSession(settings);

      // Clean up previous batch object if it was in an inactive terminal state (e.g. cancelled/failed)
      if (next.batch && !batchActive(next)) {
        delete next.batch;
      }

      // If all chunks already completed, reset chunks so generation has content to produce
      const unrendered = next.chunks.filter(c => !c.pcm).length;
      if (unrendered === 0) {
        next.chunks = splitScript(next.settings).map(text => ({ text }));
      }

      setError('');
      await save(next);
      if (kind === 'batch') {
        setStatus('กำลังตรวจและส่งคิว Batch (ประหยัด 50%)…');
        try {
          await submitBatch(next, save);
        } catch (e) {
          setBatchReady(false);
          setBatchConnection(`ส่ง Batch ไม่สำเร็จ: ${errorMessage(e)} — สามารถใช้ปุ่มสร้างทันทีได้`);
          throw e;
        }
      } else {
        if (next.settings.mode === 'multi' && next.settings.model === 'gemini-3.8-flash-lite-tts') {
          next.settings.model = 'gemini-3.8-flash-tts';
          setSettings(s => ({ ...s, model: 'gemini-3.8-flash-tts' }));
        }
        await generateStandard(next, save, setStatus, { shouldStop: () => stop.current });
      }
    });

  const testBatchConnection = () =>
    run(async () => {
      setStatus('กำลังตรวจโมเดลรองรับ Batch API…');
      setBatchConnection('กำลังตรวจการเชื่อมต่อ Batch…');
      if (!currentPricing.batchSupported) {
        setBatchReady(false);
        setBatchConnection('⚠️ โมเดลนี้ไม่รองรับ Batch API ของ Google (กรุณาสลับโมเดลเป็น Gemini 3.8 Flash-Lite เพื่อใช้งาน)');
        return;
      }
      try {
        await checkBatchConnection(settings.model);
        setBatchReady(true);
        setBatchConnection('✅ โมเดลนี้พร้อมสำหรับงาน Batch API (ประหยัด 50%) — หมายเหตุ: คิว Batch ของ Google ใช้เวลาประมาณ 10-30 นาทีขึ้นไป หากต้องการเสียงด่วนในไม่กี่วินาที แนะนำให้ใช้ปุ่ม "สร้างทันที" แทน');
      } catch (e) {
        setBatchReady(false);
        setBatchConnection(`Batch ไม่พร้อมใช้งาน: ${errorMessage(e)} — สามารถใช้ปุ่มสร้างทันทีได้`);
      }
    });

  const handleCancelBatch = () =>
    run(async () => {
      if (!session) return;
      setStatus('กำลังยกเลิกงาน Batch และปลดล็อกระบบ…');
      await cancelBatch(structuredClone(session), save);
      setStatus('');
    });

  const handleCancelAndGenerateStandard = () =>
    run(async () => {
      if (!session) return;
      setStatus('กำลังยกเลิกงาน Batch และสลับไปสร้างเสียงทันที (Real-time)…');
      const clone = structuredClone(session);
      await cancelBatch(clone, save);
      if (clone.settings.mode === 'multi' && clone.settings.model === 'gemini-3.8-flash-lite-tts') {
        clone.settings.model = 'gemini-3.8-flash-tts';
        setSettings(s => ({ ...s, model: 'gemini-3.8-flash-tts' }));
      }
      await generateStandard(clone, save, setStatus, { shouldStop: () => stop.current });
    });

  const handleDismissBatch = () =>
    run(async () => {
      if (!session) return;
      await dismissBatch(structuredClone(session), save);
    });

  const testConnection = () =>
    run(async () => {
      setTestAudio(null);
      setConnection('');
      const script = settings.speakers
        .map(
          (speaker, index) =>
            `${speaker.name}: ${
              index === 0
                ? 'สวัสดีครับ นี่คือเสียงทดสอบระบบ Gemini TTS'
                : 'สวัสดีค่ะ ทดสอบระบบเสียงสองผู้พูดค่ะ'
            }`
        )
        .join('\n');
      const sample = createSession({ ...settings, script });
      await generateStandard(sample, async () => {}, setStatus);
      setTestAudio(assembleSession(sample));
      setConnection('สร้างเสียงทดสอบสำเร็จผ่านคีย์ AI Studio แล้ว! บทพูดหลักและงานเดิมยังปลอดภัยอยู่ครบ');
    });

  const resetJob = (mode: 'clear-all' | 'keep-script' | 'restore') =>
    run(async () => {
      if (mode === 'restore') {
        const next = await sessionStore('previous');
        if (!next) throw new Error('ไม่มีงานก่อนรีเซ็ตให้เรียกคืน');
        next.revision = (next.revision ?? 0) + 1;
        await sessionStore('reset', next);
        setSession(structuredClone(next));
        setSettings(next.settings);
        setHasPrevious(false);
        setConnection('เรียกงานและไฟล์เสียงก่อนรีเซ็ตคืนเรียบร้อยแล้ว');
        return;
      }

      if (mode === 'clear-all') {
        const cleanSettings: TtsSettings = {
          mode: 'multi',
          speakers: DEFAULT_MULTI_SPEAKER,
          model: 'gemini-3.8-flash-tts',
          chunkSize: 3000,
          styleInstructions: DEFAULT_PODCAST_STYLE,
          script: '',
        };
        const next = createSession(cleanSettings);
        next.revision = (session?.revision ?? 0) + 1;
        await sessionStore('reset', next);
        setSession(null);
        setSettings(cleanSettings);
        setHasPrevious(!!session || !!settings.script);
        setError('');
        setConnection('ล้างข้อมูลทั้งหมดเรียบร้อยแล้ว! หน้ากระดาษว่างพร้อมให้พิมพ์บทพูดตอนใหม่ทันที');
        return;
      }

      // 'keep-script' mode: clears generated audio chunks, but keeps current script and speaker configs
      const next = createSession(settings);
      next.revision = (session?.revision ?? 0) + 1;
      await sessionStore('reset', next);
      setSession(structuredClone(next));
      setHasPrevious(!!session);
      setError('');
      setConnection('ล้างไฟล์เสียงเก่าเรียบร้อยแล้ว! บทพูดยังอยู่ครบ กดปุ่มสร้างเสียงเพื่อเริ่มใหม่ได้ทันที');
    });

  const repair = (index: number) =>
    run(async () => {
      if (session) await generateStandard(structuredClone(session), save, setStatus, { replaceIndex: index });
    });

  const downloadReport = () => {
    if (!session) return;
    const report = {
      ...session,
      chunks: session.chunks.map(({ pcm, previousTake, shortRepair, ...c }) => ({
        ...c,
        bytes: pcm?.length,
        previousTakeBytes: previousTake?.pcm?.length,
        shortRepair: shortRepair?.chunks.map(({ pcm, ...part }) => ({ ...part, bytes: pcm?.length })),
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `podcast-report-${session.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const starts: (number | undefined)[] = [];
  let elapsed: number | undefined = 0;
  session?.chunks.forEach(c => {
    starts.push(elapsed);
    elapsed = elapsed !== undefined && c.seconds !== undefined ? elapsed + c.seconds + 0.1 : undefined;
  });

  // Calculate actual cost from session token charges according to model pricing
  const knownCost =
    session?.charges.reduce((sum, c) => {
      const modelPricing = MODEL_PRICING[session.settings.model] ?? currentPricing;
      const isBatch = c.mode === 'batch';
      const inRate = isBatch ? modelPricing.batchInputPerMillion : modelPricing.inputPerMillion;
      const audioRate = isBatch ? modelPricing.batchAudioPerMillion : modelPricing.audioTokensPerMillion;
      const inputCost = ((c.inputTokens ?? 0) * inRate) / 1e6;
      const audioCost = ((c.audioTokens ?? 0) * audioRate) / 1e6;
      return sum + inputCost + audioCost;
    }, 0) ?? 0;

  const estimatedMinutes = Math.max(1, Number(minutes) || 1);
  const estimatedAudioTokens = estimatedMinutes * 1500;
  const estimatedRealtimeCost = (estimatedMinutes * currentPricing.costPerMinute).toFixed(4);
  const estimatedBatchCost = (estimatedMinutes * currentPricing.batchCostPerMinute).toFixed(4);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-8 pb-48 md:pb-48">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4 pb-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 border border-cyan-500/30">
              <BrainCircuit className="text-cyan-400" size={30} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-cyan-200 via-white to-indigo-200 bg-clip-text text-transparent">
                  Thai Podcast Creator
                </h1>
                <span className="text-[11px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  {settings.model.startsWith('gemini-3.8') ? 'Gemini 3.8 TTS' : 'Gemini 2.5 Flash TTS'}
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                พอดแคสต์ 2 ผู้พูด (A / {settings.speakers[0]?.voice || 'Sadaltager'} & B / {settings.speakers[1]?.voice || 'Sulafat'}) · สลับเสียงอัตโนมัติตามสคริปต์ A: / B:
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {window.aistudio && (
              <button
                disabled={busy}
                className={`${button} bg-zinc-900 border border-zinc-700 hover:border-zinc-500 text-xs py-2`}
                onClick={() => {
                  setBatchReady(false);
                  setBatchConnection('');
                  void window
                    .aistudio!.openSelectKey()
                    .then(() => {
                      setError('');
                      setConnection('เลือกคีย์ผ่าน AI Studio แล้ว กดทดสอบเสียงสั้นเพื่อตรวจการใช้งานจริง');
                    })
                    .catch(e => setError(errorMessage(e)));
                }}
              >
                <Key size={13} className="inline mr-1.5 text-cyan-400" />
                เลือก API key
              </button>
            )}
            <button
              onClick={() => setShowGuide(!showGuide)}
              className={`${button} ${
                showGuide ? 'bg-cyan-900/60 border border-cyan-500 text-cyan-200' : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800'
              } text-xs py-2`}
            >
              <BookOpen size={13} className="inline mr-1.5" />
              {showGuide ? 'ซ่อนคู่มือ' : 'คู่มือแท็กเสียง & คำอ่านไทย'}
            </button>
          </div>
        </header>

        {/* Phonetic & Vocal Tags Guide Modal/Drawer */}
        {showGuide && (
          <section className="mb-8 p-5 bg-gradient-to-b from-zinc-900 to-zinc-950 rounded-2xl border border-cyan-500/30 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles size={18} className="text-cyan-400" />
                <h3 className="font-semibold text-sm text-cyan-100">
                  คู่มือเทคนิคปรับแต่งเสียงขั้นสูง & แท็กอารมณ์สำหรับ Gemini 3.8
                </h3>
              </div>
              <button onClick={() => setShowGuide(false)} className="text-xs text-zinc-400 hover:text-zinc-200">
                ✕ ปิดคู่มือ
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-5 text-xs text-zinc-300">
              {/* Col 1: Inline Vocal Expression Tags */}
              <div className="space-y-2 bg-zinc-950/60 p-4 rounded-xl border border-zinc-800">
                <p className="font-semibold text-cyan-300 flex items-center gap-1.5">
                  <Volume2 size={14} /> 1. แท็กอารมณ์ในบรรทัด (Inline Tags)
                </p>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  แทรกลงในบทพูดได้ทันที โมเดล 3.8 จะเปล่งเสียงหัวเราะ สูดหายใจ หรือถอนหายใจในจังหวะนั้น
                </p>
                <div className="space-y-1.5 pt-1">
                  {INLINE_VOCAL_TAGS.slice(0, 6).map(item => (
                    <div key={item.tag} className="flex items-center justify-between p-1.5 bg-zinc-900/80 rounded border border-zinc-800">
                      <span className="font-mono text-cyan-300">{item.tag}</span>
                      <span className="text-zinc-400">{item.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Col 2: Punctuation & Pause Tricks */}
              <div className="space-y-2 bg-zinc-950/60 p-4 rounded-xl border border-zinc-800">
                <p className="font-semibold text-indigo-300 flex items-center gap-1.5">
                  <Zap size={14} /> 2. จังหวะการหยุดหายใจ (Punctuation Tricks)
                </p>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  ภาษาไทยไม่มีเว้นวรรคตายตัว ใช้สัญลักษณ์เพื่อควบคุมจังหวะหายใจอย่างเป็นธรรมชาติ:
                </p>
                <div className="space-y-2 pt-1">
                  <div className="p-2 bg-zinc-900/80 rounded border border-zinc-800">
                    <span className="font-mono text-amber-300 font-bold">... (จุดสามจุด)</span>
                    <p className="text-zinc-400 mt-0.5">เว้นช่วง 0.3-0.5 วินาที เพื่อหยุดคิดหรือเปลี่ยนอารมณ์</p>
                  </div>
                  <div className="p-2 bg-zinc-900/80 rounded border border-zinc-800">
                    <span className="font-mono text-amber-300 font-bold">, (จุลภาค)</span>
                    <p className="text-zinc-400 mt-0.5">เว้นสั้น 0.1 วินาที ใช้คั่นประโยคเพื่อหายใจ</p>
                  </div>
                  <div className="p-2 bg-zinc-900/80 rounded border border-zinc-800">
                    <span className="font-mono text-amber-300 font-bold">- (ยัติภังค์)</span>
                    <p className="text-zinc-400 mt-0.5">ลากเสียงสระยาว เช่น "ม้า-า-า-ก" หรือ "ดี-สุด-สุด"</p>
                  </div>
                </div>
              </div>

              {/* Col 3: Thai Phonetic Respelling */}
              <div className="space-y-2 bg-zinc-950/60 p-4 rounded-xl border border-zinc-800">
                <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
                  <Sparkles size={14} /> 3. คำอ่านทับศัพท์ (Phonetic Respelling)
                </p>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  คำศัพท์ภาษาอังกฤษหรือตัวย่อ ควรเขียนคำอ่านไทยเพื่อให้สำเนียงเป๊ะ ไม่เพี้ยน:
                </p>
                <div className="space-y-1.5 pt-1">
                  {PHONETIC_EXAMPLES.map(ex => (
                    <div
                      key={ex.original}
                      className="flex items-center justify-between p-1.5 bg-zinc-900/80 rounded border border-zinc-800 hover:border-zinc-700 cursor-pointer"
                      onClick={() => insertTagAtCursor(ex.respelled)}
                      title="คลิกเพื่อแทรกลงในบทพูด"
                    >
                      <span className="font-mono text-zinc-300">{ex.original}</span>
                      <span className="font-semibold text-emerald-300">→ {ex.respelled}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-500 italic mt-1">* คลิกที่รายการเพื่อแทรกลงในบทพูด</p>
              </div>
            </div>
          </section>
        )}

        <div className="grid lg:grid-cols-12 gap-8">
          {/* Settings Sidebar */}
          <fieldset disabled={locked} className="lg:col-span-4 space-y-5 min-w-0 disabled:opacity-60">
            {/* Mode selection */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                โหมดการสร้างเสียง
              </label>
              <select
                className={field}
                value={settings.mode}
                onChange={e => {
                  const mode = e.target.value as 'single' | 'multi';
                  change({
                    mode,
                    speakers: mode === 'multi' ? DEFAULT_MULTI_SPEAKER : DEFAULT_SINGLE_SPEAKER,
                    model: mode === 'multi' ? 'gemini-3.8-flash-tts' : 'gemini-3.8-flash-lite-tts',
                  });
                }}
              >
                <option value="multi">พอดแคสต์ 2 ผู้พูด (Native Multi-Speaker)</option>
                <option value="single">เสียงเดี่ยว (Single Speaker)</option>
              </select>
            </div>

            {/* Speaker configuration */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  ผู้พูด ({settings.speakers.length} คน)
                </label>
                <span className="text-[11px] text-cyan-400 font-medium">สลับอัตโนมัติใน API เดียว</span>
              </div>
              {settings.speakers.map((speaker, i) => (
                <VoiceSelector
                  key={speaker.id}
                  speaker={speaker}
                  index={i}
                  onChange={updated =>
                    change({
                      speakers: settings.speakers.map((s, j) => (j === i ? updated : s)),
                    })
                  }
                />
              ))}
            </div>

            {/* Model Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  โมเดล Gemini TTS
                </label>
                <span className="text-[11px] text-emerald-400 font-medium">{currentPricing.badge}</span>
              </div>
              <select
                className={field}
                value={settings.model}
                onChange={e => change({ model: e.target.value as TtsModel })}
              >
                <option value="gemini-3.8-flash-tts">
                  Gemini 3.8 Flash TTS (พอดแคสต์ 2 ผู้พูด & Inline Tags · แนะนำ) — $0.405/ชม. Batch
                </option>
                <option value="gemini-3.8-flash-lite-tts">
                  Gemini 3.8 Flash-Lite TTS (เสียงเดี่ยว Single Speaker · ประหยัดสุด) — $0.27/ชม. Batch
                </option>
                <option value="gemini-2.5-flash-preview-tts">
                  Gemini 2.5 Flash TTS (ดั้งเดิม)
                </option>
                <option value="gemini-3.1-flash-tts-preview">
                  Gemini 3.1 Flash TTS Preview (ทดลอง)
                </option>
              </select>

              {/* Model Pricing Card */}
              <div className="mt-2.5 p-3 rounded-xl bg-zinc-900/90 border border-zinc-800 text-xs space-y-1.5">
                <div className="flex items-center justify-between font-medium">
                  <span className="text-zinc-300">อัตราค่าบริการ (Audio Tokens):</span>
                  <span className="text-cyan-300 font-mono">25 Tokens / วินาที</span>
                </div>
                <div className="flex items-center justify-between text-zinc-400">
                  <span>ส่งคิว Batch (ลด 50%):</span>
                  <span className="text-emerald-400 font-mono font-medium">
                    ${currentPricing.batchCostPerHour.toFixed(2)}/ชม. (~฿9.70)
                  </span>
                </div>
                <div className="flex items-center justify-between text-zinc-400">
                  <span>สร้างทันที (Real-time):</span>
                  <span className="text-zinc-300 font-mono">
                    ${currentPricing.costPerHour.toFixed(2)}/ชม.
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 pt-1 border-t border-zinc-800/80">
                  {currentPricing.description}
                </p>
              </div>
            </div>

            {/* Chunk Size */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                ความยาวต่อช่วง (Chunk Size)
              </label>
              <select
                className={field}
                value={settings.chunkSize}
                onChange={e => change({ chunkSize: Number(e.target.value) })}
              >
                {[1000, 1500, 2000, 3000].map(n => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} ตัวอักษร
                    {n === 3000 ? ' (แนะนำสำหรับสคริปต์ 3.8 ยาว)' : n === 1500 ? ' (ตรวจเช็คง่าย)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-400 mt-1.5">
                Gemini 3.8 รองรับสคริปต์ยาวได้เสถียรขึ้น และรักษาสภาพแท็กอารมณ์ไม่ให้ขาดตอน
              </p>
            </div>

            {/* Style Instructions with Podcast Tone Lock */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  คำกำกับโทนเสียง (Speaking Style)
                </label>
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 font-medium">
                  <Lock size={11} className="text-cyan-400" /> ล็อคโทน Podcast
                </span>
              </div>

              {/* Tone Presets Chips */}
              <div className="space-y-1.5 pt-0.5">
                <span className="text-[11px] text-zinc-400 block font-medium">เลือกสไตล์ผู้จัดรายการพอดแคสต์ (Podcast Tone Presets):</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {PODCAST_TONE_PRESETS.map(preset => {
                    const isActive = settings.styleInstructions === preset.prompt;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => change({ styleInstructions: preset.prompt })}
                        className={`text-left p-2 rounded-xl border text-xs transition-all cursor-pointer ${
                          isActive
                            ? 'bg-cyan-950/90 border-cyan-500 text-cyan-200 shadow-sm shadow-cyan-900/40'
                            : 'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-850'
                        }`}
                        title={preset.desc}
                      >
                        <div className="flex items-center gap-1.5 font-medium text-[11px]">
                          <span>{preset.icon}</span>
                          <span className="truncate">{preset.name.split('(')[0]}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <textarea
                className={`${field} h-20 text-xs mt-1.5`}
                value={settings.styleInstructions}
                placeholder="เช่น Natural, engaging conversational podcast host tone with lively banter."
                onChange={e => change({ styleInstructions: e.target.value })}
              />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                🔒 โทนเสียงพอดแคสต์ (Podcast Tone) ถูกล็อคแทรกในคำขอเสมอ เพื่อให้น้ำเสียงเป็นธรรมชาติแบบผู้ดำเนินรายการพอดแคสต์จริง
              </p>
            </div>
          </fieldset>

          {/* Script Editor & Studio Action */}
          <section className="lg:col-span-8 min-w-0 space-y-5">
            {/* Inline Vocal Expressions Toolbar */}
            <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-cyan-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                    แท็กอารมณ์ & เสียงธรรมชาติ (Inline Vocal Expression Tags)
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={restoreOriginalDharmaScript}
                    className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1 font-medium bg-cyan-950/40 px-2.5 py-1 rounded-lg border border-cyan-800/40"
                    title="คืนค่าตัวละคร A (Sadaltager), B (Sulafat), โมเดล 3.8 และบทธรรมะเริ่มต้น"
                  >
                    <RotateCcw size={12} /> บทธรรมะเริ่มต้น (A/B)
                  </button>
                  <button
                    type="button"
                    onClick={loadSampleAiScript}
                    className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline flex items-center gap-1"
                  >
                    สคริปต์ AI
                  </button>
                  {settings.script && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('คุณต้องการล้างข้อความในบทพูดทั้งหมดหรือไม่?')) {
                          change({ script: '' });
                        }
                      }}
                      className="text-xs text-rose-400 hover:text-rose-300 hover:underline flex items-center gap-1 font-medium bg-rose-950/30 px-2.5 py-1 rounded-lg border border-rose-900/40 transition-colors"
                      title="ลบข้อความในบทพูดทั้งหมดเพื่อพิมพ์ใหม่"
                    >
                      <Trash2 size={12} /> ล้างบทพูด
                    </button>
                  )}
                </div>
              </div>

              {/* Vocal Tag Insertion Chips */}
              <div className="flex flex-wrap gap-1.5">
                {INLINE_VOCAL_TAGS.map(t => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => insertTagAtCursor(t.tag)}
                    title={`${t.desc} — คลิกเพื่อแทรกลงในบท`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-cyan-950 hover:border-cyan-500/50 border border-zinc-700/60 text-xs text-zinc-200 hover:text-cyan-200 transition-all cursor-pointer active:scale-95"
                  >
                    <span>{t.icon}</span>
                    <span className="font-mono text-[11px]">{t.tag}</span>
                  </button>
                ))}
              </div>

              {/* Pause & Rhythm Tricks Chips */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-800/80">
                <span className="text-[11px] text-zinc-400">จังหวะหายใจ:</span>
                {PAUSE_TRICKS.map(p => (
                  <button
                    key={p.text}
                    type="button"
                    onClick={() => insertTagAtCursor(p.text.trim())}
                    title={p.desc}
                    className="inline-flex items-center px-2 py-0.5 rounded bg-zinc-800/70 hover:bg-zinc-700 border border-zinc-700/50 text-[11px] text-amber-200 font-mono transition-colors active:scale-95"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Script Textarea */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  บทพูดพอดแคสต์ (Script)
                </label>
                <div className="flex items-center gap-2 text-xs">
                  {tagAnalysis.totalTags > 0 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-800/60 text-cyan-300 font-medium text-[11px]">
                      <CheckCircle2 size={12} /> ตรวจพบ {tagAnalysis.totalTags} แท็กอารมณ์
                    </span>
                  ) : (
                    <span className="text-zinc-500 text-[11px]">
                      ยังไม่มีแท็กอารมณ์ (ลองคลิกปุ่มแท็กด้านบน)
                    </span>
                  )}
                </div>
              </div>
              <textarea
                ref={scriptTextareaRef}
                disabled={locked}
                className={`${field} h-72 text-sm font-mono leading-relaxed resize-y`}
                value={settings.script}
                onChange={e => change({ script: e.target.value })}
                placeholder={
                  settings.mode === 'multi'
                    ? 'A: [excited] สวัสดีครับ...\nB: [giggle] สวัสดีค่ะ...'
                    : 'ข้อความสำหรับสร้างเสียงเดี่ยว สามารถใส่แท็ก [excited] หรือ [laughter] ได้'
                }
              />
            </div>

            {/* Script Analysis & Tag Badges */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-zinc-400">
                {plan.error ? (
                  <span className="text-red-400 font-medium flex items-center gap-1">
                    <AlertTriangle size={14} /> {plan.error}
                  </span>
                ) : (
                  <span>
                    ความยาวบท: <strong className="text-zinc-200">{settings.script.length.toLocaleString()}</strong>{' '}
                    ตัวอักษร · แบ่งเป็น <strong className="text-cyan-300">{plan.chunks.length}</strong> ช่วง
                  </span>
                )}
              </div>

              {/* Tag Badges list */}
              {tagAnalysis.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tagAnalysis.tags.map(t => (
                    <span
                      key={t.tag}
                      className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300"
                    >
                      {t.tag} <strong className="text-cyan-400">×{t.count}</strong>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Script Warnings (if any) */}
            {tagAnalysis.warnings.length > 0 && (
              <div className="p-3 bg-amber-950/30 border border-amber-900/50 rounded-xl space-y-1">
                {tagAnalysis.warnings.map(w => (
                  <p key={w} className="text-xs text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle size={13} className="shrink-0" /> {w}
                  </p>
                ))}
              </div>
            )}

            {/* Cost Calculator & Audio Tokens Logic */}
            <div className="bg-gradient-to-br from-cyan-950/20 via-zinc-900/40 to-indigo-950/20 border border-cyan-900/40 rounded-2xl p-4 text-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Info size={16} className="text-cyan-400" />
                  <span className="font-semibold text-zinc-200">
                    คำนวณราคาและ Audio Tokens (2026 Promo Pricing)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span>ความยาวเสียงที่คาดไว้:</span>
                  <input
                    type="number"
                    min="1"
                    max="600"
                    className="w-16 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-center font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    value={minutes}
                    onChange={e => setMinutes(e.target.value)}
                  />
                  <span>นาที</span>
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-3 pt-1">
                <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px]">Audio Tokens ที่ใช้:</span>
                  <span className="font-mono text-sm font-semibold text-zinc-200">
                    ~{estimatedAudioTokens.toLocaleString()} Tokens
                  </span>
                  <span className="text-[10px] text-zinc-500 block">อัตราคงที่ 25 tokens/วินาที</span>
                </div>

                <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px]">สร้างทันที (Real-time):</span>
                  <span className="font-mono text-sm font-semibold text-zinc-300">
                    ${estimatedRealtimeCost}
                  </span>
                  <span className="text-[10px] text-zinc-500 block">
                    (${currentPricing.costPerHour.toFixed(2)}/ชม.)
                  </span>
                </div>

                <div className="p-2.5 rounded-xl bg-emerald-950/30 border border-emerald-800/40">
                  <span className="text-emerald-400 block text-[11px] font-medium">
                    ส่งคิว Batch (ลดทันที 50%):
                  </span>
                  <span className="font-mono text-sm font-bold text-emerald-300">
                    ${estimatedBatchCost}
                  </span>
                  <span className="text-[10px] text-emerald-400/80 block">
                    (${currentPricing.batchCostPerHour.toFixed(2)}/ชม. · ประมาณ ฿9.70)
                  </span>
                </div>
              </div>
            </div>

            {/* Test Audio & Batch Check Actions */}
            <div className="grid sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-1.5">
                <button
                  disabled={busy || !ready || !!plan.error}
                  className="text-cyan-400 hover:text-cyan-300 font-medium underline disabled:opacity-40"
                  onClick={testConnection}
                >
                  ทดสอบเสียงสั้น (Single Request)
                </button>
                <p className="text-[11px] text-zinc-400">
                  ทดสอบสร้างประโยคสั้น 1 คำขอเพื่อตรวจเช็คเสียงของโมเดลที่เลือก
                </p>
                {connection && <p className="text-zinc-300 mt-1">{connection}</p>}
                {testAudio && (
                  <div className="mt-2">
                    <AudioPlayer audioBlob={testAudio} />
                  </div>
                )}
              </div>

              <div className="p-3 bg-indigo-950/20 border border-indigo-900/50 rounded-xl space-y-1.5">
                <button
                  disabled={busy || !ready}
                  className="text-indigo-300 hover:text-indigo-200 font-medium underline disabled:opacity-40"
                  onClick={testBatchConnection}
                >
                  ตรวจโมเดลรองรับ Batch API (ไม่เสียเงิน)
                </button>
                <p className="text-[11px] text-zinc-400">
                  {batchConnection ||
                    'ตรวจสอบความพร้อมของคิว Batch กับโมเดลที่เลือกก่อนกดส่งงาน'}
                </p>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div
                role="alert"
                className="bg-red-950/40 border border-red-900 p-4 rounded-xl text-red-300 text-xs whitespace-pre-wrap break-words flex items-start justify-between gap-3 shadow-lg"
              >
                <div className="flex items-start gap-2.5">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5 text-red-400" />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setError('')}
                  className="px-2 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[11px] font-medium transition-all shrink-0 cursor-pointer"
                  title="ปิดข้อความแจ้งเตือนนี้"
                >
                  ✕ ปิด
                </button>
              </div>
            )}

            {/* Session Management & Project Reset - Prominent & Big */}
            <div className="rounded-2xl border-2 border-zinc-800 bg-gradient-to-b from-zinc-900/90 via-zinc-900 to-zinc-950 p-5 space-y-4 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
                    <Trash2 size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-wide flex items-center gap-2">
                      จัดการโปรเจกต์ & รีเซ็ตข้อมูล (Project & Reset)
                    </h3>
                    <p className="text-xs text-zinc-400">
                      ล้างไฟล์เสียงเก่าเพื่อเรนเดอร์ใหม่ หรือล้างข้อมูลทั้งหมดเพื่อเริ่มทำตอนใหม่
                    </p>
                  </div>
                </div>

                {hasPrevious && (
                  <button
                    type="button"
                    disabled={busy || !ready}
                    className="px-4 py-2 rounded-xl border border-cyan-700/60 bg-cyan-950/70 hover:bg-cyan-900 text-cyan-300 text-xs font-semibold transition-all flex items-center gap-2 shadow cursor-pointer active:scale-95"
                    onClick={() => resetJob('restore')}
                    title="กู้คืนงานและไฟล์เสียงที่เคยบันทึกไว้ก่อนรีเซ็ตล่าสุด"
                  >
                    <RotateCcw size={14} className="text-cyan-400" />
                    <span>กู้คืนข้อมูลก่อนรีเซ็ตล่าสุด</span>
                  </button>
                )}
              </div>

              {/* 2 Big Action Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {/* Button 1: Clear All & Fresh Start */}
                <button
                  type="button"
                  disabled={busy || !ready}
                  onClick={() => {
                    if (window.confirm('ยืนยันล้างข้อมูลทั้งหมด? บทพูดและไฟล์เสียงที่เคยสร้างจะถูกลบทั้งหมดเพื่อเริ่มงานใหม่ (ระบบมีสำรองให้กู้คืนได้)')) {
                      resetJob('clear-all');
                    }
                  }}
                  className="group relative flex flex-col items-start p-4 rounded-xl border-2 border-rose-900/50 bg-gradient-to-br from-rose-950/30 via-zinc-900 to-zinc-950 hover:from-rose-950/60 hover:to-zinc-900 hover:border-rose-500 text-left transition-all shadow-lg hover:shadow-rose-950/40 cursor-pointer active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-2.5 text-rose-300 font-bold text-sm md:text-base mb-1">
                    <div className="w-8 h-8 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 group-hover:bg-rose-500 group-hover:text-white transition-all shrink-0">
                      <Trash2 size={18} />
                    </div>
                    <span>เริ่มงานใหม่ & ล้างข้อมูลทั้งหมด</span>
                  </div>
                  <span className="text-xs text-zinc-400 group-hover:text-zinc-300 leading-relaxed pl-10.5">
                    ล้างทั้งบทพูดและไฟล์เสียงทั้งหมด เพื่อเปิดหน้ากระดาษว่างพร้อมใส่บทพอดแคสต์ตอนใหม่
                  </span>
                </button>

                {/* Button 2: Clear Audio Only (Keep Script) */}
                <button
                  type="button"
                  disabled={busy || !ready || !session}
                  onClick={() => resetJob('keep-script')}
                  className="group relative flex flex-col items-start p-4 rounded-xl border-2 border-zinc-700 bg-gradient-to-br from-zinc-850/80 via-zinc-900 to-zinc-950 hover:from-zinc-800 hover:to-zinc-900 hover:border-amber-500/70 text-left transition-all shadow-lg hover:shadow-amber-950/30 cursor-pointer active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-2.5 text-amber-300 font-bold text-sm md:text-base mb-1">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 group-hover:bg-amber-500 group-hover:text-black transition-all shrink-0">
                      <RefreshCw size={18} />
                    </div>
                    <span>ล้างเฉพาะไฟล์เสียง (เก็บบทพูดไว้)</span>
                  </div>
                  <span className="text-xs text-zinc-400 group-hover:text-zinc-300 leading-relaxed pl-10.5">
                    ลบเฉพาะไฟล์เสียงเก่าที่สร้างไว้ เพื่อเรนเดอร์ใหม่ตั้งแต่ต้น โดยไม่ต้องพิมพ์บทพูดซ้ำ
                  </span>
                </button>
              </div>
            </div>

            {/* Main Generation Buttons */}
            {session?.batch && !activeBatch && session.batch.state === 'JOB_STATE_CANCELLED' && (
              <div className="p-3.5 bg-cyan-950/40 border border-cyan-800/60 rounded-xl text-xs text-cyan-200 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-cyan-400 shrink-0" />
                  <span>
                    ยกเลิกการรอคิว Batch แล้ว — ระบบปลดล็อกพร้อมใช้งาน สามารถกดปุ่ม <strong>"สร้างทันที / ทำช่วงที่เหลือต่อ"</strong> ด้านล่างเพื่อรับไฟล์เสียงได้ทันที
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleDismissBatch}
                  className="text-cyan-400 hover:text-cyan-300 text-xs underline shrink-0 cursor-pointer"
                >
                  ปิดแจ้งเตือน
                </button>
              </div>
            )}

            {activeBatch ? (
              <div className="p-5 bg-gradient-to-b from-indigo-950/60 via-zinc-900 to-zinc-950 border border-indigo-700/60 rounded-2xl space-y-4 shadow-xl shadow-indigo-950/20">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-800/40 pb-3">
                  <div className="flex items-center gap-2.5">
                    {session!.batch!.state === 'JOB_STATE_RUNNING' ? (
                      <span className="w-3.5 h-3.5 rounded-full bg-cyan-400 animate-spin border-2 border-cyan-200 border-t-transparent" />
                    ) : (
                      <Clock size={19} className="text-amber-400 shrink-0" />
                    )}
                    <div>
                      <p className="font-semibold text-zinc-100 text-sm">
                        {session!.batch!.state === 'JOB_STATE_RUNNING'
                          ? 'Google กำลังเรนเดอร์เสียง (JOB_STATE_RUNNING)'
                          : 'มีงานในคิว Batch: รอคิวประมวลผล (JOB_STATE_PENDING)'}
                      </p>
                      <p className="text-[11px] text-zinc-400 font-mono break-all">
                        {session!.batch!.name || session!.batch!.displayName}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-mono font-medium border ${
                    session!.batch!.state === 'JOB_STATE_RUNNING'
                      ? 'bg-cyan-950 text-cyan-300 border-cyan-800'
                      : 'bg-amber-950/80 text-amber-300 border-amber-800'
                  }`}>
                    {session!.batch!.state}
                  </span>
                </div>

                {/* Explanation for why it takes long & how to solve */}
                <div className="p-3.5 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-1.5 text-xs">
                  <div className="flex items-start gap-2">
                    <Info size={16} className="text-amber-400 shrink-0 mt-0.5" />
                    <div className="space-y-1 text-zinc-300 leading-relaxed">
                      <p className="font-medium text-amber-300">
                        ทำไมระบบ Batch ถึงรอนาน / เหมือนหมุนไม่หยุด?
                      </p>
                      <p className="text-[11px] text-zinc-400">
                        Google Gemini Batch API (ส่วนลดค่าเสียง 50%) เป็นคิวงานแบบ <strong>Asynchronous</strong> โดย Google จะนำคำขอไปรันในช่วงที่เซิร์ฟเวอร์ว่าง ซึ่งปกติคิวจะใช้เวลาประมาณ <strong>10–30 นาทีขึ้นไป</strong> (ไม่ได้เกิดจากหน้าเว็บค้าง)
                      </p>
                      <p className="text-[11px] text-cyan-300 font-medium pt-0.5">
                        ⚡ หากคุณต้องการฟังเสียงทันที ไม่จำเป็นต้องรอคิว สามารถกดปุ่ม <span className="underline">สลับไปสร้างเสียงทันที</span> ด้านล่างได้ทันที (เสร็จใน 5-15 วินาทีต่อช่วง)
                      </p>
                    </div>
                  </div>
                </div>

                {/* Auto Polling & Notification Banner */}
                <div className="p-3 bg-zinc-950/90 rounded-xl border border-indigo-900/60 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                  <div className="flex items-center gap-2 text-zinc-300">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping shrink-0" />
                    <span>
                      {autoPoll ? (
                        <>ระบบตรวจและดึงไฟล์เสียงอัตโนมัติ: ในอีก <strong className="text-cyan-300 font-mono">{pollCountdown}s</strong></>
                      ) : (
                        <>ปิดการดึงเสียงอัตโนมัติอยู่ (ต้องกดตรวจเอง)</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer hover:text-zinc-200">
                      <input
                        type="checkbox"
                        checked={autoPoll}
                        onChange={e => setAutoPoll(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-900 text-cyan-500 focus:ring-0"
                      />
                      <span>ดึงเสียงอัตโนมัติเมื่อเสร็จ</span>
                    </label>

                    {!notificationsAllowed ? (
                      <button
                        type="button"
                        onClick={enableNotifications}
                        className="text-[11px] text-amber-400 hover:text-amber-300 flex items-center gap-1 hover:underline"
                        title="เปิดแจ้งเตือนบนหน้าจอเมื่อไฟล์เสียงพร้อม"
                      >
                        <Bell size={12} /> เปิดแจ้งเตือนเสียงเสร็จ
                      </button>
                    ) : (
                      <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
                        <BellRing size={12} /> เปิดแจ้งเตือนแล้ว 🔔
                      </span>
                    )}
                  </div>
                </div>

                {/* Status Message / Last Checked */}
                {(session!.batch!.checkMessage || session!.batch!.lastChecked) && (
                  <div className="text-xs text-zinc-300 bg-indigo-950/40 p-3 rounded-xl border border-indigo-800/40 leading-relaxed">
                    <span className="font-semibold text-indigo-300">ผลการตรวจล่าสุด: </span>
                    {session!.batch!.checkMessage || `ตรวจล่าสุดเมื่อ ${session!.batch!.lastChecked}`}
                  </div>
                )}

                {session!.batch!.lastError && (
                  <div className="p-3 bg-red-950/40 border border-red-900 rounded-xl text-red-300 text-xs flex items-start justify-between gap-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={15} className="shrink-0 mt-0.5 text-red-400" />
                      <span>{session!.batch!.lastError}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (session?.batch) {
                          session.batch.lastError = undefined;
                          save(session);
                        }
                      }}
                      className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[10px] shrink-0 cursor-pointer"
                      title="ปิดข้อความแจ้งเตือนนี้"
                    >
                      ✕ ปิด
                    </button>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2.5 pt-1">
                  <button
                    disabled={busy}
                    className={`${button} bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center justify-center gap-1.5 shadow-lg shadow-cyan-950/40`}
                    onClick={handleCancelAndGenerateStandard}
                    title="ยกเลิกการรอคิว Batch แล้วเริ่มสร้างเสียงทันที (Real-time)"
                  >
                    <Wand2 size={15} />
                    <span>สลับไปสร้างเสียงทันที (เสร็จใน 5-15 วินาที)</span>
                  </button>

                  <button
                    disabled={busy}
                    className={`${button} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs py-2 flex items-center gap-1.5`}
                    onClick={() =>
                      run(async () => {
                        setError('');
                        if (session?.batch) {
                          session.batch.lastError = undefined;
                        }
                        setStatus('กำลังตรวจสถานะคิวงาน Batch กับ Google…');
                        await collectBatch(structuredClone(session!), save);
                      })
                    }
                  >
                    <RefreshCw size={13} className="inline" />
                    <span>ตรวจสถานะคิว / ดึงเสียง</span>
                  </button>

                  <button
                    disabled={busy}
                    className={`${button} bg-red-950/60 hover:bg-red-900/60 text-red-300 border border-red-800/60 text-xs py-2 flex items-center gap-1.5`}
                    onClick={handleCancelBatch}
                    title="ยกเลิกการรอคิวนี้และปลดล็อกปุ่มสร้างเสียง"
                  >
                    <XCircle size={13} />
                    <span>ยกเลิกการรอคิว</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <button
                    disabled={locked || !!plan.error || (!!sameSettings && allDone)}
                    className={`${button} w-full bg-cyan-600 hover:bg-cyan-500 text-white font-medium shadow-lg shadow-cyan-900/30`}
                    onClick={() => generate('standard')}
                  >
                    <Wand2 size={16} className="inline mr-2" />
                    สร้างทันที / ทำช่วงที่เหลือต่อ
                  </button>
                  {!!sameSettings && allDone && (
                    <p className="text-[11px] text-zinc-500 text-center">
                      สร้างครบทุกช่วงแล้ว (แก้ไขบทหรือเริ่มงานใหม่เพื่อส่งอีกครั้ง)
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <button
                    disabled={locked || !currentPricing.batchSupported || !!plan.error || (!!sameSettings && allDone)}
                    className={`${button} w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow-lg shadow-indigo-900/30 flex items-center justify-center gap-1.5`}
                    onClick={() => generate('batch')}
                  >
                    <Zap size={16} />
                    ส่งคิว Batch (ลดทันที 50%)
                  </button>
                  {!currentPricing.batchSupported ? (
                    <p className="text-[11px] text-amber-400/90 text-center">
                      ⚠️ โมเดลนี้ไม่รองรับ Batch (เลือก Gemini 3.8 Flash-Lite เพื่อลด 50%)
                    </p>
                  ) : !!sameSettings && allDone ? (
                    <p className="text-[11px] text-zinc-500 text-center">
                      สร้างครบทุกช่วงแล้ว (แก้ไขบทหรือเริ่มงานใหม่เพื่อส่งอีกครั้ง)
                    </p>
                  ) : null}
                </div>
              </div>
            )}

            {/* Working Indicator Modal/Bar */}
            {busy && (
              <WorkingIndicator
                message={status}
                completed={workingCompleted}
                total={workingTotal}
                canPause={!activeBatch && /สร้าง|ซ่อม|จะหยุด/.test(status)}
                onPause={() => {
                  stop.current = true;
                  setStatus('จะหยุดหลังบันทึกช่วงปัจจุบัน');
                }}
              />
            )}

            {/* Finished Session & Audio Player */}
            {session && (
              <div className="space-y-4 pt-6 border-t border-zinc-800">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <p className="font-medium text-zinc-300">
                    บันทึกสำเร็จแล้ว {completed}/{session.chunks.length} ช่วง
                  </p>
                  <button
                    className="text-cyan-400 hover:text-cyan-300 text-xs flex items-center gap-1"
                    onClick={downloadReport}
                  >
                    <Download size={13} /> ส่งออกรายงานงาน (.json)
                  </button>
                </div>

                <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 text-xs text-zinc-400">
                  ยอดรวมจากโทเค็นที่ใช้งานจริง: <strong className="text-cyan-300 font-mono">${knownCost.toFixed(4)}</strong>{' '}
                  (คำนวณตามเรต Gemini 3.8 Flash-Lite Batch/Real-time)
                </div>

                {!sameSettings && (
                  <p className="text-amber-300 text-xs bg-amber-950/30 p-3 rounded-xl border border-amber-900/50">
                    ⚠️ การตั้งค่าบทพูดหรือผู้พูดด้านบนมีการเปลี่ยนแปลง แต่ไฟล์เสียงด้านล่างยังเป็นของงานเดิม หากกดสร้างใหม่จะเริ่มบันทึกทับงานเดิม
                  </p>
                )}

                {/* Master Audio Player */}
                {audio ? (
                  <div className="rounded-2xl border border-emerald-700/60 bg-gradient-to-b from-emerald-950/30 to-zinc-950 p-5 shadow-xl space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="text-emerald-400" size={18} />
                      <p className="font-semibold text-emerald-300 text-sm">
                        รวมเสียงสมบูรณ์ครบทุกช่วงแล้ว · สามารถฟังต่อเนื่องและดาวน์โหลด WAV ได้
                      </p>
                    </div>
                    <AudioPlayer audioBlob={audio} />
                  </div>
                ) : (
                  <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs text-zinc-400">
                    เมื่อบันทึกครบทั้ง {session.chunks.length} ช่วง ระบบจะรวมไฟล์เสียงเข้าด้วยกันอัตโนมัติ ระหว่างนี้สามารถเปิดฟังและซ่อมเสียงแยกรายช่วงได้ด้านล่าง
                  </p>
                )}

                {/* Chunks List */}
                <div className="space-y-2 pt-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    รายการช่วงเสียงทั้งหมด (Chunk Inspection & Repair)
                  </p>
                  {session.chunks.map((chunk, index) => (
                    <ChunkPreview
                      key={`${session.id}:${index}`}
                      chunk={chunk}
                      index={index}
                      start={starts[index]}
                      disabled={locked}
                      repair={() => repair(index)}
                      shortRepair={() =>
                        run(async () => {
                          await repairWithShortRequests(structuredClone(session), index, save, setStatus, {
                            shouldStop: () => stop.current,
                          });
                        })
                      }
                      restore={() =>
                        run(async () => {
                          const next = structuredClone(session);
                          restorePreviousTake(next, index);
                          await save(next);
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
