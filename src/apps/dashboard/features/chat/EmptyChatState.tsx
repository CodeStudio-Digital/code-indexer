import { MessageSquareCode, PanelLeft, Plus, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';

interface EmptyChatStateProps {
  onNew: () => void;
  projectName: string;
  onOpenSidebar?: () => void;
}

const SUGGESTIONS = [
  'Explain the project architecture',
  'Find and fix the most recent bug',
  'Add tests for the main module',
  'Refactor for clarity',
];

export function EmptyChatState({ onNew, projectName, onOpenSidebar }: EmptyChatStateProps) {
  return (
    <div className="flex-1 flex flex-col">
      {onOpenSidebar && (
        <div className="lg:hidden border-b px-3 py-2 flex items-center">
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label="Open sessions"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <PanelLeft className="h-4 w-4" />
            Sessions
          </button>
        </div>
      )}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md space-y-5">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
            <MessageSquareCode className="h-8 w-8" />
          </div>
          <div>
            <h3 className="text-xl font-semibold">Start a conversation</h3>
            <p className="text-sm text-muted-foreground mt-1.5">
              Chat with the coder agent on <span className="font-medium text-foreground">{projectName}</span>.
            </p>
          </div>
          <Button onClick={onNew} size="lg">
            <Plus className="h-4 w-4" /> New session
          </Button>
          <div className="pt-4">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-2 flex items-center justify-center gap-1">
              <Sparkles className="h-3 w-3" /> Try asking
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {SUGGESTIONS.map((s) => (
                <Badge key={s} variant="outline" className="text-[11px] font-normal normal-case py-1 px-2.5">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
