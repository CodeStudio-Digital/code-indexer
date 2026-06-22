/**
 * Host-injected UI kit for plugin webviews. The three layers concatenate
 * into one stylesheet that `plugin-iframe-runtime` injects right after the
 * webview's `<head>` opens — before the author's <style>, so plugins can
 * override any kit rule by simply restating it.
 *
 * Living in the dashboard (instead of the plugin SDK) keeps the kit version
 * permanently in sync with the host theme variables, and already-installed
 * plugins pick it up with no rebuild.
 */
import { KIT_BASE } from './base.css.js';
import { KIT_CONTROLS } from './controls.css.js';
import { KIT_LAYOUT } from './layout.css.js';
import { KIT_DATA } from './data.css.js';

export const PLUGIN_UI_KIT_CSS = [KIT_BASE, KIT_CONTROLS, KIT_LAYOUT, KIT_DATA].join('\n');
