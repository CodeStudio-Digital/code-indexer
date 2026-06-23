/**
 * Shared detail dialog for Session Drive entries (notes, investigations,
 * plans). Renders a centered modal (radix Dialog — wider than the narrow
 * right-rail panel) with a title + optional meta line + a scrollable body.
 *
 * The body is a slot: read-only views pass `<Markdown text={...}/>`; the
 * Notes tab swaps in a textarea when editing. Optional footer for actions.
 */
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../../components/ui/dialog.js';

export function DriveDetailDialog({
  open,
  onOpenChange,
  title,
  meta,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  meta?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6 break-words">{title}</DialogTitle>
          {meta ? <DialogDescription className="text-[11px]">{meta}</DialogDescription> : null}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">{children}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
