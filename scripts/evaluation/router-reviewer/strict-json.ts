/** Preserve duplicate-key detection before JSON.parse can discard evidence/usage. */
export function parseProviderJson(text: string): unknown {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i=0;i<tokens.length;i++) {
    const token=tokens[i];
    if(token==='{')stack.push(new Set());
    else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else if(token.startsWith('"')&&tokens[i+1]===':') {
      const keys=stack.at(-1), key=JSON.parse(token) as string;
      if(!keys||keys.has(key))throw Error('DUPLICATE_PROVIDER_JSON_KEY');
      keys.add(key);
    }
  }
  return JSON.parse(text) as unknown;
}
