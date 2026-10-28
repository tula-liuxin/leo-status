import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
const result=await build({entryPoints:['src/client.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',external:['react'],jsx:'transform',loader:{'.css':'text'},minify:true})
await writeFile('client.js',`window.__ModuleLoader__.load({id:'leo-status',factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text.replace('renderMarkdown:()=>`  \n','renderMarkdown:()=>`\\x20\\x20\n')}\nreturn module.exports;}});\n`)
