/**
 * Lightbox modal that previews a single artifact (screenshot or video).
 * Image gets `<img>`; video gets `<video controls>`. Source URL is the
 * pre-built `/qa/artifact?service=&path=` URL the backend already
 * returned via `enrichResultsWithUrls`.
 *
 * Closes via Escape or backdrop click. Lazy: parent only mounts when
 * the user clicks the artifact icon — no early bandwidth cost.
 */
import React, { useEffect } from 'react';

interface Props {
  kind: 'screenshot' | 'video';
  url: string;
  /** Workspace-relative path, displayed as caption. */
  path: string;
  onClose: () => void;
}

export function ArtifactPreview({ kind, url, path, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-background/70 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-lg max-w-5xl max-h-[85vh] w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-2 border-b">
          <code className="text-xs truncate flex-1 mr-3">{path}</code>
          <a
            href={url}
            download
            className="text-xs text-primary hover:underline mr-3"
            title="Download artifact"
          >
            Download
          </a>
          <button
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            Close (Esc)
          </button>
        </header>
        <div className="flex-1 flex items-center justify-center overflow-auto bg-black/20 p-2">
          {kind === 'screenshot' ? (
            <img
              src={url}
              alt={path}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <video src={url} controls autoPlay className="max-w-full max-h-full">
              Your browser does not support the video tag.
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
