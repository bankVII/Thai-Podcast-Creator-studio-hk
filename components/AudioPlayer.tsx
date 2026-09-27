
import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, Download, RefreshCw } from 'lucide-react';

interface AudioPlayerProps {
  audioBlob: Blob | null;
  onReset?: () => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioBlob, onReset }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState('0:00');
  const [duration, setDuration] = useState('0:00');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);

  useEffect(() => {
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime('0:00');
    setDuration('0:00');
    if (audioBlob) {
      const url = URL.createObjectURL(audioBlob);
      setBlobUrl(url);
      setPlaybackRate(1.0);
      return () => URL.revokeObjectURL(url);
    } else {
      setBlobUrl(null);
    }
  }, [audioBlob]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, blobUrl]);

  const togglePlay = async () => {
    if (!audioRef.current || !blobUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      try { await audioRef.current.play(); } catch { setIsPlaying(false); }
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const current = audioRef.current.currentTime;
      const total = audioRef.current.duration;
      setProgress(Number.isFinite(total) && total > 0 ? (current / total) * 100 : 0);
      setCurrentTime(formatTime(current));
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(formatTime(audioRef.current.duration));
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setProgress(0);
  };

  const handleSpeedToggle = () => {
    const speeds = [1.0, 1.25, 1.5, 1.75, 2.0];
    const currentIndex = speeds.indexOf(playbackRate);
    const nextIndex = (currentIndex + 1) % speeds.length;
    setPlaybackRate(speeds[nextIndex]);
  };

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `gemini-podcast-${new Date().toISOString().slice(0, 10)}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!audioBlob) return null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mt-6 shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      {blobUrl ? (
        <audio
          ref={audioRef}
          src={blobUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
      ) : null}
      
      <div className="flex flex-col gap-4">
        {/* Progress Bar */}
        <div className="relative w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden cursor-pointer group" onClick={(e) => {
             if (!audioRef.current || !Number.isFinite(audioRef.current.duration)) return;
             const rect = e.currentTarget.getBoundingClientRect();
             const x = e.clientX - rect.left;
             const clickedValue = (x / rect.width);
             audioRef.current.currentTime = clickedValue * audioRef.current.duration;
        }}>
          <div 
            className="absolute top-0 left-0 h-full bg-indigo-500 transition-all duration-100 ease-linear group-hover:bg-indigo-400"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-zinc-400 font-mono w-20">
            {currentTime} / {duration}
          </div>

          <div className="flex items-center gap-4">
            {onReset && <button
              onClick={onReset}
              className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Generate New"
            >
               <RefreshCw size={18} />
            </button>}

            <button
              onClick={togglePlay}
              className="w-12 h-12 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 text-white rounded-full shadow-lg shadow-indigo-900/20 transition-all hover:scale-105"
            >
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
            </button>

            {/* Speed Toggle */}
            <button 
              onClick={handleSpeedToggle}
              className="p-2 text-zinc-500 hover:text-indigo-400 transition-colors flex items-center justify-center font-mono text-xs font-bold w-12 h-10 rounded hover:bg-zinc-800/50"
              title="Playback Speed (Click to toggle)"
            >
              {playbackRate}x
            </button>

            <button
              onClick={handleDownload}
              className="p-2 text-zinc-500 hover:text-indigo-400 transition-colors"
              title="Download WAV"
            >
              <Download size={20} />
            </button>
          </div>
          
          <div className="w-20"></div> {/* Spacer for alignment */}
        </div>
      </div>
    </div>
  );
};
