/**
 * Dropdown: pick a microservice to filter the Tab Testes views by.
 *
 * Renders nothing when there is 0 or 1 service — single-service
 * sessions don't need a switcher. Multi-service sessions get a small
 * select with the primary's `name` followed by the additional
 * services. Status-aware tone (running/error/unknown) on each option
 * so the operator sees at a glance which service is healthy.
 */
import React from 'react';
import { useSessionServices } from './useSessionServices.js';

interface Props {
  sessionId: number;
  value: string;
  onChange: (serviceId: string) => void;
}

export function ServiceSwitcher({ sessionId, value, onChange }: Props) {
  const { services, loading } = useSessionServices(sessionId);

  if (loading) {
    return (
      <span className="text-xs text-muted-foreground">Loading services…</span>
    );
  }
  if (services.length <= 1) {
    return null;
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Service:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border rounded px-2 py-1 text-xs bg-background"
        aria-label="Filter QA runs by microservice"
      >
        {services.map((s) => (
          <option key={s.service_id} value={s.service_id}>
            {s.name}
            {s.is_primary ? ' · primary' : ''}
            {s.status && s.status !== 'ready' && s.status !== 'running'
              ? ` (${s.status})`
              : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
