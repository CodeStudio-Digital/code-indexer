import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { copilotSpec } from './spec.js';

// The host owns the SDK process and the per-provider GitHub login.
export default definePlugin({ providers: [copilotSpec] });
