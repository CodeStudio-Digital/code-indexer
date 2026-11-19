import type { ReactNode } from 'react';

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="group/msg w-full">
      <article className="w-full min-w-0">
        <div>{children}</div>
      </article>
    </div>
  );
}
