import { contributeToolWindow, definePlugin } from '@mcp/plugin-sdk/define';

export default definePlugin({
  toolWindows: [contributeToolWindow({ id: 'figma', title: 'Figma', icon: 'figma', side: 'right', entry: 'ui/panel.html' })],
});
