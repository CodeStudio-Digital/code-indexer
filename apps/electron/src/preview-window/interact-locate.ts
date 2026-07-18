/**
 * Actionable element locator for preview interactions. Accepts CSS/text
 * selectors and stable refs emitted by preview_snapshot. Every result carries
 * enough element identity to verify what was targeted.
 */
import type { PreviewWindow } from './cdp.js';

export type LocateMode = 'coords' | 'focus' | 'fill';
export interface LocateResult {
  found?: boolean;
  x?: number;
  y?: number;
  focused?: boolean;
  editable?: boolean;
  tag?: string;
  role?: string;
  name?: string;
  error?: string;
}

// Verbatim JS (NOT transpiled — avoids tsc down-level helpers reaching the page).
const FINDER_SRC = `function(sel, mode){
  var visible=function(e){
    if(!e||!e.getClientRects||!e.getClientRects().length)return false;
    var s=getComputedStyle(e),r=e.getBoundingClientRect();
    return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;
  };
  var textOf=function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim();};
  var leaf=function(e){return e.querySelectorAll('*').length;};
  var interactive=function(e){return /^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(e.tagName)||e.isContentEditable||e.getAttribute('role')==='button'||e.getAttribute('tabindex')!==null;};
  var byText=function(base,t,exact){
    var all=Array.prototype.filter.call(document.querySelectorAll(base),visible);
    var cands=exact?all.filter(function(e){return textOf(e)===t;}):[];
    var pool=cands.length?cands:all.filter(function(e){return textOf(e).indexOf(t)>=0;});
    pool.sort(function(a,b){return (interactive(b)?1000:0)-(interactive(a)?1000:0)||leaf(a)-leaf(b);});
    return pool[0]||null;
  };
  var control=function(e){
    if(e&&e.tagName==='LABEL'&&e.control)return e.control;
    if(e&&e.closest){var l=e.closest('label');if(l&&l.control)return l.control;}
    return e;
  };
  var describe=function(e){return {tag:(e.tagName||'').toLowerCase(),role:e.getAttribute&&e.getAttribute('role')||'',name:(e.getAttribute&&e.getAttribute('aria-label'))||textOf(e).slice(0,200)};};
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
  }catch(e){return {error:'invalid selector: '+((e&&e.message)||String(e))+' — use CSS, ref=aN, or text="visible text".'};}
  if(!el)return {found:false};
  if(mode==='focus'||mode==='fill')el=control(el);
  if(!visible(el))return {found:false,error:'matched element is not visible'};
  if(el.disabled||(el.getAttribute&&el.getAttribute('aria-disabled')==='true'))return {found:false,error:'matched element is disabled'};
  try{el.scrollIntoView({block:'center',inline:'center'});}catch(_e){}
  if(mode==='focus'||mode==='fill'){
    try{el.focus();}catch(_e){}
    var editable=/^(INPUT|TEXTAREA)$/.test(el.tagName)||!!el.isContentEditable;
    if(mode==='fill'&&editable){
      if(el.select){try{el.select();}catch(_e){}}
      else if(el.isContentEditable){try{var rr=document.createRange();rr.selectNodeContents(el);var ss=getSelection();ss.removeAllRanges();ss.addRange(rr);}catch(_e){}}
    }
    return Object.assign({found:true,focused:document.activeElement===el,editable:editable},describe(el));
  }
  var r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
  if(hit&&hit!==el&&!el.contains(hit))return Object.assign({found:false,error:'element is covered by '+(hit.tagName||'another element').toLowerCase()},describe(el));
  return Object.assign({found:true,x:x,y:y},describe(el));
}`;

const RESOLVED_ACTION_SRC = `function(mode){
  var el=this;
  var text=function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim();};
  var info=function(e){return {tag:(e.tagName||'').toLowerCase(),role:e.getAttribute&&e.getAttribute('role')||'',name:(e.getAttribute&&e.getAttribute('aria-label'))||text(e).slice(0,200)};};
  if(!el||!el.getBoundingClientRect)return {found:false,error:'referenced node is no longer an element'};
  var s=getComputedStyle(el),r=el.getBoundingClientRect();
  if(!el.getClientRects().length||s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||r.width<=0||r.height<=0)return {found:false,error:'referenced element is not visible'};
  if(el.disabled||(el.getAttribute&&el.getAttribute('aria-disabled')==='true'))return {found:false,error:'referenced element is disabled'};
  try{el.scrollIntoView({block:'center',inline:'center'});}catch(_e){}
  if(mode==='focus'||mode==='fill'){
    try{el.focus();}catch(_e){}
    var editable=/^(INPUT|TEXTAREA)$/.test(el.tagName)||!!el.isContentEditable;
    if(mode==='fill'&&editable&&el.select){try{el.select();}catch(_e){}}
    return Object.assign({found:true,focused:document.activeElement===el,editable:editable},info(el));
  }
  r=el.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
  if(hit&&hit!==el&&!el.contains(hit))return Object.assign({found:false,error:'referenced element is covered'},info(el));
  return Object.assign({found:true,x:x,y:y},info(el));
}`;

async function locateRef(pw: PreviewWindow, ref: string, mode: LocateMode): Promise<LocateResult> {
  const backendNodeId = pw.resolveRef(ref);
  if (!backendNodeId) return { error: `unknown or stale preview ref '${ref}' — call preview_snapshot again` };
  const resolved = (await pw.send('DOM.resolveNode', { backendNodeId })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) return { error: `preview ref '${ref}' is no longer attached` };
  try {
    const called = (await pw.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: RESOLVED_ACTION_SRC,
      arguments: [{ value: mode }],
      returnByValue: true,
    })) as { result?: { value?: LocateResult }; exceptionDetails?: { text?: string } };
    if (called.exceptionDetails) return { error: called.exceptionDetails.text ?? 'ref actionability check failed' };
    return called.result?.value ?? { found: false };
  } finally {
    await pw.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

/** Resolve a target in the page; returns coords (coords) or focuses it. */
export async function locate(
  pw: PreviewWindow,
  selector: string,
  mode: LocateMode,
): Promise<LocateResult> {
  const ref = selector.match(/^ref=(a\d+)$/)?.[1];
  if (ref) return locateRef(pw, ref, mode);
  const expr = `(${FINDER_SRC})(${JSON.stringify(selector)},${JSON.stringify(mode)})`;
  const result = (await pw.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  })) as { result?: { value?: LocateResult }; exceptionDetails?: { text?: string } };
  if (result.exceptionDetails) return { error: result.exceptionDetails.text ?? 'locate evaluation failed' };
  return result.result?.value ?? { found: false };
}
