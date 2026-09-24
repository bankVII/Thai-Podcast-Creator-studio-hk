import React from 'react';
import { SpeakerConfig, VoiceName } from '../types';
import { AVAILABLE_VOICES } from '../constants';
import { Mic2, User } from 'lucide-react';

interface VoiceSelectorProps {
  speaker: SpeakerConfig;
  onChange: (updatedSpeaker: SpeakerConfig) => void;
  index: number;
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({ speaker, onChange, index }) => {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-3 transition-colors hover:border-zinc-700">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-2 h-2 rounded-full ${speaker.color}`} />
        <h4 className="text-sm font-medium text-zinc-300">Speaker {index + 1} Settings</h4>
      </div>

      <div className="space-y-4">
        {/* Name Input */}
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1.5 uppercase tracking-wider">
            Name (in script)
          </label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={speaker.name}
              onChange={(e) => onChange({ ...speaker, name: e.target.value })}
              className="w-full bg-black/20 border border-zinc-800 rounded-lg py-2 pl-9 pr-3 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all placeholder-zinc-600"
              placeholder="e.g. Host, Guest, Narrator"
            />
          </div>
        </div>

        {/* Voice Selection */}
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1.5 uppercase tracking-wider">
            Voice Model
          </label>
          <div className="relative">
            <Mic2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <select
              value={speaker.voice}
              onChange={(e) => onChange({ ...speaker, voice: e.target.value as VoiceName })}
              className="w-full appearance-none bg-black/20 border border-zinc-800 rounded-lg py-2 pl-9 pr-8 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all cursor-pointer"
            >
              {AVAILABLE_VOICES.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.gender}, {v.style})
                </option>
              ))}
            </select>
            {/* Custom chevron */}
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-zinc-500">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
