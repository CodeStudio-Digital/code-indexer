/**
 * Worker RPC failure predicates. `isPortClosedError` recognises only a
 * closed transport; `isMutationOutcomeUnknownError` additionally recognises
 * request timeouts because those do not cancel an already-running handler.
 * Both recognise class instances and the serializable `.code` shape.
 *
 * `isPortClosedError` must recognise both the `ErrPortClosed` class AND the
 * `{ code: 'port_closed' }` shape so structured-cloned errors
 * crossing a MessageChannel (which lose prototype) still match.
 */
import { describe, expect, it } from 'vitest';
import {
  ErrPortClosed,
  ErrRequestTimeout,
  isMutationOutcomeUnknownError,
  isPortClosedError,
} from '../MessageBridge.js';

describe('isPortClosedError', () => {
  it('matches a thrown ErrPortClosed instance', () => {
    expect(isPortClosedError(new ErrPortClosed())).toBe(true);
  });

  it('matches a plain object with code === "port_closed"', () => {
    expect(isPortClosedError({ code: 'port_closed' })).toBe(true);
    expect(isPortClosedError({ code: 'port_closed', message: 'whatever' })).toBe(true);
  });

  it('matches a regular Error with the same code attached', () => {
    const err = Object.assign(new Error('worker died'), { code: 'port_closed' });
    expect(isPortClosedError(err)).toBe(true);
  });

  it('does not match other bridge errors', () => {
    expect(isPortClosedError(new ErrRequestTimeout())).toBe(false);
  });

  it('does not match unrelated errors', () => {
    expect(isPortClosedError(new Error('something else'))).toBe(false);
    expect(isPortClosedError(new TypeError('bad arg'))).toBe(false);
  });

  it('does not match primitives or null/undefined', () => {
    expect(isPortClosedError(undefined)).toBe(false);
    expect(isPortClosedError(null)).toBe(false);
    expect(isPortClosedError('port_closed')).toBe(false);
    expect(isPortClosedError(42)).toBe(false);
    expect(isPortClosedError(true)).toBe(false);
  });

  it('does not match objects with a DIFFERENT code', () => {
    expect(isPortClosedError({ code: 'request_timeout' })).toBe(false);
    expect(isPortClosedError({ code: 'something_else' })).toBe(false);
  });

  it('does not match objects without any code field', () => {
    expect(isPortClosedError({ message: 'hi' })).toBe(false);
    expect(isPortClosedError({})).toBe(false);
  });
});

describe('isMutationOutcomeUnknownError', () => {
  it('matches closed ports and request timeouts', () => {
    expect(isMutationOutcomeUnknownError(new ErrPortClosed())).toBe(true);
    expect(isMutationOutcomeUnknownError({ code: 'port_closed' })).toBe(true);
    expect(isMutationOutcomeUnknownError(new ErrRequestTimeout())).toBe(true);
    expect(isMutationOutcomeUnknownError({ code: 'request_timeout' })).toBe(true);
    expect(isMutationOutcomeUnknownError({ code: 'unserializable_response' })).toBe(true);
  });

  it('does not classify ordinary worker rejections as unknown outcomes', () => {
    expect(isMutationOutcomeUnknownError(new Error('validation failed'))).toBe(false);
    expect(isMutationOutcomeUnknownError({ code: 'provider_error' })).toBe(false);
    expect(isMutationOutcomeUnknownError(null)).toBe(false);
  });
});
