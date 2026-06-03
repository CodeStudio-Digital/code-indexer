import React from 'react';
import { Monitor, Smartphone, Tablet } from 'lucide-react';

export type DeviceFrame = 'desktop' | 'tablet' | 'mobile';

/** Pixel width the preview iframe is constrained to per device. `null` = fill. */
export const DEVICE_WIDTH: Record<DeviceFrame, number | null> = {
  desktop: null,
  tablet: 768,
  mobile: 390,
};

const OPTIONS: Array<{ id: DeviceFrame; Icon: typeof Monitor; label: string }> = [
  { id: 'desktop', Icon: Monitor, label: 'Desktop' },
  { id: 'tablet', Icon: Tablet, label: 'Tablet' },
  { id: 'mobile', Icon: Smartphone, label: 'Mobile' },
];

export function DeviceFrameSwitcher({
  value,
  onChange,
}: {
  value: DeviceFrame;
  onChange: (d: DeviceFrame) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {OPTIONS.map(({ id, Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          title={label}
          aria-pressed={value === id}
          className={`h-6 w-6 flex items-center justify-center rounded ${
            value === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
