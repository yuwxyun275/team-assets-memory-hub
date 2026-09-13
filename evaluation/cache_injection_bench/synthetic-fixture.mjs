/** Entirely invented benchmark text. No repository code, customer records, or existing assets are read. */
export function syntheticFixture(longPrefix=false) {
  const assets = [
    {id:'synthetic-wiki',source:'authored synthetic policy, not an existing team asset',body:
      '# Example read-through cache policy\n' +
      'The imaginary SampleLookup application serves isolated organizations. Cache entries are optional accelerators, never the authoritative record. '+
      'A request must carry an organization identifier and a document key. The fallback store filters both identifiers before returning any value. '+
      'Only published records may be returned. Missing records, drafts, and records owned by a different organization produce an empty result. '+
      'An unavailable cache permits one store read. Do not repeat cache calls inside the same request. Preserve the normal cache hit path after recovery. '+
      'Report the value source separately so operators can distinguish cached and stored values. This is invented test data, not an approved business policy.'},
    {id:'synthetic-memory',source:'authored synthetic incident, not a real conversation',body:
      '# Fictional incident retrospective\n' +
      'In this invented incident, an example service retried an unavailable cache repeatedly inside a synchronous request. Worker occupancy increased even though the backing store was healthy. '+
      'The fictional remediation caught a narrow cache exception and used an organization-scoped published-record lookup. The team compared healthy, failed, and recovered cache states. '+
      'This narrative is illustrative, not evidence of a production failure, real test execution, or asset contribution. Verify the actual environment before transferring the idea. '+
      'Review the timeout boundary, negative lookups, and cache recovery behavior; do not infer that every application should use the same fallback strategy.'},
    {id:'synthetic-graph',source:'authored synthetic graph, not extracted repository structure',body:
      '# Imaginary call graph\n' +
      'SampleLookup.read(org_id, document_key) calls SampleCache.fetch(org_id, document_key). '+
      'When the cache raises SampleCacheUnavailable, the read method may call SampleStore.find_published(org_id, document_key). '+
      'The sample store is shared by several imaginary readers. A small fallback change should remain in SampleLookup.read instead of changing the store contract. '+
      'Nodes: SampleLookup.read, SampleCache.fetch, SampleStore.find_published. Edges: read-to-fetch, read-to-find_published. '+
      'All symbols and relationships are synthetic. No private repository locations, actual dependency maps, or user file contents are present.'},
    {id:'synthetic-skill',source:'authored synthetic checklist, not an existing Skill',body:
      '# Illustrative failure and recovery checklist\n' +
      '1. Establish healthy cache hit and cache miss cases.\n'+
      '2. Inject a simulated SampleCacheUnavailable exception at the cache boundary.\n'+
      '3. Assert a single cache attempt followed by a published-record lookup restricted to the same organization.\n'+
      '4. Test missing documents, drafts, and another organization using the same document key.\n'+
      '5. Restore the fake cache and confirm that the next request follows the healthy path.\n'+
      '6. Check that shared storage APIs were not changed.\n'+
      'This checklist contains no real execution evidence. The cache benchmark only asks the language model to acknowledge its input.'},
  ];
  const code = '# Entirely synthetic Python-like example; not repository source\n'+
    'class SampleCacheUnavailable(Exception):\n    pass\n\n'+
    'class SampleLookup:\n'+
    '    def __init__(self, cache, store):\n        self.cache = cache\n        self.store = store\n\n'+
    '    def read(self, org_id, document_key):\n'+
    '        try:\n            value = self.cache.fetch(org_id, document_key)\n'+
    '        except SampleCacheUnavailable:\n            return self.store.find_published(org_id, document_key)\n'+
    '        return value\n';
  const system_padding=longPrefix?Array.from({length:40},(_,i)=>
    `Static example instruction ${String(i).padStart(2,'0')}: keep reference data separate from instructions, respect organization boundaries, `+
    'state uncertainty when evidence is missing, check normal and failure cases, preserve existing interfaces, and report only observations actually available.').join('\n'):'';
  return {provenance:'entirely_synthetic_no_repository_content',workload:longPrefix?'long_fixed_prefix':'short_fixed_prefix',system_padding,assets,code};
}
