import { expect, it } from 'vitest';
import { parsePostmanCollection } from '../import-postman.js';

const info = { name: 'Report', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };
it('maps nested folders, inherited authorization, variables, disabled rows and GraphQL', () => {
  const result = parsePostmanCollection(JSON.stringify({ info, auth: {type:'bearer', bearer:[{ key:'token', value:'{{token}}' }]},
    variable:[{key:'token',value:'fixture',type:'secret'}], item:[{name:'Outer',item:[{name:'Inner',item:[
      { name:'Query', request:{method:'POST', url:{raw:'{{base}}/v/:id?off=1',query:[{key:'off',value:'1',disabled:true},{key:'q',value:'a&b'}],
        variable:[{key:'id',value:'123'}]}, body:{mode:'graphql',graphql:{query:'{version}', variables:'{}'}}},
        event:[{listen:'test'}], response:[{}] },
      { name:'File',request:{url:'http://localhost/',body:{mode:'file',file:{src:'local.dat'}}} },
    ]}]}] }));
  expect(result.folders).toEqual(['Outer','Outer / Inner']);
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ name:'Query', folder:'Outer / Inner', method:'POST', path_template:'{{base}}/v/123?q=a%26b', auth_type:'bearer', body_kind:'graphql' });
  expect(JSON.parse(result.requests[0].auth_json!)).toEqual({ token:'{{token}}' });
  expect(JSON.parse(result.requests[0].query_json!)[0].enabled).toBe(false);
  expect(result.variables.token).toEqual({ value:'fixture', secret:true });
  expect(result).toMatchObject({ scripts:1, examples:1, skipped:1 });
});

it('handles legacy string request and reports unsupported auth without sending a different request', () => {
  const result = parsePostmanCollection(JSON.stringify({info,item:[
    { name:'Valid',request:'https://example.invalid/x' },
    { name:'Unsupported',request:{url:'https://example.invalid',auth:{type:'hawk'}} },
  ]}));
  expect(result.requests.map(r => r.name)).toEqual(['Valid']);
  expect(result.skipped).toBe(1);
  expect(() => parsePostmanCollection('{"info":{},"item":[]}')).toThrow();
});
