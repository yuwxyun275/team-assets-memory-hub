import {describe,it,expect} from "vitest";
import {runRules} from "../rules.js";
import {snapshot} from "./fixtures.js";
describe("AST exporter graph snapshot compatibility",()=>{
  const code="class Service:\n    def read(self):\n        return self.key()\n    def key(self):\n        return 1\n";
  const graph={repository:"repo",revision:"v1",source_sha256:"a".repeat(64),coverage:"One-hop syntactic only",nodes:[{id:"read",source_id:"code",path:"service.py",symbol:"Service.read",start_line:2,end_line:3},{id:"key",source_id:"code",path:"service.py",symbol:"Service.key",start_line:4,end_line:5}],edges:[{source:"read",target:"key",type:"calls",source_id:"code",line:3,resolution:"same_file_syntactic"}]};
  function checks(g:any){return runRules({...snapshot("code_graph"),body:JSON.stringify(g),sources:[{id:"code",kind:"code",locator:"service.py",repository:"repo",revision:"v1",content:code}]}).checks;}
  it("accepts typed exporter edges and qualified lexical declarations",()=>expect(checks(graph).filter(c=>c.id.startsWith("graph.")).every(c=>c.status==="pass")).toBe(true));
  it("does not accept nonexistent endpoints or impossible source line ranges",()=>{
    expect(checks({...graph,edges:[{...graph.edges[0],target:"missing"}]}).find(c=>c.id==="graph.structure")?.status).toBe("fail");
    expect(checks({...graph,nodes:graph.nodes.map(n=>({...n,start_line:n.start_line+1000,end_line:n.end_line+1000}))}).find(c=>c.id==="graph.source_anchors")?.status).toBe("fail");
  });
  it("does not match a different terminal name",()=>expect(checks({...graph,nodes:[{...graph.nodes[0],symbol:"Service.missing"},graph.nodes[1]]}).find(c=>c.id==="graph.source_anchors")?.status).toBe("fail"));
});
