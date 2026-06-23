/**
 * Microphone device selection: a persisted `deviceId` (localStorage) plus a hook
 * that enumerates the OS audio-input devices. Same localStorage pattern as
 * `MasterComposer`'s COLLAPSED_KEY. The recorder reads `readMicDeviceId()` at
 * `start()`; the picker writes it. `null` = the OS default device.
 */
import { useCallback, useEffect, useState } from 'react';

const MIC_DEVICE_KEY = 'composer.mic.deviceId';

export function readMicDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(MIC_DEVICE_KEY) || null;
  } catch {
    return null;
  }
}

export function writeMicDeviceId(deviceId: string | null): void {
  try {
    if (deviceId) window.localStorage.setItem(MIC_DEVICE_KEY, deviceId);
    else window.localStorage.removeItem(MIC_DEVICE_KEY);
  } catch { /* quota / private mode */ }
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

/**
 * Enumerate audio-input devices and keep the list fresh on hot-plug
 * (`devicechange`). Device labels are only populated AFTER mic permission has
 * been granted once — before that the picker falls back to generic names.
 */
export function useMicDevices(): { devices: MicDevice[]; refresh: () => void } {
  const [devices, setDevices] = useState<MicDevice[]>([]);

  const refresh = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((all) => {
        const inputs = all
          .filter((d) => d.kind === 'audioinput' && d.deviceId)
          .map((d) => ({ deviceId: d.deviceId, label: d.label }));
        setDevices(inputs);
      })
      .catch(() => { /* enumeration can reject in locked-down contexts */ });
  }, []);

  useEffect(() => {
    refresh();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md) return;
    md.addEventListener?.('devicechange', refresh);
    return () => md.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  return { devices, refresh };
}
