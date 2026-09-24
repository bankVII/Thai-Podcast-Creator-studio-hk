import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, BrainCircuit, Key, RefreshCw, Download, LoaderCircle } from 'lucide-react';
import { TtsSettings, PodcastSession, AudioChunk } from './types';
import { DEFAULT_MULTI_SPEAKER, DEFAULT_SINGLE_SPEAKER } from './constants';
import { VoiceSelector } from './components/VoiceSelector';
import { AudioPlayer } from './components/AudioPlayer';
import { assembleSession, batchActive, checkBatchConnection, collectBatch, createSession, errorMessage, generateStandard, repairWithShortRequests, restorePreviousTake, submitBatch } from './services/gemini';
import { sessionStore } from './services/storage';
import { splitScript } from './utils/script';
import { createWavBlob } from './utils/audio';

const defaults: TtsSettings = {
  mode: 'multi', speakers: DEFAULT_MULTI_SPEAKER,
  model: 'gemini-2.5-flash-preview-tts', chunkSize: 3000,
  styleInstructions: 'Natural, conversational tone.',
  script: 'A: เคยสังเกตไหมครับว่า ยิ่งเราพยายามอ่านหนังสือธรรมะให้เยอะขึ้นเท่าไหร่ ยิ่งเราฟังพอดแคสต์พัฒนาจิตวิญญาณมากแค่ไหน ความทุกข์จริงๆ ในใจเรากลับไม่ได้ลดลงเลย\nB: เปิดรายการมาก็แทงใจดำเลยนะคะเนี่ย มิ้นนี่แหละตัวดีเลยค่ะ หนังสือธรรมะกองเต็มหัวเตียง ซื้อมาดองไว้เพียบ แต่พอเจอเรื่องกระทบใจจริงๆ ก็ยังวีนแตกเหมือนเดิม',
};
const field = 'w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-sm';
const button = 'rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed';

function WorkingIndicator({ message, completed, total, canPause, onPause }: { message: string; completed: number; total: number; canPause: boolean; onPause: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const progress = total ? Math.min(100, completed / total * 100) : 0;
  return <aside aria-label="สถานะการทำงาน" className="fixed bottom-4 left-4 right-4 sm:left-auto sm:w-[420px] z-50 rounded-2xl border border-cyan-500/40 bg-zinc-950/95 p-5 shadow-2xl shadow-black/60 backdrop-blur">
    <div className="flex items-center gap-3">
      <div aria-hidden="true" className="grid place-items-center rounded-xl bg-cyan-500/10 w-12 h-12 shrink-0"><LoaderCircle size={30} className="animate-spin motion-reduce:animate-none text-cyan-300" /></div>
      <div className="min-w-0 flex-1"><p className="font-semibold text-cyan-200">กำลังทำงาน</p><p role="status" aria-live="polite" className="text-sm mt-1 break-words">{message || 'กำลังบันทึก…'}</p></div>
      <div aria-hidden="true" className="flex h-8 items-center gap-1">{[0, 1, 2, 3, 4].map(i => <span key={i} className="podcast-working-bar bg-cyan-400 rounded-full w-1" style={{ height: `${12 + (i % 3) * 6}px`, animationDelay: `${i * 120}ms` }} />)}</div>
    </div>
    <div className="mt-4 flex justify-between gap-3 text-xs text-zinc-400"><span>เวลารอบนี้ {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>{total > 0 && <span>บันทึกแล้ว {completed}/{total} ส่วน</span>}</div>
    {total > 0 && <><div role="progressbar" aria-label="ส่วนที่บันทึกสำเร็จ" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-cyan-400 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${progress}%` }} /></div><p className="text-xs text-zinc-500 mt-2">แถบจะเพิ่มเมื่อบันทึกแต่ละส่วนสำเร็จ ระหว่างรอเสียงจะยังไม่เพิ่ม</p></>}
    {canPause && <button className="mt-3 w-full rounded-lg border border-zinc-700 py-2 text-sm hover:bg-zinc-800" onClick={onPause}>พักหลังจบช่วงนี้</button>}
  </aside>;
}

function ChunkPreview({ chunk, index, disabled, repair, shortRepair, restore, start }: { chunk: AudioChunk; index: number; disabled: boolean; repair: () => void; shortRepair: () => void; restore: () => void; start?: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!chunk.pcm) { setUrl(''); return; }
    const next = URL.createObjectURL(createWavBlob(chunk.pcm));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [chunk.pcm]);
  return <details className="bg-zinc-900/60 rounded-xl p-4 border border-zinc-800">
    <summary className="cursor-pointer text-sm">ช่วง {index + 1} · {chunk.pcm ? `${chunk.seconds?.toFixed(1)} วินาที` : 'ยังไม่มีเสียง'}{start !== undefined ? ` · เริ่ม ${Math.floor(start / 60)}:${Math.floor(start % 60).toString().padStart(2, '0')}` : ''}{chunk.error ? ' · มีข้อผิดพลาด' : ''}</summary>
    <p className="whitespace-pre-wrap text-sm text-zinc-400 my-3">{chunk.text}</p>
    {url && <><audio controls src={url} className="w-full my-3" /><a className="text-cyan-400 text-sm mr-4" href={url} download={`part-${index + 1}.wav`}>ดาวน์โหลดช่วงนี้</a></>}
    <button disabled={disabled || !!chunk.shortRepair} onClick={repair} className={`${button} bg-zinc-800 mt-2`}>สร้างใหม่เฉพาะช่วง {index + 1} (ราคาปกติ)</button>
    {chunk.pcm && (chunk.text.length > 1000 || chunk.shortRepair) && <div className="mt-3 space-y-2">
      <button disabled={disabled} onClick={shortRepair} className={`${button} bg-cyan-900`}>{chunk.shortRepair ? 'ทำการซ่อมช่วงสั้นต่อ' : 'ทดลองซ่อมด้วยช่วงสั้น 1,000 ตัวอักษร'} (คิดค่าบริการ)</button>
      <p className="text-xs text-zinc-400">สร้างใหม่เฉพาะช่วงนี้ด้วยคำขอสั้นหลายครั้ง ใช้เสียงและโมเดลเดิม เก็บเสียงเดิมไว้จนซ่อมครบและสลับคืนได้ ยังไม่รับประกันว่าเสียงเพี้ยนจะหาย</p>
      {chunk.shortRepair && <p className="text-xs text-cyan-300">ซ่อมแล้ว {chunk.shortRepair.chunks.filter(c => c.pcm).length}/{chunk.shortRepair.chunks.length} ส่วน เสียงที่ฟังอยู่ยังเป็นเสียงก่อนซ่อม</p>}
    </div>}
    {chunk.previousTake && <button disabled={disabled || !!chunk.shortRepair} onClick={restore} className={`${button} text-cyan-400`}>สลับกลับเสียงก่อนซ่อม (ฟรี)</button>}
    {chunk.error && <p className="text-red-400 text-sm mt-2">{chunk.error}</p>}
    {chunk.warnings?.map(w => <p key={w} className="text-amber-400 text-sm mt-2">{w}</p>)}
  </details>;
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
  const [minutes, setMinutes] = useState('');
  const stop = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    let mounted = true;
    sessionStore('previous').then(saved => { if (mounted) setHasPrevious(!!saved); }).catch(() => {});
    sessionStore('read').then(saved => {
      if (mounted && saved?.version === 1) { setSession(saved); setSettings(saved.settings); }
    }).catch(e => { if (mounted) setError(errorMessage(e)); }).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);
  const plan = useMemo(() => { try { return { chunks: splitScript(settings), error: '' }; } catch (e) { return { chunks: [], error: errorMessage(e) }; } }, [settings]);
  const audio = useMemo(() => session ? assembleSession(session) : null, [session]);
  const activeBatch = batchActive(session);
  const locked = busy || activeBatch || !ready;
  const sameSettings = session && JSON.stringify(settings) === JSON.stringify(session.settings);
  const completed = session?.chunks.filter(c => c.pcm).length ?? 0;
  const allDone = !!session && completed === session.chunks.length;
  const repairing = session?.chunks.find(c => c.shortRepair)?.shortRepair;
  const workingTotal = /สร้าง|ซ่อม|จะหยุด/.test(status) ? (repairing?.chunks.length ?? session?.chunks.length ?? 0) : 0;
  const workingCompleted = repairing ? repairing.chunks.filter(c => c.pcm).length : completed;
  useEffect(() => { setBatchReady(false); setBatchConnection(''); }, [settings.model]);
  const change = (patch: Partial<TtsSettings>) => setSettings(s => ({ ...s, ...patch }));
  const save = async (next: PodcastSession) => {
    next.revision = (next.revision ?? 0) + 1;
    // Keep downloaded audio available even if persistence fails.
    setSession(structuredClone(next));
    await sessionStore('write', next);
  };
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); stop.current = false;
    const execute = async () => {
      try { await operation(); } catch (e) { setError(errorMessage(e)); }
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request('podcast-generation', { ifAvailable: true }, async lock => {
          if (!lock) { setError('มีหน้าต่างอื่นกำลังทำงาน กรุณาใช้ทีละหน้าต่าง'); return; }
          // A second tab must not overwrite a newer episode or submit stale work.
          const latest = await sessionStore('read');
          if (latest?.id !== session?.id || latest?.revision !== session?.revision) {
            setError('มีงานเปลี่ยนจากอีกหน้าต่าง กรุณารีโหลดเพื่อรับงานล่าสุด'); return;
          }
          await execute();
        });
      } else await execute();
    } catch (e) { setError(errorMessage(e)); }
    finally { running.current = false; setBusy(false); setStatus(''); }
  };
  const generate = (kind: 'standard' | 'batch') => run(async () => {
    if (kind === 'batch' && !batchReady) throw new Error('กรุณาตรวจการเชื่อมต่อ Batch ก่อนส่งคิว');
    if (activeBatch) throw new Error('กรุณาตรวจงาน Batch ที่ค้างอยู่ก่อน');
    const next = sameSettings ? structuredClone(session!) : createSession(settings);
    await save(next);
    if (kind === 'batch') {
      setStatus('กำลังตรวจและส่งคิว Batch…');
      try { await submitBatch(next, save); } catch (e) { setBatchReady(false); setBatchConnection(`ส่ง Batch ไม่สำเร็จ: ${errorMessage(e)} — ใช้ปุ่มสร้างทันทีได้`); throw e; }
    } else await generateStandard(next, save, setStatus, { shouldStop: () => stop.current });
  });
  const testBatchConnection = () => run(async () => {
    setStatus('กำลังตรวจโมเดลรองรับ Batch…');
    setBatchReady(false); setBatchConnection('กำลังตรวจการเชื่อมต่อ Batch…');
    try {
      await checkBatchConnection(settings.model);
      setBatchReady(true); setBatchConnection('Google ระบุว่าโมเดลนี้รองรับ Batch และอ่านรายการงานได้ — ยังไม่ได้ทดสอบส่งงานจริง');
    } catch (e) {
      setBatchConnection(`Batch ยังไม่พร้อม: ${errorMessage(e)} — ไม่ได้ส่งงานสร้างเสียง การสร้างปกติยังใช้ได้`);
    }
  });
  const testConnection = () => run(async () => {
    setTestAudio(null); setConnection('');
    const script = settings.speakers.map((speaker, index) => `${speaker.name}: ${index === 0 ? 'สวัสดีครับ นี่คือเสียงทดสอบการเชื่อมต่อ' : 'สวัสดีค่ะ ทดสอบเสียงภาษาไทยค่ะ'}`).join('\n');
    const sample = createSession({ ...settings, script });
    await generateStandard(sample, async () => {}, setStatus);
    setTestAudio(assembleSession(sample));
    setConnection('สร้างเสียงทดสอบสำเร็จผ่านคีย์ AI Studio แล้ว บทพูดและงานเดิมยังอยู่');
  });
  const resetJob = (restore = false) => run(async () => {
    const next = restore ? await sessionStore('previous') : createSession(settings);
    if (!next) throw new Error('ไม่มีงานก่อนรีเซ็ต');
    next.revision = (next.revision ?? 0) + 1;
    await sessionStore('reset', next);
    setSession(structuredClone(next)); setSettings(next.settings); setHasPrevious(!!session);
    setConnection(restore ? 'เรียกงานก่อนรีเซ็ตคืนแล้ว' : 'เริ่มงานใหม่แล้ว บทพูดยังอยู่ กดสร้างเมื่อพร้อม');
  });
  const repair = (index: number) => run(async () => {
    if (session) await generateStandard(structuredClone(session), save, setStatus, { replaceIndex: index });
  });
  const downloadReport = () => {
    if (!session) return;
    const report = { ...session, chunks: session.chunks.map(({ pcm, previousTake, shortRepair, ...c }) => ({ ...c, bytes: pcm?.length, previousTakeBytes: previousTake?.pcm.length, shortRepair: shortRepair?.chunks.map(({ pcm, ...part }) => ({ ...part, bytes: pcm?.length })) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `podcast-report-${session.id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const multiplier = settings.model.includes('3.1') ? 2 : 1;
  const starts: (number | undefined)[] = [];
  let elapsed: number | undefined = 0;
  session?.chunks.forEach(c => { starts.push(elapsed); elapsed = elapsed !== undefined && c.seconds !== undefined ? elapsed + c.seconds + 0.1 : undefined; });
  const knownCost = session?.charges.reduce((sum, c) => sum + ((c.inputTokens ?? 0) * 0.5 + (c.audioTokens ?? 0) * 10) / 1e6 * (session.settings.model.includes('3.1') ? 2 : 1) * (c.mode === 'batch' ? 0.5 : 1), 0) ?? 0;
  return <main className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-8 pb-64 md:pb-64">
    <div className="max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-3"><BrainCircuit className="text-cyan-400" size={32} /><div><h1 className="text-xl font-bold">Gemini Thai Podcast</h1><p className="text-sm text-zinc-400">เสียงเดิม · สร้างต่อได้ · ซ่อมเฉพาะช่วง</p></div></div>
        {window.aistudio && <button disabled={busy} className={`${button} bg-zinc-800`} onClick={() => { setBatchReady(false); setBatchConnection(''); void window.aistudio!.openSelectKey().then(() => { setError(''); setConnection('เลือกคีย์ผ่าน AI Studio แล้ว กดทดสอบเสียงสั้นเพื่อตรวจการใช้งานจริง'); }).catch(e => setError(errorMessage(e))); }}><Key size={14} className="inline mr-2" />เลือก API key</button>}
      </header>
      <div className="grid lg:grid-cols-12 gap-8">
        <fieldset disabled={locked} className="lg:col-span-4 space-y-5 min-w-0 disabled:opacity-60">
          <label className="block text-sm">โหมด<select className={`${field} mt-2`} value={settings.mode} onChange={e => { const mode = e.target.value as 'single' | 'multi'; change({ mode, speakers: mode === 'multi' ? DEFAULT_MULTI_SPEAKER : DEFAULT_SINGLE_SPEAKER }); }}><option value="multi">พอดแคสต์ 2 คน</option><option value="single">เสียงเดี่ยว</option></select></label>
          {settings.speakers.map((speaker, i) => <VoiceSelector key={speaker.id} speaker={speaker} index={i} onChange={updated => change({ speakers: settings.speakers.map((s, j) => j === i ? updated : s) })} />)}
          <label className="block text-sm">โมเดล<select className={`${field} mt-2`} value={settings.model} onChange={e => change({ model: e.target.value as TtsSettings['model'] })}><option value="gemini-2.5-flash-preview-tts">2.5 Flash TTS — รุ่นเดิม ประหยัดที่สุด</option><option value="gemini-3.1-flash-tts-preview">3.1 Flash TTS — ทดลองคุณภาพ ราคา 2 เท่า</option></select></label>
          <label className="block text-sm">ความยาวต่อช่วง<select className={`${field} mt-2`} value={settings.chunkSize} onChange={e => change({ chunkSize: Number(e.target.value) })}>{[1000, 1500, 2000, 3000].map(n => <option key={n} value={n}>{n.toLocaleString()} ตัวอักษร{n === 1500 ? ' — ทดลองช่วงสั้น' : n === 3000 ? ' — ค่าเดิม' : ''}</option>)}</select></label>
          <p className="text-xs text-zinc-400">ช่วงสั้นช่วยให้ฟังตรวจและซ่อมง่ายขึ้น แต่อาจเปลี่ยนจังหวะระหว่างช่วง ยังต้องฟังเทียบคุณภาพ</p>
          <label className="block text-sm">โทนเสียง<textarea className={`${field} mt-2 h-28`} value={settings.styleInstructions} onChange={e => change({ styleInstructions: e.target.value })} /></label>
        </fieldset>
        <section className="lg:col-span-8 min-w-0 space-y-5">
          <label className="block text-sm">บทพูด<textarea disabled={locked} className={`${field} mt-2 h-80 text-base leading-relaxed`} value={settings.script} onChange={e => change({ script: e.target.value })} /></label>
          <p className="text-sm text-zinc-400">{plan.error || `${settings.script.length.toLocaleString()} ตัวอักษร · แบ่งเป็น ${plan.chunks.length} ช่วง`}</p>
          <div className="bg-cyan-950/30 border border-cyan-900 rounded-xl p-4 text-sm space-y-2">
            <label>ความยาวเสียงที่คุณคาดไว้ <input type="number" min="1" max="600" className="w-20 mx-2 bg-zinc-900 border border-zinc-700 rounded p-1" value={minutes} placeholder="ระบุนาที" onChange={e => setMinutes(e.target.value)} /> นาที</label>
            <p>{Number(minutes) > 0 ? `ค่าเสียงตามเวลาที่กรอก: ปกติ $${(Number(minutes) * .015 * multiplier).toFixed(3)} · Batch $${(Number(minutes) * .0075 * multiplier).toFixed(3)}` : `ค่าเสียงต่อนาที: ปกติ $${(.015 * multiplier).toFixed(3)} · Batch $${(.0075 * multiplier).toFixed(4)}`}</p>
            <p className="text-xs text-zinc-400">เวลาในช่องนี้ไม่ได้คำนวณจากบทพูด จำนวนช่วงไม่ใช่ตัวคูณราคาเสียง</p>
            <p className="text-xs text-zinc-400">USD เฉพาะเสียง ไม่รวมข้อความ ภาษี และการสร้างซ้ำ · ราคา Batch ใช้ได้เมื่อโมเดลและ API รองรับเท่านั้น เป้าหมายรอผลภายใน 24 ชั่วโมง</p>
          </div>
          <div className="text-sm space-y-2"><button disabled={busy || !ready || !!plan.error} className="text-cyan-400 underline disabled:opacity-40" onClick={testConnection}>ทดสอบเสียงสั้น (คิดค่าบริการตามใช้จริง)</button><p className="text-xs text-zinc-400">ทดสอบหนึ่งคำขอด้วยเสียงที่เลือก เก็บบทพูดและงานเดิมไว้</p>{connection && <p>{connection}</p>}{testAudio && <AudioPlayer audioBlob={testAudio} />}</div>
          <div className="rounded-xl border border-indigo-900 bg-indigo-950/20 p-4 space-y-2">
            <button disabled={busy || !ready} className="text-indigo-300 underline text-sm disabled:opacity-40" onClick={testBatchConnection}>ตรวจโมเดลรองรับ Batch (ไม่สร้างเสียง)</button>
            <p className="text-xs text-zinc-400">{batchConnection || 'ตรวจว่าโมเดลที่เลือกมี Batch ก่อนเปิดปุ่มส่งคิว ใช้คีย์เดิมใน AI Studio'}</p>
          </div>
          {error && <p role="alert" className="bg-red-950/40 border border-red-900 p-4 rounded-xl text-red-300 whitespace-pre-wrap break-words">{error}</p>}
          {session && <div className="rounded-xl border border-zinc-700 p-4 space-y-2">
            <button disabled={busy || !ready} className={`${button} bg-zinc-700`} onClick={() => resetJob()}>เริ่มงานใหม่ / รีเซ็ตสถานะ (เก็บบทพูด)</button>
            {hasPrevious && <button disabled={busy || !ready} className={`${button} text-cyan-400`} onClick={() => resetJob(true)}>เรียกงานก่อนรีเซ็ตคืน</button>}
            <p className="text-xs text-zinc-400">รีเซ็ตเฉพาะสถานะในแอป สำรองงานเดิมไว้ให้ย้อนกลับ ไม่ส่งสร้างเสียงอัตโนมัติ</p>
            {activeBatch && <p className="text-xs text-amber-300">รีเซ็ตไม่ยกเลิกงานที่ Google หากงานเดิมส่งสำเร็จ การกดสร้างบทเดิมอีกครั้งอาจคิดเงินซ้ำ</p>}
          </div>}
          {activeBatch ? <div className="p-4 bg-indigo-950/40 rounded-xl space-y-3">
            <p>งานคิว: {session!.batch!.name ? session!.batch!.state : 'ยังยืนยันการส่งไม่สำเร็จ'}</p><p className="text-xs break-all text-zinc-400">{session!.batch!.name || session!.batch!.displayName}</p>
            {session!.batch!.lastError && <p className="text-red-300 text-sm">{session!.batch!.lastError}</p>}
            {!session!.batch!.name && <p className="text-amber-300 text-sm">ยังไม่มีเลขงานจาก Google กรุณาค้นหางานก่อนส่งซ้ำ บทพูดยังเก็บอยู่</p>}
            <p className="text-sm text-zinc-400">ปิดหน้านี้ได้ แล้วกลับมาตรวจผลในเบราว์เซอร์และที่อยู่เว็บเดิม ดาวน์โหลดเสียงเมื่อผลพร้อม</p>
            <button disabled={busy} className={`${button} bg-indigo-600`} onClick={() => run(async () => { setStatus('กำลังตรวจผล…'); await collectBatch(structuredClone(session!), save); })}><RefreshCw size={14} className="inline mr-2" />{session!.batch!.name ? 'ตรวจสถานะ / รับเสียง' : 'ค้นหางานที่ส่งไปแล้ว'}</button>
          </div> : <div className="grid sm:grid-cols-2 gap-3">
            <button disabled={locked || !!plan.error || (!!sameSettings && allDone)} className={`${button} bg-cyan-600`} onClick={() => generate('standard')}><Wand2 size={16} className="inline mr-2" />สร้างทันที / ทำช่วงที่เหลือต่อ</button>
            <button disabled={locked || !batchReady || !!plan.error || (!!sameSettings && allDone)} className={`${button} bg-indigo-600`} onClick={() => generate('batch')}>ส่งคิว Batch (เมื่อรองรับ)</button>
          </div>}
          {busy && <WorkingIndicator message={status} completed={workingCompleted} total={workingTotal} canPause={!activeBatch && /สร้าง|ซ่อม|จะหยุด/.test(status)} onPause={() => { stop.current = true; setStatus('จะหยุดหลังบันทึกช่วงปัจจุบัน'); }} />}
          {session && <div className="space-y-4 pt-4 border-t border-zinc-800">
            <div className="flex justify-between gap-3 text-sm"><p>เก็บเสียงแล้ว {completed}/{session.chunks.length} ช่วง</p><button className="text-cyan-400" onClick={downloadReport}><Download size={14} className="inline mr-1" />รายงานงาน</button></div>
            <p className="text-xs text-zinc-400">ยอดจากโทเค็นที่ได้รับกลับมา ≈ ${knownCost.toFixed(4)} · อาจไม่ครบ ไม่ใช่ยอดใบแจ้งหนี้ รวมการซ่อมที่มีข้อมูลโทเค็นแล้ว</p>
            {!sameSettings && <p className="text-amber-300 text-sm">ตั้งค่าด้านบนเปลี่ยนแล้ว เสียงด้านล่างยังเป็นงานเดิม ปุ่มสร้างด้านบนจะเริ่มงานใหม่และแทนที่งานที่บันทึกไว้ — ดาวน์โหลดเสียงเดิมก่อน</p>}
            {audio ? <div className="rounded-xl border border-emerald-800 bg-emerald-950/20 p-4"><p className="font-medium text-emerald-300">รวมเสียงครบทั้งตอนแล้ว · ฟังต่อเนื่องและดาวน์โหลด WAV ได้</p><p className="text-xs text-zinc-400 mt-1">เมื่อซ่อมช่วงใดสำเร็จ ไฟล์รวมจะเปลี่ยนมาใช้เสียงใหม่ของช่วงนั้นอัตโนมัติ</p><AudioPlayer audioBlob={audio} /></div> : <p className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm text-zinc-300">เมื่อครบ {session.chunks.length} ช่วง แอปจะรวมเสียงเป็นไฟล์เดียวให้ฟังยาว ๆ และดาวน์โหลดได้ ระหว่างนี้เปิดฟังแต่ละช่วงด้านล่างได้</p>}
            {!busy && status && <p className="text-sm text-zinc-400">{status}</p>}
            <p className="text-xs text-zinc-400">เปิดแต่ละช่วงเพื่อฟังและซ่อม ปุ่มซ่อมใช้บท/เสียงของงานที่บันทึกไว้และคิดราคาปกติ ตัวตรวจสัญญาณไม่สามารถยืนยันว่าไม่มีเสียงเพี้ยน</p>
            {session.chunks.map((chunk, index) => <ChunkPreview key={`${session.id}:${index}`} chunk={chunk} index={index} start={starts[index]} disabled={locked} repair={() => repair(index)} shortRepair={() => run(async () => { await repairWithShortRequests(structuredClone(session), index, save, setStatus, { shouldStop: () => stop.current }); })} restore={() => run(async () => { const next = structuredClone(session); restorePreviousTake(next, index); await save(next); })} />)}
          </div>}
          <p className="text-xs text-zinc-500">บันทึกอัตโนมัติเฉพาะงานล่าสุดในเบราว์เซอร์นี้ เริ่มบันทึกเมื่อกดสร้าง · ล้างข้อมูลเว็บไซต์จะทำให้งานหาย · ฟังตรวจที่ความเร็ว 1×</p>
        </section>
      </div>
    </div>
  </main>;
}
