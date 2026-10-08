/** Recorded draft lifecycle counts in a log window, never current store size. */
export interface DraftStats {
 captured:number;evidenceAdded:number;expired:number;evicted:number;shown:number;
 promoted:number;wouldPromote:number;duplicateBlocked:number;wouldDuplicateBlock:number;
 otherBlocked:number;wouldOtherBlock:number;captureErrors:number;announced:number;
}
export function aggregateDrafts(events:Record<string,unknown>[]):DraftStats|null {
 const stats:DraftStats={captured:0,evidenceAdded:0,expired:0,evicted:0,shown:0,promoted:0,wouldPromote:0,duplicateBlocked:0,wouldDuplicateBlock:0,otherBlocked:0,wouldOtherBlock:0,captureErrors:0,announced:0};let observed=false;
 const count=(value:unknown):number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:0;
 for(const event of events){
  if(event.kind==="session_harvest"&&typeof event.draft_count==="number"){
   observed=true;stats.captured+=count(event.draft_count);stats.evidenceAdded+=count(event.draft_evidence_count);stats.evicted+=count(event.draft_evicted_count);stats.captureErrors+=event.draft_error===true?1:0;
  }else if(event.kind==="draft_expired"){observed=true;stats.expired+=count(event.count);}
  else if(event.kind==="draft_hint"){observed=true;stats.shown+=count(event.draft_count);}
  else if(event.kind==="draft_notice"){observed=true;stats.announced+=count(event.count);}
  else if(event.kind==="draft_promoted"){observed=true;stats.promoted++;}
  else if(event.kind==="draft_would_promote"){observed=true;stats.wouldPromote++;}
  else if(event.kind==="draft_duplicate_blocked"){observed=true;stats.duplicateBlocked++;}
  else if(event.kind==="draft_would_block"){observed=true;if(event.reason==="existing-note-or-quote-tombstone")stats.wouldDuplicateBlock++;else stats.wouldOtherBlock++;}
  else if(event.kind==="draft_promote_blocked"){observed=true;stats.otherBlocked++;}
 }
 return observed?stats:null;
}
export function renderDrafts(stats:DraftStats|null):string[]{
 if(!stats)return [];
 return ["  drafts (recorded in this window):",
  `    captured ${stats.captured}, additional evidence ${stats.evidenceAdded}; expired ${stats.expired}, evicted ${stats.evicted}`,
  `    shown ${stats.shown} hook deliveries; promoted ${stats.promoted}, would promote ${stats.wouldPromote}; announced ${stats.announced}`,
  `    duplicate blocked ${stats.duplicateBlocked}, would block ${stats.wouldDuplicateBlock}; other block decisions ${stats.otherBlocked+stats.wouldOtherBlock}; capture errors ${stats.captureErrors}`];
}
