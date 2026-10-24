/** Host worker code is constant. Request scripts are data passed exclusively to
 * QuickJS, never to Node eval/vm. No module loader or host functions are exposed. */
export const SCRIPT_WORKER_SOURCE = String.raw`
const { parentPort, workerData: data } = require('node:worker_threads');
(async () => {
  const quickjs = await require(data.modulePath).getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(128 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let collected = {}, error;
  const deadline = Date.now() + data.timeout;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const evaluate = source => {
    const result = vm.evalCode(source, 'api-script.js', { type: 'global' });
    if (result.error) {
      const value = vm.dump(result.error); result.error.dispose();
      throw new Error(value?.message ?? String(value));
    }
    try { return vm.dump(result.value); } finally { result.value.dispose(); }
  };
  try {
    const value = vm.newString(data.input);
    try { vm.setProp(vm.global, '__PM_INPUT__', value); } finally { value.dispose(); }
    evaluate(data.bootstrap);
    try { evaluate('(function(){\n' + data.source + '\n})()'); } catch (cause) { error = cause.message; }
    runtime.setInterruptHandler(() => Date.now() >= deadline + 100);
    try { collected = JSON.parse(evaluate('__pmCollect()')); } catch (cause) { error ??= cause.message; }
  } catch (cause) { error ??= cause.message; }
  finally { vm.dispose(); runtime.dispose(); }
  parentPort.postMessage(JSON.stringify({ collected, error })); parentPort.close();
})().catch(error => { parentPort.postMessage(JSON.stringify({ error: error.message })); parentPort.close(); });
`;
