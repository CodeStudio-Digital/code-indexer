import React from 'react';
import { parseDiff, Diff, Hunk, type FileData } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface Props {
  diff: string;
}

export function DiffBlock({ diff }: Props) {
  const trimmed = diff?.trim() ?? '';
  if (!trimmed) {
    return <div className="px-3 py-2 text-xs text-muted-foreground italic">Sem diferenças.</div>;
  }

  let files: FileData[] = [];
  try {
    files = parseDiff(diff);
  } catch (err) {
    return (
      <pre className="px-3 py-2 m-0 font-mono text-[10.5px] leading-snug whitespace-pre overflow-auto max-h-[320px]">
        {diff}
      </pre>
    );
  }

  if (files.length === 0 || files.every((f) => !f.hunks || f.hunks.length === 0)) {
    return (
      <pre className="px-3 py-2 m-0 font-mono text-[10.5px] leading-snug whitespace-pre overflow-auto max-h-[320px]">
        {diff}
      </pre>
    );
  }

  return (
    <div className="diff-block max-h-[320px] overflow-auto font-mono text-[11px] leading-snug">
      {files.map((file, i) => (
        <Diff
          key={`${file.oldPath ?? ''}-${file.newPath ?? ''}-${i}`}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
        >
          {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
        </Diff>
      ))}
    </div>
  );
}
