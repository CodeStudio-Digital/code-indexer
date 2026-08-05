/**
 * True for Node's `ERR_STREAM_PREMATURE_CLOSE` (message "Premature close"),
 * including when a vendor SDK nests the original under `.cause`.
 */
export function isPrematureClose(err) {
    let e = err;
    for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
        const o = e;
        if (o.code === 'ERR_STREAM_PREMATURE_CLOSE')
            return true;
        if (typeof o.message === 'string' && o.message.includes('Premature close'))
            return true;
        e = o.cause;
    }
    return false;
}
/**
 * Decorate a ChatProvider so a benign *trailing* premature close ends the
 * stream cleanly instead of throwing. See the file header for the rationale.
 * Only `chat` is wrapped; `name` / `model` / `setModel` delegate to `inner`.
 */
export function withStreamResilience(inner) {
    return {
        get name() {
            return inner.name;
        },
        get model() {
            return inner.model;
        },
        set model(m) {
            inner.model = m;
        },
        setModel(model) {
            inner.setModel(model);
        },
        async *chat(req) {
            let sawDone = false;
            try {
                for await (const delta of inner.chat(req)) {
                    if (delta.type === 'done')
                        sawDone = true;
                    yield delta;
                }
            }
            catch (err) {
                // Response already completed (`done` seen) and the only failure is the
                // late socket teardown → end gracefully. Otherwise it's a real
                // truncation (or an unrelated error) → let the runner handle it.
                if (sawDone && isPrematureClose(err))
                    return;
                throw err;
            }
        },
    };
}
//# sourceMappingURL=stream-resilience.js.map