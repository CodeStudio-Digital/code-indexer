import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

const MAX_COMPILED_SCHEMAS = 32;

/**
 * The SDK eagerly asks for every output validator during tools/list. Compiling
 * a large catalogue there blocked Electron's main thread for seconds on each
 * connection/refresh, even when the user was only opening an empty session.
 * Keep the SDK's result validation, but compile only when a result needs it.
 */
export class DeferredMcpValidator implements jsonSchemaValidator {
  private readonly compiled = new Map<string, JsonSchemaValidator<unknown>>();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    let key: string | undefined;
    return (input) => {
      // Fingerprint on first use, too: listing tools must not traverse/compile
      // every output schema. New tools/list objects can reuse an unchanged one.
      key ??= createHash('sha256').update(JSON.stringify(schema)).digest('hex');
      let validate = this.compiled.get(key);
      if (!validate) {
        // Isolate schemas: unrelated tools may reuse $id, and a server may
        // change a schema without changing its $id. Never reuse by $id alone.
        validate = new AjvJsonSchemaValidator().getValidator(schema);
      }
      this.compiled.delete(key);
      this.compiled.set(key, validate);
      if (this.compiled.size > MAX_COMPILED_SCHEMAS) {
        this.compiled.delete(this.compiled.keys().next().value!);
      }
      return (validate as JsonSchemaValidator<T>)(input);
    };
  }
}
