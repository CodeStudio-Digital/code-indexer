/**
 * ErrorBoundary — contains a render/runtime crash to the subtree it wraps so a
 * single broken panel shows an inline message instead of taking down the whole
 * app (the React Router error overlay). Reusable: wrap any panel/tab/tool-window
 * whose content is independently fallible.
 *
 * `resetKey` clears a stuck error when it changes (e.g. pass the active tab id,
 * so switching tabs recovers without a reload).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Short label for what failed (shown in the fallback + logged). */
  label?: string;
  /** Changing this value resets the boundary. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the breadcrumb in the console for the dev — the fallback only shows
    // the message, not the stack.
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.label
      ? `Something went wrong in ${this.props.label}.`
      : 'Something went wrong.';
    const retry = 'Retry';

    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground max-w-md break-words font-mono line-clamp-4">
          {error.message}
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="mt-1 inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted transition-colors"
        >
          <RotateCcw className="h-3 w-3" />
          {retry}
        </button>
      </div>
    );
  }
}
