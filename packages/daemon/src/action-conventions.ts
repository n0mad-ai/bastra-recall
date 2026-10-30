/** Fixed structural categories. No interpretation of natural-language descriptions. */
import type {Vault} from '@bastra-recall/core';
import {cachedRulebookCatalog} from './rulebook-catalog.js';
export async function indexedActionConventions(vault:Pick<Vault,'list'|'get'>,project:string|null,category:'github-issues-prs'){
 const catalog=await cachedRulebookCatalog(vault,{project,active:[]});
 return {hits:catalog.entries.filter(e=>e.rule_categories?.includes(category)).map(e=>({
  id:e.id,title:e.title,type:e.type,scope:e.scope??'all-projects',summary:e.summary??e.applies_when??'',
  revision:e.revision,write_origin:e.write_origin,rule_categories:e.rule_categories,
  score:164,matched_recall_when:true,anchor_strength:'strong',
 })),score_kind:'rrf'};
}
