import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import i18n from '../i18n/index.js';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return i18n.t('time.never');
  const normalized = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const then = new Date(normalized).getTime();
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return i18n.t('time.secondsAgo', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return i18n.t('time.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return i18n.t('time.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return i18n.t('time.daysAgo', { count: day });
  return new Date(iso).toLocaleDateString(i18n.language);
}
