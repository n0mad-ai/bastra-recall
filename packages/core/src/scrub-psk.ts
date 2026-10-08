/** Explicit PSK command/XML/prose syntax; no conversation intent classification. */
export function pskLineEnd(text:string,start:number):number {
  for(let pos=start;pos<text.length;pos++){
    const c=text[pos];
    if('\r\n,;<>}]'.includes(c))return pos;
    if(c!==' '&&c!=='\t')continue;
    let next=pos;while(text[next]===' '||text[next]==='\t')next++;
    if(/^--?[a-z]/i.test(text.slice(next,next+3)))return pos;
    const key=/^[a-z_][a-z0-9_.-]{0,127}/i.exec(text.slice(next,next+128));
    if(key){let end=next+key[0].length;while(text[end]===' '||text[end]==='\t')end++;if(text[end]==='=')return pos;}
    pos=next-1;
  }
  return text.length;
}
export function scanPskForms(text:string,markPsk:(start:number,wholeLine?:boolean)=>number,mark:(start:number,length:number)=>void,isReference:(value:string)=>boolean):void {
  for(const m of text.matchAll(/(?:^|[\s;])(?:wifi-sec\.psk|802-11-wireless-security\.psk|-psk|pre-shared-key)[ \t]+/gi))markPsk(m.index!+m[0].length);
  for(const m of text.matchAll(/(?:^|\r?\n)[ \t]*wpa-psk[ \t]+/gi))markPsk(m.index!+m[0].length);
  for(const m of text.matchAll(/\bwpa_passphrase[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)[ \t]+/gi))markPsk(m.index!+m[0].length);
  for(const m of text.matchAll(/:[ \t]*PSK[ \t]+/gi))markPsk(m.index!+m[0].length,true);
  // One failed closing-tag search per tag kind, not per repeated opener.
  const asciiLower=text.replace(/[A-Z]/g,c=>c.toLowerCase()),missing=new Set<string>();
  const tags=/<(psk|keyMaterial)>/gi;let opening:RegExpExecArray|null;
  while((opening=tags.exec(text))){
    const tag=opening[1].toLowerCase();if(missing.has(tag))continue;
    const start=opening.index+opening[0].length,close=`</${tag}>`,end=asciiLower.indexOf(close,start);
    if(end<0){missing.add(tag);continue;}
    if(!isReference(text.slice(start,end).trim()))mark(start,end-start);
    tags.lastIndex=end+close.length;
  }
  // DE ist/lautet and EN is are explicitly supported binding words. The
  // optional label context is bounded; whitespace is traversed once per run.
  for(const m of text.matchAll(/\b(?:PSK|Pre[ -]Shared[ -]Key)\b/gi)){
    let pos=m.index!+m[0].length;
    if(text[pos]!==' '&&text[pos]!=='\t')continue;
    while(text[pos]===' '||text[pos]==='\t')pos++;
    const limit=pos+48;
    while(pos<=limit && pos<text.length){
      const word=/^[^\s:]{1,49}/.exec(text.slice(pos,pos+49));if(!word)break;
      const end=pos+word[0].length,verb=word[0].toLowerCase();
      if(verb==='ist'||verb==='lautet'||verb==='is'){
        let start=end;while(text[start]===' '||text[start]==='\t')start++;
        const colon=text[start]===':';if(colon){start++;while(text[start]===' '||text[start]==='\t')start++;}
        if(start>end||colon)markPsk(start,true);
        break;
      }
      pos=end;while(text[pos]===' '||text[pos]==='\t')pos++;
      if(pos===end)break;
    }
  }
}
