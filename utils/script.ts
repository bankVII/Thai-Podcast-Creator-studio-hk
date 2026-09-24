import { TtsSettings } from '../types';

// Sentence/word segmentation understands Thai. Grapheme fallback never splits
// a vowel/mark or surrogate pair; the speaker prefix counts toward the budget.
function splitText(text: string, budget: number): string[] {
  const result: string[] = [];
  let current = '';
  const add = (part: string) => {
    if (current.length + part.length > budget && current) {
      result.push(current.trim());
      current = '';
    }
    current += part;
  };
  const words = new Intl.Segmenter('th', { granularity: 'word' });
  const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
  for (const { segment: sentence } of new Intl.Segmenter('th', { granularity: 'sentence' }).segment(text)) {
    if (sentence.length <= budget) { add(sentence); continue; }
    for (const { segment } of words.segment(sentence)) {
      if (segment.length <= budget) add(segment);
      else for (const { segment: grapheme } of graphemes.segment(segment)) {
        if (grapheme.length > budget) throw new Error('ข้อความมีอักขระต่อเนื่องยาวผิดปกติ');
        add(grapheme);
      }
    }
  }
  if (current.trim()) result.push(current.trim());
  return result.filter(Boolean);
}

export function splitScript(settings: TtsSettings): string[] {
  const { mode, chunkSize, speakers } = settings;
  if (![1000, 1500, 2000, 3000].includes(chunkSize)) throw new Error('ขนาดช่วงไม่ถูกต้อง');
  if (!settings.script.trim()) throw new Error('กรุณาใส่บทพูด');
  if (speakers.length !== (mode === 'multi' ? 2 : 1)) throw new Error('จำนวนผู้พูดไม่ตรงกับโหมด');
  const names = speakers.map(s => s.name.trim());
  if (names.some(n => !n || n.length > 60 || /[:\r\n]/.test(n)) || new Set(names.map(n => n.toLowerCase())).size !== names.length) {
    throw new Error('ชื่อผู้พูดต้องไม่ว่าง ไม่ซ้ำ และไม่มีเครื่องหมาย : หรือขึ้นบรรทัดใหม่');
  }
  if (settings.styleInstructions.length > 2000) throw new Error('คำกำกับโทนเสียงยาวเกิน 2,000 ตัวอักษร');
  const turns: { speaker: string; text: string }[] = [];
  for (const line of settings.script.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (mode === 'single') { turns.push({ speaker: '', text: line }); continue; }
    const colon = line.indexOf(':');
    const speaker = colon >= 0 ? names.find(n => n.toLowerCase() === line.slice(0, colon).trim().toLowerCase()) : undefined;
    if (speaker) turns.push({ speaker, text: line.slice(colon + 1).trim() });
    else {
      if (colon >= 0 && /^[\p{L}\p{N}_ .-]{1,60}$/u.test(line.slice(0, colon))) {
        throw new Error(`ไม่รู้จักผู้พูด "${line.slice(0, colon)}" — ใช้ ${names.join(' / ')}`);
      }
      if (!turns.length) throw new Error(`บทพอดแคสต์ต้องเริ่มด้วย ${names[0]}: หรือ ${names[1]}:`);
      turns[turns.length - 1].text += '\n' + line;
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const turn of turns) {
    const prefix = mode === 'multi' ? `${turn.speaker}: ` : '';
    for (const part of splitText(turn.text, chunkSize - prefix.length)) {
      const line = prefix + part;
      if (current && current.length + line.length + 1 > chunkSize) { chunks.push(current); current = ''; }
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  if (!chunks.length) throw new Error('ไม่มีข้อความพูดหลังชื่อผู้พูด');
  return chunks;
}
