export interface HttpEnvironment {
  incoming?: { socket: { remoteAddress?: string } };
  inProcess?: boolean;
}

export class HttpRequest {
  #query?: URLSearchParams;
  #params: Readonly<Record<string, string>> = Object.create(null);

  constructor(public raw: Request, readonly path: string) {}

  get url(): string { return this.raw.url; }
  get method(): string { return this.raw.method; }

  setParams(params: Readonly<Record<string, string>>): void {
    this.#params = params;
  }

  param(key: string): string {
    return this.#params[key] ?? '';
  }

  #searchParams(): URLSearchParams {
    return this.#query ??= new URL(this.url).searchParams;
  }

  query(): Record<string, string>;
  query(key: string): string | undefined;
  query(key?: string): Record<string, string> | string | undefined {
    const params = this.#searchParams();
    if (key !== undefined) return params.get(key) ?? undefined;
    const result: Record<string, string> = Object.create(null);
    for (const [name, value] of params) result[name] ??= value;
    return result;
  }

  queries(key: string): string[] | undefined {
    const values = this.#searchParams().getAll(key);
    return values.length ? values : undefined;
  }

  header(key: string): string | undefined {
    return this.raw.headers.get(key) ?? undefined;
  }

  json<T = unknown>(): Promise<T> {
    return this.raw.json() as Promise<T>;
  }

  async parseBody(): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
    const values: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.create(null);
    const type = this.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'multipart/form-data' && type !== 'application/x-www-form-urlencoded') return values;
    for (const [key, value] of await this.raw.formData()) {
      if (!key.endsWith('[]')) {
        values[key] = value;
        continue;
      }
      const entries = values[key] ??= [];
      if (Array.isArray(entries)) entries.push(value);
    }
    return values;
  }
}

export class HttpContext {
  readonly #headers = new Headers();
  readonly #appendHeaders = new Set<string>();
  readonly #values = new Map<string, unknown>();

  constructor(readonly req: HttpRequest, readonly env: HttpEnvironment | undefined) {}

  get<T = unknown>(key: string): T | undefined { return this.#values.get(key) as T | undefined; }
  set(key: string, value: unknown): void { this.#values.set(key, value); }

  header(name: string, value: string, options?: { append: boolean }): void {
    const key = name.toLowerCase();
    if (options?.append) {
      if (!this.#headers.has(key)) this.#appendHeaders.add(key);
      this.#headers.append(key, value);
    } else {
      this.#appendHeaders.delete(key);
      this.#headers.set(key, value);
    }
  }

  json(data: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'application/json; charset=UTF-8');
    return new Response(JSON.stringify(data), { status, headers: responseHeaders });
  }

  text(data: string, status = 200, headers?: HeadersInit): Response {
    return this.#textResponse(data, status, 'text/plain; charset=UTF-8', headers);
  }

  html(data: string, status = 200, headers?: HeadersInit): Response {
    return this.#textResponse(data, status, 'text/html; charset=UTF-8', headers);
  }

  #textResponse(data: string, status: number, contentType: string, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', contentType);
    return this.body(data, status, responseHeaders);
  }

  body(data: BodyInit | null, status = 200, headers?: HeadersInit): Response {
    return new Response(data, { status, headers });
  }

  redirect(location: string, status = 302): Response {
    return this.body(null, status, { location });
  }

  applyHeaders(response: Response): Response {
    if (this.#headers.keys().next().done) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of this.#headers) {
      if (name === 'set-cookie' || this.#appendHeaders.has(name)) headers.append(name, value);
      else headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, options?: { message?: string }) {
    super(options?.message);
  }

  toResponse(): Response {
    return new Response(this.message || null, { status: this.status });
  }
}
