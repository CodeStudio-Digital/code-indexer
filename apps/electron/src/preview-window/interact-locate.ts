/**
 * Page-side element locator for the preview interaction tools. Runs ONE
 * `Runtime.evaluate` in the page and resolves a target by:
 *   - standard CSS selector, OR
 *   - `text="visible text"` (exact, then substring), OR
 *   - a Playwright-ish `<css>:has-text("...")` (base CSS + substring filter).
 * Prefers the most leaf-like VISIBLE match (the real button/label, not a
 * wrapping container — clicks bubble anyway). Returns viewport-center coords
 * (`coords`) or focuses the element (`focus`/`fill`); `{error}` on a bad CSS
 * selector so the agent gets a clear message instead of a raw CDP throw.
 */
import type { PreviewWindow } from './cdp.js';

export type LocateMode = 'coords' | 'focus' | 'fill';
export interface LocateResult {
  found?: boolean;
  x?: number;
  y?: number;
  focused?: boolean;
  error?: string;
}

// Verbatim JS (NOT transpiled — avoids tsc down-level helpers reaching the page).
const FINDER_SRC = `function(sel, mode){
  var visible=function(e){return e.getClientRects&&e.getClientRects().length>0;};
  var textOf=function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim();};
  var leaf=function(e){return e.querySelectorAll('*').length;};
  var byText=function(base,t,exact){
    var all=Array.prototype.filter.call(document.querySelectorAll(base),visible);
    var cands=exact?all.filter(function(e){return textOf(e)===t;}):[];
    var pool=cands.length?cands:all.filter(function(e){return textOf(e).indexOf(t)>=0;});
    pool.sort(function(a,b){return leaf(a)-leaf(b);});
    return pool[0]||null;
  };
  var el=null;
  try{
    if(sel.indexOf('text=')===0){
      var t=sel.slice(5).trim().replace(/^["']|["']$/g,'');
      el=byText('body *',t,true);
    } else {
      var m=sel.match(/^(.*?):has-text\\(\\s*["']?([\\s\\S]*?)["']?\\s*\\)\\s*$/i);
      if(m){el=byText((m[1].trim()||'*'),m[2],false);}
      else {el=document.querySelector(sel);}
    }
  }catch(e){return {error:'invalid selector: '+((e&&e.message)||String(e))+' — use a CSS selector, or text="visible text".'};}
  if(!el){return {found:false};}
  try{el.scrollIntoView({block:'center',inline:'center'});}catch(_e){}
  if(mode==='focus'||mode==='fill'){
    try{el.focus();}catch(_e){}
    if(mode==='fill'&&el.select){try{el.select();}catch(_e){}}
    return {found:true,focused:document.activeElement===el};
  }
  var r=el.getBoundingClientRect();
  return {found:true,x:r.left+r.width/2,y:r.top+r.height/2};
}`;

/** Resolve a target in the page; returns coords (coords) or focuses it. */
export async function locate(
  pw: PreviewWindow,
  selector: string,
  mode: LocateMode,
): Promise<LocateResult> {
  const expr = `(${FINDER_SRC})(${JSON.stringify(selector)},${JSON.stringify(mode)})`;
  const r = (await pw.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  })) as { result?: { value?: LocateResult }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) return { error: r.exceptionDetails.text ?? 'locate evaluation failed' };
  return (r.result && r.result.value) || { found: false };
}
