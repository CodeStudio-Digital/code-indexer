/**
 * Compact microphone-device selector for the composer icon row — mirrors the
 * `OutputCapPicker` popover pattern. Lists "system default" + the OS audio-input
 * devices; the choice persists in localStorage (`composer.mic.deviceId`) and is
 * read by `useAudioRecorder` at `start()`. Tinted when a non-default device is
 * picked. Hidden when there's nothing to choose (≤1 device and none selected).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { useMicDevices, readMicDeviceId, writeMicDeviceId } from './mic-device.js';

interface MicDevicePickerProps {
  disabled?: boolean;
}

export function MicDevicePicker({ disabled }: MicDevicePickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => readMicDeviceId());
  const { devices, refresh } = useMicDevices();

  // Nothing meaningful to pick yet: 0/1 device and on the default → stay hidden.
  if (devices.length <= 1 && !selected) return null;

  function choose(deviceId: string | null) {
    writeMicDeviceId(deviceId);
    setSelected(deviceId);
    setOpen(false);
  }

  const elevated = selected != null;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) refresh();
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('composer.mic.device.heading', { defaultValue: 'Microfone' })}
          title={t('composer.mic.device.heading', { defaultValue: 'Microfone' })}
          className={`relative inline-flex items-center justify-center h-7 w-5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            elevated
              ? 'text-rose-500 hover:bg-rose-500/15'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1.5" align="start" side="top">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
          {t('composer.mic.device.heading', { defaultValue: 'Microfone' })}
        </div>
        <DeviceRow
          label={t('composer.mic.device.systemDefault', { defaultValue: 'Padrão do sistema' })}
          active={selected == null}
          onClick={() => choose(null)}
        />
        {devices.map((d, i) => (
          <DeviceRow
            key={d.deviceId}
            label={d.label || t('composer.mic.device.generic', { defaultValue: 'Microfone {{n}}', n: i + 1 })}
            active={selected === d.deviceId}
            onClick={() => choose(d.deviceId)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function DeviceRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between gap-2 ${
        active ? 'bg-rose-500/15 text-rose-500' : 'hover:bg-muted'
      }`}
    >
      <span className="truncate">{label}</span>
      {active && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}
