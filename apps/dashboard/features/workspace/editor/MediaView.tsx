import { useEffect, useMemo, useState } from 'react';
import { FileAudio2, FileImage, FileText, Film, Loader2, RotateCcw } from 'lucide-react';
import type { OpenFile } from '../../../state/workspace.js';
import type { BinaryMediaKind } from './media-types.js';
import { rawProjectFileUrl } from './media-types.js';

interface MediaViewProps {
  file: OpenFile;
  kind: BinaryMediaKind;
}

const checkerboardStyle = {
  backgroundColor: 'hsl(var(--muted))',
  backgroundImage:
    'linear-gradient(45deg, hsl(var(--border)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--border)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--border)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--border)) 75%)',
  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
  backgroundSize: '20px 20px',
};

const labels: Record<BinaryMediaKind, string> = {
  image: 'Image preview',
  video: 'Video preview',
  audio: 'Audio preview',
  pdf: 'PDF preview',
};

export function MediaView({ file, kind }: MediaViewProps) {
  const source = useMemo(
    () => rawProjectFileUrl(file.projectId, file.path),
    [file.projectId, file.path],
  );
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setError(false), [source, kind]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="h-7 shrink-0 border-b bg-card/40 flex items-center px-2 gap-1 text-[10.5px] text-muted-foreground">
        <MediaIcon kind={kind} />
        <span>{labels[kind]}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {file.path.split('/').pop()}
        </span>
      </div>
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm text-center text-sm text-muted-foreground">
              <p className="text-foreground font-medium">Preview unavailable</p>
              <p className="mt-1 text-xs">
                The file could not be decoded by this browser. Its container or codec may be unsupported.
              </p>
              <button
                type="button"
                onClick={() => {
                  setError(false);
                  setReloadKey((value) => value + 1);
                }}
                className="mt-3 h-7 inline-flex items-center gap-1.5 rounded border px-2.5 text-xs hover:bg-muted text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          </div>
        ) : (
          <MediaSurface key={`${source}:${reloadKey}`} kind={kind} source={source} fileName={file.path.split('/').pop() ?? file.path} onError={() => setError(true)} />
        )}
      </div>
    </div>
  );
}

function MediaIcon({ kind }: { kind: BinaryMediaKind }) {
  const Icon = kind === 'image' ? FileImage : kind === 'video' ? Film : kind === 'audio' ? FileAudio2 : FileText;
  return <Icon className="h-3 w-3" />;
}

function MediaSurface({
  kind,
  source,
  fileName,
  onError,
}: {
  kind: BinaryMediaKind;
  source: string;
  fileName: string;
  onError: () => void;
}) {
  if (kind === 'image') {
    return (
      <div className="h-full w-full overflow-auto p-5 grid place-items-center" style={checkerboardStyle}>
        <img
          src={source}
          alt={fileName}
          draggable={false}
          onError={onError}
          className="block max-h-full max-w-full object-contain drop-shadow-md select-none"
        />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="h-full w-full p-5 grid place-items-center bg-black/90">
        <video
          src={source}
          controls
          preload="metadata"
          onError={onError}
          className="max-h-full max-w-full bg-black shadow-xl"
        >
          Your browser does not support this video format.
        </video>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="h-full w-full grid place-items-center p-6 bg-gradient-to-b from-muted/40 to-background">
        <div className="w-full max-w-lg rounded-xl border bg-card/80 shadow-sm p-6 text-center">
          <FileAudio2 className="h-12 w-12 mx-auto text-primary/70" />
          <p className="mt-3 mb-4 text-sm font-medium truncate" title={fileName}>{fileName}</p>
          <audio src={source} controls preload="metadata" onError={onError} className="w-full">
            Your browser does not support this audio format.
          </audio>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative bg-muted/20">
      <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground pointer-events-none">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
      <iframe
        src={source}
        title={`PDF preview: ${fileName}`}
        onError={onError}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
    </div>
  );
}
