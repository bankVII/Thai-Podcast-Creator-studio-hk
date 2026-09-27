import { TtsSettings } from '../types';

export const KNOWN_TAGS = new Set([
  '[laughter]', '[giggle]', '[snicker]', '[sigh]', '[gasp]',
  '[whisper]', '[clears throat]', '[cough]', '[yawn]',
  '[hesitation]', '[hum]', '[excited]',
  '<breath>', '<laugh>', '<gasp>', '|mhm|', '|yeah|',
]);

export interface TagAnalysis {
  tags: { tag: string; count: number; known: boolean }[];
  totalTags: number;
  warnings: string[];
}

export function analyzeInlineTags(text: string): TagAnalysis {
  const tagRegex = /\[[a-zA-Z0-9_\s-]+\]|<[a-zA-Z0-9_\s-]+>|\|[a-zA-Z0-9_\s-]+\|/g;
  const counts = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const raw = match[0].toLowerCase();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }

  const tags = Array.from(counts.entries()).map(([tag, count]) => ({
    tag,
    count,
    known: KNOWN_TAGS.has(tag),
  }));

  const warnings: string[] = [];

  // Check for potentially unclosed brackets
  const openBracketWithoutClose = /\[(?![^\]]*\])[^\[\n]{1,40}(?=\n|$)/g;
  let unclosedMatch: RegExpExecArray | null;
  while ((unclosedMatch = openBracketWithoutClose.exec(text)) !== null) {
    warnings.push(`อาจมีแท็กที่ไม่ได้ปิดวงเล็บ: "${unclosedMatch[0]}"`);
  }

  // Check for common typo variations like [laugh] instead of [laughter]
  if (text.includes('[laugh]')) warnings.push('พบ "[laugh]" — Gemini 3.8 แนะนำใช้ "[laughter]" สำหรับเสียงหัวเราะเต็มเสียง');
  if (text.includes('[cry]')) warnings.push('พบ "[cry]" — Gemini 3.8 รองรับแท็กอย่างเป็นทางการ เช่น [laughter], [sigh], [whisper], [gasp]');

  return {
    tags,
    totalTags: tags.reduce((acc, t) => acc + t.count, 0),
    warnings,
  };
}

// Tokenize text into words/particles and atomic inline tags so tags are never severed
function tokenizeWithTags(text: string): string[] {
  const tokens: string[] = [];
  // Match inline tags [tag], <tag>, |tag| as atomic tokens
  const tagPattern = /(\[[a-zA-Z0-9_\s-]+\]|<[a-zA-Z0-9_\s-]+>|\|[a-zA-Z0-9_\s-]+\|)/g;
  const parts = text.split(tagPattern);
  const words = new Intl.Segmenter('th', { granularity: 'word' });

  for (const part of parts) {
    if (!part) continue;
    if (tagPattern.test(part)) {
      tokens.push(part);
    } else {
      for (const { segment } of words.segment(part)) {
        if (segment) tokens.push(segment);
      }
    }
  }
  return tokens;
}

// Sentence/word segmentation understands Thai and preserves atomic tags.
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

  const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
  for (const { segment: sentence } of new Intl.Segmenter('th', { granularity: 'sentence' }).segment(text)) {
    if (sentence.length <= budget) { add(sentence); continue; }
    
    // When sentence is longer than budget, tokenize while preserving inline tags
    for (const token of tokenizeWithTags(sentence)) {
      if (token.length <= budget) {
        add(token);
      } else {
        // Fallback for unusually long non-tag tokens
        for (const { segment: grapheme } of graphemes.segment(token)) {
          if (grapheme.length > budget) throw new Error('ข้อความมีอักขระต่อเนื่องยาวผิดปกติ');
          add(grapheme);
        }
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
  for (const rawLine of settings.script.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (mode === 'single') {
      turns.push({ speaker: '', text: rawLine });
      continue;
    }

    // Strip markdown formatting if it wraps the speaker label (e.g. **A:** or **A**:) and list markers
    const line = rawLine.replace(/^[-*•]\s+/, '').replace(/^(\*{1,2})([^*]+?)\1/, '$2');

    // Extract speaker prefix using standard ':' or Thai fullwidth '：'
    const colonIdx = line.search(/[:：]/);
    let matchedSpeaker: string | undefined;
    let turnContent = line;

    const isSpeaker1 = (p: string) => /^(a|1|host\s*[a1]|speaker\s*[a1]|ผู้พูด\s*[a1ก]|พิธีกร\s*[a1ก]|คนที่\s*1|ก|นาย\s*ก|person\s*[a1]|user\s*[a1])$/i.test(p);
    const isSpeaker2 = (p: string) => /^(b|2|host\s*[b2]|speaker\s*[b2]|ผู้พูด\s*[b2ข]|พิธีกร\s*[b2ข]|คนที่\s*2|ข|นางสาว\s*ข|person\s*[b2]|user\s*[b2])$/i.test(p);

    if (colonIdx >= 0) {
      const prefix = line.slice(0, colonIdx).replace(/[\[\]\(\)\*]/g, '').trim();
      const content = line.slice(colonIdx + 1).trim();

      const exact = names.find(n => n.toLowerCase() === prefix.toLowerCase());
      if (exact) {
        matchedSpeaker = exact;
      } else if (isSpeaker1(prefix)) {
        matchedSpeaker = names[0];
      } else if (isSpeaker2(prefix)) {
        matchedSpeaker = names[1];
      }

      if (matchedSpeaker) {
        turnContent = content;
      }
    } else {
      // Bracketed without colon like [A] สวัสดีครับ or (A) สวัสดีครับ or [Speaker A]
      const bracketMatch = line.match(/^[\[\(]([a-zA-Z0-9_\u0E00-\u0E7F\s]+)[\]\)]\s*(.*)$/);
      if (bracketMatch) {
        const prefix = bracketMatch[1].trim();
        const content = bracketMatch[2].trim();
        const exact = names.find(n => n.toLowerCase() === prefix.toLowerCase());
        if (exact) {
          matchedSpeaker = exact;
        } else if (isSpeaker1(prefix)) {
          matchedSpeaker = names[0];
        } else if (isSpeaker2(prefix)) {
          matchedSpeaker = names[1];
        }
        if (matchedSpeaker) {
          turnContent = content;
        }
      } else {
        // Dot or dash prefix: A. สวัสดีครับ or 1. สวัสดีครับ or A - สวัสดีครับ
        const dotMatch = line.match(/^([a-zA-Z0-9_\u0E00-\u0E7F\s]{1,15})[\.\-]\s+(.+)$/);
        if (dotMatch) {
          const prefix = dotMatch[1].trim();
          const content = dotMatch[2].trim();
          const exact = names.find(n => n.toLowerCase() === prefix.toLowerCase());
          if (exact) {
            matchedSpeaker = exact;
          } else if (isSpeaker1(prefix)) {
            matchedSpeaker = names[0];
          } else if (isSpeaker2(prefix)) {
            matchedSpeaker = names[1];
          }
          if (matchedSpeaker) {
            turnContent = content;
          }
        }
      }
    }

    if (matchedSpeaker) {
      turns.push({ speaker: matchedSpeaker, text: turnContent });
    } else {
      // Continuation of previous turn or fallback to first speaker
      if (!turns.length) {
        turns.push({ speaker: names[0], text: line });
      } else {
        turns[turns.length - 1].text += '\n' + line;
      }
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
